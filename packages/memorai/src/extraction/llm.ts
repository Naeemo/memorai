import type {
  Event,
  ExtractContext,
  Extractor,
  KnowledgeTriple,
  LLMService,
  TemporalAnchor,
  WritePayload,
} from "../types.js";
import { buildBaseWrite, rawIndexableText } from "./shared.js";
import { LightExtractor } from "./light.js";

interface LLMExtractionOutput {
  summary: string;
  facts?: string[];
  tags: string[];
  salience: number;
  description?: string;
  triples?: KnowledgeTriple[];
  temporalAnchors?: TemporalAnchor[];
}

const EXTRACTOR_VERSION = "llm-v1";

/**
 * LLM-powered extractor. Sends the event's textual content to the configured
 * LLMService and asks for a structured `{ summary, facts, tags, salience, description, triples }`.
 *
 * Writes:
 *   - Tier 1 `raw` unchanged from the upstream Event
 *   - Tier 2 `annotations.summary` (LLM canonical form) +
 *            `annotations.facts` (paraphrased variants) +
 *            `annotations.tags` (LLM-extracted entities) +
 *            `annotations.salienceScore` (LLM-rated) +
 *            `annotations.triples` (knowledge-graph triples)
 *
 * On any error (LLM failure, parse failure, missing LLM in context), falls
 * back to `LightExtractor` so production never throws because the extractor
 * had a bad day. Tier 1 still gets written; only Tier 2 degrades.
 */
export class LLMExtractor implements Extractor {
  private readonly fallback = new LightExtractor();

  constructor(
    private readonly opts: {
      llm?: LLMService;
      systemPrompt?: string;
      temperature?: number;
    } = {},
  ) {}

  async extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]> {
    const llm = this.opts.llm ?? ctx.llm;
    if (!llm) {
      return this.fallback.extract(event, ctx);
    }

    const base = buildBaseWrite(event, ctx.now());
    const rawText = rawIndexableText(base.raw);
    if (!rawText || rawText.length === 0) {
      return this.fallback.extract(event, ctx);
    }

    try {
      const prompt = buildPrompt(event, rawText, ctx);
      const out = await llm.complete(prompt, {
        temperature: this.opts.temperature ?? 0,
        maxTokens: 768,
        responseFormat: "json",
        signal: ctx.signal,
      });
      const parsed = parseOutput(out);

      const annotations = base.annotations ?? {};
      annotations.summary = parsed.summary || annotations.summary;
      if (parsed.facts && parsed.facts.length > 0) {
        annotations.facts = parsed.facts;
      }
      annotations.tags = mergeTags(annotations.tags, parsed.tags);
      annotations.salienceScore = parsed.salience;
      if (parsed.description) {
        annotations.description = parsed.description;
      }
      if (parsed.triples && parsed.triples.length > 0) {
        annotations.triples = parsed.triples;
      }
      if (parsed.temporalAnchors && parsed.temporalAnchors.length > 0) {
        annotations.temporalAnchors = parsed.temporalAnchors;
      }

      base.annotations = annotations;
      base.annotationVersion = EXTRACTOR_VERSION;
      return [base];
    } catch {
      return this.fallback.extract(event, ctx);
    }
  }
}

function mergeTags(a: string[] | undefined, b: string[]): string[] {
  const set = new Set<string>();
  for (const t of a ?? []) set.add(t.toLowerCase());
  for (const t of b) set.add(t.toLowerCase());
  return [...set];
}

