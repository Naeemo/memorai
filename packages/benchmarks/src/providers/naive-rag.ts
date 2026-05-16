import {
  OllamaEmbeddingService,
  OpenAIEmbeddingService,
  cosineSimilarity,
  type EmbeddingService,
} from "memorai";
import type {
  IngestOptions,
  MemoryHit,
  MemoryProvider,
  QueryOptions,
} from "../core/provider.js";
import type { Turn } from "../core/types.js";

interface Entry {
  content: string;
  embedding: number[];
  timestampMs?: number;
  role: "user" | "assistant";
}

export interface NaiveRagProviderOptions {
  embedder: "ollama" | "openai";
  ollamaModel?: string;
  ollamaDim?: number;
  openaiModel?: string;
  openaiDim?: number;
  // Injection hook for tests — bypasses makeEmbedder().
  embedderInstance?: EmbeddingService;
}

function makeEmbedder(opts: NaiveRagProviderOptions): EmbeddingService {
  if (opts.embedder === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required for --embedder=openai");
    return new OpenAIEmbeddingService({
      apiKey,
      model: opts.openaiModel ?? "text-embedding-3-small",
      dimension: opts.openaiDim ?? 1536,
    });
  }
  return new OllamaEmbeddingService({
    model: opts.ollamaModel ?? "nomic-embed-text",
    dimension: opts.ollamaDim ?? 768,
  });
}

export class NaiveRagProvider implements MemoryProvider {
  readonly name = "naive-rag";
  private readonly opts: NaiveRagProviderOptions;
  private embedder!: EmbeddingService;
  private stores = new Map<string, Entry[]>();

  constructor(opts: NaiveRagProviderOptions) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    this.embedder = this.opts.embedderInstance ?? makeEmbedder(this.opts);
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    if (this.embedder.embedBatch) {
      return this.embedder.embedBatch(texts);
    }
    return Promise.all(texts.map((t) => this.embedder.embed(t)));
  }

  async ingestTurns(turns: Turn[], opts: IngestOptions): Promise<void> {
    const store = this.stores.get(opts.userId) ?? [];
    const embeddings = await this.embedTexts(turns.map((t) => t.content));
    for (const [i, t] of turns.entries()) {
      store.push({
        content: t.content,
        embedding: embeddings[i],
        timestampMs: t.timestampMs,
        role: t.role,
      });
    }
    this.stores.set(opts.userId, store);
  }

  async query(question: string, opts: QueryOptions): Promise<MemoryHit[]> {
    const store = this.stores.get(opts.userId);
    if (!store || store.length === 0) return [];
    const qEmb = await this.embedder.embed(question);
    const scored = store.map((e) => ({
      content: e.content,
      score: cosineSimilarity(qEmb, e.embedding),
      timestampMs: e.timestampMs,
    }));
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored.slice(0, opts.topK ?? 30);
  }

  async resetUser(userId: string): Promise<void> {
    this.stores.delete(userId);
  }

  async close(): Promise<void> {
    this.stores.clear();
  }
}
