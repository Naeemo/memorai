import type { RerankDoc, RerankResult, RerankerService } from "./types.js";

/**
 * Score function shape — takes a list of (query, doc) pairs and returns
 * a relevance score per pair. Higher is better. Range is implementation-
 * defined but cross-encoders typically return scores in roughly [0, 1].
 *
 * Decoupled from a specific transformer library so the reranker stays
 * testable. Use `loadXenovaCrossEncoder(modelName)` for the standard
 * `@xenova/transformers` integration, or wire your own scorer (sentence-
 * transformers via Python sidecar, Cohere rerank API, etc.).
 */
export type CrossEncoderScoreFn = (
  pairs: Array<{ query: string; doc: string }>,
) => Promise<number[]>;

/**
 * Local cross-encoder reranker. Alternative to `LLMReranker` — faster
 * (~50ms for 30 docs on a small model), cheaper (no API calls), and
 * runs anywhere a JS cross-encoder can.
 *
 * Reranking precision is competitive with LLM rerankers for short docs;
 * for long passages an LLM still has the edge because it can attend
 * across the full context.
 *
 * Usage:
 *
 *   import { TransformersReranker, loadXenovaCrossEncoder } from "memorai";
 *   const reranker = new TransformersReranker({
 *     score: await loadXenovaCrossEncoder("Xenova/ms-marco-MiniLM-L-6-v2"),
 *   });
 *
 * The `score` function is injected so this class stays free of any
 * transformer-library import; users supply the wiring.
 */
export class TransformersReranker implements RerankerService {
  private readonly score: CrossEncoderScoreFn;
  private readonly maxDocs: number;
  private readonly snippetChars: number;
  private readonly batchSize: number;

  constructor(opts: {
    /** The cross-encoder scorer. Required. */
    score: CrossEncoderScoreFn;
    /** Cap the number of docs sent to the scorer (default 30). */
    maxDocs?: number;
    /** Truncate each doc to this many chars before scoring (default 512). */
    snippetChars?: number;
    /** Score this many pairs per batch (default 16). */
    batchSize?: number;
  }) {
    this.score = opts.score;
    this.maxDocs = opts.maxDocs ?? 30;
    this.snippetChars = opts.snippetChars ?? 512;
    this.batchSize = opts.batchSize ?? 16;
  }

  async rerank(query: string, docs: RerankDoc[], topK: number): Promise<RerankResult[]> {
    if (docs.length === 0) return [];
    const capped = docs.slice(0, this.maxDocs);
    const pairs = capped.map((d) => ({
      query,
      doc: d.text.slice(0, this.snippetChars).replace(/\s+/g, " ").trim(),
    }));

    const scores: number[] = [];
    for (let i = 0; i < pairs.length; i += this.batchSize) {
      const batch = pairs.slice(i, i + this.batchSize);
      try {
        const batchScores = await this.score(batch);
        scores.push(...batchScores);
      } catch {
        // Scorer failure → fill the batch with 0s and continue. Caller can
        // detect "all zeros" as a rerank no-op and fall back if needed.
        for (let j = 0; j < batch.length; j++) scores.push(0);
      }
    }

    const result: RerankResult[] = capped.map((d, i) => ({
      id: d.id,
      score: scores[i] ?? 0,
    }));
    result.sort((a, b) => b.score - a.score);
    return result.slice(0, topK);
  }
}

/**
 * Convenience loader for `@xenova/transformers` cross-encoders.
 *
 * Returns a `CrossEncoderScoreFn` that pipes (query, doc) pairs through the
 * specified text-classification pipeline. Common models:
 *
 *   - "Xenova/ms-marco-MiniLM-L-6-v2"  — fast, accurate, ~80MB
 *   - "Xenova/bge-reranker-base"        — BAAI's reranker, ~300MB
 *
 * `@xenova/transformers` is a peer dependency — install separately:
 *   `npm install @xenova/transformers`
 *
 * Falls back to a clear error message when the dep isn't installed.
 */
export async function loadXenovaCrossEncoder(modelName: string): Promise<CrossEncoderScoreFn> {
  let mod: { pipeline?: unknown };
  try {
    // Dynamic import keeps the dependency optional. The package isn't a
    // direct dependency of memorai — users install `@xenova/transformers`
    // themselves when they want this loader. ts-ignore the import so the
    // build doesn't require the types to be present at compile time.
    // @ts-ignore — optional peer dep, resolved at runtime
    mod = (await import(/* @vite-ignore */ "@xenova/transformers")) as {
      pipeline?: unknown;
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadXenovaCrossEncoder: failed to load @xenova/transformers — ${reason}. ` +
        `Install it with: npm install @xenova/transformers`,
    );
  }
  if (typeof mod.pipeline !== "function") {
    throw new Error("loadXenovaCrossEncoder: @xenova/transformers.pipeline is not a function");
  }
  const pipelineFn = mod.pipeline as (
    task: string,
    model: string,
  ) => Promise<(inputs: unknown) => Promise<unknown>>;
  const classifier = await pipelineFn("text-classification", modelName);

  return async (pairs) => {
    const inputs = pairs.map(({ query, doc }) => ({ text: query, text_pair: doc }));
    const raw = (await classifier(inputs)) as Array<{ label?: string; score?: number }>;
    return raw.map((r) => (typeof r.score === "number" ? r.score : 0));
  };
}
