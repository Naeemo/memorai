import type { Turn } from "./types.js";

export type IngestMode = "wrap" | "extract" | "paired";

export interface IngestOptions {
  userId: string;
  sessionId?: string;
  evolve?: boolean;
}

export interface QueryOptions {
  userId: string;
  topK?: number;
}

export interface MemoryHit {
  content: string;
  score?: number;
  timestampMs?: number;
  meta?: Record<string, unknown>;
}

export interface MemoryProvider {
  readonly name: string;
  init(): Promise<void>;
  ingestTurns(turns: Turn[], opts: IngestOptions): Promise<void>;
  query(question: string, opts: QueryOptions): Promise<MemoryHit[]>;
  resetUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderConfig {
  ingestMode: IngestMode;
  embedder: "ollama" | "openai";
}
