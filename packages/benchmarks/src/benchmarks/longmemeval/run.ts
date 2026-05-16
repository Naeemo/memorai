import { runSuite, type RunOptions } from "../../core/runner.js";
import type { RunResult } from "../../core/types.js";
import { loadLongMemEval, type LongMemEvalSplit } from "./dataset.js";

export interface LongMemEvalRunOptions
  extends Omit<RunOptions, "suite" | "conversations"> {
  split?: LongMemEvalSplit;
  datasetPath?: string;
  limit?: number;
}

export async function runLongMemEval(
  opts: LongMemEvalRunOptions,
): Promise<RunResult> {
  const conversations = await loadLongMemEval(
    opts.split ?? "oracle",
    opts.datasetPath,
  );
  const slice = opts.limit ? conversations.slice(0, opts.limit) : conversations;
  return runSuite({
    suite: `longmemeval_${opts.split ?? "oracle"}`,
    conversations: slice,
    ...opts,
  });
}
