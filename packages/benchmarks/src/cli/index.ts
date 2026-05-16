#!/usr/bin/env tsx
import type { MemoryProvider } from "../core/provider.js";
import type { LongMemEvalSplit } from "../benchmarks/longmemeval/dataset.js";
import { MemoraiProvider } from "../providers/memorai.js";
import { NaiveRagProvider } from "../providers/naive-rag.js";
import { runCustomSuite } from "../benchmarks/custom/run.js";
import { runLoCoMo } from "../benchmarks/locomo/run.js";
import { runLongMemEval } from "../benchmarks/longmemeval/run.js";

type Suite = "custom" | "locomo" | "longmemeval" | "all";

interface CliOptions {
  suite: Suite;
  provider: "memorai" | "naive-rag";
  ingestMode: "wrap" | "extract" | "paired";
  extractor: "wrap" | "llm";
  extractorModel?: string;
  embedder: "ollama" | "openai";
  topK: number;
  limit?: number;
  limitQas?: number;
  categories?: string[];
  evolve: boolean;
  outDir: string;
  answererModel?: string;
  judgeModel?: string;
  split: LongMemEvalSplit;
  datasetPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const suiteRaw = argv[0];
  const validSuites: Suite[] = ["custom", "locomo", "longmemeval", "all"];
  if (!validSuites.includes(suiteRaw as Suite)) {
    console.error(`Unknown suite: ${suiteRaw}. Expected one of: ${validSuites.join(", ")}`);
    printHelp();
    process.exit(2);
  }
  const suite = suiteRaw as Suite;

  const opts: CliOptions = {
    suite,
    provider: "memorai",
    ingestMode: "wrap",
    extractor: "wrap",
    embedder: "ollama",
    topK: 30,
    evolve: true,
    outDir: "results",
    split: "oracle",
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      return v;
    };
    switch (arg) {
      case "--provider":
        opts.provider = next() as CliOptions["provider"];
        break;
      case "--ingest-mode":
        opts.ingestMode = next() as CliOptions["ingestMode"];
        break;
      case "--extractor":
        opts.extractor = next() as CliOptions["extractor"];
        break;
      case "--extractor-model":
        opts.extractorModel = next();
        break;
      case "--embedder":
        opts.embedder = next() as CliOptions["embedder"];
        break;
      case "--top-k":
        opts.topK = Number.parseInt(next(), 10);
        break;
      case "--limit":
        opts.limit = Number.parseInt(next(), 10);
        break;
      case "--limit-qas":
        opts.limitQas = Number.parseInt(next(), 10);
        break;
      case "--categories":
        opts.categories = next().split(",").map((s) => s.trim());
        break;
      case "--no-evolve":
        opts.evolve = false;
        break;
      case "--out":
        opts.outDir = next();
        break;
      case "--answerer-model":
        opts.answererModel = next();
        break;
      case "--judge-model":
        opts.judgeModel = next();
        break;
      case "--split":
        opts.split = next() as LongMemEvalSplit;
        break;
      case "--dataset":
        opts.datasetPath = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: bench <suite> [options]

suites:
  custom        Memorai's internal synthetic suite (8 benchmarks)
  locomo        LoCoMo (10 conversations, ~1500 QAs)
  longmemeval   LongMemEval (500 QAs)
  all           Run every available suite

options:
  --provider memorai|naive-rag           (default: memorai)
  --extractor wrap|llm                   (default: wrap; llm uses Ollama answerer for ingest extraction)
  --extractor-model <id>                 (default: gemma4:e2b — small local model for fast extraction)
  --ingest-mode wrap|extract|paired      (legacy; superseded by --extractor)
  --embedder ollama|openai               (default: ollama)
  --top-k <n>                            (default: 30)
  --limit <n>                            (process first N conversations; default: all)
  --limit-qas <n>                        (max N QAs per conversation; default: all)
  --categories <csv>                     (LoCoMo categories filter; default: 1,2,3,4)
  --no-evolve                            (skip memory.evolve() after each session)
  --out <path>                           (default: results)
  --answerer-model <id>                  (default: gpt-4o-mini or gemma4:31b-cloud)
  --judge-model <id>                     (default: gpt-4o-mini or qwen3-coder-next:cloud — different family from answerer)
  --split oracle|s                       (LongMemEval split; default: oracle)
  --dataset <path>                       (override default dataset location)
  -h, --help                             show this help
`);
}

function makeProvider(opts: CliOptions): MemoryProvider {
  if (opts.provider === "naive-rag") {
    return new NaiveRagProvider({ embedder: opts.embedder });
  }
  return new MemoraiProvider({
    embedder: opts.embedder,
    ingestMode: opts.ingestMode,
    extractor: opts.extractor,
    extractorModel: opts.extractorModel,
    answererModel: opts.answererModel,
  });
}

async function runOne(opts: CliOptions): Promise<void> {
  if (opts.suite === "custom") {
    await runCustomSuite({ outDir: opts.outDir });
    return;
  }

  const provider = makeProvider(opts);
  const baseOpts = {
    provider,
    ingestMode: opts.extractor === "llm" ? "llm" : opts.ingestMode,
    embedder: opts.embedder,
    topK: opts.topK,
    evolve: opts.evolve,
    outDir: opts.outDir,
    answererModel: opts.answererModel,
    judgeModel: opts.judgeModel,
    limitQas: opts.limitQas,
    onProgress: (msg: string) => console.log(msg),
  };

  if (opts.suite === "locomo") {
    const result = await runLoCoMo({
      ...baseOpts,
      limit: opts.limit,
      categories: opts.categories,
      datasetPath: opts.datasetPath,
    });
    summarize(result);
    return;
  }
  if (opts.suite === "longmemeval") {
    const result = await runLongMemEval({
      ...baseOpts,
      limit: opts.limit,
      split: opts.split,
      datasetPath: opts.datasetPath,
    });
    summarize(result);
    return;
  }
}

function summarize(result: import("../core/types.js").RunResult): void {
  console.log("");
  console.log(`=== ${result.suite} / ${result.provider} ===`);
  console.log(`Accuracy: ${(result.accuracy * 100).toFixed(2)}% (${result.correct}/${result.totalQas})`);
  console.log(`Avg latency: ${result.avgLatencyMs.toFixed(1)}ms, P95: ${result.p95LatencyMs.toFixed(1)}ms`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("Per-category:");
  for (const c of result.byCategory) {
    console.log(
      `  ${c.category.padEnd(20)} acc=${(c.accuracy * 100).toFixed(1)}% (${c.correct}/${c.count})  f1=${c.f1.toFixed(3)}  bleu1=${c.bleu1.toFixed(3)}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.suite === "all") {
    for (const s of ["custom", "locomo", "longmemeval"] as Suite[]) {
      console.log(`\n# Suite: ${s}\n`);
      try {
        await runOne({ ...opts, suite: s });
      } catch (err) {
        console.error(`[${s}] failed: ${String(err)}`);
      }
    }
    return;
  }
  await runOne(opts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
