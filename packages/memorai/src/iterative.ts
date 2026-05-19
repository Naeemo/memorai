import type { LLMService, RecallOptions, RecallResult, RecalledMemory } from "./types.js";

/**
 * Status code per iteration step. `sufficient` and `no_progress` are
 * the clean stops; `max_iterations` means we hit the cap before the
 * judge said "stop"; `judge_error` covers LLM failures (we stop rather
 * than loop forever on a broken judge); `no_llm` is the
 * "iterative recall called without a configured LLM" fallback path.
 */
export type IterativeJudgment =
  | "sufficient"
  | "insufficient"
  | "max_iterations"
  | "no_progress"
  | "judge_error"
  | "no_llm";

export interface IterativeRecallOptions extends RecallOptions {
  /** Maximum number of recall iterations. Default 3. */
  maxIterations?: number;
  /** Hard cap on how many top memories are shown to the judge each turn (keeps the prompt bounded). Default 20. */
  judgeWindow?: number;
}

export interface IterativeRecallStep {
  /** 1-indexed iteration number. */
  iteration: number;
  /** The query used for this iteration's recall. */
  query: string;
  /** Memories surfaced this iteration that weren't already in the collected set. */
  newMemoriesFound: number;
  /** Why this iteration stopped — or `insufficient` if we kept going. */
  judgment: IterativeJudgment;
}

export interface IterativeRecallResult extends RecallResult {
  /** Number of iterations actually run (≤ `maxIterations`). */
  iterations: number;
  /** One entry per iteration; final entry's `judgment` describes why we stopped. */
  steps: IterativeRecallStep[];
}

/**
 * Iterative / agentic recall — repeats a `recall → judge → rewrite`
 * loop until the LLM judges the collected memories sufficient, no new
 * memories surface, or `maxIterations` is reached.
 *
 * Why: single-pass recall is a one-shot — the embedding+BM25 fusion
 * surfaces what it can and stops. For multi-hop questions ("when did X
 * happen and what did Y say about it") or queries that need
 * back-and-forth refinement, that's not enough. Mem0 v2 / Letta /
 * GraphRAG all do some form of iterative retrieval; this is Memorai's
 * version.
 *
 * Each iteration:
 *   1. recall(query) → memories
 *   2. dedupe vs. previously-collected; tag each with `iter:N` provenance
 *   3. ask the LLM "given these memories and the original question, is
 *      this sufficient? if not, what single focused query targets the
 *      gap?"
 *   4. SUFFICIENT  → stop, return
 *      NEEDS: <q>  → use <q> as next iteration's query
 *
 * Termination:
 *   - LLM judged sufficient
 *   - max iterations reached
 *   - rewrite repeats a prior query ("no progress")
 *   - LLM throws (treat as judge_error, stop with what we have)
 */
export class IterativeRecaller {
  constructor(
    private readonly llm: LLMService,
    private readonly recallFn: (q: string, opts: RecallOptions) => Promise<RecallResult>,
  ) {}

