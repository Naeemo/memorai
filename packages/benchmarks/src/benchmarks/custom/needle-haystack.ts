import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { generateHaystack, generateNeedles } from "./data.js";
import { ollamaEmbed } from "../../core/llm/ollama.js";
import { needleInTopK, type BenchmarkResult } from "../../core/metrics.js";

const CORPUS_SIZES = [10, 50, 100, 250];
const TOP_K = 5;
const THRESHOLD = 0.72;

export async function runNeedleHaystackBenchmark(): Promise<BenchmarkResult> {
  const scores: number[] = [];
  const latencies: number[] = [];
  const details: Record<string, number | string> = {};

  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });
  const storage = new MemoryAdapter();
  const memory = new Memorai({ storage, embedding });

  for (const corpusSize of CORPUS_SIZES) {
    const haystack = generateHaystack(corpusSize);
    const needles = generateNeedles(1);
    const needle = needles[0];

    for (const h of haystack) {
      await memory.write(h);
    }

    await memory.write(needle);

    const start = performance.now();
    const result = await memory.retrieve({
      text: needle.query,
      strategy: "factual",
      topK: TOP_K,
      earlyStop: false,
    });
    const latency = performance.now() - start;
    latencies.push(latency);

    const needleEmb = await ollamaEmbed(needle.payload.summary);
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) => ollamaEmbed(n.payload.summary)),
    );
    const { found, rank, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );

    const score = found ? 1 : similarity / THRESHOLD;
    scores.push(score);

    details[`n=${corpusSize}`] =
      `score=${score.toFixed(2)}, rank=${rank}, sim=${similarity.toFixed(3)}`;

    await storage.close();
  }

  await memory.close();

  return {
    name: "Needle-in-a-Haystack",
    score: scores.reduce((a, b) => a + b, 0) / scores.length,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details,
  };
}
