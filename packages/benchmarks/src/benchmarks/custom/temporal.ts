import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { generateTemporalMemories } from "./data.js";
import { type BenchmarkResult } from "../../core/metrics.js";

const MEMORY_COUNT = 60;
const TIME_SPAN_HOURS = 24;
const QUERIES = 5;

export async function runTemporalBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });
  const storage = new MemoryAdapter();
  const memory = new Memorai({ storage, embedding });

  const memories = generateTemporalMemories(MEMORY_COUNT, TIME_SPAN_HOURS);

  for (const m of memories) {
    await memory.write({
      raw: m.raw,
      annotations: m.annotations,
      timestamp: m.timestamp,
      meta: m.meta,
    });
  }

  const scores: number[] = [];
  const latencies: number[] = [];

  const spanMs = TIME_SPAN_HOURS * 60 * 60 * 1000;
  const startTime = Date.now() - spanMs;

  for (let q = 0; q < QUERIES; q++) {
    const windowSize = spanMs / 6;
    const windowStart = startTime + Math.random() * (spanMs - windowSize);
    const windowEnd = windowStart + windowSize;

    const expected = memories.filter(
      (m) => m.expectedTime >= windowStart && m.expectedTime <= windowEnd,
    );

    const queryStart = performance.now();
    const result = await memory.retrieve({
      text: "activities during this time period",
      strategy: "temporal",
      timeRange: { start: windowStart, end: windowEnd },
      topK: expected.length + 5,
      traversalOrder: "forward",
      earlyStop: false,
    });
    const latency = performance.now() - queryStart;
    latencies.push(latency);

    const retrievedInRange = result.nodes.filter(
      (n) => n.timestamp >= windowStart && n.timestamp <= windowEnd,
    );

    const recall =
      expected.length > 0 ? retrievedInRange.length / expected.length : 1;
    scores.push(Math.min(1, recall));
  }

  await memory.close();

  return {
    name: "Temporal Retrieval",
    score: scores.reduce((a, b) => a + b, 0) / scores.length,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details: {
      memory_count: MEMORY_COUNT,
      queries: QUERIES,
      avg_recall: scores.reduce((a, b) => a + b, 0) / scores.length,
    },
  };
}
