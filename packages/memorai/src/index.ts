import { EvolutionEngine } from "./evolution.js";
import { RetrievalEngine } from "./retrieval.js";
import { generateId } from "./utils.js";
import { LightExtractor, LLMExtractor } from "./extraction/index.js";
import type {
  AgentMemoryProfile,
  AutoEvolveTriggers,
  CompressionService,
  Event,
  Extractor,
  ListOptions,
  MediaPayload,
  MemoraiConfig,
  MemoryNode,
  Modality,
  NodePatch,
  RecallOptions,
  RecallResult,
  RecalledMemory,
  RecordHandle,
  RetrievalQuery,
  RetrievalResult,
  WriteOptions,
  WritePayload,
} from "./types.js";

const DEFAULT_AGENT_PROFILE: AgentMemoryProfile = {
  agentId: "default",
  role: "reasoning",
  writePolicy: {
    levels: ["segment", "atomic_action", "event"],
    modalities: ["text", "vision", "audio", "multimodal"],
    salienceBoost: 1,
  },
  readPolicy: {
    defaultLevel: "event",
    defaultTraversal: "reverse",
    timeHorizonMs: 86400000,
  },
};

const DEFAULT_TRIGGERS: Required<Omit<AutoEvolveTriggers, "intervalMs">> & { intervalMs?: number } = {
  onWriteCount: 100,
  onIdleMs: 5000,
  onStmFull: true,
  onClose: true,
};

/**
 * Memorai — the public memory engine.
 *
 * Primary surface (Event API):
 *   - recordEvent(event)        record one event; returns RecordHandle
 *   - recordEvents(events)      record many events
 *   - recall(question, opts?)   natural-language recall
 *   - recallByActor/Time/Tag/Relationship  structured recall
 *
 * Internal surface (`@internal` — for extractors, tests, and benchmarks):
 *   - write / writeBatch        structured-payload write
 *   - retrieve                  low-level retrieval
 *   - evolve                    manual L2 aggregation
 */
export class Memorai {
  private readonly retrieval: RetrievalEngine;
  private readonly evolution: EvolutionEngine;
  private readonly agentProfile: AgentMemoryProfile;
  private readonly extractor: Extractor;
  private readonly evolveMode: "auto" | "manual";
  private readonly triggers: typeof DEFAULT_TRIGGERS;
  private writesSinceEvolve = 0;
  private stmCount = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private evolveInFlight?: Promise<void>;

