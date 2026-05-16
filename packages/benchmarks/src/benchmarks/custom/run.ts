import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatCustomMarkdown,
  type BenchmarkResult,
  type BenchmarkSuite,
} from "../../core/metrics.js";
import { runNeedleHaystackBenchmark } from "./needle-haystack.js";
import { runMultiNeedleBenchmark } from "./multi-needle.js";
import { runEvolutionBenchmark } from "./evolution.js";
import { runTemporalBenchmark } from "./temporal.js";
import { runScalabilityBenchmark } from "./scalability.js";
import { runCrossAgentBenchmark } from "./cross-agent.js";
import { runMultimodalRecallBenchmark } from "./multimodal-recall.js";
import { runTimeWindowBenchmark } from "./time-window.js";

const BENCHMARKS = [
  runNeedleHaystackBenchmark,
  runMultiNeedleBenchmark,
  runEvolutionBenchmark,
  runTemporalBenchmark,
  runScalabilityBenchmark,
  runCrossAgentBenchmark,
  runMultimodalRecallBenchmark,
  runTimeWindowBenchmark,
];

export interface RunCustomOptions {
  outDir?: string;
  onProgress?: (msg: string) => void;
}

export async function runCustomSuite(
  opts: RunCustomOptions = {},
): Promise<BenchmarkSuite> {
  const onProgress = opts.onProgress ?? ((msg) => process.stdout.write(msg));
  const outDir = opts.outDir ?? "results";

  onProgress("=== Custom Synthetic Suite ===\n");
  onProgress(`Using Ollama at: ${process.env.OLLAMA_HOST ?? "http://localhost:11434"}\n`);
  onProgress("Embedding model: nomic-embed-text\n");
  onProgress("Judge model: gemma4:31b-cloud\n\n");

  const results: BenchmarkResult[] = [];
  let totalScore = 0;
  let totalLatency = 0;

  for (const bench of BENCHMARKS) {
    const name = bench.name.replace("run", "").replace("Benchmark", "");
    onProgress(`Running ${name}... `);
    try {
      const result = await bench();
      results.push(result);
      totalScore += result.score;
      totalLatency += result.latencyMs;
      onProgress(`done (score: ${(result.score * 100).toFixed(1)}%)\n`);
    } catch (error) {
      onProgress(`FAILED: ${String(error)}\n`);
      results.push({
        name: bench.name,
        score: 0,
        latencyMs: 0,
        details: { error: String(error) },
      });
    }
  }

  const suite: BenchmarkSuite = {
    name: "Memorai Custom Suite",
    results,
    totalScore: totalScore / BENCHMARKS.length,
    totalLatencyMs: totalLatency,
    runAt: new Date().toISOString(),
  };

  const dir = resolve(process.cwd(), outDir);
  await mkdir(dir, { recursive: true });
  const ts = suite.runAt.replace(/[:.]/g, "-");
  const base = `custom-memorai-${ts}`;
  const mdPath = resolve(dir, `${base}.md`);
  const jsonPath = resolve(dir, `${base}.json`);
  await writeFile(mdPath, formatCustomMarkdown(suite));
  await writeFile(jsonPath, JSON.stringify(suite, null, 2));

  onProgress(`\nResults saved to: ${mdPath}\n`);
  onProgress(`JSON saved to:    ${jsonPath}\n`);

  return suite;
}