  async recall(
    question: string,
    opts: IterativeRecallOptions = {},
  ): Promise<IterativeRecallResult> {
    const maxIterations = Math.max(1, opts.maxIterations ?? 3);
    const judgeWindow = Math.max(1, opts.judgeWindow ?? 20);
    const topK = opts.topK ?? 10;

    const collected = new Map<string, RecalledMemory>();
    const steps: IterativeRecallStep[] = [];
    const seenQueries = new Set<string>([question]);
    let currentQuery = question;
    let totalScanned = 0;

    for (let i = 0; i < maxIterations; i++) {
      const result = await this.recallFn(currentQuery, opts);
      totalScanned += result.totalScanned;

      let newCount = 0;
      for (const mem of result.memories) {
        if (collected.has(mem.id)) continue;
        collected.set(mem.id, this.tagProvenance(mem, i + 1));
        newCount += 1;
      }

      // Final iteration → stop with `max_iterations` regardless of LLM.
      if (i === maxIterations - 1) {
        steps.push({
          iteration: i + 1,
          query: currentQuery,
          newMemoriesFound: newCount,
          judgment: "max_iterations",
        });
        break;
      }

      const collectedArr = [...collected.values()].sort((a, b) => b.score - a.score);
      const judgement = await this.judge(question, collectedArr.slice(0, judgeWindow));

      if (judgement.kind === "sufficient") {
        steps.push({
          iteration: i + 1,
          query: currentQuery,
          newMemoriesFound: newCount,
          judgment: "sufficient",
        });
        break;
      }

      if (judgement.kind === "error") {
        steps.push({
          iteration: i + 1,
          query: currentQuery,
          newMemoriesFound: newCount,
          judgment: "judge_error",
        });
        break;
      }

      // judgement.kind === "insufficient"
      const next = judgement.nextQuery;
      if (seenQueries.has(next)) {
        // LLM rewrote to a query we already used → no real progress.
        steps.push({
          iteration: i + 1,
          query: currentQuery,
          newMemoriesFound: newCount,
          judgment: "no_progress",
        });
        break;
      }

      steps.push({
        iteration: i + 1,
        query: currentQuery,
        newMemoriesFound: newCount,
        judgment: "insufficient",
      });
      seenQueries.add(next);
      currentQuery = next;
    }

    const sorted = [...collected.values()].sort((a, b) => b.score - a.score).slice(0, topK);
    const confidence =
      sorted.length === 0
        ? 0
        : sorted.reduce((s, m) => s + Math.min(1, m.score), 0) / sorted.length;

    return {
      memories: sorted,
      confidence,
      totalScanned,
      iterations: steps.length,
      steps,
    };
  }

  private async judge(
    question: string,
    memories: RecalledMemory[],
  ): Promise<
    { kind: "sufficient" } | { kind: "insufficient"; nextQuery: string } | { kind: "error" }
  > {
    const memList =
      memories.length === 0
        ? "(no memories surfaced yet)"
        : memories.map((m, i) => `${i + 1}. ${this.summarizeForJudge(m)}`).join("\n");

    const prompt =
      `You are evaluating whether the retrieved memories contain enough information to answer a question. ` +
      `If they do, output the single word "SUFFICIENT". ` +
      `If they do not, output "NEEDS:" followed by a single focused search query (one sentence, no commentary) that targets the missing information.\n\n` +
      `Question: ${question}\n\n` +
      `Retrieved memories:\n${memList}\n\n` +
      `Your output:`;

    try {
      const raw = await this.llm.complete(prompt, { temperature: 0.2, maxTokens: 200 });
      const trimmed = raw.trim();

      if (/^SUFFICIENT\b/i.test(trimmed)) {
        return { kind: "sufficient" };
      }

      const match = trimmed.match(/^NEEDS\s*:\s*(.+?)$/is);
      if (match) {
        const next = match[1].trim().replace(/^["']|["']$/g, "");
        if (next.length > 3 && next.length < 400) {
          return { kind: "insufficient", nextQuery: next };
        }
      }

      // Unparseable response — be conservative, treat as sufficient
      // rather than burn another LLM round-trip on a model that won't
      // produce structured output.
      return { kind: "sufficient" };
    } catch {
      return { kind: "error" };
    }
  }

  private summarizeForJudge(mem: RecalledMemory): string {
    // Keep the judge prompt compact. A long candidate set + verbose
    // memories blows past the model's context for cheap judges.
    const head = (mem.summary ?? "").trim();
    if (head.length <= 200) return head;
    return head.slice(0, 197) + "...";
  }

  private tagProvenance(mem: RecalledMemory, iteration: number): RecalledMemory {
    const existing = mem.provenance;
    return {
      ...mem,
      provenance: {
        pathways: [...(existing?.pathways ?? []), `iter:${iteration}`],
        fusedScore: existing?.fusedScore ?? mem.score,
        pathwayScores: { ...existing?.pathwayScores },
      },
    };
  }
}
