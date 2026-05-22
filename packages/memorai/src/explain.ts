import type {
  ExplainResult,
  RecallOptions,
  RecallResult,
  RecallSpan,
  RecalledMemory,
} from "./types.js";

/**
 * Build an {@link ExplainResult} from the raw pieces of a recall invocation.
 * Called by `Memorai.explain()` and also used internally after a normal
 * `recall()` to feed the `onRecall` hook.
 */
export function buildExplainResult(opts: {
  question: string;
  recallOpts: RecallOptions;
  spans: RecallSpan[];
  nodeResult: RecallResult;
  eventResult?: RecallResult;
  fusedMemories: RecalledMemory[];
}): ExplainResult {
  const { question, recallOpts, spans, nodeResult, eventResult, fusedMemories } = opts;

  const pathways: Record<string, { count: number; avgScore: number }> = {};
  for (const m of fusedMemories) {
    for (const p of m.provenance?.pathways ?? []) {
      const entry = pathways[p] ?? { count: 0, avgScore: 0 };
      entry.count += 1;
      entry.avgScore += m.score;
      pathways[p] = entry;
    }
  }
  for (const p of Object.keys(pathways)) {
    const entry = pathways[p];
    entry.avgScore = entry.count > 0 ? entry.avgScore / entry.count : 0;
  }

  return {
    question,
    opts: recallOpts,
    spans,
    nodeResult,
    eventResult,
    fusion: {
      method: "rrf",
      nodeCount: nodeResult.memories.length,
      eventCount: eventResult?.memories.length ?? 0,
      finalCount: fusedMemories.length,
    },
    pathways,
  };
}

/** Helper to start a span and return a function that ends it. */
export function spanTracker(): {
  start(name: string, details?: Record<string, unknown>): () => void;
  collect(): RecallSpan[];
} {
  const spans: RecallSpan[] = [];
  return {
    start(name, details?) {
      const startMs = performance.now();
      return () => {
        spans.push({ name, startMs, endMs: performance.now(), details });
      };
    },
    collect() {
      return spans;
    },
  };
}
