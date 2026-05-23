import { EvolutionEngine } from "./evolution.js";
import { ReflectionEngine } from "./reflection.js";
import { RetrievalEngine, RuleBasedIntentClassifier } from "./retrieval.js";
import { InMemorySkillStore, SkillExtractor } from "./skills/index.js";
import type { ProceduralSkill, SkillExtractionOptions, SkillExtractionResult, SkillStore } from "./skills/index.js";
import { cosineSimilarity, generateId } from "./utils.js";
import { LightExtractor, LLMExtractor, composeIndexableText } from "./extraction/index.js";
import { InMemoryEventStore, LLMEventIdentifier } from "./events/index.js";
import { resolveTimeExpression } from "./temporal/index.js";
import { InMemoryWorkingMemory } from "./working/index.js";
import { DefaultRetentionPolicy } from "./retention/index.js";
import { IterativeRecaller } from "./iterative.js";
import { buildExplainResult, spanTracker } from "./explain.js";
import { MemoryFederation, SubscriptionRegistry } from "./federation.js";
import { NarrativeBuilder } from "./narrative.js";
import type {
  AgentMemoryProfile,
  AutoEvolveTriggers,
  CompressionService,
  ContradictionResult,
  Event,
  EventIdentifier,
  EventStore,
  ExplainResult,
  Extractor,
  IdentifiedEvent,
  IntentClassifier,
  ListOptions,
  MediaPayload,
  MemoraiConfig,
  MemoryAnnotations,
  MemoryEvent,
  MemoryLevel,
  MemoryNode,
  MemorySlice,
  Modality,
  NarrativeRecall,
  NodePatch,
  QueryIntent,
  RawContent,
  ReAnnotateOptions,
  ReflectOptions,
  ReflectionResult,
  SleepOptions,
  SleepResult,
  ReAnnotateResult,
  RecallOptions,
  RecallResult,
  RecalledMemory,
  RecordHandle,
  RetrievalQuery,
  RetrievalResult,
  SubscribeFilter,
  SubscriptionHandle,
  WriteOptions,
  WritePayload,
} from "./types.js";
import type { VectorIndex } from "./vector/types.js";
import type { EntityGraph, GraphEdge, GraphPath, UpsertEdgeInput } from "./graph/types.js";
import type { WorkingMemory } from "./working/types.js";
import type { ForgetOptions, ForgetResult, RetentionPolicy } from "./retention/types.js";
import type { IterativeRecallOptions, IterativeRecallResult } from "./iterative.js";

