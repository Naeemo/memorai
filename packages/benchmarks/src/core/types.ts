export interface Turn {
  role: "user" | "assistant";
  content: string;
  timestampMs?: number;
}

export interface QA {
  id: string;
  question: string;
  gold: string;
  category?: string;
}

export interface Conversation {
  id: string;
  sessions: Turn[][];
  qas: QA[];
  meta?: Record<string, unknown>;
}

export interface RunRecord {
  qa: QA;
  hits: { content: string; score?: number }[];
  predicted: string;
  judgeLabel: "CORRECT" | "INCORRECT";
  latencyMs: number;
  hitCount: number;
}

export interface CategoryStats {
  category: string;
  count: number;
  correct: number;
  accuracy: number;
  f1: number;
  bleu1: number;
}

export interface RunResult {
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
  byCategory: CategoryStats[];
  records: RunRecord[];
  runAt: string;
  durationMs: number;
}
