import { runSuite, type RunOptions } from "../../core/runner.js";
import type { RunResult } from "../../core/types.js";
import { loadLoCoMo } from "./dataset.js";

const DEFAULT_CATEGORIES = ["single_hop", "temporal", "multi_hop", "open_domain"];

export interface LoCoMoRunOptions
  extends Omit<RunOptions, "suite" | "conversations" | "categories"> {
  datasetPath?: string;
  limit?: number;
  categories?: string[];
}

export async function runLoCoMo(
  opts: LoCoMoRunOptions,
): Promise<RunResult> {
  const conversations = await loadLoCoMo(opts.datasetPath);
  const slice = opts.limit ? conversations.slice(0, opts.limit) : conversations;
  return runSuite({
    suite: "locomo",
    conversations: slice,
    categories: opts.categories ?? DEFAULT_CATEGORIES,
    ...opts,
  });
}
