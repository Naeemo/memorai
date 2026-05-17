import { EvolutionEngine } from "./evolution.js";
import { RetrievalEngine } from "./retrieval.js";
import { generateId } from "./utils.js";
import { LightExtractor, LLMExtractor, composeIndexableText } from "./extraction/index.js";
import type {
  AgentMemoryProfile,
  AutoEvolveTriggers,
  CompressionService,
  Event,
  Extractor,
  ListOptions,
  MediaPayload,
  MemoraiConfig,
  MemoryAnnotations,
  MemoryNode,
  Modality,
  NodePatch,
  RawContent,
  ReAnnotateOptions,
  ReAnnotateResult,
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

const DEFAULT_TRIGGERS: Required<Omit<AutoEvolveTriggers, "intervalMs">> & { intervalMs?: number } =
  {
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
   *
   * When `queryExpansion` and/or `hyde` are set (and a LLM is configured),
   * the question is expanded into multiple variant queries before retrieval,
   * and the results are fused via outer Reciprocal Rank Fusion. Each variant
   * shows up as a separate pathway in the final memory's `provenance`.
   *
   * When `MemoraiConfig.reranker` is set, a final reranker pass refines the
   * top-N candidates for precision. Both expansion and reranking are
   * opt-in and gracefully no-op when their dependencies aren't configured.
   */
  async recall(question: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const variants = await this.expandRecallQueries(question, opts);
    const topK = opts.topK ?? 10;
    // Pull more candidates than topK so the optional reranker has room
    // to reorder. Cap at 3× topK to keep the LLM rerank call bounded.
    const preRerankTopK = this.config.reranker ? Math.min(topK * 3, 30) : topK;

    let preRerank: RecallResult;
    if (variants.length === 1) {
      const query = this.buildRecallQuery(question, { ...opts, topK: preRerankTopK });
      const result = await this.retrieve(query);
      preRerank = this.toRecallResult(result);
    } else {
      const subResults = await Promise.all(
        variants.map((v) => {
          const q = this.buildRecallQuery(v.text, { ...opts, topK: preRerankTopK });
          if (v.embedding) q.embedding = v.embedding;
          return this.retrieve(q).then((r) => ({ tag: v.tag, result: r }));
        }),
      );
      preRerank = this.fuseVariantResults(subResults, preRerankTopK);
    }

    if (!this.config.reranker || preRerank.memories.length === 0) {
      return {
        memories: preRerank.memories.slice(0, topK),
        confidence: preRerank.confidence,
        totalScanned: preRerank.totalScanned,
      };
    }

    return this.applyReranker(question, preRerank, topK);
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

    const annInput = payload.annotations ?? {};
    const tags = annInput.tags ?? [];
    const salienceScore = annInput.salienceScore ?? 0.5;
    const modality: Modality[] = annInput.modality ?? ["text"];

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

    const indexableText = composeIndexableText(payload.raw, annInput);
    let embedding = annInput.embedding;
    if (!opts.skipEmbedding && !embedding && indexableText) {
      embedding = await this.config.embedding.embed(indexableText);
    }

    const boostedSalience = salienceScore * profile.writePolicy.salienceBoost;

    let media: MediaPayload | undefined = payload.raw.media;
    if (media && this.config.compression) {
      media = await this.compressMedia(media, this.config.compression);
    }

    const raw: RawContent = {
      content: payload.raw.content,
      text: payload.raw.text,
      media,
    };

    const { summary, facts, description, triples, ...openAnnotations } = annInput;
    const annotations: MemoryAnnotations = {
      ...openAnnotations,
      summary,
      facts,
      description,
      tags,
      salienceScore: boostedSalience,
      modality,
      embedding,
      triples,
    };

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
      raw,
      annotations,
      annotatedAt: payload.annotationVersion ? now : undefined,
      annotationVersion: payload.annotationVersion,
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
        if (!p.annotations?.embedding) {
          const text = composeIndexableText(p.raw, p.annotations);
          if (text) toEmbed.push({ index: i, text });
        }
      }

      if (toEmbed.length > 0) {
        const embeddings = await embeddingService.embedBatch!(toEmbed.map((e) => e.text));
        for (const [i, e] of toEmbed.entries()) {
          const p = payloads[e.index];
          p.annotations = { ...(p.annotations ?? {}) };
          p.annotations.embedding = embeddings[i];
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

    // Update lastAccessed / accessCount and persist a clean copy of each
    // node — the retrieval engine annotates nodes with `_score` / `_pathways`
    // / `_pathwayScores` for provenance, which must NOT be persisted.
    for (const node of result.nodes) {
      node.meta.lastAccessed = Date.now();
      node.meta.accessCount += 1;
      await this.config.storage.put(stripAnnotations(node));
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

  /** Update a memory node's annotations / linkage / metadata. Tier 1 `raw` is never modified through this surface — use `reAnnotate()` to regenerate Tier 2 from raw. */
  async update(id: string, patch: NodePatch): Promise<MemoryNode> {
    const node = await this.config.storage.get(id);
    if (!node) throw new Error(`Memory node not found: ${id}`);

    const annotationPatch = patch.annotations ?? patch.payload;
    if (annotationPatch) {
      node.annotations = { ...node.annotations, ...annotationPatch };
    }
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

  /**
   * Regenerate Tier 2 annotations + Tier 3 indexes from Tier 1 raw events.
   *
   * The unique three-tier capability: existing memories keep their identity
   * (id, timestamp, raw) while annotations and embeddings are replaced. Use
   * it to upgrade the extractor, switch embedding models, or backfill new
   * annotation kinds across the whole store — without losing the source
   * timeline.
   *
   * Pass `opts.extractor` to use a different extractor than the configured
   * one; `opts.filter` to scope to a subset; `opts.skipEmbedding` to keep
   * existing embeddings (when only annotations need refreshing).
   */
  async reAnnotate(opts: ReAnnotateOptions = {}): Promise<ReAnnotateResult> {
    const extractor = opts.extractor ?? this.extractor;
    const allNodes = await this.config.storage.listAll();
    const targets = opts.filter ? allNodes.filter(opts.filter) : allNodes;
    const total = targets.length;

    const result: ReAnnotateResult = {
      reannotated: 0,
      skipped: 0,
      errors: [],
    };

    for (let i = 0; i < targets.length; i++) {
      const node = targets[i];
      try {
        const event = this.nodeToEvent(node);
        const ctx = {
          recent: [] as MemoryNode[],
          embedding: this.config.embedding,
          llm: this.config.llm,
          now: () => Date.now(),
        };
        const payloads = await extractor.extract(event, ctx);
        if (payloads.length === 0) {
          result.skipped += 1;
          opts.onProgress?.(i + 1, total);
          continue;
        }

        const first = payloads[0];
        const annInput = first.annotations ?? {};
        const tags = annInput.tags ?? [];
        const salienceScore = annInput.salienceScore ?? node.annotations.salienceScore;
        const modality: Modality[] = annInput.modality ?? node.annotations.modality;

        let embedding = annInput.embedding;
        if (!opts.skipEmbedding && !embedding) {
          const indexableText = composeIndexableText(node.raw, annInput);
          if (indexableText) {
            embedding = await this.config.embedding.embed(indexableText);
          }
        } else if (opts.skipEmbedding && !embedding) {
          embedding = node.annotations.embedding;
        }

        const { summary, facts, description, triples, ...openAnnotations } = annInput;
        node.annotations = {
          ...openAnnotations,
          summary,
          facts,
          description,
          tags,
          salienceScore,
          modality,
          embedding,
          triples,
        };
        node.annotatedAt = Date.now();
        if (first.annotationVersion) {
          node.annotationVersion = first.annotationVersion;
        }

        await this.config.storage.put(node);
        result.reannotated += 1;
      } catch (err) {
        result.errors.push({
          id: node.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      opts.onProgress?.(i + 1, total);
    }

    return result;
  }

  private nodeToEvent(node: MemoryNode): Event {
    const event: Event = {
      actor: node.actor ?? this.config.defaultActor ?? this.agentProfile.agentId,
      content: node.raw.content,
    };
    if (node.duration > 0) {
      event.during = { start: node.timestamp - node.duration, end: node.timestamp };
    } else {
      event.at = node.timestamp;
    }
    if (node.target !== undefined) event.target = node.target;
    if (node.userId !== undefined) event.userId = node.userId;
    if (node.meta.participants !== undefined) event.participants = node.meta.participants;
    if (node.meta.writeContext !== undefined) event.context = node.meta.writeContext;
    if (node.meta.eventId !== undefined) event.id = node.meta.eventId;
    return event;
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
    const memories: RecalledMemory[] = result.nodes.map((n) => {
      const annotated = n as MemoryNode & {
        _score?: number;
        _pathways?: string[];
        _pathwayScores?: Record<string, number>;
      };
      const provenance =
        annotated._pathways && annotated._pathways.length > 0
          ? {
              pathways: annotated._pathways,
              fusedScore: annotated._score ?? 0,
              pathwayScores: annotated._pathwayScores,
            }
          : undefined;
      return {
        id: n.id,
        at: n.timestamp,
        during:
          n.duration && n.duration > 0
            ? { start: n.timestamp - n.duration, end: n.timestamp }
            : undefined,
        userId: n.userId,
        actor: n.actor,
        target: n.target,
        summary: n.annotations.summary ?? n.raw.text ?? "",
        description: n.annotations.description,
        tags: n.annotations.tags,
        salienceScore: n.annotations.salienceScore,
        evidence: n.raw.media,
        score: annotated._score ?? n.annotations.salienceScore,
        level: n.level,
        provenance,
      };
    });
    return {
      memories,
      confidence: result.confidence,
      totalScanned: result.traversalStats.scanned,
    };
  }

  /**
   * Apply the configured reranker to the fused recall candidates. Boosts the
   * memory's `score` to the reranker's score, adds a "rerank" pathway to
   * provenance, and slices to topK.
   */
  private async applyReranker(
    query: string,
    preRerank: RecallResult,
    topK: number,
  ): Promise<RecallResult> {
    const reranker = this.config.reranker!;
    const docs = preRerank.memories.map((m) => ({
      id: m.id,
      text: [m.summary, m.description ?? ""].filter(Boolean).join(" — "),
    }));

    let reranked;
    try {
      reranked = await reranker.rerank(query, docs, topK);
    } catch {
      // Reranker failure → return the fused list unchanged.
      return {
        memories: preRerank.memories.slice(0, topK),
        confidence: preRerank.confidence,
        totalScanned: preRerank.totalScanned,
      };
    }

    // Empty result from reranker means "no rerank applied" — fall back.
    if (reranked.length === 0) {
      return {
        memories: preRerank.memories.slice(0, topK),
        confidence: preRerank.confidence,
        totalScanned: preRerank.totalScanned,
      };
    }

    const byId = new Map(preRerank.memories.map((m) => [m.id, m]));
    const memories: RecalledMemory[] = [];
    for (const r of reranked) {
      const m = byId.get(r.id);
      if (!m) continue;
      const pathways = m.provenance?.pathways ? [...m.provenance.pathways, "rerank"] : ["rerank"];
      const pathwayScores = {
        ...(m.provenance?.pathwayScores ?? {}),
        rerank: r.score,
      };
      memories.push({
        ...m,
        score: r.score,
        provenance: {
          pathways,
          fusedScore: m.provenance?.fusedScore ?? m.score,
          pathwayScores,
        },
      });
    }

    // Confidence after rerank: average of rerank scores (already in [0,1]).
    const confidence =
      memories.length === 0 ? 0 : memories.reduce((s, m) => s + m.score, 0) / memories.length;

    return {
      memories,
      confidence,
      totalScanned: preRerank.totalScanned,
    };
  }

  /**
   * Generate the list of query variants to run for a single recall call.
   * Always includes the original question. If a LLM is configured and the
   * caller opted in, adds query-expansion paraphrases and/or a HyDE variant.
   */
  private async expandRecallQueries(
    question: string,
    opts: RecallOptions,
  ): Promise<Array<{ text: string; tag: string; embedding?: number[] }>> {
    const variants: Array<{ text: string; tag: string; embedding?: number[] }> = [
      { text: question, tag: "primary" },
    ];

    const llm = this.config.llm;
    if (!llm || !question) return variants;

    const tasks: Promise<void>[] = [];

    if (opts.queryExpansion && opts.queryExpansion > 0) {
      tasks.push(
        (async () => {
          try {
            const n = Math.min(5, opts.queryExpansion!);
            const prompt = `Rewrite the following question into ${n} different paraphrases that preserve the original intent. Output the paraphrases on separate lines, no numbering, no commentary.\n\nQUESTION: ${question}`;
            const raw = await llm.complete(prompt, {
              temperature: 0.7,
              maxTokens: 256,
            });
            const lines = raw
              .split(/\r?\n/)
              .map((l) => l.replace(/^[\s\-•*\d.()]+/, "").trim())
              .filter((l) => l.length > 4 && l.length < 400);
            for (const [i, l] of lines.slice(0, n).entries()) {
              variants.push({ text: l, tag: `expansion:${i}` });
            }
          } catch {
            // best-effort; ignore expansion failures
          }
        })(),
      );
    }

    if (opts.hyde) {
      tasks.push(
        (async () => {
          try {
            const prompt = `Write a short hypothetical answer (2-3 sentences) to the following question, as if you knew the answer. Do not say "I don't know" — invent plausible content.\n\nQUESTION: ${question}`;
            const hypothetical = await llm.complete(prompt, {
              temperature: 0.4,
              maxTokens: 256,
            });
            const text = hypothetical.trim();
            if (text.length > 0) {
              const embedding = await this.config.embedding.embed(text);
              variants.push({ text: question, tag: "hyde", embedding });
            }
          } catch {
            // best-effort; ignore HyDE failures
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return variants;
  }

  /**
   * Outer Reciprocal Rank Fusion across multiple `retrieve` results — used
   * when query expansion or HyDE produced more than one variant query. Each
   * variant contributes its top-K with rank-based scoring; provenance from
   * inner retrieval is preserved alongside the variant-level tag.
   */
  private fuseVariantResults(
    subResults: Array<{ tag: string; result: RetrievalResult }>,
    topK: number,
  ): RecallResult {
    const RRF_K = 60;
    const fused = new Map<
      string,
      {
        node: MemoryNode;
        score: number;
        variantPathways: Set<string>;
        innerPathways: Set<string>;
        pathwayScores: Record<string, number>;
      }
    >();

    let totalScanned = 0;
    for (const { tag, result } of subResults) {
      totalScanned += result.traversalStats.scanned;
      for (const [rank, node] of result.nodes.entries()) {
        const annotated = node as MemoryNode & {
          _score?: number;
          _pathways?: string[];
          _pathwayScores?: Record<string, number>;
        };
        let entry = fused.get(node.id);
        if (!entry) {
          entry = {
            node,
            score: 0,
            variantPathways: new Set(),
            innerPathways: new Set(),
            pathwayScores: {},
          };
          fused.set(node.id, entry);
        }
        entry.score += 1 / (RRF_K + rank);
        entry.variantPathways.add(tag);
        if (annotated._pathways) {
          for (const p of annotated._pathways) entry.innerPathways.add(p);
        }
        if (annotated._pathwayScores) {
          for (const [name, s] of Object.entries(annotated._pathwayScores)) {
            // keep the max per pathway across variants
            entry.pathwayScores[name] = Math.max(entry.pathwayScores[name] ?? 0, s);
          }
        }
      }
    }

    const sorted = [...fused.values()].sort((a, b) => b.score - a.score);
    const memories: RecalledMemory[] = sorted.slice(0, topK).map((entry) => {
      const n = entry.node;
      const pathways = [...entry.variantPathways, ...entry.innerPathways];
      return {
        id: n.id,
        at: n.timestamp,
        during:
          n.duration && n.duration > 0
            ? { start: n.timestamp - n.duration, end: n.timestamp }
            : undefined,
        userId: n.userId,
        actor: n.actor,
        target: n.target,
        summary: n.annotations.summary ?? n.raw.text ?? "",
        description: n.annotations.description,
        tags: n.annotations.tags,
        salienceScore: n.annotations.salienceScore,
        evidence: n.raw.media,
        score: entry.score,
        level: n.level,
        provenance: {
          pathways,
          fusedScore: entry.score,
          pathwayScores: entry.pathwayScores,
        },
      };
    });

    const totalVariants = subResults.length;
    const confidence =
      memories.length === 0
        ? 0
        : memories.reduce((sum, m) => {
            const variantHits = (m.provenance?.pathways ?? []).filter(
              (p) => p === "primary" || p === "hyde" || p.startsWith("expansion:"),
            ).length;
            return sum + Math.min(1, variantHits / totalVariants);
          }, 0) / memories.length;

    return { memories, confidence, totalScanned };
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

/**
 * Strip transient retrieval annotations (`_score` / `_pathways` /
 * `_pathwayScores`) from a node before persisting it. The annotations live
 * on the same object during a retrieval pass for performance but must NOT
 * be written back to storage.
 */
function stripAnnotations(node: MemoryNode): MemoryNode {
  const { id, timestamp, duration, level, raw, annotations, meta } = node;
  const clean: MemoryNode = {
    id,
    timestamp,
    duration,
    level,
    raw,
    annotations,
    meta,
  };
  if (node.userId !== undefined) clean.userId = node.userId;
  if (node.actor !== undefined) clean.actor = node.actor;
  if (node.target !== undefined) clean.target = node.target;
  if (node.parentId !== undefined) clean.parentId = node.parentId;
  if (node.childrenIds !== undefined) clean.childrenIds = node.childrenIds;
  if (node.mergedFrom !== undefined) clean.mergedFrom = node.mergedFrom;
  if (node.annotatedAt !== undefined) clean.annotatedAt = node.annotatedAt;
  if (node.annotationVersion !== undefined) clean.annotationVersion = node.annotationVersion;
  return clean;
}

// Re-export everything from submodules for convenience
export * from "./types.js";
export * from "./utils.js";
export { BM25Index, tokenize as bm25Tokenize } from "./bm25.js";
export { LLMReranker, parseScores as parseRerankerScores } from "./reranker.js";
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
