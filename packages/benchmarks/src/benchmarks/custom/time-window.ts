// Time-window benchmark — Memorai-specific
// Tests: recallByTime accuracy across a 24-hour span of evenly-distributed events.

import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { type BenchmarkResult } from "../../core/metrics.js";

const EVENT_COUNT = 60;
const TIME_SPAN_HOURS = 24;
const WINDOW_QUERIES = 8;
const WINDOW_FRACTION = 1 / 6; // 4-hour windows on a 24-hour span

const TEMPLATES = [
  "user ran a database migration",
  "user reviewed pull request",
  "user joined the standup meeting",
  "user updated the deployment configuration",
  "user investigated the memory leak",
  "user merged a feature branch",
  "user wrote documentation for the API",
  "user fixed a flaky test",
  "user paired with a colleague on debugging",
  "user benchmarked the cache layer",
];

export async function runTimeWindowBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });
  const memory = new Memorai({
    storage: new MemoryAdapter(),
    embedding,
    evolution: { mode: "manual" },
  });

  const spanMs = TIME_SPAN_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const windowSize = spanMs * WINDOW_FRACTION;

  // Ingest evenly-spaced events.
  const eventTimes: number[] = [];
  for (let i = 0; i < EVENT_COUNT; i++) {
    const at = now - spanMs + Math.floor((i / EVENT_COUNT) * spanMs);
    eventTimes.push(at);
    await memory.recordEvent({
      at,
      actor: "user",
      content: { kind: "observation", text: TEMPLATES[i % TEMPLATES.length] + ` (#${i})` },
    }).nodes;
  }
  await memory.evolve();

  let recallSum = 0;
  let precisionSum = 0;
  const latencies: number[] = [];

  for (let q = 0; q < WINDOW_QUERIES; q++) {
    const windowStart = now - spanMs + Math.random() * (spanMs - windowSize);
    const windowEnd = windowStart + windowSize;
    const expected = eventTimes.filter((t) => t >= windowStart && t <= windowEnd);
    const expectedCount = expected.length;
    if (expectedCount === 0) continue; // skip degenerate window

    const start = performance.now();
    const result = await memory.recallByTime(
      { start: windowStart, end: windowEnd },
      { topK: Math.max(expectedCount + 5, 10) },
    );
    latencies.push(performance.now() - start);

    // Count how many of the recalled memories actually fall within the window.
    // recallByTime should return ONLY in-window events when the storage layer
    // honours the timeRange filter end-to-end.
    const inWindow = result.memories.filter(
      (m) => m.at >= windowStart && m.at <= windowEnd,
    );
    const recall = inWindow.length / expectedCount; // how many in-window we returned, vs how many existed
    const precision = result.memories.length > 0
      ? inWindow.length / result.memories.length
      : 0;
    recallSum += recall;
    precisionSum += precision;
  }

  await memory.close();

  const avgRecall = recallSum / WINDOW_QUERIES;
  const avgPrecision = precisionSum / WINDOW_QUERIES;
  // F1 of (recall, precision) at the window level
  const f1 =
    avgRecall + avgPrecision > 0
      ? (2 * avgRecall * avgPrecision) / (avgRecall + avgPrecision)
      : 0;

  return {
    name: "Time-Window Recall",
    score: f1,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details: {
      events: EVENT_COUNT,
      windows: WINDOW_QUERIES,
      span_hours: TIME_SPAN_HOURS,
      avg_recall: avgRecall,
      avg_precision: avgPrecision,
    },
  };
}
