import {
  LLMExtractor,
  LLMReranker,
  Memorai,
  MemoryAdapter,
  OllamaEmbeddingService,
  OpenAIEmbeddingService,
  WrapExtractor,
  type EmbeddingService,
  type Event,
  type EventContent,
  type Extractor,
  type LLMService,
  type RerankerService,
} from "memorai";
import type {
  IngestOptions,
  IngestMode,
  MemoryHit,
  MemoryProvider,
  QueryOptions,
} from "../core/provider.js";
import type { Turn } from "../core/types.js";
import { ollamaGenerate } from "../core/llm/ollama.js";

export interface MemoraiProviderOptions {
  ingestMode: IngestMode;
  /** "wrap" → WrapExtractor (no LLM); "llm" → LLMExtractor wired to Ollama. */
  extractor?: "wrap" | "llm";
  /** Ollama model used for LLM extraction (separate from the bench answerer). */
  extractorModel?: string;
  /** Ollama model to use for answer generation in benchmark QA loop. */
  answererModel?: string;
  /** "llm" → wire LLMReranker over the configured LLM; "none" → off. */
  reranker?: "llm" | "none";
  /** Ollama model for the reranker (defaults to the answerer model). */
  rerankerModel?: string;
  /** Number of paraphrase variants to generate at recall time. */
  queryExpansion?: number;
  /** Enable HyDE — generate hypothetical answer and use its embedding. */
  hyde?: boolean;
  embedder: "ollama" | "openai";
  ollamaModel?: string;
  ollamaDim?: number;
  openaiModel?: string;
  openaiDim?: number;
}

function makeEmbedder(opts: MemoraiProviderOptions): EmbeddingService {
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

function makeOllamaLLMService(model: string): LLMService {
  return {
    complete: (prompt, opts) =>
      ollamaGenerate(prompt, model, {
        temperature: opts?.temperature,
        maxTokens: opts?.maxTokens,
      }),
  };
}

function pickExtractor(opts: MemoraiProviderOptions): Extractor {
  if (opts.extractor === "llm") {
    const model =
      opts.extractorModel ??
      process.env.EXTRACTOR_MODEL ??
      opts.answererModel ??
      process.env.ANSWERER_MODEL ??
      "gemma4:e2b";
    return new LLMExtractor({ llm: makeOllamaLLMService(model) });
  }
  return new WrapExtractor();
}

function pickReranker(opts: MemoraiProviderOptions): RerankerService | undefined {
  if (opts.reranker !== "llm") return undefined;
  const model =
    opts.rerankerModel ??
    process.env.RERANKER_MODEL ??
    opts.answererModel ??
    process.env.ANSWERER_MODEL ??
    "gemma4:31b-cloud";
  return new LLMReranker({ llm: makeOllamaLLMService(model) });
}

function pickRecallLLM(opts: MemoraiProviderOptions): LLMService | undefined {
  // The query-expansion / HyDE path needs an LLM. Reuse the answerer
  // model unless an explicit override is set via env.
  if (!opts.queryExpansion && !opts.hyde) return undefined;
  const model =
    opts.answererModel ?? process.env.ANSWERER_MODEL ?? "gemma4:31b-cloud";
  return makeOllamaLLMService(model);
}

/**
 * Memorai benchmark provider. Routes all benchmark conversations through a
 * single Memorai instance, scoping each conversation by userId.
 *
 * Default extractor is WrapExtractor (no LLM) — measures Memorai's storage +
 * retrieval + evolution layer in isolation. Switch with `--extractor llm` to
 * benchmark the full pipeline including LLM-driven extraction (head-to-head
 * comparable to mem0/Letta-class systems).
 */
export class MemoraiProvider implements MemoryProvider {
  readonly name = "memorai";
  private readonly opts: MemoraiProviderOptions;
  private memorai!: Memorai;
  private wallclock = new Map<string, number>();

  constructor(opts: MemoraiProviderOptions) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    if (this.opts.ingestMode === "extract" || this.opts.ingestMode === "paired") {
      throw new Error(
        `ingest mode '${this.opts.ingestMode}' is a legacy flag — use --extractor=llm instead`,
      );
    }
    this.memorai = this.spawnInstance();
  }

  private spawnInstance(): Memorai {
    return new Memorai({
      storage: new MemoryAdapter(),
      embedding: makeEmbedder(this.opts),
      extractor: pickExtractor(this.opts),
      reranker: pickReranker(this.opts),
      llm: pickRecallLLM(this.opts),
      // Benchmark needs deterministic evolve points — flush manually per session.
      evolution: { mode: "manual" },
    });
  }

  private nextTimestamp(userId: string, hint?: number): number {
    if (hint) {
      this.wallclock.set(userId, hint + 1);
      return hint;
    }
    const next = (this.wallclock.get(userId) ?? Date.now()) + 1;
    this.wallclock.set(userId, next);
    return next;
  }

  async ingestTurns(turns: Turn[], opts: IngestOptions): Promise<void> {
    const events: Event[] = turns.map((t) => {
      const content: EventContent = { kind: "message", text: t.content };
      return {
        at: this.nextTimestamp(opts.userId, t.timestampMs),
        actor: t.role,
        userId: opts.userId,
        context: opts.sessionId,
        content,
      };
    });
    const handle = this.memorai.recordEvents(events);
    await handle.nodes;
    if (opts.evolve !== false) {
      await this.memorai.evolve();
    }
  }

  async query(question: string, opts: QueryOptions): Promise<MemoryHit[]> {
    const result = await this.memorai.recall(question, {
      userId: opts.userId,
      topK: opts.topK ?? 30,
      strategy: "factual",
      queryExpansion: this.opts.queryExpansion,
      hyde: this.opts.hyde,
    });
    return result.memories.map((m) => ({
      content: m.summary,
      timestampMs: m.at,
      score: m.score,
      meta: {
        id: m.id,
        level: m.level,
        salience: m.salienceScore,
        pathways: m.provenance?.pathways,
      },
    }));
  }

  async resetUser(userId: string): Promise<void> {
    // Storage is shared; we can't easily evict one user's nodes from
    // MemoryAdapter today. Spin up a fresh instance per conversation.
    if (this.memorai) {
      await this.memorai.close();
    }
    this.wallclock.delete(userId);
    this.memorai = this.spawnInstance();
  }

  async close(): Promise<void> {
    if (this.memorai) {
      await this.memorai.close();
    }
    this.wallclock.clear();
  }
}
