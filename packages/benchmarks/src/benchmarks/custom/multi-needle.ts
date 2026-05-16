import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { generateHaystack, generateNeedles } from "./data.js";
import { ollamaEmbed } from "../../core/llm/ollama.js";
import { needleInTopK, type BenchmarkResult } from "../../core/metrics.js";

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

    for (const h of haystack) {
      await memory.write(h);
    }

    for (const needle of needles) {
      await memory.write(needle);
    }

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

      const needleEmb = await ollamaEmbed(needle.payload.summary);
      const retrievedEmb = await Promise.all(
        result.nodes.map((n) => ollamaEmbed(n.payload.summary)),
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

    details[`needles=${needleCount}`] =
      `recall=${score.toFixed(2)}, avg_rank=${(totalRank / needleCount).toFixed(1)}, avg_sim=${(totalSim / needleCount).toFixed(3)}`;

    await memory.close();
  }

  return {
    name: "Multi-Needle Retrieval",
    score: scores.reduce((a, b) => a + b, 0) / scores.length,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details,
  };
}