const DEFAULT_AGENT_PROFILE: AgentMemoryProfile = {
  agentId: "default",
  role: "reasoning",
  writePolicy: {
    levels: ["segment", "atomic_action", "episode"],
    modalities: ["text", "vision", "audio", "multimodal"],
    salienceBoost: 1,
  },
  readPolicy: {
    defaultLevel: "episode",
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
  private readonly eventStore: EventStore;
  private readonly identifier?: EventIdentifier;
  private readonly vectorIndex?: VectorIndex;
  private readonly entityGraph?: EntityGraph;
  private readonly skillStore: SkillStore;
  /**
   * Fast typed scratchpad for short-lived agent state — current task,
   * pending tool args, in-flight beliefs. Defaults to an in-memory
   * implementation; override with a persistent backend via
   * `MemoraiConfig.workingMemory`.
   */
  readonly workingMemory: WorkingMemory;
  private readonly retentionPolicy: RetentionPolicy;
  private readonly intentClassifier: IntentClassifier;
  private readonly evolveMode: "auto" | "manual";
  private readonly triggers: typeof DEFAULT_TRIGGERS;
  private writesSinceEvolve = 0;
  private stmCount = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private evolveInFlight?: Promise<void>;
  private readonly subscriptions = new SubscriptionRegistry();
  readonly federation: MemoryFederation = new MemoryFederation();

  constructor(private readonly config: MemoraiConfig) {
    this.vectorIndex = config.vectorIndex;
    this.entityGraph = config.entityGraph;
    this.skillStore = config.skillStore ?? new InMemorySkillStore();
    this.workingMemory = config.workingMemory ?? new InMemoryWorkingMemory();
    this.retentionPolicy = config.retentionPolicy ?? new DefaultRetentionPolicy();
    this.retrieval = new RetrievalEngine(config.storage, this.vectorIndex, this.entityGraph);
    this.evolution = new EvolutionEngine(config.storage, config.evolution);
    this.agentProfile = config.agentProfile ?? DEFAULT_AGENT_PROFILE;
    this.evolveMode = config.evolution?.mode ?? "auto";
    this.triggers = { ...DEFAULT_TRIGGERS, ...config.evolution?.autoTriggers };
    this.intentClassifier = config.intentClassifier ?? new RuleBasedIntentClassifier();

    if (config.extractor) {
      this.extractor = config.extractor;
    } else if (config.llm) {
      this.extractor = new LLMExtractor({ llm: config.llm });
    } else {
      this.extractor = new LightExtractor();
    }

    this.eventStore =
      config.events ?? new InMemoryEventStore({
        vectorIndex: config.eventVectorIndex,
        namespace: config.namespace,
      });
    if (config.identifier) {
      this.identifier = config.identifier;
    } else if (config.llm) {
      this.identifier = new LLMEventIdentifier({ llm: config.llm });
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
   * When `queryExpansion`, `hyde`, and/or `decompose` are set (and a LLM
   * is configured), the question is expanded into multiple variant
   * queries before retrieval and results are fused via outer Reciprocal
   * Rank Fusion. Each variant shows up as a separate pathway in the
   * final memory's `provenance` — `expansion:N` for paraphrases,
   * `hyde` for the hypothetical-answer embedding, and `decompose:N` for
   * sub-questions split from a multi-hop query.
   *
   * When an `EventIdentifier` is configured, recall also runs in parallel
   * over MemoryEvents (state / transition / happening) and outer-fuses the
   * event-level hits with the raw-node hits via RRF. Set
   * `opts.includeEvents = false` to disable.
   *
   * When `MemoraiConfig.reranker` is set, a final reranker pass refines the
   * top-N candidates for precision. All expansion modes and reranking are
   * opt-in and gracefully no-op when their dependencies aren't configured.
   */
  async recall(question: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const { result } = await this._recallInternal(question, opts);
    return result;
  }

  /**
   * Explain why a recall returned the memories it did.
   *
   * Runs the same pipeline as {@link recall} but returns a full audit
   * trail: per-phase timing spans, pathway activation stats, fusion
   * math, and the raw results from each retrieval route. Useful for
   * debugging recall quality and understanding which pathways are
   * contributing (or missing).
   */
  async explain(question: string, opts: RecallOptions = {}): Promise<ExplainResult> {
    const { explainResult } = await this._recallInternal(question, opts, true);
    return explainResult!;
  }

  private async _recallInternal(
    question: string,
    opts: RecallOptions,
    returnExplain = false,
  ): Promise<{ result: RecallResult; explainResult?: ExplainResult }> {
    const tracker = spanTracker();
    const topK = opts.topK ?? 10;
    const preRerankTopK = this.config.reranker ? Math.min(topK * 3, 30) : topK;

    const endTemporal = tracker.start("temporal-resolution");
    const effectiveOpts =
      opts.resolveTime && !opts.timeRange ? await this.applyTemporalResolution(question, opts) : opts;
    endTemporal();

    // S1: Adaptive pathway selection — classify query intent before retrieval.
    const endIntent = tracker.start("intent-classification");
    const { intent } = await this.intentClassifier.classify(question);
    endIntent();

    const eventsEnabled = effectiveOpts.includeEvents !== false && this.identifier !== undefined;

    const endNodes = tracker.start("node-recall", { variants: 0, intent });
    const nodeResult = await this.recallNodes(question, effectiveOpts, preRerankTopK, intent);
    endNodes();
    endNodes();

    let eventMemories: RecalledMemory[] = [];
    if (eventsEnabled) {
      const endEvents = tracker.start("event-recall");
      eventMemories = await this.recallEvents(question, effectiveOpts, preRerankTopK);
      endEvents();
    }

    const endFusion = tracker.start("fusion");
    const preRerank = this.mergeNodeAndEventResults(nodeResult, eventMemories, preRerankTopK);
    endFusion();

    let result: RecallResult;
    if (!this.config.reranker || preRerank.memories.length === 0) {
      result = {
        memories: preRerank.memories.slice(0, topK),
        confidence: preRerank.confidence,
        totalScanned: preRerank.totalScanned,
      };
    } else {
      const endRerank = tracker.start("rerank");
      result = await this.applyReranker(question, preRerank, topK);
      endRerank();
    }

    const spans = tracker.collect();
    this.config.onRecall?.(question, result, spans);

    if (returnExplain) {
      const nodeResForExplain: RecallResult = {
        memories: nodeResult.memories.slice(0, preRerankTopK),
        confidence: nodeResult.confidence,
        totalScanned: nodeResult.totalScanned,
      };
      const eventResForExplain: RecallResult | undefined = eventsEnabled
        ? {
            memories: eventMemories.slice(0, preRerankTopK),
            confidence: eventMemories.length > 0 ? 1 : 0,
            totalScanned: eventMemories.length,
          }
        : undefined;
      const explainResult = buildExplainResult({
        question,
        recallOpts: effectiveOpts,
        spans,
        nodeResult: nodeResForExplain,
        eventResult: eventResForExplain,
        fusedMemories: result.memories,
      });
      return { result, explainResult };
    }

    return { result };
  }

  /**
   * Iterative / agentic recall — repeats a `recall → judge → rewrite`
   * loop until the configured LLM judges the collected memories
   * sufficient, no new memories surface, or `maxIterations` is reached.
   *
   * Use this for multi-hop questions where a single recall pass under-fills
   * the answer ("when did X happen and what did Y say about it"). Each
   * iteration is a full {@link recall} call — including HyDE / query
   * expansion / reranker — so the per-iteration cost is the same as a
   * one-shot recall, and the total cost is `iterations` multiples.
   *
   * Falls back to single-pass recall when no LLM is configured (no judge
   * available). The returned `steps[]` records why we stopped — useful for
   * debugging when iteration counts seem off.
   */
  async iterativeRecall(
    question: string,
    opts: IterativeRecallOptions = {},
  ): Promise<IterativeRecallResult> {
    if (!this.config.llm) {
      const single = await this.recall(question, opts);
      return {
        ...single,
        iterations: 1,
        steps: [
          {
            iteration: 1,
            query: question,
            newMemoriesFound: single.memories.length,
            judgment: "no_llm",
          },
        ],
      };
    }
    const recaller = new IterativeRecaller(this.config.llm, (q, o) => this.recall(q, o));
    return recaller.recall(question, opts);
  }

  /**
   * Auto-detect time expressions in the question and populate `opts.timeRange`.
   * No-op when the resolver finds nothing OR when the match is low-confidence
   * (bare month names without modifier — ambiguous which year is meant). The
   * original `opts` flows unchanged so retrieval can fall back to a global
   * search.
   */
  private async applyTemporalResolution(question: string, opts: RecallOptions): Promise<RecallOptions> {
    // Tier 1: heuristic absolute-time resolution (yesterday, last week, etc.)
    const resolved = resolveTimeExpression(question);
    if (resolved) {
      // Drop low-confidence matches even when the caller opted in.
      if (resolved.confidence === "low") return opts;
      return {
        ...opts,
        timeRange: { start: resolved.start, end: resolved.end },
        strategy: opts.strategy ?? "temporal",
      };
    }

    // Tier 2: relative-to-anchor resolution ("before the migration", "after Alice arrived")
    const anchorResolved = await this.resolveRelativeToAnchor(question);
    if (anchorResolved) {
      return {
        ...opts,
        timeRange: anchorResolved,
        strategy: opts.strategy ?? "temporal",
      };
    }

    // Tier 3: LLM-assisted resolution for ambiguous relative expressions
    // ("when we last spoke", "the other day", "around that time")
    const llmResolved = await this.resolveTemporalViaLLM(question, opts);
    if (llmResolved) {
      return {
        ...opts,
        timeRange: llmResolved,
        strategy: opts.strategy ?? "temporal",
      };
    }

    return opts;
  }

  /**
   * Try to resolve relative time expressions that reference named temporal
   * anchors ("before the migration", "after Alice arrived", "during the meeting").
   * Returns a timeRange or null when no matching anchor is found.
   */
  private async resolveRelativeToAnchor(
    question: string,
  ): Promise<{ start: number; end: number } | null> {
    const lower = question.toLowerCase();

    // Expanded patterns: before/after/during/since/until/around
    const relativeMatch = lower.match(
      /\b(before|after|during|since|until|around|near)\s+(?:the\s+)?([a-zA-Z][a-zA-Z0-9\s_-]{2,40})\b/,
    );
    if (!relativeMatch) return null;

    const relation = relativeMatch[1] as
      | "before"
      | "after"
      | "during"
      | "since"
      | "until"
      | "around"
      | "near";
    const anchorName = relativeMatch[2]
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/^the-/, "");

    const nodes = await this.config.storage.queryByTemporalAnchor(anchorName, { limit: 10 });
    if (nodes.length === 0) return null;

    // Pick the highest-confidence anchor
    let bestAnchor: { start?: number; end?: number; confidence: number } | null = null;
    for (const n of nodes) {
      for (const a of n.annotations.temporalAnchors ?? []) {
        if (a.name === anchorName || a.name.includes(anchorName)) {
          if (!bestAnchor || a.confidence > bestAnchor.confidence) {
            bestAnchor = a;
          }
        }
      }
    }
    if (!bestAnchor) return null;

    const now = Date.now();
    const anchorStart = bestAnchor.start ?? now;
    const anchorEnd = bestAnchor.end ?? anchorStart;
    // Default margin for fuzzy relations ("around", "near")
    const margin = 12 * 60 * 60 * 1000; // 12 hours

    switch (relation) {
      case "before":
        return { start: 0, end: anchorStart };
      case "after":
      case "since":
        return { start: anchorEnd, end: now };
      case "during":
        return { start: anchorStart, end: anchorEnd };
      case "until":
        return { start: 0, end: anchorStart };
      case "around":
      case "near":
        return { start: anchorStart - margin, end: anchorEnd + margin };
      default:
        return null;
    }
  }

  /**
   * Tier 3 temporal resolution: ask the configured LLM to interpret ambiguous
   * relative time expressions given recent event context. Used as a fallback
   * when heuristic + anchor resolution both fail.
   *
   * The LLM is given the last 20 events in scope (filtered by userId/actor)
   * and asked to return a JSON timeRange for the expression. If the LLM is
   * not configured or the prompt fails, returns null.
   */
  private async resolveTemporalViaLLM(
    question: string,
    opts: RecallOptions,
  ): Promise<{ start: number; end: number } | null> {
    const llm = this.config.llm;
    if (!llm) return null;

    // Fetch recent events as context for the LLM
    let recentEvents: MemoryEvent[] = [];
    try {
      if (opts.actor) {
        recentEvents = await this.eventStore.queryEventsByParticipant(opts.actor, {
          userId: opts.userId,
          orderBy: "occurredAt",
          order: "desc",
          limit: 20,
        });
      } else {
        recentEvents = await this.eventStore.listEvents({
          userId: opts.userId,
          orderBy: "occurredAt",
          order: "desc",
          limit: 20,
        });
      }
    } catch {
      return null;
    }
    if (recentEvents.length === 0) return null;

    const prompt = buildTemporalResolutionPrompt(question, recentEvents);
    try {
      const raw = await llm.complete(prompt, { temperature: 0, maxTokens: 256, responseFormat: "json" });
      const trimmed = raw.trim();
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { start?: number; end?: number };
      if (
        typeof obj.start === "number" &&
        typeof obj.end === "number" &&
        obj.start >= 0 &&
        obj.end > obj.start
      ) {
        return { start: obj.start, end: obj.end };
      }
    } catch {
      // LLM fallback failed — return null so recall falls back to global search
    }
    return null;
  }

  private async recallNodes(
    question: string,
    opts: RecallOptions,
    preRerankTopK: number,
    intent?: QueryIntent,
  ): Promise<RecallResult> {
    const variants = await this.expandRecallQueries(question, opts);

    if (variants.length === 1) {
      const query = this.buildRecallQuery(question, { ...opts, topK: preRerankTopK }, intent);
      const result = await this.retrieve(query);
      return this.toRecallResult(result);
    }

    const subResults = await Promise.all(
      variants.map((v) => {
        const q = this.buildRecallQuery(v.text, { ...opts, topK: preRerankTopK }, intent);
        if (v.embedding) q.embedding = v.embedding;
        return this.retrieve(q).then((r) => ({ tag: v.tag, result: r }));
      }),
    );
    return this.fuseVariantResults(subResults, preRerankTopK);
  }

  /**
   * Event-level recall. Runs two pathways in parallel — semantic (embedding
   * cosine over MemoryEvent.embedding) and sparse (BM25 over description) —
   * and fuses them via RRF. Filters by valid-time so superseded state
   * events stay out unless explicitly requested.
   */
  private async recallEvents(
    question: string,
    opts: RecallOptions,
    topK: number,
  ): Promise<RecalledMemory[]> {
    if (!question) return [];

    const excludeInvalidated = opts.excludeInvalidatedEvents !== false;
    const eventQueryOpts = {
      userId: opts.userId,
      validAt: opts.timeRange?.end ?? Date.now(),
      excludeInvalidated,
      topK: topK * 2,
    };

    const queryEmbedding = await this.config.embedding.embed(question);

    let semanticHits: MemoryEvent[];
    let textHits: MemoryEvent[];

    // S6: Bi-temporal — when validAt is set, filter by validity window.
    if (opts.validAt !== undefined) {
      const validTimeRange = { start: opts.validAt - 1, end: opts.validAt + 1 };
      const [s, t] = await Promise.all([
        this.eventStore.queryEventsByEmbedding(queryEmbedding, { ...eventQueryOpts, ...validTimeRange }),
        this.eventStore.queryEventsByText(question, { ...eventQueryOpts, ...validTimeRange }),
      ]);
      semanticHits = s.filter((ev) => {
        const vs = ev.validity?.validStart ?? ev.occurredAt;
        const ve = ev.validity?.validEnd;
        if (vs > opts.validAt!) return false;
        if (ve !== undefined && ve < opts.validAt!) return false;
        return true;
      });
      textHits = t.filter((ev) => {
        const vs = ev.validity?.validStart ?? ev.occurredAt;
        const ve = ev.validity?.validEnd;
        if (vs > opts.validAt!) return false;
        if (ve !== undefined && ve < opts.validAt!) return false;
        return true;
      });
    } else {
      [semanticHits, textHits] = await Promise.all([
        this.eventStore.queryEventsByEmbedding(queryEmbedding, eventQueryOpts),
        this.eventStore.queryEventsByText(question, eventQueryOpts),
      ]);
    }

    const RRF_K = 60;
    const fused = new Map<
      string,
      {
        event: MemoryEvent;
        score: number;
        pathways: Set<string>;
        pathwayScores: Record<string, number>;
        /**
         * When cross-event dedup collapses two events with the same
         * description, the dropped twin's sourceNodeIds are merged in
         * here so downstream `coveredByEvent` dedup still sees them.
         */
        mergedSourceNodeIds?: readonly string[];
      }
    >();

    for (const [rank, event] of semanticHits.entries()) {
      const entry = fused.get(event.id) ?? {
        event,
        score: 0,
        pathways: new Set<string>(),
        pathwayScores: {},
      };
      entry.score += 1 / (RRF_K + rank);
      entry.pathways.add("event:semantic");
      entry.pathwayScores["event:semantic"] = 1 / (RRF_K + rank);
      fused.set(event.id, entry);
    }

    for (const [rank, event] of textHits.entries()) {
      const entry = fused.get(event.id) ?? {
        event,
        score: 0,
        pathways: new Set<string>(),
        pathwayScores: {},
      };
      entry.score += 1 / (RRF_K + rank);
      entry.pathways.add("event:bm25");
      entry.pathwayScores["event:bm25"] = 1 / (RRF_K + rank);
      fused.set(event.id, entry);
    }

    // Honor opts.timeRange.start as well — semantic / BM25 queries returned
    // candidates filtered only by validAt (which is timeRange.end). Drop
    // events whose occurredAt falls outside the requested window.
    let candidates = [...fused.values()];
    if (opts.timeRange) {
      const { start, end } = opts.timeRange;
      candidates = candidates.filter(
        (c) => c.event.occurredAt >= start && c.event.occurredAt <= end,
      );
    }

    // Cross-event dedup: when the identifier ran over overlapping batches
    // it can produce multiple MemoryEvents with the same canonical
    // description ("Alice prefers tea" extracted twice from different
    // segments). Both eat topK slots without adding information. Collapse
    // by normalized description, keep the higher-scoring entry, and
    // merge pathway / sourceNodeIds provenance from the dropped twin.
    candidates = this.dedupeEventCandidates(candidates);

    let sorted = candidates.sort((a, b) => b.score - a.score).slice(0, topK);

    // Surface related events: for each top-K event, pull in its
    // `relatedEventIds` so multi-hop queries find connected context.
    // Related events are scored slightly below their referrer to preserve
    // rank order, and deduped so an event isn't duplicated.
    const relatedIds = new Set<string>();
    const relatedEntries: typeof sorted = [];
    for (const entry of sorted) {
      for (const rid of entry.event.relatedEventIds ?? []) {
        if (relatedIds.has(rid)) continue;
        if (fused.has(rid)) continue; // already in candidate set
        relatedIds.add(rid);
        const related = await this.eventStore.getEvent(rid);
        if (!related) continue;
        if (excludeInvalidated && related.invalidatedAt !== undefined) continue;
        if (opts.timeRange) {
          const { start, end } = opts.timeRange;
          if (related.occurredAt < start || related.occurredAt > end) continue;
        }
        relatedEntries.push({
          event: related,
          score: entry.score * 0.85, // slight penalty vs direct hit
          pathways: new Set([...entry.pathways, "event:related"]),
          pathwayScores: { ...entry.pathwayScores, "event:related": entry.score * 0.85 },
        });
      }
    }
    if (relatedEntries.length > 0) {
      sorted = sorted.concat(relatedEntries).sort((a, b) => b.score - a.score).slice(0, topK);
    }

    // Touch lastAccessed for surfaced events. Fire-and-forget; failures
    // here should not block recall.
    const now = Date.now();
    void Promise.all(
      sorted.map((e) => {
        e.event.meta.lastAccessed = now;
        e.event.meta.accessCount += 1;
        return this.eventStore.putEvent(e.event);
      }),
    ).catch(() => {});

    return sorted.map(({ event, score, pathways, pathwayScores, mergedSourceNodeIds }) => ({
      id: event.id,
      at: event.occurredAt,
      userId: event.userId,
      actor: event.actor,
      summary: event.description,
      tags: event.topics,
      salienceScore: event.confidence ?? 0.5,
      score,
      // Event-derived hits don't sit on the HME level axis; pick the
      // source-segment level as a honest provenance signal and rely on
      // `eventKind` to mark the layer.
      level: "segment" as MemoryLevel,
      eventKind: event.kind,
      sourceNodeIds: mergedSourceNodeIds ?? event.sourceNodeIds,
      provenance: {
        pathways: [...pathways],
        fusedScore: score,
        pathwayScores,
      },
    }));
  }

  /**
   * Cross-event dedup. The identifier can run over overlapping batches
   * and extract the same fact twice ("Alice prefers tea" as two distinct
   * MemoryEvents). Both eat topK slots without adding information.
   *
   * Collapse by normalized description (lowercase, whitespace-collapsed,
   * punctuation-stripped). The higher-scoring entry survives; the dropped
   * twin's pathway provenance and sourceNodeIds are merged in — so
   * downstream `coveredByEvent` dedup against raw nodes still sees the
   * full coverage and pathway scores stay honest.
   *
   * Events with empty descriptions can't collide, so they pass through
   * untouched.
   */
  private dedupeEventCandidates(
    candidates: Array<{
      event: MemoryEvent;
      score: number;
      pathways: Set<string>;
      pathwayScores: Record<string, number>;
      mergedSourceNodeIds?: readonly string[];
    }>,
  ): typeof candidates {
    const byDesc = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const key = normalizeEventDescription(c.event.description);
      if (!key) {
        // No usable description — can't safely collide; keep each one.
        byDesc.set(`__id:${c.event.id}`, c);
        continue;
      }
      const existing = byDesc.get(key);
      if (!existing) {
        byDesc.set(key, c);
        continue;
      }

      const [keep, drop] = c.score > existing.score ? [c, existing] : [existing, c];
      for (const p of drop.pathways) keep.pathways.add(p);
      for (const [k, v] of Object.entries(drop.pathwayScores)) {
        keep.pathwayScores[k] = Math.max(keep.pathwayScores[k] ?? 0, v);
      }
      // Combine sourceNodeIds from both events so downstream
      // node-vs-event dedup covers everything the dropped twin saw.
      const ids = new Set<string>();
      for (const id of keep.mergedSourceNodeIds ?? keep.event.sourceNodeIds) ids.add(id);
      for (const id of drop.mergedSourceNodeIds ?? drop.event.sourceNodeIds) ids.add(id);
      keep.mergedSourceNodeIds = [...ids];
      byDesc.set(key, keep);
    }
    return [...byDesc.values()];
  }

  /**
   * Outer RRF fusion between node-level recall and event-level recall. Each
   * source ranks its hits; we fuse by id (so the same memory surfaced from
   * both routes gets credit).
   *
   * Event memories typically carry richer canonical descriptions than the
   * raw nodes that backed them, so we dedupe: when an event surfaces with
   * `sourceNodeIds = [A, B]`, any raw-node hit with id A or B is dropped
   * to free its topK slot for distinct information.
   */
  private mergeNodeAndEventResults(
    nodeResult: RecallResult,
    eventMemories: RecalledMemory[],
    topK: number,
  ): RecallResult {
    if (eventMemories.length === 0) {
      return {
        memories: nodeResult.memories.slice(0, topK),
        confidence: nodeResult.confidence,
        totalScanned: nodeResult.totalScanned,
      };
    }

    // Collect raw-node IDs covered by surfaced events. Those node hits are
    // redundant — the event description is the canonical version.
    const coveredByEvent = new Set<string>();
    for (const m of eventMemories) {
      for (const sid of m.sourceNodeIds ?? []) coveredByEvent.add(sid);
    }

    const RRF_K = 60;
    const merged = new Map<
      string,
      {
        memory: RecalledMemory;
        score: number;
        pathways: Set<string>;
        pathwayScores: Record<string, number>;
      }
    >();

    let nodeRank = 0;
    for (const m of nodeResult.memories) {
      if (coveredByEvent.has(m.id)) continue; // dedupe vs surfaced events
      const inc = 1 / (RRF_K + nodeRank);
      merged.set(m.id, {
        memory: m,
        score: inc,
        pathways: new Set(m.provenance?.pathways ?? []),
        pathwayScores: { ...m.provenance?.pathwayScores },
      });
      nodeRank += 1;
    }

    for (const [rank, m] of eventMemories.entries()) {
      const inc = 1 / (RRF_K + rank);
      const existing = merged.get(m.id);
      if (existing) {
        existing.score += inc;
        for (const p of m.provenance?.pathways ?? []) existing.pathways.add(p);
        for (const [k, v] of Object.entries(m.provenance?.pathwayScores ?? {})) {
          existing.pathwayScores[k] = Math.max(existing.pathwayScores[k] ?? 0, v);
        }
      } else {
        merged.set(m.id, {
          memory: m,
          score: inc,
          pathways: new Set(m.provenance?.pathways ?? []),
          pathwayScores: { ...m.provenance?.pathwayScores },
        });
      }
    }

    const sorted = [...merged.values()].sort((a, b) => b.score - a.score);
    const memories: RecalledMemory[] = sorted.slice(0, topK).map((entry) => ({
      ...entry.memory,
      score: entry.score,
      provenance: {
        pathways: [...entry.pathways],
        fusedScore: entry.score,
        pathwayScores: entry.pathwayScores,
      },
    }));

    const totalScanned = nodeResult.totalScanned + eventMemories.length;
    const confidence =
      memories.length === 0
        ? 0
        : memories.reduce((s, m) => s + Math.min(1, m.score), 0) / memories.length;

    return { memories, confidence, totalScanned };
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
    await this.upsertNodeVector(segment);
    await this.upsertNodeTriples(segment);
    await this.evolution.processSegment(segment);
    await this.resyncVectorChainFromSegment(segment.id);
    this.subscriptions.notify(segment);
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
          p.annotations = { ...p.annotations };
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
  // Reflection (S5)
  // ═══════════════════════════════════════════════════════════

  /**
   * Generative reflection — ask the LLM to form new insights from patterns
   * across recent events. Unlike `evolve()` which is extractive (compresses
   * existing nodes), reflection is generative: it produces beliefs that were
   * never explicitly stated in any single event.
   *
   * Returns newly-generated `state` MemoryEvents plus a list of existing
   * events that were reinterpreted. Insights are automatically persisted to
   * the event store.
   *
   * Requires `MemoraiConfig.llm`. Returns empty result when no LLM is configured.
   */
  async reflect(opts: ReflectOptions = {}): Promise<ReflectionResult> {
    if (!this.config.llm) {
      return { insights: [], revisedEvents: [] };
    }
    const engine = new ReflectionEngine({ eventStore: this.eventStore, llm: this.config.llm });
    const result = await engine.reflect(opts);
    // Persist generated insights.
    for (const insight of result.insights) {
      await this.eventStore.putEvent(insight);
    }
    return result;
  }

  /**
   * Structured episodic recall — returns a narrative arc instead of a flat
   * memory list. Events are assigned roles (setup, trigger, response, climax,
   * resolution) and causal connections are identified.
   *
   * Requires `MemoraiConfig.llm` for full narrative structuring. Without an
   * LLM, falls back to a simple chronological ordering with heuristic role
   * assignment.
   */
  async recallNarrative(question: string, opts: RecallOptions = {}): Promise<NarrativeRecall> {
    const recallResult = await this.recall(question, opts);
    const builder = new NarrativeBuilder(this.config.llm);
    return builder.build(recallResult, question);
  }

  // ═══════════════════════════════════════════════════════════
  // Procedural Skills (S2)
  // ═══════════════════════════════════════════════════════════

  /**
   * Extract reusable procedural skills from recent tool_call memory nodes.
   * Scans for repeated tool invocation patterns with high success rates
   * and turns them into `ProceduralSkill` templates.
   *
   * Returns the extracted skills plus the IDs of nodes that were consumed.
   * Skills are automatically stored in `MemoraiConfig.skillStore`.
   */
  async extractSkills(opts: SkillExtractionOptions = {}): Promise<SkillExtractionResult> {
    const all = await this.config.storage.listAll();
    const extractor = new SkillExtractor();
    const result = extractor.extract(all, opts);
    for (const skill of result.skills) {
      await this.skillStore.put(skill);
    }
    return result;
  }

  /**
   * Recall procedural skills that match a natural-language query.
   * Uses substring/overlap matching against skill triggers.
   */
  async recallSkills(query: string, topK = 5): Promise<ProceduralSkill[]> {
    return this.skillStore.queryByTrigger(query, topK);
  }

  // ═══════════════════════════════════════════════════════════
  // Evolution
  // ═══════════════════════════════════════════════════════════

  /**
   * @internal Manually trigger Level-2 evolution. Normally auto-triggered.
   * Multiple concurrent calls coalesce — only one evolution runs at a time.
   *
   * When an EventIdentifier is configured, evolution also runs event
   * identification over un-identified segment nodes — turning the raw
   * timeline into MemoryEvents (state / transition / happening).
   */
  evolve(): Promise<void> {
    if (this.evolveInFlight) return this.evolveInFlight;
    const p = (async () => {
      try {
        await this.evolution.evolve();
        if (this.vectorIndex) {
          await this.resyncHigherLevelNodes();
        }
        if (this.identifier) {
          try {
            await this.identifyRecent();
          } catch (err) {
            console.error("[Memorai] event identification failed:", err);
          }
        }
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
  // MemoryEvents
  // ═══════════════════════════════════════════════════════════

  /**
   * Run event identification over un-identified segment nodes. Returns the
   * newly identified MemoryEvents. Idempotent: nodes already processed are
   * skipped. Normally called from `evolve()`; expose for explicit control.
   */
  async identifyRecent(
    opts: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<MemoryEvent[]> {
    if (!this.identifier) return [];
    const batchSize = opts.batchSize ?? 30;
    const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
    const all = await this.config.storage.listAll({ level: "segment" });
    const unidentified = all
      .filter((n) => n.meta.identifiedAt === undefined)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (unidentified.length === 0) return [];

    const out: MemoryEvent[] = [];
    let batches = 0;
    for (let i = 0; i < unidentified.length && batches < maxBatches; i += batchSize) {
      const batch = unidentified.slice(i, i + batchSize);
      const events = await this.identifyBatch(batch);
      out.push(...events);
      batches += 1;
    }
    return out;
  }

  /** Fetch a single MemoryEvent by id. */
  async getEvent(id: string): Promise<MemoryEvent | null> {
    return this.eventStore.getEvent(id);
  }

  /** List MemoryEvents with optional filtering. */
  async listEvents(
    opts: {
      userId?: string;
      kind?: MemoryEvent["kind"];
      validAt?: number;
      excludeInvalidated?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<MemoryEvent[]> {
    return this.eventStore.listEvents(opts);
  }

  /**
   * Materialized user-profile view — returns currently-valid `state` events
   * for the given tenant, optionally filtered to a specific participant
   * (the "who" the assertion is about) and/or topic.
   *
   * This is the canonical "what does the agent currently believe about X?"
   * surface. Use it for:
   *   - rendering a profile panel ("Alice prefers tea")
   *   - preamble injection ("recall everything we know about Bob then
   *     answer the question")
   *   - cross-conversation continuity (carry state forward to a new chat)
   *
   * State events that have been superseded (`invalidatedAt` set) are
   * excluded — call `listEvents` directly to see the full revision history.
   */
  async getUserFacts(
    opts: {
      userId?: string;
      participant?: string;
      topic?: string;
      limit?: number;
      /** S6: query facts that were valid at this point in time. */
      validAt?: number;
    } = {},
  ): Promise<MemoryEvent[]> {
    let candidates: MemoryEvent[];
    if (opts.participant) {
      candidates = await this.eventStore.queryEventsByParticipant(opts.participant, {
        userId: opts.userId,
        kind: "state",
        excludeInvalidated: true,
        limit: opts.limit,
      });
    } else if (opts.topic) {
      candidates = await this.eventStore.queryEventsByTopic(opts.topic, {
        userId: opts.userId,
        kind: "state",
        excludeInvalidated: true,
        limit: opts.limit,
      });
    } else {
      candidates = await this.eventStore.listEvents({
        userId: opts.userId,
        kind: "state",
        excludeInvalidated: true,
        limit: opts.limit,
      });
    }

    // When both participant and topic are supplied, AND them after the index lookup.
    if (opts.participant && opts.topic) {
      const topicLower = opts.topic.toLowerCase();
      candidates = candidates.filter((e) => e.topics.some((t) => t.toLowerCase() === topicLower));
    }

    // S6: Bi-temporal filtering — only return facts valid at the requested time.
    if (opts.validAt !== undefined) {
      candidates = candidates.filter((ev) => {
        const vs = ev.validity?.validStart ?? ev.occurredAt;
        const ve = ev.validity?.validEnd;
        if (vs > opts.validAt!) return false;
        if (ve !== undefined && ve < opts.validAt!) return false;
        return true;
      });
    }

    return candidates;
  }

  /**
   * Topic vocabulary the profile knows for a given (userId, participant?).
   * Useful for surfacing "we have facts about: preferences, role, location"
   * to a downstream UI.
   */
  async listUserTopics(opts: { userId?: string; participant?: string } = {}): Promise<string[]> {
    const facts = await this.getUserFacts(opts);
    const topics = new Set<string>();
    for (const f of facts) {
      for (const t of f.topics) topics.add(t.toLowerCase());
    }
    return [...topics].sort();
  }

  /**
   * Explicit belief revision — create a new `state` MemoryEvent that
   * supersedes one or more older state events, marking them invalidated
   * at the new event's occurredAt.
   *
   * Pattern: when the agent learns its prior belief about something was
   * wrong, call this with the old event id(s) and the new canonical
   * statement. The `reason` is stamped on the new event's `meta` so the
   * revision chain stays auditable.
   *
   * Cross-tenant supersedes are refused (mirrors `persistIdentifiedEvent`
   * behavior). Old events from a different `userId` than the new event
   * are silently skipped — only valid supersedes land on `event.supersedes`.
   */
  async reviseBelief(opts: {
    supersedes: string | readonly string[];
    description: string;
    participants?: string[];
    topics?: string[];
    occurredAt?: number;
    userId?: string;
    actor?: string;
    sourceNodeIds?: string[];
    confidence?: number;
    reason?: string;
  }): Promise<MemoryEvent | null> {
    const supersedesIds = Array.isArray(opts.supersedes)
      ? [...opts.supersedes]
      : [opts.supersedes as string];
    if (supersedesIds.length === 0) return null;

    const now = Date.now();
    const occurredAt = opts.occurredAt ?? now;

    // Pull the first valid old event to inherit defaults from when the
    // caller didn't supply participants/topics/userId/actor.
    const olds: MemoryEvent[] = [];
    for (const id of supersedesIds) {
      const old = await this.eventStore.getEvent(id);
      if (old) olds.push(old);
    }
    if (olds.length === 0) return null;
    const inheritFrom = olds[0];
    const inferredUserId = opts.userId ?? inheritFrom.userId;

    const participants = opts.participants ?? inheritFrom.participants;
    const topics = opts.topics ?? inheritFrom.topics;
    const indexable = [opts.description, ...participants, ...topics].filter(Boolean).join(" — ");
    const embedding = indexable ? await this.config.embedding.embed(indexable) : undefined;

    // Compute revision depth as max(predecessor.depth ?? 0) + 1.
    let maxDepth = 0;
    for (const old of olds) {
      const d = old.meta.revisionDepth ?? 0;
      if (d > maxDepth) maxDepth = d;
    }

    const validSupersedes: string[] = [];
    for (const old of olds) {
      if (old.userId !== inferredUserId) continue; // cross-tenant guard
      validSupersedes.push(old.id);
      if (old.invalidatedAt === undefined) {
        old.invalidatedAt = occurredAt;
        await this.eventStore.putEvent(old);
      }
    }

    const event: MemoryEvent = {
      id: generateId(),
      kind: "state",
      description: opts.description,
      participants,
      topics,
      occurredAt,
      sourceNodeIds: opts.sourceNodeIds ?? [],
      userId: inferredUserId,
      actor: opts.actor ?? inheritFrom.actor,
      embedding,
      confidence: opts.confidence,
      identifierVersion: this.identifier?.version ?? "manual-revise-v1",
      meta: {
        identifiedAt: now,
        accessCount: 0,
        revisionReason: opts.reason,
        revisionDepth: maxDepth + 1,
      },
    };
    if (validSupersedes.length > 0) event.supersedes = validSupersedes;
    await this.eventStore.putEvent(event);
    return event;
  }

  /**
   * Walk the supersedes chain backwards from `eventId`, returning the
   * full revision history oldest-first.
   *
   * Useful for surfacing "third update on Alice's preferences" or auditing
   * how the agent's belief about X evolved over time.
   */
  async revisionsOf(eventId: string): Promise<MemoryEvent[]> {
    const seen = new Set<string>();
    const collected: MemoryEvent[] = [];
    // Walk forward through the chain: starting at `eventId`, repeatedly
    // collect its `supersedes` ancestors.
    const queue: string[] = [eventId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const ev = await this.eventStore.getEvent(id);
      if (!ev) continue;
      collected.push(ev);
      if (ev.supersedes) {
        for (const oldId of ev.supersedes) {
          if (!seen.has(oldId)) queue.push(oldId);
        }
      }
    }
    collected.sort((a, b) => a.occurredAt - b.occurredAt);
    return collected;
  }

  /**
   * Check whether a new assertion contradicts any currently-valid `state`
   * events in the event store. Returns matches sorted by confidence
   * descending.
   *
   * Requires `MemoraiConfig.contradictionDetector` (or `llm` for the
   * built-in LLMContradictionDetector). Returns empty array when neither
   * is configured.
   */
  async detectContradictions(opts: {
    description: string;
    participants?: string[];
    topics?: string[];
    userId?: string;
  }): Promise<ContradictionResult[]> {
    const detector = this.config.contradictionDetector;
    if (!detector) {
      return [];
    }
    return detector.detect(opts);
  }

  private async identifyBatch(nodes: MemoryNode[]): Promise<MemoryEvent[]> {
    if (!this.identifier) return [];

    const relatedEvents = await this.fetchRelatedEvents(nodes);

    let identified: IdentifiedEvent[] = [];
    let identifyFailed = false;
    try {
      identified = await this.identifier.identify({
        nodes,
        relatedEvents,
        embedding: this.config.embedding,
        llm: this.config.llm,
        now: () => Date.now(),
      });
    } catch (err) {
      identifyFailed = true;
      console.error("[Memorai] identifier.identify failed:", err);
    }

    const produced: MemoryEvent[] = [];
    try {
      // Per-event try/catch so one bad persist doesn't take down the batch.
      for (const ident of identified) {
        try {
          const event = await this.persistIdentifiedEvent(ident, nodes);
          if (event) produced.push(event);
        } catch (err) {
          console.error("[Memorai] persistIdentifiedEvent failed:", err);
        }
      }
    } finally {
      // Stamp identifiedAt on every node so re-running the same batch
      // can't produce duplicate events for ones that succeeded.
      //
      // If the identifier call itself failed (network error, etc.), skip
      // stamping so the nodes are retried on the next evolve pass.
      //
      // For nodes that ended up covered by an identified event, also
      // mark `meta.coveredByEvent = true` and re-embed without
      // `annotations.summary` — the event's canonical `description`
      // is now the source of truth, and double-indexing the
      // LLM-paraphrased summary alongside it inflated BM25 + embedding
      // duplication (the -3.9pp `--extractor llm + --identifier llm`
      // regression we tracked in 0.4.0's published benchmarks).
      if (!identifyFailed) {
        const stamp = Date.now();
        const coveredIds = new Set<string>();
        for (const ev of produced) {
          for (const sid of ev.sourceNodeIds) coveredIds.add(sid);
        }

        const toReembed: { node: MemoryNode; text: string }[] = [];
        for (const node of nodes) {
          node.meta.identifiedAt = stamp;
          if (coveredIds.has(node.id) && !node.meta.coveredByEvent) {
            node.meta.coveredByEvent = true;
            const text = composeIndexableText(node.raw, node.annotations, {
              coveredByEvent: true,
            });
            if (text) toReembed.push({ node, text });
          }
        }

        // Batch-embed the covered subset when the embedding service supports
        // it — one round trip beats N for typical batch sizes.
        if (toReembed.length > 0) {
          try {
            const e = this.config.embedding;
            const embeddings = e.embedBatch
              ? await e.embedBatch(toReembed.map((t) => t.text))
              : await Promise.all(toReembed.map((t) => e.embed(t.text)));
            for (let i = 0; i < toReembed.length; i++) {
              toReembed[i].node.annotations.embedding = embeddings[i];
            }
          } catch (err) {
            console.error("[Memorai] re-embed covered nodes failed:", err);
          }
        }

        for (const node of nodes) {
          try {
            await this.config.storage.put(node);
            if (this.vectorIndex && coveredIds.has(node.id)) {
              await this.upsertNodeVector(node);
            }
          } catch (err) {
            console.error("[Memorai] persist covered/identified node failed:", err);
          }
        }
      }
    }

    return produced;
  }

  /**
   * Pull events relevant to the batch for supersede context. Prefers
   * participant overlap (gathered from actor / target / meta.participants —
   * the actual entity fields, NOT general tags) over "most recent N". Falls
   * back to the recent-N heuristic when the batch has no usable participant
   * signal.
   *
   * Queries are issued in parallel per (userId, participant) pair and merged
   * by id.
   */
  private async fetchRelatedEvents(nodes: MemoryNode[]): Promise<MemoryEvent[]> {
    const userIds = new Set<string | undefined>(nodes.map((n) => n.userId));
    const participants = new Set<string>();
    for (const n of nodes) {
      if (n.actor) participants.add(n.actor.toLowerCase());
      if (n.target) participants.add(n.target.toLowerCase());
      if (n.meta.participants) {
        for (const p of n.meta.participants) {
          if (p) participants.add(p.toLowerCase());
        }
      }
    }

    const PER_PARTICIPANT_LIMIT = 10;

    const tasks: Promise<MemoryEvent[]>[] = [];
    for (const userId of userIds) {
      if (participants.size === 0) {
        // No participant signal — fall back to most recent for this user.
        tasks.push(
          this.eventStore.listEvents({
            userId,
            orderBy: "occurredAt",
            order: "desc",
            limit: 50,
            excludeInvalidated: true,
          }),
        );
        continue;
      }
      for (const p of participants) {
        tasks.push(
          this.eventStore.queryEventsByParticipant(p, {
            userId,
            orderBy: "occurredAt",
            order: "desc",
            limit: PER_PARTICIPANT_LIMIT,
            excludeInvalidated: true,
          }),
        );
      }
    }

    const results = await Promise.all(tasks);
    const seen = new Map<string, MemoryEvent>();
    for (const batch of results) {
      for (const ev of batch) seen.set(ev.id, ev);
    }
    return [...seen.values()];
  }

  private async persistIdentifiedEvent(
    ident: IdentifiedEvent,
    batch: MemoryNode[],
  ): Promise<MemoryEvent | null> {
    if (!this.identifier) return null;

    const anchorNode = batch.find((n) => ident.sourceNodeIds.includes(n.id)) ?? batch[0];
    if (!anchorNode) return null;

    const indexable = [ident.description, ...ident.participants, ...ident.topics]
      .filter(Boolean)
      .join(" — ");
    const embedding = indexable ? await this.config.embedding.embed(indexable) : undefined;

    const event: MemoryEvent = {
      id: generateId(),
      kind: ident.kind,
      description: ident.description,
      participants: ident.participants,
      topics: ident.topics,
      occurredAt: ident.occurredAt,
      sourceNodeIds: ident.sourceNodeIds,
      userId: anchorNode.userId,
      actor: anchorNode.actor,
      embedding,
      confidence: ident.confidence,
      identifierVersion: this.identifier.version,
      meta: {
        identifiedAt: Date.now(),
        accessCount: 0,
      },
    };

    if (ident.relatedEventIds && ident.relatedEventIds.length > 0) {
      const validRelated: string[] = [];
      for (const relatedId of ident.relatedEventIds) {
        const related = await this.eventStore.getEvent(relatedId);
        if (!related) continue;
        if (related.userId !== event.userId) continue;
        validRelated.push(relatedId);
      }
      if (validRelated.length > 0) {
        event.relatedEventIds = validRelated;
      }
    }

    if (ident.kind === "state" && ident.supersedes && ident.supersedes.length > 0) {
      const validSupersedes: string[] = [];
      for (const oldId of ident.supersedes) {
        const old = await this.eventStore.getEvent(oldId);
        if (!old) continue;
        // Defense-in-depth against a misbehaving identifier: never let
        // an event supersede another user's record. fetchRelatedEvents
        // already scopes context per userId, but downstream callers can
        // pass arbitrary ids — refuse cross-tenant invalidation here too.
        if (old.userId !== event.userId) continue;
        validSupersedes.push(oldId);
        if (old.invalidatedAt === undefined) {
          old.invalidatedAt = event.occurredAt;
          await this.eventStore.putEvent(old);
        }
      }
      if (validSupersedes.length > 0) {
        event.supersedes = validSupersedes;
      }
    }

    await this.eventStore.putEvent(event);
    return event;
  }

  // ═══════════════════════════════════════════════════════════
  // Sleep Consolidation (S7)
  // ═══════════════════════════════════════════════════════════

  /**
   * Sleep / consolidation pass — deep memory maintenance for long-running agents.
   *
   * Orchestrates multiple maintenance tasks:
   *   1. Merge highly similar leaf segment nodes (embedding cosine > 0.95)
   *   2. Evict low-retention nodes via `forget()`
   *   3. Extract procedural skills from tool_call history
   *   4. Generate reflection insights from recent events
   *   5. Rebuild vector index if significant changes occurred
   *
   * Each step can be disabled via `SleepOptions`. The default window is
   * since the last sleep call (or last 7 days on first call).
   */
  async sleep(opts: SleepOptions = {}): Promise<SleepResult> {
    const startMs = performance.now();
    // Default window: since last sleep, or last 7 days on first run.
    const since = opts.since ?? this.lastSleptAt ?? Date.now() - 7 * 86400000;
    const result: SleepResult = {
      mergedNodes: 0,
      evictedNodes: 0,
      skillsExtracted: 0,
      insightsGenerated: 0,
      durationMs: 0,
    };

    // 1. Merge similar nodes.
    if (opts.mergeSimilar !== false) {
      result.mergedNodes = await this.mergeSimilarNodes();
    }

    // 2. Evict low-retention nodes.
    if (opts.forget !== false) {
      const forgetResult = await this.forget();
      result.evictedNodes = forgetResult.evicted;
    }

    // 3. Extract skills.
    if (opts.extractSkills !== false) {
      const skillResult = await this.extractSkills({ since });
      result.skillsExtracted = skillResult.skills.length;
    }

    // 4. Generate reflection insights.
    if (opts.reflect !== false && this.config.llm) {
      const reflectionResult = await this.reflect({ since });
      result.insightsGenerated = reflectionResult.insights.length;
    }

    // 5. Rebuild vector index if significant changes.
    if (opts.rebuildIndex !== false && this.vectorIndex) {
      const totalChange = result.mergedNodes + result.evictedNodes + result.insightsGenerated;
      if (totalChange > 5) {
        await this.rebuildVectorIndex();
      }
    }

    this.lastSleptAt = Date.now();
    result.durationMs = Math.round(performance.now() - startMs);
    return result;
  }

  private lastSleptAt?: number;

  private async mergeSimilarNodes(): Promise<number> {
    // Only merge leaf segments — merging higher-level nodes (atomic_action / episode)
    // corrupts the HME hierarchy. Also cap to avoid runaway O(n²) on large stores.
    const MAX_SCAN = 2000;
    const all = await this.config.storage.listAll({ level: "segment", limit: MAX_SCAN });
    const SIMILARITY_THRESHOLD = 0.95;
    const merged = new Set<string>();

    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (merged.has(a.id)) continue;
      if (!a.annotations.embedding) continue;

      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (merged.has(b.id)) continue;
        if (!b.annotations.embedding) continue;
        if (a.userId !== b.userId) continue;

        const sim = cosineSimilarity(a.annotations.embedding, b.annotations.embedding);
        if (sim >= SIMILARITY_THRESHOLD) {
          // Merge b into a: update children, extend raw text.
          if (b.childrenIds) {
            a.childrenIds = [...(a.childrenIds ?? []), ...b.childrenIds];
          }
          if (b.raw.text) {
            a.raw.text = a.raw.text
              ? `${a.raw.text}; ${b.raw.text}`
              : b.raw.text;
          }
          a.annotations.salienceScore = Math.max(
            a.annotations.salienceScore,
            b.annotations.salienceScore,
          );
          // Recompute embedding from merged text so the combined node
          // accurately represents both originals.
          const mergedText = composeIndexableText(a.raw, a.annotations);
          if (mergedText) {
            try {
              a.annotations.embedding = await this.config.embedding.embed(mergedText);
            } catch {
              // Keep existing embedding if recompute fails.
            }
          }
          await this.config.storage.put(a);
          if (this.vectorIndex) {
            await this.vectorIndex.upsert({
              id: a.id,
              embedding: a.annotations.embedding!,
              metadata: {},
            });
          }
          await this.config.storage.delete(b.id);
          if (this.vectorIndex) {
            await this.vectorIndex.delete(b.id);
          }
          merged.add(b.id);
        }
      }
    }

    return merged.size;
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
    if (this.vectorIndex) {
      await this.vectorIndex.delete(id);
    }
  }

  /**
   * Apply a retention policy across storage and evict low-retention nodes.
   *
   * `mode: "delete"` (default) removes nodes entirely — Tier 1 raw, Tier 2
   * annotations, Tier 3 indexes. Use this for bounded-storage deployments
   * where the raw timeline doesn't need to be preserved.
   *
   * `mode: "strip"` keeps the `MemoryNode` but clears `annotations` (Tier
   * 2) and removes the vector-index entry. The raw timeline (Tier 1) stays
   * — a later `reAnnotate()` can resurrect the node when a better
   * extractor appears. Use this when the agent's "永不忘记" promise is
   * load-bearing.
   *
   * Pass `dryRun: true` to compute counts without actually evicting —
   * useful for sizing a forgetting pass against a threshold.
   *
   * Forgetting is **not** auto-triggered. The caller decides when to run
   * it (after `evolve()`, on a schedule, on STM pressure, etc.).
   */
  async forget(opts: ForgetOptions = {}): Promise<ForgetResult> {
    const mode = opts.mode ?? "delete";
    const policy = opts.policy ?? this.retentionPolicy;
    const now = Date.now();
    const ctx = { now };

    const all = await this.config.storage.listAll();
    const candidates = opts.filter ? all.filter(opts.filter) : all;

    const toEvict: MemoryNode[] = [];
    for (const node of candidates) {
      if (policy.shouldEvict(node, ctx)) {
        toEvict.push(node);
      }
    }

    if (opts.dryRun) {
      return {
        scanned: candidates.length,
        evicted: toEvict.length,
        kept: candidates.length - toEvict.length,
        mode,
        wouldEvictIds: toEvict.map((n) => n.id),
      };
    }

    for (const node of toEvict) {
      if (mode === "delete") {
        await this.delete(node.id, false);
      } else {
        await this.stripNode(node);
      }
    }

    return {
      scanned: candidates.length,
      evicted: toEvict.length,
      kept: candidates.length - toEvict.length,
      mode,
    };
  }

  /**
   * Strip a node's Tier 2 annotations + vector-index entry while keeping
   * the Tier 1 raw record intact. `forgottenAt` is stamped on `meta` so
   * a future `reAnnotate()` knows the node was deliberately stripped.
   */
  private async stripNode(node: MemoryNode): Promise<void> {
    const stripped: MemoryNode = {
      ...node,
      annotations: {
        tags: [],
        salienceScore: 0,
        modality: node.annotations.modality,
      },
      annotatedAt: undefined,
      annotationVersion: undefined,
      meta: {
        ...node.meta,
        ...(node.meta as { forgottenAt?: number }),
        forgottenAt: Date.now(),
      } as MemoryNode["meta"] & { forgottenAt: number },
    };
    await this.config.storage.put(stripped);
    if (this.vectorIndex) {
      await this.vectorIndex.delete(node.id);
    }
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
          const indexableText = composeIndexableText(node.raw, annInput, {
            coveredByEvent: node.meta.coveredByEvent,
          });
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
        await this.upsertNodeVector(node);
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

  /**
   * Subscribe to newly-written memories that match a filter.
   *
   * When a node is written and passes the filter, `callback` is invoked
   * with the node. Use this for reactive memory: agent A writes, agent B
   * gets notified.
   *
   * Returns an {@link SubscriptionHandle} — call `unsubscribe()` to remove.
   */
  subscribe(filter: SubscribeFilter, callback: (node: MemoryNode) => void): SubscriptionHandle {
    return this.subscriptions.subscribe(filter, callback);
  }

  /**
   * Import a {@link MemorySlice} from another Memorai instance.
   *
   * Remaps IDs to avoid collisions, attaches provenance metadata, and
   * writes all nodes (and events, if present) to local storage.
   */
  async mergeSlice(slice: MemorySlice): Promise<{ importedNodes: number; importedEvents: number }> {
    const prepared = this.federation.prepareImport(slice);
    for (const node of prepared.nodes) {
      await this.config.storage.put(node);
      await this.upsertNodeVector(node);
    }
    if (prepared.events) {
      await this.eventStore.batchPutEvents(prepared.events);
    }
    return {
      importedNodes: prepared.nodes.length,
      importedEvents: prepared.events?.length ?? 0,
    };
  }

  /** Close all resources (storage, event store, background timers, etc.). */
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
    await this.eventStore.closeEventStore();
    await this.config.storage.close();
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private buildRecallQuery(
    question: string,
    opts: RecallOptions,
    intent?: QueryIntent,
  ): RetrievalQuery {
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
      intent,
    };
    return { ...base, ...opts.overrideQuery };
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
        ...m.provenance?.pathwayScores,
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

    if (opts.decompose) {
      tasks.push(
        (async () => {
          try {
            // Decompose into independent sub-questions. "Independent" is the
            // key word — paraphrases (queryExpansion) preserve intent, this
            // splits the intent. If the question isn't decomposable, the LLM
            // is instructed to return a single line equal to the original.
            const prompt =
              `Decompose the following question into 2 to 4 independent sub-questions, each retrievable from a memory store. ` +
              `If the question is already simple and cannot be broken down, output a single line equal to the original question. ` +
              `Output one sub-question per line, no numbering, no commentary.\n\n` +
              `QUESTION: ${question}\n\nSub-questions:`;
            const raw = await llm.complete(prompt, {
              temperature: 0.2,
              maxTokens: 256,
            });
            const lines = raw
              .split(/\r?\n/)
              .map((l) => l.replace(/^[\s\-•*\d.()]+/, "").trim())
              .filter((l) => l.length > 4 && l.length < 400);
            // Drop lines identical to the primary question — that's the
            // "not decomposable" output the prompt signals.
            const distinct = lines.filter((l) => l !== question).slice(0, 4);
            for (const [i, sub] of distinct.entries()) {
              variants.push({ text: sub, tag: `decompose:${i}` });
            }
          } catch {
            // best-effort; ignore decompose failures
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
              (p) =>
                p === "primary" ||
                p === "hyde" ||
                p.startsWith("expansion:") ||
                p.startsWith("decompose:"),
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
      this.idleTimer = setTimeout(() => void this.onIdle(), this.triggers.onIdleMs);
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

  private async onIdle(): Promise<void> {
    await this.evolve();
    // After evolution, run sleep consolidation to merge, reflect, extract skills.
    // Skip if sleep was run recently (< 1 min) to avoid redundant work.
    const SLEEP_COOLDOWN_MS = 60000;
    if (!this.lastSleptAt || Date.now() - this.lastSleptAt > SLEEP_COOLDOWN_MS) {
      try {
        await this.sleep();
      } catch (err) {
        console.error("[Memorai] sleep on idle failed:", err);
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Vector index — population + maintenance
  // ═══════════════════════════════════════════════════════════

  /**
   * Rebuild the configured vector index from current storage. Useful after
   * attaching a vector index to an existing store, or after swapping
   * embedding models with `reAnnotate()`.
   */
  async rebuildVectorIndex(): Promise<{ indexed: number }> {
    if (!this.vectorIndex) {
      throw new Error("Memorai.rebuildVectorIndex: no vectorIndex configured");
    }
    await this.vectorIndex.clear();
    const all = await this.config.storage.listAll();
    const records = all
      .filter((n) => n.annotations.embedding && n.annotations.embedding.length > 0)
      .map((n) => this.nodeToVectorRecord(n));
    if (records.length > 0) {
      await this.vectorIndex.upsertBatch(records);
    }
    return { indexed: records.length };
  }

  private async upsertNodeVector(node: MemoryNode): Promise<void> {
    if (!this.vectorIndex) return;
    if (!node.annotations.embedding || node.annotations.embedding.length === 0) return;
    await this.vectorIndex.upsert(this.nodeToVectorRecord(node));
  }

  private nodeToVectorRecord(node: MemoryNode) {
    return {
      id: node.id,
      embedding: node.annotations.embedding!,
      metadata: {
        userId: node.userId ?? null,
        actor: node.actor ?? null,
        target: node.target ?? null,
        level: node.level,
        timestamp: node.timestamp,
        salience: node.annotations.salienceScore,
        agentRole: node.meta.agentRole,
        parentId: node.parentId ?? null,
      },
    };
  }

  /**
   * After L1 evolution touched a segment, the segment itself may have
   * gained a parentId and the parent atomic_action's embedding may have
   * shifted. Re-upsert both so the vector index stays in sync.
   */
  private async resyncVectorChainFromSegment(segmentId: string): Promise<void> {
    if (!this.vectorIndex) return;
    const segment = await this.config.storage.get(segmentId);
    if (!segment) return;
    await this.upsertNodeVector(segment);
    if (segment.parentId) {
      const parent = await this.config.storage.get(segment.parentId);
      if (parent) await this.upsertNodeVector(parent);
    }
  }

  /**
   * After L2 evolution, sweep atomic_action + episode nodes and re-upsert
   * their (possibly merged) embeddings. Bounded — these levels are far
   * smaller than the segment population, and the upsert is idempotent.
   */
  private async resyncHigherLevelNodes(): Promise<void> {
    if (!this.vectorIndex) return;
    const all = await this.config.storage.listAll();
    const records = all
      .filter(
        (n) =>
          (n.level === "atomic_action" || n.level === "episode") &&
          n.annotations.embedding &&
          n.annotations.embedding.length > 0,
      )
      .map((n) => this.nodeToVectorRecord(n));
    if (records.length > 0) {
      await this.vectorIndex.upsertBatch(records);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Entity graph — population + queries
  // ═══════════════════════════════════════════════════════════

  /** Upsert a (subject, predicate, object) edge into the configured graph. */
  async upsertGraphEdge(input: UpsertEdgeInput): Promise<GraphEdge | null> {
    if (!this.entityGraph) return null;
    return this.entityGraph.upsertEdge(input);
  }

  /** Neighbors of an entity in the configured graph (edges in either direction). */
  async graphNeighbors(
    entity: string,
    opts: {
      userId?: string;
      predicate?: string;
      limit?: number;
      excludeInvalidated?: boolean;
    } = {},
  ): Promise<GraphEdge[]> {
    if (!this.entityGraph) return [];
    return this.entityGraph.queryNeighbors(entity, {
      userId: opts.userId,
      predicate: opts.predicate,
      excludeInvalidated: opts.excludeInvalidated,
      limit: opts.limit,
    });
  }

  /** Shortest paths between two entities, up to `maxDepth` hops. */
  async graphPaths(
    from: string,
    to: string,
    opts: { maxDepth?: number; userId?: string; limit?: number } = {},
  ): Promise<GraphPath[]> {
    if (!this.entityGraph) return [];
    return this.entityGraph.queryPaths(from, to, opts);
  }

  /**
   * Pull (subject, predicate, object) triples from the node's Tier 2
   * annotations into the configured entity graph. No-op when no graph is
   * configured or the node has no triples.
   */
  private async upsertNodeTriples(node: MemoryNode): Promise<void> {
    if (!this.entityGraph) return;
    const triples = node.annotations.triples;
    if (!triples || triples.length === 0) return;
    const inputs: UpsertEdgeInput[] = triples.map((t) => ({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      confidence: t.confidence,
      sourceNodeId: node.id,
      userId: node.userId,
      validAt: node.timestamp,
    }));
    try {
      await this.entityGraph.upsertEdges(inputs);
    } catch (err) {
      console.error("[Memorai] entityGraph.upsertEdges failed:", err);
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
 * Normalize a MemoryEvent description for dedup comparison. Lowercases,
 * collapses whitespace, and strips punctuation — so "Alice prefers tea."
 * and "alice prefers tea" collapse to the same key.
 */
function buildTemporalResolutionPrompt(question: string, events: MemoryEvent[]): string {
  const eventLines = events
    .map(
      (e, i) =>
        `${i + 1}. [${new Date(e.occurredAt).toISOString()}] ${e.description} (participants: ${e.participants.join(", ")})`,
    )
    .join("\n");

  return `You are a temporal-resolution assistant. Given a question with a time expression and a list of recent events, resolve the expression to an absolute time range.

QUESTION: "${question}"

RECENT EVENTS (newest first):
${eventLines}

Respond with JSON only:
{
  "start": <unix timestamp ms>,
  "end": <unix timestamp ms>
}

Guidance:
- "start" and "end" are Unix timestamps in milliseconds.
- If the expression refers to "when we last spoke", use the most recent event involving the query's participants.
- If the expression is "around that time", use a ±12h window around the referenced event.
- If truly unresolvable, return {"start": 0, "end": 0}.
- No prose, no commentary — JSON only.`;
}

function normalizeEventDescription(s: string | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
export {
  TransformersReranker,
  loadXenovaCrossEncoder,
  type CrossEncoderScoreFn,
} from "./reranker-transformers.js";
export { IndexedDBAdapter, MemoryAdapter } from "./storage/index.js";
export {
  CLIPEmbedder,
  OllamaEmbeddingService,
  OpenAIEmbeddingService,
} from "./embeddings/index.js";
export { EvolutionEngine } from "./evolution.js";
export { RetrievalEngine, extractEntityTokens } from "./retrieval.js";
export {
  InMemoryEventStore,
  LLMEventIdentifier,
  SQLiteEventStore,
  IndexedDBEventStore,
} from "./events/index.js";
export { LLMContradictionDetector } from "./contradiction.js";
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
  extractTemporalAnchors,
  MultimodalExtractor,
  type AudioTranscriber,
  type ImageCaptioner,
  type MultimodalExtractorOptions,
} from "./extraction/index.js";
export {
  BruteForceVectorIndex,
  HnswVectorIndex,
  HnswWasmVectorIndex,
  USearchVectorIndex,
  loadHnswlib,
  loadHnswWasm,
  loadUSearch,
  matchFilter,
  matchFilterClause,
  type HnswlibIndex,
  type HnswVectorIndexOptions,
  type HnswWasmIndex,
  type HnswWasmVectorIndexOptions,
  type USearchIndex,
  type USearchIndexOptions,
  type USearchVectorIndexOptions,
  type VectorFilter,
  type VectorFilterClause,
  type VectorIndex,
  type VectorMetadata,
  type VectorMetadataValue,
  type VectorQueryOptions,
  type VectorQueryResult,
  type VectorRecord,
} from "./vector/index.js";
export {
  InMemoryEntityGraph,
  IndexedDBEntityGraph,
  SQLiteEntityGraph,
  canonicalName as graphCanonicalName,
  edgePassesFilter,
  type EdgeFilter,
  type EntityGraph,
  type GraphEdge,
  type GraphEntity,
  type GraphPath,
  type UpsertEdgeInput,
} from "./graph/index.js";
export { resolveTimeExpression, type ResolvedTimeRange } from "./temporal/index.js";
export {
  IterativeRecaller,
  type IterativeJudgment,
  type IterativeRecallOptions,
  type IterativeRecallResult,
  type IterativeRecallStep,
} from "./iterative.js";
export {
  StreamIngestor,
  type StreamIngestorOptions,
  type StreamResult,
} from "./stream.js";
export {
  InMemoryWorkingMemory,
  type SetOptions as WorkingMemorySetOptions,
  type WorkingMemory,
  type WorkingMemoryEntry,
} from "./working/index.js";
export {
  DefaultRetentionPolicy,
  type DefaultRetentionPolicyOptions,
  type ForgetMode,
  type ForgetOptions,
  type ForgetResult,
  type RetentionContext,
  type RetentionPolicy,
} from "./retention/index.js";
export {
  PassthroughQuantizer,
  ScalarQuantizer,
  type EmbeddingQuantizer,
} from "./quantizer.js";
export {
  MemoryFederation,
  SubscriptionRegistry,
} from "./federation.js";
export { ReflectionEngine } from "./reflection.js";
export {
  NarrativeBuilder,
} from "./narrative.js";
export {
  InMemorySkillStore,
  SkillExtractor,
  type ProceduralSkill,
  type SkillExtractionOptions,
  type SkillExtractionResult,
  type SkillStep,
  type SkillStore,
} from "./skills/index.js";

// Suppress unused import warnings for types that are re-exported via types.js
export type {
  Event,
  AutoEvolveTriggers,
  ExplainResult,
  Extractor,
  MemorySlice,
  NodePatch,
  RecallOptions,
  RecallResult,
  RecallSpan,
  RecalledMemory,
  RecordHandle,
  SubscribeFilter,
  SubscriptionHandle,
} from "./types.js";
