import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { generateHaystack, generateNeedles } from "./data.js";
import { ollamaEmbed } from "../../core/llm/ollama.js";
import { needleInTopK, type BenchmarkResult } from "../../core/metrics.js";

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
      episodeTimeWindowMs: 300000,
      mode: "manual",
      stmMaxSize: 50,
    },
  });

  const haystack = generateHaystack(CORPUS_SIZE);
  const needles = generateNeedles(NEEDLE_COUNT);

  for (const h of haystack) {
    await memory.write(h);
  }
  for (const needle of needles) {
    await memory.write(needle);
  }

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

    const needleEmb = await ollamaEmbed(
      needle.annotations?.summary ?? needle.raw.text ?? "",
    );
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) =>
        ollamaEmbed(n.annotations.summary ?? n.raw.text ?? ""),
      ),
    );
    const { found, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );
    baselineScores.push(found ? 1 : similarity / THRESHOLD);
  }

  const evolveStart = performance.now();
  await memory.evolve();
  const evolveLatency = performance.now() - evolveStart;

  const evolvedScores: number[] = [];
  const evolvedLatencies: number[] = [];

  for (const needle of needles) {
    const start = performance.now();
    const result = await memory.retrieve({
      text: needle.query,
      strategy: "factual",
      topK: TOP_K,
      level: "episode",
      earlyStop: false,
    });
    evolvedLatencies.push(performance.now() - start);

    const needleEmb = await ollamaEmbed(
      needle.annotations?.summary ?? needle.raw.text ?? "",
    );
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) =>
        ollamaEmbed(n.annotations.summary ?? n.raw.text ?? ""),
      ),
    );
    const { found, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );
    evolvedScores.push(found ? 1 : similarity / THRESHOLD);
  }

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
      baseline_latency_ms:
        baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length,
    },
  };
}
