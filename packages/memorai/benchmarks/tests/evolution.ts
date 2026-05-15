// Hierarchical Memory Evolution benchmark
// Tests: does STM -> LTM evolution preserve retrievability?

import { Memorai, MemoryAdapter } from "../../src/index.js";
import { OllamaEmbeddingService } from "../../src/embeddings/ollama.js";
import { generateHaystack, generateNeedles } from "../lib/data.js";
import { embed } from "../lib/llm.js";
import { needleInTopK, type BenchmarkResult } from "../lib/metrics.js";

const CORPUS_SIZE = 80;
const NEEDLE_COUNT = 3;
const TOP_K = 5;
const THRESHOLD = 0.7;

export async function runEvolutionBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });
  const storage = new MemoryAdapter();
  const memory = new Memorai({
    storage,
    embedding,
    evolution: {
      semanticMergeThreshold: 0.82,
      temporalGapThresholdMs: 60000,
      sceneSimilarityThreshold: 0.78,
      eventTimeWindowMs: 300000,
      autoEvolveIntervalMs: 0, // manual
      stmMaxSize: 50,
    },
  });

  const haystack = generateHaystack(CORPUS_SIZE);
  const needles = generateNeedles(NEEDLE_COUNT);

  // Write all memories
  for (const h of haystack) {
    await memory.write(h);
  }
  const needleNodes = [];
  for (const needle of needles) {
    needleNodes.push(await memory.write(needle));
  }

  // Baseline retrieval (before evolution)
  const baselineScores: number[] = [];
  const baselineLatencies: number[] = [];

  for (const needle of needles) {
    const start = performance.now();
    const result = await memory.retrieve({
      text: needle.query,
      strategy: "factual",
      topK: TOP_K,
      level: "segment",
      earlyStop: false,
    });
    baselineLatencies.push(performance.now() - start);

    const needleEmb = await embed(needle.payload.summary);
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) => embed(n.payload.summary)),
    );
    const { found, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );
    baselineScores.push(found ? 1 : similarity / THRESHOLD);
  }

  // Trigger evolution
  const evolveStart = performance.now();
  await memory.evolve();
  const evolveLatency = performance.now() - evolveStart;

  // Post-evolution retrieval (at event level)
  const evolvedScores: number[] = [];
  const evolvedLatencies: number[] = [];

  for (const needle of needles) {
    const start = performance.now();
    const result = await memory.retrieve({
      text: needle.query,
      strategy: "factual",
      topK: TOP_K,
      level: "event",
      earlyStop: false,
    });
    evolvedLatencies.push(performance.now() - start);

    const needleEmb = await embed(needle.payload.summary);
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) => embed(n.payload.summary)),
    );
    const { found, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );
    evolvedScores.push(found ? 1 : similarity / THRESHOLD);
  }

  // Compute preservation ratio: how much of the baseline score is retained
  let preservationSum = 0;
  for (let i = 0; i < NEEDLE_COUNT; i++) {
    preservationSum +=
      baselineScores[i] > 0 ? evolvedScores[i] / baselineScores[i] : 1;
  }
  const preservationRatio = preservationSum / NEEDLE_COUNT;

  await memory.close();

  return {
    name: "Hierarchical Evolution Preservation",
    score: Math.min(1, preservationRatio),
    latencyMs:
      evolveLatency +
      evolvedLatencies.reduce((a, b) => a + b, 0) / evolvedLatencies.length,
    details: {
      baseline_score: baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length,
      evolved_score: evolvedScores.reduce((a, b) => a + b, 0) / evolvedScores.length,
      preservation_ratio: preservationRatio,
      evolve_ms: evolveLatency,
      baseline_latency_ms: baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length,
    },
  };
}
