export type {
  EvalTurn,
  EvalQA,
  EvalConversation,
  EvalRunRecord,
  EvalCategoryStats,
  EvalRunResult,
} from "./types.js";

import type { EvalConversation, EvalRunResult } from "./types.js";
import type { Memorai } from "../index.js";

export interface EvalRunner {
  ingest: (conversations: EvalConversation[]) => Promise<void>;
  answer: (question: string) => Promise<string>;
  judge: (question: string, gold: string, predicted: string) => Promise<"CORRECT" | "INCORRECT">;
}

/**
 * Run an evaluation suite against a Memorai instance.
 *
 * This is the public `memorai/eval` surface. The heavy benchmark datasets
 * (LoCoMo, LongMemEval) live in `@memorai/benchmarks`; this entry point is
 * for users who want to run custom suites against their own data.
 */
export async function runEval(
  memory: Memorai,
  conversations: EvalConversation[],
  runner: EvalRunner,
  opts: { topK?: number } = {},
): Promise<EvalRunResult> {
  const started = Date.now();
  await runner.ingest(conversations);

  const records: EvalRunResult["records"] = [];
  let correct = 0;
  const latencies: number[] = [];

  for (const conv of conversations) {
    for (const qa of conv.qas) {
      const t0 = performance.now();
      const recall = await memory.recall(qa.question, { topK: opts.topK ?? 5 });
      const predicted = await runner.answer(qa.question);
      const judgeLabel = await runner.judge(qa.question, qa.gold, predicted);
      const latencyMs = performance.now() - t0;

      latencies.push(latencyMs);
      if (judgeLabel === "CORRECT") correct++;

      records.push({
        qa,
        hits: recall.memories.map((m) => ({ content: m.summary, score: m.score })),
        predicted,
        judgeLabel,
        latencyMs,
        hitCount: recall.memories.length,
      });
    }
  }

  const totalQas = records.length;
  const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95LatencyMs = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

  return {
    suite: "custom",
    provider: "memorai",
    ingestMode: "wrap",
    answererModel: "user-provided",
    judgeModel: "user-provided",
    embedder: "user-provided",
    conversations: conversations.length,
    totalQas,
    correct,
    accuracy: totalQas > 0 ? correct / totalQas : 0,
    avgLatencyMs,
    p95LatencyMs,
    byCategory: [],
    records,
    runAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