const DEFAULT_SYSTEM = `You are a memory-extraction assistant. Given an event involving an actor, an optional target, and content, you produce a JSON object that captures the salient memory in canonical form.

Output schema (strict JSON, no prose):
{
  "summary": "<one or two sentences capturing what happened, in factual canonical form>",
  "facts": ["<2-4 alternative phrasings of the same fact, useful for retrieval>"],
  "tags": ["<3-8 lowercase tags: entities, topics, key terms>"],
  "salience": <number 0..1 — importance>,
  "description": "<optional longer expansion; omit if summary is sufficient>",
  "triples": [
    {"subject": "<entity>", "predicate": "<relation>", "object": "<entity or value>", "confidence": <number 0..1>}
  ],
  "temporalAnchors": [
    {"name": "canonical-anchor-name", "type": "point|range|deadline|milestone", "label": "exact phrase from text", "confidence": <number 0..1>}
  ]
}

Guidance:
- "summary" should resolve pronouns and include explicit dates / times when present in the event ("yesterday" → the actual date relative to the event's timestamp)
- "facts" should rephrase the same content in different surface forms (e.g. "Caroline researched adoption agencies" / "Adoption agencies were what Caroline looked into")
- "tags" should be lowercase canonical entity / topic tokens — match the casing in "triples" so retrieval can cross-reference
- "salience" is the agent's importance estimate: 0.9 for decisions / commitments / preferences that persist; 0.5 for routine facts; 0.2 for filler / acknowledgments
- "triples" capture structured knowledge: (caroline, researched, "adoption agencies"), (caroline, attended_on, "2023-05-07"). Include "confidence" — lower when the relation is implied rather than stated
- "temporalAnchors" identify named time references in the text that users might later query relative to: "before the migration", "after Alice arrived", "during the Q3 review", "since the project started", "until the deadline". "name" should be a short canonical slug (lowercase, no spaces), "type" should be one of: point (instant), range (duration), deadline (fixed cutoff), milestone (significant event). Only include anchors that are clearly referenced in the text — do NOT invent them
- omit a field if you'd be guessing; do NOT invent participants, dates, or relations not grounded in the event content

EXAMPLE 1 — input:
EVENT:
- actor: alice
- kind: message
- content: i love earl grey, prefer it over coffee every morning

Output:
{
  "summary": "Alice prefers Earl Grey tea over coffee, drinks it every morning.",
  "facts": ["Alice's preferred beverage is Earl Grey tea", "Alice drinks Earl Grey every morning instead of coffee"],
  "tags": ["alice", "earl grey", "tea", "coffee", "morning routine", "preference"],
  "salience": 0.85,
  "triples": [
    {"subject": "alice", "predicate": "prefers", "object": "earl grey tea", "confidence": 0.95},
    {"subject": "alice", "predicate": "drinks_routinely", "object": "earl grey", "confidence": 0.9}
  ]
}

EXAMPLE 2 — input:
EVENT:
- actor: bob
- kind: message
- content: ok sounds good thanks!

Output:
{
  "summary": "Bob acknowledged.",
  "tags": ["bob", "acknowledgment"],
  "salience": 0.15
}`;

function buildPrompt(event: Event, raw: string, ctx: ExtractContext): string {
  const recent = ctx.recent
    .slice(-3)
    .map((n) => `- ${n.annotations.summary ?? n.raw.text ?? ""}`)
    .filter((s) => s.length > 4)
    .join("\n");
  const recentBlock = recent ? `\nRECENT CONTEXT:\n${recent}\n` : "";
  const target = event.target ? ` to ${event.target}` : "";
  return `${DEFAULT_SYSTEM}
${recentBlock}
EVENT:
- actor: ${event.actor}${target}
- kind: ${event.content.kind}
- content: ${raw}

Respond with JSON only.`;
}

function parseOutput(raw: string): LLMExtractionOutput {
  const trimmed = raw.trim();
  const candidates = [trimmed, extractJsonBlock(trimmed)].filter((s): s is string => Boolean(s));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<LLMExtractionOutput>;
      if (typeof obj.summary === "string") {
        return {
          summary: obj.summary,
          facts: Array.isArray(obj.facts)
            ? obj.facts.filter((f): f is string => typeof f === "string" && f.length > 0)
            : undefined,
          tags: Array.isArray(obj.tags)
            ? obj.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
            : [],
          salience: clampSalience(obj.salience),
          description: typeof obj.description === "string" ? obj.description : undefined,
          triples: parseTriples(obj.triples),
          temporalAnchors: parseTemporalAnchors(obj.temporalAnchors),
        };
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("LLMExtractor: could not parse JSON output");
}

function parseTriples(v: unknown): KnowledgeTriple[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: KnowledgeTriple[] = [];
  for (const item of v) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { subject: unknown }).subject === "string" &&
      typeof (item as { predicate: unknown }).predicate === "string" &&
      typeof (item as { object: unknown }).object === "string"
    ) {
      const t = item as {
        subject: string;
        predicate: string;
        object: string;
        confidence?: unknown;
      };
      const triple: KnowledgeTriple = {
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
      };
      if (typeof t.confidence === "number" && Number.isFinite(t.confidence)) {
        triple.confidence = Math.max(0, Math.min(1, t.confidence));
      }
      out.push(triple);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseTemporalAnchors(v: unknown): TemporalAnchor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TemporalAnchor[] = [];
  for (const item of v) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { name: unknown }).name === "string" &&
      typeof (item as { label: unknown }).label === "string"
    ) {
      const a = item as {
        name: string;
        type?: unknown;
        label: string;
        confidence?: unknown;
      };
      const type =
        a.type === "point" || a.type === "range" || a.type === "recurring" || a.type === "deadline" || a.type === "milestone"
          ? a.type
          : "point";
      const confidence =
        typeof a.confidence === "number" && Number.isFinite(a.confidence)
          ? Math.max(0, Math.min(1, a.confidence))
          : 0.7;
      out.push({
        name: a.name.toLowerCase().trim().replace(/\s+/g, "-"),
        type,
        label: a.label,
        confidence,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function extractJsonBlock(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function clampSalience(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
