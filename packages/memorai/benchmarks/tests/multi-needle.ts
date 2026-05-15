// Multi-Needle Retrieval benchmark
// Tests: can we retrieve multiple specific memories from a corpus?

import { Memorai, MemoryAdapter } from "../../src/index.js";
import { OllamaEmbeddingService } from "../../src/embeddings/ollama.js";
import { generateHaystack, generateNeedles } from "../lib/data.js";
import { embed } from "../lib/llm.js";
import { needleInTopK, type BenchmarkResult } from "../lib/metrics.js";

const CORPUS_SIZE = 100;
const NEEDLE_COUNTS = [1, 3, 5];
const TOP_K = 10;
const THRESHOLD = 0.72;

export async function runMultiNeedleBenchmark(): Promise<BenchmarkResult> {
  const scores: number[] = [];
  const latencies: number[] = [];
  const details: Record<string, number | string> = {};

  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });

  for (const needleCount of NEEDLE_COUNTS) {
    const storage = new MemoryAdapter();
    const memory = new Memorai({ storage, embedding });

    const haystack = generateHaystack(CORPUS_SIZE);
    const needles = generateNeedles(needleCount);

    // Write haystack
    for (const h of haystack) {
      await memory.write(h);
    }

    // Write needles
    const needleNodes = [];
    for (const needle of needles) {
      needleNodes.push(await memory.write(needle));
    }

    // Test each needle
    let foundCount = 0;
    let totalRank = 0;
    let totalSim = 0;

    for (const needle of needles) {
      const start = performance.now();
      const result = await memory.retrieve({
        text: needle.query,
        strategy: "factual",
        topK: TOP_K,
        earlyStop: false,
      });
      const latency = performance.now() - start;
      latencies.push(latency);

      const needleEmb = await embed(needle.payload.summary);
      const retrievedEmb = await Promise.all(
        result.nodes.map((n) => embed(n.payload.summary)),
      );
      const { found, rank, similarity } = needleInTopK(
        needleEmb,
        retrievedEmb,
        THRESHOLD,
      );

      if (found) foundCount++;
      totalRank += rank >= 0 ? rank : TOP_K;
      totalSim += similarity;
    }

    const score = foundCount / needleCount;
    scores.push(score);

    details[
      `needles=${needleCount}`
    ] = `recall=${score.toFixed(2)}, avg_rank=${(totalRank / needleCount).toFixed(1)}, avg_sim=${(totalSim / needleCount).toFixed(3)}`;

    await memory.close();
  }

  return {
    name: "Multi-Needle Retrieval",
    score: scores.reduce((a, b) => a + b, 0) / scores.length,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details,
  };
}
