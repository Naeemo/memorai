/** Shared types for the Memorai evaluation harness. */

export interface EvalTurn {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number;
}

export interface EvalQA {
  id: string;
  question: string;
  gold: string;
  category?: string;
}

export interface EvalConversation {
  id: string;
  sessions: EvalTurn[][];
  qas: EvalQA[];
  meta?: Record<string, unknown>;
}

export interface EvalRunRecord {
  qa: EvalQA;
  hits: { content: string; score?: number }[];
  predicted: string;
  judgeLabel: "CORRECT" | "INCORRECT";
  latencyMs: number;
  hitCount: number;
}

export interface EvalCategoryStats {
  category: string;
  count: number;
  correct: number;
  accuracy: number;
  f1: number;
  bleu1: number;
}

export interface EvalRunResult {
  suite: string;
  provider: string;
  ingestMode: string;
  answererModel: string;
  judgeModel: string;
  embedder: string;
  conversations: number;
  totalQas: number;
  correct: number;
  accuracy: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byCategory: EvalCategoryStats[];
  records: EvalRunRecord[];
  runAt: string;
  durationMs: number;
}
