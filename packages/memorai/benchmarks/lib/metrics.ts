// Benchmark metrics and scoring utilities

import { cosineSimilarity } from "../../src/utils.js";

export interface BenchmarkResult {
  name: string;
  score: number; // 0-1
  latencyMs: number;
  details: Record<string, number | string>;
}

export interface BenchmarkSuite {
  name: string;
  results: BenchmarkResult[];
  totalScore: number;
  totalLatencyMs: number;
  runAt: string;
}

/**
 * Check if a needle is present in the top-K retrieved results.
 * Uses embedding cosine similarity between the needle summary and retrieved summaries.
 */
export function needleInTopK(
  needleEmbedding: number[],
  retrievedEmbeddings: number[][],
  threshold = 0.75,
): { found: boolean; rank: number; similarity: number } {
  let bestRank = -1;
  let bestSim = 0;

  for (const [i, emb] of retrievedEmbeddings.entries()) {
    const sim = cosineSimilarity(needleEmbedding, emb);
    if (sim > bestSim) {
      bestSim = sim;
      bestRank = i;
    }
  }

  return { found: bestSim >= threshold, rank: bestRank, similarity: bestSim };
}

/**
 * Compute recall for multi-needle retrieval.
 */
export function multiNeedleRecall(
  needleIds: string[],
  retrievedIds: string[],
): number {
  const found = needleIds.filter((id) => retrievedIds.includes(id));
  return found.length / needleIds.length;
}

/**
 * Compute precision for retrieval.
 */
export function retrievalPrecision(
  relevantIds: string[],
  retrievedIds: string[],
): number {
  if (retrievedIds.length === 0) return 0;
  const found = retrievedIds.filter((id) => relevantIds.includes(id));
  return found.length / retrievedIds.length;
}

/**
 * Format benchmark results as markdown.
 */
export function formatResultsMarkdown(suite: BenchmarkSuite): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Results: ${suite.name}`);
  lines.push("");
  lines.push(`**Run at:** ${suite.runAt}`);
  lines.push(`**Overall Score:** ${(suite.totalScore * 100).toFixed(1)}%`);
  lines.push(`**Total Latency:** ${suite.totalLatencyMs.toFixed(0)}ms`);
  lines.push("");
  lines.push("| Benchmark | Score | Latency | Details |");
  lines.push("|-----------|-------|---------|---------|");

  for (const r of suite.results) {
    const detailStr = Object.entries(r.details)
      .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(3) : v}`)
      .join(", ");
    lines.push(
      `| ${r.name} | ${(r.score * 100).toFixed(1)}% | ${r.latencyMs.toFixed(0)}ms | ${detailStr} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
