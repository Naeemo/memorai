#!/usr/bin/env tsx
// Memorai Benchmark Suite
// Run with: pnpm exec tsx benchmarks/index.ts

import { runNeedleHaystackBenchmark } from "./tests/needle-haystack.js";
import { runMultiNeedleBenchmark } from "./tests/multi-needle.js";
import { runEvolutionBenchmark } from "./tests/evolution.js";
import { runTemporalBenchmark } from "./tests/temporal.js";
import { runScalabilityBenchmark } from "./tests/scalability.js";
import { runCrossAgentBenchmark } from "./tests/cross-agent.js";
import {
  formatResultsMarkdown,
  type BenchmarkResult,
  type BenchmarkSuite,
} from "./lib/metrics.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BENCHMARKS = [
  runNeedleHaystackBenchmark,
  runMultiNeedleBenchmark,
  runEvolutionBenchmark,
  runTemporalBenchmark,
  runScalabilityBenchmark,
  runCrossAgentBenchmark,
];

async function main(): Promise<void> {
  console.log("=== Memorai Benchmark Suite ===\n");
  console.log(`Using Ollama at: ${process.env.OLLAMA_HOST ?? "http://localhost:11434"}`);
  console.log("Embedding model: nomic-embed-text");
  console.log("Judge model: gemma4:31b-cloud\n");
  console.log("This may take several minutes...\n");

  const results: BenchmarkResult[] = [];
  let totalScore = 0;
  let totalLatency = 0;

  for (const bench of BENCHMARKS) {
    const name = bench.name.replace("run", "").replace("Benchmark", "");
    process.stdout.write(`Running ${name}... `);
    try {
      const result = await bench();
      results.push(result);
      totalScore += result.score;
      totalLatency += result.latencyMs;
      console.log(`done (score: ${(result.score * 100).toFixed(1)}%)`);
    } catch (error) {
      console.log(`FAILED: ${error}`);
      results.push({
        name: bench.name,
        score: 0,
        latencyMs: 0,
        details: { error: String(error) },
      });
    }
  }

  const suite: BenchmarkSuite = {
    name: "Memorai v0.0.0",
    results,
    totalScore: totalScore / BENCHMARKS.length,
    totalLatencyMs: totalLatency,
    runAt: new Date().toISOString(),
  };

  console.log("\n=== Results ===\n");
  console.log(formatResultsMarkdown(suite));

  // Save to file
  const outDir = resolve(process.cwd(), "benchmarks", "results");
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(outDir, { recursive: true }),
  );

  const outFile = resolve(
    outDir,
    `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
  );
  writeFileSync(outFile, formatResultsMarkdown(suite));
  console.log(`Results saved to: ${outFile}`);

  // Also save as JSON
  const jsonFile = outFile.replace(".md", ".json");
  writeFileSync(jsonFile, JSON.stringify(suite, null, 2));
  console.log(`JSON saved to: ${jsonFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
