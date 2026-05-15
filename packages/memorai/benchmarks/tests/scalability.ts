// Scalability benchmark
// Tests: performance at different corpus sizes

import { Memorai, MemoryAdapter } from "../../src/index.js";
import { OllamaEmbeddingService } from "../../src/embeddings/ollama.js";
import { generateHaystack, generateNeedles } from "../lib/data.js";
import { type BenchmarkResult } from "../lib/metrics.js";

const CORPUS_SIZES = [50, 100, 250, 500, 1000];

export async function runScalabilityBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
    batchSize: 16,
  });

  const seqWriteLatencies: number[] = [];
  const batchWriteLatencies: number[] = [];
  const retrieveLatencies: number[] = [];
  const details: Record<string, number | string> = {};

  for (const corpusSize of CORPUS_SIZES) {
    const storage = new MemoryAdapter();
    const memory = new Memorai({ storage, embedding });

    const haystack = generateHaystack(corpusSize);
    const needles = generateNeedles(1);

    // Measure sequential write throughput
    const seqStart = performance.now();
    for (const h of haystack.slice(0, 10)) {
      await memory.write(h);
    }
    const seqMs = performance.now() - seqStart;
    const seqPerItem = seqMs / 10;
    seqWriteLatencies.push(seqPerItem);

    // Measure batch write throughput (rest of corpus)
    const batchStart = performance.now();
    await memory.writeBatch(haystack.slice(10));
    const batchMs = performance.now() - batchStart;
    const batchPerItem = batchMs / (corpusSize - 10);
    batchWriteLatencies.push(batchPerItem);

    // Measure retrieval latency
    const retrieveStart = performance.now();
    await memory.retrieve({
      text: needles[0].query,
      strategy: "factual",
      topK: 5,
      earlyStop: false,
    });
    const retrieveMs = performance.now() - retrieveStart;
    retrieveLatencies.push(retrieveMs);

    details[`n=${corpusSize}_seq_write_ms/item`] = seqPerItem;
    details[`n=${corpusSize}_batch_write_ms/item`] = batchPerItem;
    details[`n=${corpusSize}_retrieve_ms`] = retrieveMs;
    details[`n=${corpusSize}_speedup`] = (seqPerItem / batchPerItem).toFixed(2) + "x";

    await memory.close();
  }

  const maxRetrieveMs = retrieveLatencies[retrieveLatencies.length - 1];
  const score = maxRetrieveMs < 500 ? 1 : Math.max(0, 1 - (maxRetrieveMs - 500) / 2000);

  return {
    name: "Scalability",
    score,
    latencyMs: retrieveLatencies.reduce((a, b) => a + b, 0) / retrieveLatencies.length,
    details: {
      ...details,
      avg_batch_speedup:
        seqWriteLatencies.reduce((a, b, i) => a + b / batchWriteLatencies[i], 0) /
        seqWriteLatencies.length,
    },
  };
}
