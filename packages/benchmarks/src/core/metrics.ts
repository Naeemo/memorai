import { cosineSimilarity } from "memorai";
import type {
  CategoryStats,
  RunRecord,
  RunResult,
} from "./types.js";

// ============================================================
// Custom-suite types (kept verbatim from the previous benchmark
// suite so existing tests still pass).
// ============================================================

export interface BenchmarkResult {
  name: string;
  score: number;
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

export function multiNeedleRecall(
  needleIds: string[],
  retrievedIds: string[],
): number {
  const found = needleIds.filter((id) => retrievedIds.includes(id));
  return found.length / needleIds.length;
}

export function retrievalPrecision(
  relevantIds: string[],
  retrievedIds: string[],
): number {
  if (retrievedIds.length === 0) return 0;
  const found = retrievedIds.filter((id) => relevantIds.includes(id));
  return found.length / retrievedIds.length;
}

export function formatCustomMarkdown(suite: BenchmarkSuite): string {
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

// ============================================================
// Public-suite metrics (LoCoMo / LongMemEval / ConvoMem).
// LLM-as-judge accuracy is primary. F1 and BLEU-1 are auxiliary
// per the LoCoMo paper's reporting convention.
// ============================================================

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function f1Score(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;

  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);

  let common = 0;
  for (const t of predTokens) {
    const c = goldCounts.get(t);
    if (c && c > 0) {
      common += 1;
      goldCounts.set(t, c - 1);
    }
  }
  if (common === 0) return 0;

  const precision = common / predTokens.length;
  const recall = common / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

export function bleu1(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;

  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);

  let matched = 0;
  for (const t of predTokens) {
    const c = goldCounts.get(t);
    if (c && c > 0) {
      matched += 1;
      goldCounts.set(t, c - 1);
    }
  }
  const precision = matched / predTokens.length;
  const bp = predTokens.length >= goldTokens.length
    ? 1
    : Math.exp(1 - goldTokens.length / predTokens.length);
  return bp * precision;
}

export function aggregateByCategory(records: RunRecord[]): CategoryStats[] {
  const buckets = new Map<string, RunRecord[]>();
  for (const r of records) {
    const cat = r.qa.category ?? "all";
    const list = buckets.get(cat);
    if (list) {
      list.push(r);
    } else {
      buckets.set(cat, [r]);
    }
  }
  const result: CategoryStats[] = [];
  for (const [category, rs] of buckets) {
    const correct = rs.filter((r) => r.judgeLabel === "CORRECT").length;
    const f1 =
      rs.reduce((a, r) => a + f1Score(r.predicted, r.qa.gold), 0) / rs.length;
    const bleu =
      rs.reduce((a, r) => a + bleu1(r.predicted, r.qa.gold), 0) / rs.length;
    result.push({
      category,
      count: rs.length,
      correct,
      accuracy: correct / rs.length,
      f1,
      bleu1: bleu,
    });
  }
  result.sort((a, b) => a.category.localeCompare(b.category));
  return result;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

export function formatPublicMarkdown(r: RunResult): string {
  const lines: string[] = [];
  lines.push(`# ${r.suite} — ${r.provider}`);
  lines.push("");
  lines.push(`**Run at:** ${r.runAt}`);
  lines.push(`**Duration:** ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`**Provider:** ${r.provider}`);
  lines.push(`**Ingest mode:** ${r.ingestMode}`);
  lines.push(`**Embedder:** ${r.embedder}`);
  lines.push(`**Answerer model:** ${r.answererModel}`);
  lines.push(`**Judge model:** ${r.judgeModel}`);
  lines.push("");
  lines.push(`**Conversations:** ${r.conversations}`);
  lines.push(`**Total QAs:** ${r.totalQas}`);
  lines.push(`**Correct:** ${r.correct}`);
  lines.push(`**Accuracy:** ${(r.accuracy * 100).toFixed(2)}%`);
  lines.push(`**Avg latency:** ${r.avgLatencyMs.toFixed(1)}ms`);
  lines.push(`**P95 latency:** ${r.p95LatencyMs.toFixed(1)}ms`);
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| Category | Count | Correct | Accuracy | F1 | BLEU-1 |");
  lines.push("|----------|-------|---------|----------|-----|--------|");
  for (const c of r.byCategory) {
    lines.push(
      `| ${c.category} | ${c.count} | ${c.correct} | ${(c.accuracy * 100).toFixed(1)}% | ${c.f1.toFixed(3)} | ${c.bleu1.toFixed(3)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