  constructor(private readonly config: MemoraiConfig) {
    this.retrieval = new RetrievalEngine(config.storage);
    this.evolution = new EvolutionEngine(config.storage, config.evolution);
    this.agentProfile = config.agentProfile ?? DEFAULT_AGENT_PROFILE;
    this.evolveMode = config.evolution?.mode ?? "auto";
    this.triggers = { ...DEFAULT_TRIGGERS, ...(config.evolution?.autoTriggers ?? {}) };

    if (config.extractor) {
      this.extractor = config.extractor;
    } else if (config.llm) {
      this.extractor = new LLMExtractor({ llm: config.llm });
    } else {
      this.extractor = new LightExtractor();
    }

    if (this.evolveMode === "auto" && this.triggers.intervalMs && this.triggers.intervalMs > 0) {
      this.startIntervalLoop(this.triggers.intervalMs);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Public — Event API
  // ═══════════════════════════════════════════════════════════

  /**
   * Record a single event. Returns a RecordHandle immediately — extraction
   * runs in the background. Await `handle.nodes` to block until extraction
   * completes, or fire-and-forget for low-latency hot paths.
   */
  recordEvent(event: Event): RecordHandle {
    return this.recordMany([event]);
  }

  /**
   * Record many events. Returns one handle covering all of them. Events are
   * processed in array order.
   */
  recordEvents(events: Event[]): RecordHandle {
    return this.recordMany(events);
  }

  private recordMany(events: Event[]): RecordHandle {
    const ids = events.map((e) => e.id ?? generateId());
    const controller = new AbortController();
    let isDone = false;

    const nodesPromise = (async (): Promise<MemoryNode[]> => {
      const out: MemoryNode[] = [];
      const ctx = {
        recent: [] as MemoryNode[],
        embedding: this.config.embedding,
        llm: this.config.llm,
        now: () => Date.now(),
        signal: controller.signal,
      };
      for (let i = 0; i < events.length; i++) {
        if (controller.signal.aborted) break;
        const ev = events[i];
        const enriched: Event = {
          ...ev,
          id: ids[i],
          actor: ev.actor ?? this.config.defaultActor ?? this.agentProfile.agentId,
          userId: ev.userId ?? this.config.defaultUserId,
        };
        const payloads = await this.extractor.extract(enriched, ctx);
        const written = await this.writeBatch(payloads);
        out.push(...written);
      }
      isDone = true;
      return out;
    })();

    return {
      eventIds: ids,
      nodes: nodesPromise,
      done: () => isDone,
      cancel: () => controller.abort(),
    };
  }

  /**
   * Natural-language recall. Returns the most relevant memories along with
   * confidence and traversal stats.
   */
  async recall(question: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const query = this.buildRecallQuery(question, opts);
    const result = await this.retrieve(query);
    return this.toRecallResult(result);
  }

  /** Recall events where the named actor is the producer. */
  recallByActor(actor: string, opts: RecallOptions = {}): Promise<RecallResult> {
    return this.recall(opts.overrideQuery?.text ?? "", { ...opts, actor });
  }

  /** Recall events between two parties (in either direction). */
  async recallByRelationship(
    a: string,
    b: string,
    opts: RecallOptions = {},
  ): Promise<RecallResult> {
    // Two queries, merge.
    const [forward, backward] = await Promise.all([
      this.recall(opts.overrideQuery?.text ?? "", { ...opts, actor: a, target: b }),
      this.recall(opts.overrideQuery?.text ?? "", { ...opts, actor: b, target: a }),
    ]);
    const merged = new Map<string, RecalledMemory>();
    for (const m of [...forward.memories, ...backward.memories]) merged.set(m.id, m);
    const memories = [...merged.values()].sort((x, y) => y.score - x.score);
    const topK = opts.topK ?? 10;
    return {
      memories: memories.slice(0, topK),
      confidence: (forward.confidence + backward.confidence) / 2,
      totalScanned: forward.totalScanned + backward.totalScanned,
    };
  }

  /** Recall events in a time window. */
  recallByTime(
    range: { start: number; end: number },
    opts: RecallOptions = {},
  ): Promise<RecallResult> {
    return this.recall(opts.overrideQuery?.text ?? "", { ...opts, timeRange: range });
  }

  /** Recall events matching one or more tags. */
  async recallByTag(tags: string[], opts: RecallOptions = {}): Promise<RecallResult> {
    const nodes = await this.config.storage.queryByTags(tags, { limit: opts.topK ?? 10 });
    return this.toRecallResult({
      nodes,
      confidence: nodes.length > 0 ? 1 : 0,
      traversalStats: { scanned: nodes.length, matched: nodes.length, pruned: 0, timeMs: 0 },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Internal — Structured Write
  // ═══════════════════════════════════════════════════════════

  /**
   * @internal Store a pre-extracted memory segment. Used by extractors,
   * tests, and benchmark harnesses. Application code should use
   * {@link recordEvent} instead.
   */
  async write(payload: WritePayload, opts: WriteOptions = {}): Promise<MemoryNode> {
    const id = generateId();
    const now = Date.now();
    const profile = this.agentProfile;

    const tags = payload.payload.tags ?? [];
    const salienceScore = payload.payload.salienceScore ?? 0.5;
    const modality: Modality[] = payload.payload.modality ?? ["text"];

    const allowedLevels = profile.writePolicy.levels;
    if (!allowedLevels.includes("segment")) {
      throw new Error(
        `Writing segments not allowed by write policy for agent '${profile.agentId}'`,
      );
    }
    for (const m of modality) {
      if (!profile.writePolicy.modalities.includes(m)) {
        throw new Error(
          `Modality '${m}' not allowed by write policy for agent '${profile.agentId}'`,
        );
      }
    }

    let embedding = payload.payload.embedding;
    if (!opts.skipEmbedding && !embedding && payload.payload.summary) {
      embedding = await this.config.embedding.embed(payload.payload.summary);
    }

    const boostedSalience = salienceScore * profile.writePolicy.salienceBoost;

    let media: MediaPayload | undefined = payload.payload.media;
    if (media && this.config.compression) {
      media = await this.compressMedia(media, this.config.compression);
    }

    const segment: MemoryNode = {
      id,
      timestamp: payload.timestamp ?? now,
      duration: payload.duration ?? 0,
      level: "segment",
      userId: payload.userId,
      actor: payload.actor,
      target: payload.target,
      parentId: payload.parentId,
      childrenIds: payload.childrenIds,
      mergedFrom: payload.mergedFrom,
      payload: {
        summary: payload.payload.summary,
        description: payload.payload.description,
        media,
        embedding,
        tags,
        salienceScore: boostedSalience,
        modality,
      },
      meta: {
        sourceAgent: payload.meta?.sourceAgent ?? profile.agentId,
        agentRole: payload.meta?.agentRole ?? profile.role,
        writeContext: payload.meta?.writeContext,
        participants: payload.meta?.participants,
        eventId: payload.meta?.eventId,
        lastAccessed: now,
        accessCount: 0,
      },
    };

    await this.config.storage.put(segment);
    await this.evolution.processSegment(segment);
    this.onAfterWrite();

    return segment;
  }

  /**
   * @internal Batch write multiple memory segments. Used by the extractor
   * pipeline.
   */
  async writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]> {
    const embeddingService = this.config.embedding;
    const hasEmbedBatch = !!embeddingService.embedBatch;

    if (hasEmbedBatch) {
      const toEmbed: { index: number; text: string }[] = [];
      for (const [i, p] of payloads.entries()) {
        if (!p.payload.embedding && p.payload.summary) {
          toEmbed.push({ index: i, text: p.payload.summary });
        }
      }

      if (toEmbed.length > 0) {
        const embeddings = await embeddingService.embedBatch!(toEmbed.map((e) => e.text));
        for (const [i, e] of toEmbed.entries()) {
          payloads[e.index].payload.embedding = embeddings[i];
        }
      }
    }

    const nodes: MemoryNode[] = [];
    for (const payload of payloads) {
      nodes.push(await this.write(payload, { skipEmbedding: hasEmbedBatch }));
    }
    return nodes;
  }

  // ═══════════════════════════════════════════════════════════
  // Internal — Low-level read
  // ═══════════════════════════════════════════════════════════

  /**
   * @internal Direct retrieval engine access. Most callers should use
   * {@link recall} or its structured variants.
   */
  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const mergedQuery: RetrievalQuery = {
      ...query,
      level: query.level ?? this.agentProfile.readPolicy.defaultLevel,
      traversalOrder: query.traversalOrder ?? this.agentProfile.readPolicy.defaultTraversal,
      agentRole: query.agentRole ?? this.agentProfile.role,
    };

    if (mergedQuery.text && !mergedQuery.embedding) {
      mergedQuery.embedding = await this.config.embedding.embed(mergedQuery.text);
    }

    const result = await this.retrieval.retrieve(mergedQuery);

    for (const node of result.nodes) {
      node.meta.lastAccessed = Date.now();
      node.meta.accessCount += 1;
      await this.config.storage.put(node);
    }

    return result;
  }

  /** Get a specific memory node by ID. */
  async get(id: string): Promise<MemoryNode | null> {
    const node = await this.config.storage.get(id);
    if (node) {
      node.meta.lastAccessed = Date.now();
      node.meta.accessCount += 1;
      await this.config.storage.put(node);
    }
    return node;
  }

  /** List memories with filtering and pagination. */
  async list(opts?: ListOptions): Promise<MemoryNode[]> {
    const { agentRole, limit, offset, ...queryOpts } = opts ?? {};
    let nodes = await this.config.storage.listAll(queryOpts);

    if (agentRole) {
      nodes = nodes.filter((n) => n.meta.agentRole === agentRole);
    }

    if (limit !== undefined || offset !== undefined) {
      const start = offset ?? 0;
      const end = limit !== undefined ? start + limit : nodes.length;
      nodes = nodes.slice(start, end);
    }

    return nodes;
  }

  // ═══════════════════════════════════════════════════════════
  // Evolution
  // ═══════════════════════════════════════════════════════════

  /**
   * @internal Manually trigger Level-2 evolution. Normally auto-triggered.
   * Multiple concurrent calls coalesce — only one evolution runs at a time.
   */
  evolve(): Promise<void> {
    if (this.evolveInFlight) return this.evolveInFlight;
    const p = (async () => {
      try {
        await this.evolution.evolve();
        this.writesSinceEvolve = 0;
        this.stmCount = 0;
        this.clearIdleTimer();
      } finally {
        this.evolveInFlight = undefined;
      }
    })();
    this.evolveInFlight = p;
    return p;
  }

  // ═══════════════════════════════════════════════════════════
  // Management
  // ═══════════════════════════════════════════════════════════

  /** Delete a memory node. If cascade=true, delete all children recursively. */
  async delete(id: string, cascade = false): Promise<void> {
    const children = await this.config.storage.getChildren(id);

    if (cascade) {
      for (const child of children) {
        await this.delete(child.id, true);
      }
    } else {
      for (const child of children) {
        child.parentId = undefined;
        await this.config.storage.put(child);
      }
    }

    const node = await this.config.storage.get(id);
    if (node?.parentId) {
      const parent = await this.config.storage.get(node.parentId);
      if (parent?.childrenIds) {
        parent.childrenIds = parent.childrenIds.filter((cid) => cid !== id);
        await this.config.storage.put(parent);
      }
    }

    await this.config.storage.delete(id);
  }

  /** Update a memory node's fields. */
  async update(id: string, patch: NodePatch): Promise<MemoryNode> {
    const node = await this.config.storage.get(id);
    if (!node) throw new Error(`Memory node not found: ${id}`);

    if (patch.payload) node.payload = { ...node.payload, ...patch.payload };
    if (patch.meta) node.meta = { ...node.meta, ...patch.meta };
    if ("userId" in patch) node.userId = patch.userId;
    if ("actor" in patch) node.actor = patch.actor;
    if ("target" in patch) node.target = patch.target;
    if ("parentId" in patch) node.parentId = patch.parentId;
    if ("childrenIds" in patch) node.childrenIds = patch.childrenIds;
    if ("mergedFrom" in patch) node.mergedFrom = patch.mergedFrom;

    await this.config.storage.put(node);
    return node;
  }

  /** Close all resources (storage, background timers, etc.). */
  async close(): Promise<void> {
    this.clearIdleTimer();
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    if (this.evolveMode === "auto" && this.triggers.onClose !== false) {
      try {
        await this.evolve();
      } catch (err) {
        console.error("[Memorai] evolve on close failed:", err);
      }
    }
    await this.config.storage.close();
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private buildRecallQuery(question: string, opts: RecallOptions): RetrievalQuery {
    const base: RetrievalQuery = {
      strategy: opts.strategy ?? "factual",
      text: question || undefined,
      topK: opts.topK ?? 10,
      timeRange: opts.timeRange,
      traversalOrder: opts.traversalOrder,
      level: opts.level,
      userId: opts.userId,
      actor: opts.actor,
      target: opts.target,
    };
    return { ...base, ...(opts.overrideQuery ?? {}) };
  }

  private toRecallResult(result: RetrievalResult): RecallResult {
    const memories: RecalledMemory[] = result.nodes.map((n) => ({
      id: n.id,
      at: n.timestamp,
      during:
        n.duration && n.duration > 0
          ? { start: n.timestamp - n.duration, end: n.timestamp }
          : undefined,
      userId: n.userId,
      actor: n.actor,
      target: n.target,
      summary: n.payload.summary,
      description: n.payload.description,
      tags: n.payload.tags,
      salienceScore: n.payload.salienceScore,
      evidence: n.payload.media,
      score: (n as MemoryNode & { _score?: number })._score ?? n.payload.salienceScore,
      level: n.level,
    }));
    return {
      memories,
      confidence: result.confidence,
      totalScanned: result.traversalStats.scanned,
    };
  }

  private onAfterWrite(): void {
    if (this.evolveMode !== "auto") return;
    this.writesSinceEvolve += 1;
    this.stmCount += 1;

    if (this.triggers.onStmFull && this.stmCount >= (this.config.evolution?.stmMaxSize ?? 1000)) {
      void this.evolve();
      return;
    }
    if (this.triggers.onWriteCount && this.writesSinceEvolve >= this.triggers.onWriteCount) {
      void this.evolve();
      return;
    }
    if (this.triggers.onIdleMs) {
      this.clearIdleTimer();
      this.idleTimer = setTimeout(() => void this.evolve(), this.triggers.onIdleMs);
    }
  }

  private startIntervalLoop(intervalMs: number): void {
    const run = (): void => {
      this.evolve()
        .catch((err: unknown) => console.error("[Memorai] interval evolve failed:", err))
        .finally(() => {
          if (this.intervalTimer !== undefined) {
            this.intervalTimer = setTimeout(run, intervalMs);
          }
        });
    };
    this.intervalTimer = setTimeout(run, intervalMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async compressMedia(
    media: MediaPayload,
    compression: CompressionService,
  ): Promise<MediaPayload> {
    const compressed: MediaPayload = {};

    if (media.frames) {
      const refs: string[] = [];
      for (const frame of media.frames) {
        if (typeof frame === "string") {
          refs.push(frame);
        } else {
          const imageData =
            typeof ImageData !== "undefined" && frame instanceof ImageData
              ? frame
              : (frame as unknown as ImageData);
          const img = await compression.compressImage(imageData);
          refs.push(img.ref);
        }
      }
      compressed.frames = refs;
    }

    if (media.audio) {
      if (typeof media.audio === "string") {
        compressed.audio = media.audio;
      } else {
        const audio = await compression.compressAudio(media.audio);
        compressed.audio = audio.ref;
      }
    }

    if (media.video) {
      compressed.video = media.video;
    }

    return compressed;
  }
}

// Re-export everything from submodules for convenience
export * from "./types.js";
export * from "./utils.js";
export { IndexedDBAdapter, MemoryAdapter } from "./storage/index.js";
export { OllamaEmbeddingService, OpenAIEmbeddingService } from "./embeddings/index.js";
export { EvolutionEngine } from "./evolution.js";
export { RetrievalEngine } from "./retrieval.js";
export {
  BrowserImageCompressor,
  PassthroughCompressor,
  type CompressionService,
} from "./compression.js";
export { SQLiteAdapter, type SQLiteDatabase, type SQLiteStatement } from "./storage/index.js";
export {
  LightExtractor,
  LLMExtractor,
  WrapExtractor,
  buildBaseWrite,
  contentToTextAndMedia,
  resolveTimeAnchor,
  extractTags,
  scoreSalience,
} from "./extraction/index.js";

// Suppress unused import warnings for types that are re-exported via types.js
export type {
  Event,
  AutoEvolveTriggers,
  Extractor,
  NodePatch,
  RecallOptions,
  RecallResult,
  RecalledMemory,
  RecordHandle,
} from "./types.js";
