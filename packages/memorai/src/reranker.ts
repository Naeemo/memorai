import type { LLMService, RerankDoc, RerankResult, RerankerService } from "./types.js";

/**
 * LLM-based reranker. Batches all candidates into a single LLM call and
 * asks for one score per document on a 0-10 scale.
 *
 * Falls back gracefully on parse failures: if a line cannot be parsed as a
 * number, that document scores 0 and is sorted to the bottom.
 *
 * Cost: one LLM call per `rerank()` regardless of document count, capped by
 * `maxDocs` (default 30) so the prompt stays bounded.
 */
export class LLMReranker implements RerankerService {
  private readonly llm: LLMService;
  private readonly maxDocs: number;
  private readonly snippetChars: number;

  constructor(opts: {
    llm: LLMService;
    /** Cap the number of docs sent to the LLM (default 30). */
    maxDocs?: number;
    /** Truncate each doc to this many chars (default 240). */
    snippetChars?: number;
  }) {
    this.llm = opts.llm;
    this.maxDocs = opts.maxDocs ?? 30;
    this.snippetChars = opts.snippetChars ?? 240;
  }

  async rerank(query: string, docs: RerankDoc[], topK: number): Promise<RerankResult[]> {
    if (docs.length === 0) return [];
    const capped = docs.slice(0, this.maxDocs);
    const prompt = buildPrompt(query, capped, this.snippetChars);

    let raw: string;
    try {
      raw = await this.llm.complete(prompt, {
        temperature: 0,
        maxTokens: capped.length * 6 + 32,
      });
    } catch {
      // LLM failure → signal "no rerank happened" via empty return so the
      // caller can fall back to the un-reranked list.
      return [];
    }

    const scores = parseScores(raw, capped.length);
    const scored: RerankResult[] = capped.map((d, i) => ({
      id: d.id,
      score: scores[i] ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

function buildPrompt(query: string, docs: RerankDoc[], snippetChars: number): string {
  const docsBlock = docs
    .map((d, i) => `[${i}] ${d.text.slice(0, snippetChars).replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return `Rate how relevant each document is to the query, on a scale of 0 to 10. Output exactly ${docs.length} lines, one score per document in order, nothing else.

QUERY: ${query}

DOCUMENTS:
${docsBlock}

SCORES (one per line, 0-10):`;
}

/**
 * Parse `count` scores from the LLM output. Tolerates leading rank
 * indicators like "[0]" / "0:" / "0." and ignores trailing junk.
 */
export function parseScores(raw: string, count: number): number[] {
  const lines = raw.split(/\r?\n/);
  const scores: number[] = [];
  for (const line of lines) {
    if (scores.length >= count) break;
    // Strip leading bracketed/parenthesised/numbered list indicators
    // (e.g. "[0]", "(0)", "0:", "0.", "0)") so we don't read the rank
    // itself as the score. After stripping, the first number remaining
    // is the score.
    const cleaned = line.replace(/^\s*[(\[]?\d+[)\].:\-]\s*/, "");
    const m = cleaned.match(/(-?\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number.parseFloat(m[1]);
      if (Number.isFinite(n)) scores.push(Math.max(0, Math.min(10, n)) / 10);
    }
  }
  while (scores.length < count) scores.push(0);
  return scores;
}
