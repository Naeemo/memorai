import type {
  Event,
  ExtractContext,
  Extractor,
  LLMService,
  WritePayload,
} from "../types.js";
import { buildBaseWrite, contentToTextAndMedia } from "./shared.js";
import { LightExtractor } from "./light.js";

interface LLMExtractionOutput {
  summary: string;
  tags: string[];
  salience: number;
  description?: string;
}

/**
 * LLM-powered extractor. Sends the event's textual content to the configured
 * LLMService and asks for a structured `{ summary, tags, salience, description }`.
 *
 * On any error (LLM failure, parse failure, missing LLM in context), falls
 * back to `LightExtractor` so production never throws because the extractor
 * had a bad day.
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

    const { summary: raw } = contentToTextAndMedia(event.content);
    if (!raw || raw.length === 0) {
      return this.fallback.extract(event, ctx);
    }

    try {
      const prompt = buildPrompt(event, raw, ctx);
      const out = await llm.complete(prompt, {
        temperature: this.opts.temperature ?? 0,
        maxTokens: 512,
        responseFormat: "json",
        signal: ctx.signal,
      });
      const parsed = parseOutput(out);
      const base = buildBaseWrite(event, ctx.now(), {
        tags: parsed.tags,
        salienceScore: parsed.salience,
      });
      base.payload.summary = parsed.summary || base.payload.summary;
      if (parsed.description) base.payload.description = parsed.description;
      return [base];
    } catch {
      return this.fallback.extract(event, ctx);
    }
  }
}

const DEFAULT_SYSTEM = `You are a memory-extraction assistant. Given an event involving an actor, an optional target, and content, you produce a JSON object capturing the salient memory.

Output schema (strict JSON, no prose):
{
  "summary": "<one or two sentences capturing what happened>",
  "tags": ["<3-8 lowercase tags: entities, topics, key terms>"],
  "salience": <number 0..1 — importance>,
  "description": "<optional longer expansion; omit if summary is sufficient>"
}`;

function buildPrompt(event: Event, raw: string, ctx: ExtractContext): string {
  const recent = ctx.recent
    .slice(-3)
    .map((n) => `- ${n.payload.summary}`)
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
  // Try direct JSON parse, then look for a JSON block
  const candidates = [
    trimmed,
    extractJsonBlock(trimmed),
  ].filter((s): s is string => Boolean(s));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Partial<LLMExtractionOutput>;
      if (typeof obj.summary === "string") {
        return {
          summary: obj.summary,
          tags: Array.isArray(obj.tags)
            ? obj.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
            : [],
          salience: clampSalience(obj.salience),
          description: typeof obj.description === "string" ? obj.description : undefined,
        };
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("LLMExtractor: could not parse JSON output");
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
