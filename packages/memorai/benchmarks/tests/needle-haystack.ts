// Needle-in-a-Haystack benchmark for memory retrieval
// Tests: can we retrieve a specific memory from a large corpus?

import { Memorai, MemoryAdapter } from "../../src/index.js";
import { OllamaEmbeddingService } from "../../src/embeddings/ollama.js";
import { generateHaystack, generateNeedles } from "../lib/data.js";
import { embed } from "../lib/llm.js";
import { needleInTopK, type BenchmarkResult } from "../lib/metrics.js";

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

    // Write haystack
    for (const h of haystack) {
      await memory.write(h);
    }

    // Write needle
    const needleNode = await memory.write(needle);

    // Retrieve
    const start = performance.now();
    const result = await memory.retrieve({
      text: needle.query,
      strategy: "factual",
      topK: TOP_K,
      earlyStop: false,
    });
    const latency = performance.now() - start;
    latencies.push(latency);

    // Score using embeddings
    const needleEmb = await embed(needle.payload.summary);
    const retrievedEmb = await Promise.all(
      result.nodes.map((n) => embed(n.payload.summary)),
    );
    const { found, rank, similarity } = needleInTopK(
      needleEmb,
      retrievedEmb,
      THRESHOLD,
    );

    const score = found ? 1 : similarity / THRESHOLD;
    scores.push(score);

    details[`n=${corpusSize}`] = `score=${score.toFixed(2)}, rank=${rank}, sim=${similarity.toFixed(3)}`;

    // Clean up for next iteration
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
