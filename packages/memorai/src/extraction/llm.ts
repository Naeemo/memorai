import type {
  Event,
  ExtractContext,
  Extractor,
  KnowledgeTriple,
  LLMService,
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
    {"subject": "<entity>", "predicate": "<relation>", "object": "<entity or value>"}
  ]
}

Guidance:
- "summary" should resolve pronouns and include explicit timestamps / dates if the event has them
- "facts" should rephrase the same content in different surface forms (e.g. "Caroline researched adoption agencies" / "Adoption agencies were what Caroline looked into / etc.")
- "triples" capture structured knowledge: (Caroline, researched, "adoption agencies"), (Caroline, attended_on, "2023-05-07")
- omit a field if you'd be guessing`;

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
