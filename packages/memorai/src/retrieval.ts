import { cosineSimilarity } from "./utils.js";
import type {
  IntentClassifier,
  MemoryNode,
  QueryIntent,
  RetrievalQuery,
  RetrievalResult,
  RetrievalStrategy,
  StorageAdapter,
  TraversalOrder,
  TraversalStats,
} from "./types.js";
import type { EntityGraph } from "./graph/types.js";
import type { VectorFilter, VectorIndex } from "./vector/types.js";

/** Reciprocal-Rank-Fusion constant. Standard literature value. */
const RRF_K = 60;
/** Default depth each pathway fetches before fusion. */
const PATHWAY_DEPTH = 50;
/** Internal annotation we attach to nodes during retrieval. */
type Annotated = MemoryNode & {
  _score: number;
  _pathways: string[];
  _pathwayScores: Record<string, number>;
};

/**
 * Multi-pathway retrieval engine with Reciprocal Rank Fusion.
 *
 * Each pathway (semantic / bm25 / tag / time / salience / userId / actor /
 * target) returns its own ranked list. The lists are fused by RRF:
 *
 *     fusedScore(doc) = Σ_pathway 1 / (k + rank_pathway(doc))
 *
 * A document surfacing in multiple pathways gets a multiplicative trust
 * boost. The per-pathway origin and raw scores are kept on each result so
 * `recall()` can attach a `provenance` field that explains *why* a memory
 * was returned.
 */
export class RetrievalEngine {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly vectorIndex: VectorIndex | undefined = undefined,
    private readonly entityGraph: EntityGraph | undefined = undefined,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startTime = performance.now();
    const stats: TraversalStats = {
      scanned: 0,
      matched: 0,
      pruned: 0,
      timeMs: 0,
    };

    const traversal = query.traversalOrder ?? "reverse";

    // 1. Run pathways in parallel, fuse via RRF, attach provenance.
    const candidates = await this.buildCandidateSet(query, traversal, stats);

    // 2. Strategy-driven filters + boosts.
    const filtered = this.applyStrategyFilters(query, candidates);

    // 3. Re-rank by traversal order.
    const ranked = this.reRank(query, filtered, traversal);

    // 4. Slice + early-stop.
    const result = this.applyStopCriteria(query, ranked);

    stats.matched = result.nodes.length;
    stats.pruned = stats.scanned - stats.matched;
    stats.timeMs = Math.round(performance.now() - startTime);

    // Confidence: fraction of *active* pathways that agreed on the top
    // results. High when 3+ routes all surfaced the same docs; low when
    // only one route found anything.
    const totalPathways = this.countActivePathways(query, traversal);
    const confidence =
      result.nodes.length === 0
        ? 0
        : Math.min(
            1,
            result.nodes.reduce(
              (sum, n) => sum + Math.min(1, n._pathways.length / Math.max(1, totalPathways)),
              0,
            ) / result.nodes.length,
          );

    return { nodes: result.nodes, confidence, traversalStats: stats };
  }

  private countActivePathways(query: RetrievalQuery, traversal: TraversalOrder): number {
    const intent = query.intent ?? "unknown";
    let n = 0;
    if (query.embedding && pathwayMatchesIntent("semantic", intent)) n += 1;
    if (query.text) {
      if (pathwayMatchesIntent("bm25", intent)) n += 1;
      if (pathwayMatchesIntent("tag", intent)) n += 1;
      if (this.entityGraph && pathwayMatchesIntent("graph", intent)) n += 1;
      if (pathwayMatchesIntent("temporalAnchor", intent)) n += 1;
    }
    if (query.timeRange && pathwayMatchesIntent("time", intent)) n += 1;
    if ((query.strategy === "exploratory" || traversal === "salience") && pathwayMatchesIntent("salience", intent)) {
      n += 1;
    }
    if (query.userId && pathwayMatchesIntent("identity", intent)) n += 1;
    if (query.actor && pathwayMatchesIntent("identity", intent)) n += 1;
    if (query.target && pathwayMatchesIntent("identity", intent)) n += 1;
    return Math.max(1, n);
  }

  // ─── Multi-pathway candidate pipeline ───

  private async buildCandidateSet(
    query: RetrievalQuery,
    traversal: TraversalOrder,
    stats: TraversalStats,
  ): Promise<Annotated[]> {
    // Each pathway returns a *ranked* list. Rank starts at 0 (best).
    const tasks: Array<Promise<{ name: string; ranked: Array<{ id: string; score: number }> }>> =
      [];

    // S1: Adaptive pathway selection — skip pathways irrelevant to query intent.
    const intent = query.intent ?? "unknown";
    const shouldRun = (pathway: string) => pathwayMatchesIntent(pathway, intent);

    if (query.embedding && shouldRun("semantic")) {
      tasks.push(this.runPathway("semantic", () => this.semanticPathway(query)));
    }
    if (query.text) {
      if (shouldRun("bm25")) {
        tasks.push(this.runPathway("bm25", () => this.bm25Pathway(query)));
      }
      if (shouldRun("tag")) {
        tasks.push(this.runPathway("tag", () => this.tagPathway(query)));
      }
      if (this.entityGraph && shouldRun("graph")) {
        tasks.push(this.runPathway("graph", () => this.graphPathway(query)));
      }
      if (shouldRun("temporalAnchor")) {
        tasks.push(this.runPathway("temporalAnchor", () => this.temporalAnchorPathway(query)));
      }
    }
    if (query.timeRange && shouldRun("time")) {
      tasks.push(
        this.runPathway("time", () =>
          this.timePathway(query.timeRange!.start, query.timeRange!.end),
        ),
      );
    }
    if ((query.strategy === "exploratory" || traversal === "salience") && shouldRun("salience")) {
      tasks.push(this.runPathway("salience", () => this.saliencePathway()));
    }
    if (query.userId && shouldRun("identity")) {
      tasks.push(this.runPathway("userId", () => this.identityPathway("userId", query.userId!)));
    }
    if (query.actor && shouldRun("identity")) {
      tasks.push(this.runPathway("actor", () => this.identityPathway("actor", query.actor!)));
    }
    if (query.target && shouldRun("identity")) {
      tasks.push(this.runPathway("target", () => this.identityPathway("target", query.target!)));
    }

    if (tasks.length === 0) {
      // No signal at all — fall back to listAll, ranked by salience.
      tasks.push(this.runPathway("fallback", () => this.saliencePathway()));
    }

    const results = await Promise.allSettled(tasks);

    // Fuse via RRF — accumulate per-doc fused score + provenance.
    const fused = new Map<
      string,
      { score: number; pathways: string[]; pathwayScores: Record<string, number> }
    >();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { name, ranked } = r.value;
      for (const [rank, hit] of ranked.entries()) {
        let entry = fused.get(hit.id);
        if (!entry) {
          entry = { score: 0, pathways: [], pathwayScores: {} };
          fused.set(hit.id, entry);
        }
        entry.score += 1 / (RRF_K + rank);
        entry.pathways.push(name);
        entry.pathwayScores[name] = hit.score;
      }
    }

    stats.scanned = fused.size;

    // Hydrate node objects.
    const ids = [...fused.keys()];
    const hydrated = await Promise.all(ids.map((id) => this.storage.get(id)));
    const annotated: Annotated[] = [];
    for (const [i, node] of hydrated.entries()) {
      if (!node) continue;
      const meta = fused.get(ids[i])!;
      annotated.push({
        ...node,
        _score: meta.score,
        _pathways: meta.pathways,
        _pathwayScores: meta.pathwayScores,
      });
    }

    return annotated;
  }

  private async runPathway(
    name: string,
    runner: () => Promise<Array<{ id: string; score: number }>>,
  ): Promise<{ name: string; ranked: Array<{ id: string; score: number }> }> {
    const ranked = await runner();
    return { name, ranked };
  }

  private async semanticPathway(
    query: RetrievalQuery,
  ): Promise<Array<{ id: string; score: number }>> {
    const k = query.maxCandidates ?? PATHWAY_DEPTH;
    const minThreshold = 0.3;

    // Fast path: dedicated vector index.
    if (this.vectorIndex) {
      const filter: VectorFilter = {};
      if (query.userId !== undefined) filter.userId = query.userId;
      if (query.actor !== undefined) filter.actor = query.actor;
      if (query.target !== undefined) filter.target = query.target;
      if (query.level !== undefined) filter.level = query.level;
      if (query.timeRange) {
        filter.timestamp = { range: query.timeRange };
      }
      const hits = await this.vectorIndex.query(query.embedding!, {
        topK: k,
        minScore: minThreshold,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      });
      return hits.map((h) => ({ id: h.id, score: h.score }));
    }

    // Fallback: linear scan over all nodes.
    const all = await this.storage.listAll();
    const candidates = all.filter((n) => n.annotations.embedding);
    const heap: Array<{ node: MemoryNode; score: number }> = [];

    for (const n of candidates) {
      const score = cosineSimilarity(query.embedding!, n.annotations.embedding!);
      if (score < minThreshold) continue;
      if (heap.length < k) {
        heap.push({ node: n, score });
        this.heapifyUp(heap, heap.length - 1);
      } else if (score > heap[0].score) {
        heap[0] = { node: n, score };
        this.heapifyDown(heap, 0);
      }
    }
    heap.sort((a, b) => b.score - a.score);
    return heap.map((s) => ({ id: s.node.id, score: s.score }));
  }

  private async bm25Pathway(query: RetrievalQuery): Promise<Array<{ id: string; score: number }>> {
    const limit = query.maxCandidates ?? PATHWAY_DEPTH;
    const nodes = await this.storage.queryByText(query.text!, { limit });
    // queryByText returns BM25-sorted; preserve order.
    return nodes.map((n, i) => ({ id: n.id, score: limit - i }));
  }

  private async tagPathway(query: RetrievalQuery): Promise<Array<{ id: string; score: number }>> {
    const words = query
      .text!.toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return [];
    const nodes = await this.storage.queryByTags(words);
    // Rank by how many query terms appear in tags (descending).
    const scored = nodes.map((n) => {
      const tagSet = new Set(n.annotations.tags.map((t) => t.toLowerCase()));
      const hits = words.filter((w) => tagSet.has(w)).length;
      return { id: n.id, score: hits };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, PATHWAY_DEPTH);
  }

  /**
   * Graph-aware pathway. Seeds on entity tokens from the query text, then
   * runs a confidence-weighted random-walk over the knowledge graph.
   *
   * Improvement over the previous BFS + additive scoring:
   *   - Path score = product(edge.confidence) so high-confidence chains rank
   *     above many low-confidence ones
   *   - Best-first exploration (Dijkstra-style) instead of breadth-first
   *   - Allows re-visiting entities via better paths; keeps the best score
   *   - Seeds get a teleport probability (1 - alpha) for PPR-like behavior
   *
   * For small graphs (< 1K edges) this walks up to 3 hops. For larger graphs
   * it stays at 1 hop to keep latency bounded.
   */
  private async graphPathway(query: RetrievalQuery): Promise<Array<{ id: string; score: number }>> {
    if (!this.entityGraph) return [];
    const tokens = extractEntityTokens(query.text!);
    if (tokens.length === 0) return [];

    const graphSize = await this.entityGraph.size();
    const maxHops = graphSize.edges < 1000 ? 3 : 1;
    const alpha = 0.85; // PPR continue probability

    // entity -> best path confidence from any seed
    const entityScore = new Map<string, number>();
    // sourceNodeId -> best score from any path that touched it
    const nodeScore = new Map<string, number>();

    type Frontier = { entity: string; pathConfidence: number; depth: number };
    const heap: Frontier[] = [];

    // Seed: initialize frontier with query tokens at confidence 1
    for (const token of tokens) {
      heap.push({ entity: token, pathConfidence: 1, depth: 0 });
      entityScore.set(token, 1);

      // Depth-0 edges: direct neighbors of query tokens
      let edges: import("./graph/types.js").GraphEdge[];
      try {
        edges = await this.entityGraph.queryNeighbors(token, {
          userId: query.userId,
          excludeInvalidated: true,
          limit: PATHWAY_DEPTH,
        });
      } catch {
        continue;
      }
      for (const e of edges) {
        if (e.sourceNodeId) {
          const w = (e.confidence ?? 0.5) * 2; // normalize to [0,1] roughly
          nodeScore.set(e.sourceNodeId, Math.max(nodeScore.get(e.sourceNodeId) ?? 0, w));
        }
      }
    }

    if (maxHops <= 1 || heap.length === 0) {
      const sorted = [...nodeScore.entries()].map(([id, score]) => ({ id, score }));
      sorted.sort((a, b) => b.score - a.score);
      return sorted.slice(0, PATHWAY_DEPTH);
    }

    // Best-first multi-hop walk
    while (heap.length > 0) {
      // Pop highest-confidence frontier (simple linear scan — PATHWAY_DEPTH is small)
      let bestIdx = 0;
      for (let i = 1; i < heap.length; i++) {
        if (heap[i].pathConfidence > heap[bestIdx].pathConfidence) bestIdx = i;
      }
      const cur = heap.splice(bestIdx, 1)[0];

      if (cur.depth >= maxHops) continue;

      let edges: import("./graph/types.js").GraphEdge[];
      try {
        edges = await this.entityGraph.queryNeighbors(cur.entity, {
          userId: query.userId,
          excludeInvalidated: true,
          limit: PATHWAY_DEPTH,
        });
      } catch {
        continue;
      }

      for (const e of edges) {
        const other = e.subject === cur.entity ? e.object : e.subject;
        const edgeConf = e.confidence ?? 0.5;
        const nextConf = cur.pathConfidence * edgeConf * alpha;

        // Only expand if this is a better path to `other`
        const existing = entityScore.get(other) ?? 0;
        if (nextConf <= existing) continue;

        entityScore.set(other, nextConf);
        heap.push({ entity: other, pathConfidence: nextConf, depth: cur.depth + 1 });

        if (e.sourceNodeId) {
          nodeScore.set(e.sourceNodeId, Math.max(nodeScore.get(e.sourceNodeId) ?? 0, nextConf));
        }
      }
    }

    const sorted = [...nodeScore.entries()].map(([id, score]) => ({ id, score }));
    sorted.sort((a, b) => b.score - a.score);
    return sorted.slice(0, PATHWAY_DEPTH);
  }

  /**
   * Temporal-anchor pathway. For each entity-like token in the query, look up
   * nodes that carry a temporal anchor with a matching canonical name. A node
   * referenced by more (or higher-confidence) anchors ranks higher.
   */
  private async temporalAnchorPathway(query: RetrievalQuery): Promise<Array<{ id: string; score: number }>> {
    const tokens = extractEntityTokens(query.text!);
    if (tokens.length === 0) return [];

    const scores = new Map<string, number>();
    for (const token of tokens) {
      let nodes: MemoryNode[];
      try {
        nodes = await this.storage.queryByTemporalAnchor(token, {
          limit: PATHWAY_DEPTH,
        });
      } catch {
        continue;
      }
      for (const n of nodes) {
        if (!n.annotations.temporalAnchors) continue;
        for (const a of n.annotations.temporalAnchors) {
          const weight =
            (a.confidence ?? 0.5) *
            (a.type === "milestone" || a.type === "deadline" ? 1.5 : 1.0);
          scores.set(n.id, (scores.get(n.id) ?? 0) + weight);
        }
      }
    }

    const sorted = [...scores.entries()].map(([id, score]) => ({ id, score }));
    sorted.sort((a, b) => b.score - a.score);
    return sorted.slice(0, PATHWAY_DEPTH);
  }

  private async timePathway(
    start: number,
    end: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const nodes = await this.storage.queryByTimeRange(start, end);
    // Rank by recency within the window — most recent gets rank 0.
    return nodes
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, PATHWAY_DEPTH)
      .map((n, i) => ({ id: n.id, score: PATHWAY_DEPTH - i }));
  }

  private async saliencePathway(): Promise<Array<{ id: string; score: number }>> {
    const nodes = await this.storage.queryBySalience(0.5);
    return nodes
      .sort((a, b) => b.annotations.salienceScore - a.annotations.salienceScore)
      .slice(0, PATHWAY_DEPTH)
      .map((n) => ({ id: n.id, score: n.annotations.salienceScore }));
  }

  private async identityPathway(
    kind: "userId" | "actor" | "target",
    value: string,
  ): Promise<Array<{ id: string; score: number }>> {
    const nodes =
      kind === "userId"
        ? await this.storage.queryByUserId(value)
        : kind === "actor"
          ? await this.storage.queryByActor(value)
          : await this.storage.queryByTarget(value);
    // Identity match: rank by recency, all matches get a non-zero score.
    return nodes
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, PATHWAY_DEPTH)
      .map((n, i) => ({ id: n.id, score: PATHWAY_DEPTH - i }));
  }

  // ─── Strategy-driven filters ───

  private applyStrategyFilters(query: RetrievalQuery, candidates: Annotated[]): Annotated[] {
    let results = candidates;

    // Level filter — fallback to all levels if requested level has no matches.
    if (query.level) {
      const filtered = results.filter((n) => n.level === query.level);
      if (filtered.length > 0) {
        results = filtered;
      }
    }

    if (query.timeRange) {
      results = results.filter(
        (n) => n.timestamp >= query.timeRange!.start && n.timestamp <= query.timeRange!.end,
      );
    }
    if (query.agentRole) {
      results = results.filter((n) => n.meta.agentRole === query.agentRole);
    }
    if (query.userId) results = results.filter((n) => n.userId === query.userId);
    if (query.actor) results = results.filter((n) => n.actor === query.actor);
    if (query.target) results = results.filter((n) => n.target === query.target);

    switch (query.strategy) {
      case "factual":
        results = results.map((n) => {
          let boost = 1;
          if (n.level === "atomic_action") boost *= 1.2;
          if (n.annotations.salienceScore > 0.8) boost *= 1.1;
          return { ...n, _score: n._score * boost };
        });
        break;
      case "temporal":
        results = results.map((n) => {
          let boost = 1;
          if (n.level === "episode") boost *= 1.3;
          const ageHours = (Date.now() - n.timestamp) / 3600000;
          boost *= Math.max(0.5, 1 - ageHours / 168);
          return { ...n, _score: n._score * boost };
        });
        break;
      case "inferential":
        results = results.map((n) => {
          let boost = 1;
          if (n.level === "episode") boost *= 1.4;
          if (n.childrenIds && n.childrenIds.length > 2) boost *= 1.2;
          return { ...n, _score: n._score * boost };
        });
        break;
      case "exploratory":
        results = results.map((n) => {
          let boost = 1;
          if (n.annotations.modality.includes("multimodal")) boost *= 1.2;
          return { ...n, _score: n._score * boost };
        });
        break;
      case "procedural":
        results = results.map((n) => {
          let boost = 1;
          const kind = n.raw.content.kind;
          if (kind === "tool_call") {
            boost *= 1.5;
            // Failed calls are higher-signal for "what went wrong" queries.
            if (n.raw.content.success === false) boost *= 1.2;
          } else if (kind === "plan_step") {
            boost *= 1.2;
          }
          const ageHours = (Date.now() - n.timestamp) / 3600000;
          // Procedural memory decays faster than factual — recent attempts
          // are usually what matters. Half-life ~3 days.
          boost *= Math.max(0.4, 1 - ageHours / 72);
          return { ...n, _score: n._score * boost };
        });
        break;
    }

    return results;
  }

  // ─── Temporal traversal ordering ───

  private reRank(
    _query: RetrievalQuery,
    candidates: Annotated[],
    traversal: TraversalOrder,
  ): Annotated[] {
    switch (traversal) {
      case "forward":
        candidates.sort((a, b) => {
          const timeDiff = a.timestamp - b.timestamp;
          if (timeDiff !== 0) return timeDiff;
          return b._score - a._score;
        });
        break;
      case "reverse":
        candidates.sort((a, b) => {
          const timeDiff = b.timestamp - a.timestamp;
          if (timeDiff !== 0) return timeDiff;
          return b._score - a._score;
        });
        break;
      case "salience":
        candidates.sort((a, b) => {
          const compositeA = 0.6 * a._score + 0.4 * a.annotations.salienceScore;
          const compositeB = 0.6 * b._score + 0.4 * b.annotations.salienceScore;
          return compositeB - compositeA;
        });
        break;
    }
    return candidates;
  }

  // ─── Early-stop ───

  private applyStopCriteria(query: RetrievalQuery, ranked: Annotated[]): { nodes: Annotated[] } {
    const topK = query.topK ?? 5;
    const maxDepth = query.maxCandidates ?? topK * 2;
    let results = ranked.slice(0, maxDepth);

    if (query.earlyStop) {
      const strategyStopThreshold: Record<RetrievalStrategy, number> = {
        factual: 0.05,
        temporal: 0.04,
        inferential: 0.03,
        exploratory: 0.02,
        procedural: 0.04,
      };
      const threshold = strategyStopThreshold[query.strategy];

      let stopIndex = results.length;
      for (const [i, result] of results.entries()) {
        if (result._score < threshold && i >= topK) {
          stopIndex = i;
          break;
        }
      }
      results = results.slice(0, Math.max(topK, stopIndex));
    }

    results = results.slice(0, topK);
    return { nodes: results };
  }

  // ─── Heap helpers for semantic top-K ───

  private heapifyUp(heap: Array<{ node: MemoryNode; score: number }>, i: number) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent].score <= heap[i].score) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  private heapifyDown(heap: Array<{ node: MemoryNode; score: number }>, i: number) {
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < heap.length && heap[left].score < heap[smallest].score) smallest = left;
      if (right < heap.length && heap[right].score < heap[smallest].score) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
}

/**
 * Pull entity-like tokens out of a natural-language query. We're permissive
 * here: lowercase the input, split on non-word boundaries, drop short tokens
 * and common stopwords. The graph pathway then probes each candidate.
 *
 * False positives are fine — the graph will simply return zero neighbors
 * for them — but false negatives miss valid graph entry points, so we err
 * on the side of inclusion.
 */
const ENTITY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "who",
  "how",
  "why",
  "when",
  "where",
  "did",
  "does",
  "are",
  "was",
  "were",
  "is",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "from",
  "about",
  "have",
  "has",
  "had",
  "been",
  "being",
  "tell",
  "told",
  "say",
  "said",
  "ask",
  "asked",
  "want",
  "wanted",
  "like",
  "likes",
  "liked",
]);

export function extractEntityTokens(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const token = raw.trim();
    if (token.length < 3) continue;
    if (ENTITY_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

// ─── S1: Adaptive Pathway Selection ───

/** Which pathways should run for a given query intent? */
function pathwayMatchesIntent(pathway: string, intent: QueryIntent): boolean {
  // "unknown" and "multi-hop" run everything (no filtering).
  if (intent === "unknown" || intent === "multi-hop") return true;

  switch (intent) {
    case "identity":
      // Identity queries need semantic, bm25, identity pathways, light graph.
      return ["semantic", "bm25", "tag", "graph", "identity", "salience", "fallback"].includes(
        pathway,
      );
    case "temporal":
      // Temporal queries need time-based pathways + semantic/bm25 for content.
      return ["semantic", "bm25", "tag", "temporalAnchor", "time", "salience", "fallback"].includes(
        pathway,
      );
    case "procedural":
      // Procedural queries need semantic, bm25, tag — graph rarely helps.
      return ["semantic", "bm25", "tag", "salience", "fallback"].includes(pathway);
    case "factual":
      // Factual queries benefit from most pathways. time and identity are
      // already gated by query.timeRange / query.userId in buildCandidateSet.
      return [
        "semantic",
        "bm25",
        "tag",
        "graph",
        "temporalAnchor",
        "time",
        "identity",
        "salience",
        "fallback",
      ].includes(pathway);
    default:
      return true;
  }
}

/** Keyword-based intent classifier — zero latency, no external calls. */
export class RuleBasedIntentClassifier implements IntentClassifier {
  async classify(queryText: string): Promise<{ intent: QueryIntent; confidence: number }> {
    const lower = queryText.toLowerCase();

    // Temporal indicators
    if (
      /\b(before|after|during|since|until|around|near|yesterday|today|tomorrow|last week|last month|ago|\d+\s+(minute|hour|day|week|month|year)s?\s+ago)\b/.test(
        lower,
      )
    ) {
      return { intent: "temporal", confidence: 0.85 };
    }

    // Procedural indicators
    if (/\b(how\s+(to|do|can|should)|deploy|run|install|setup|configure|build|execute|command)\b/.test(lower)) {
      return { intent: "procedural", confidence: 0.8 };
    }

    // Identity indicators
    if (/\b(who|what\s+does|what\s+is|likes?|prefers?|favorite|name|age|job|works?\s+at)\b/.test(lower)) {
      return { intent: "identity", confidence: 0.75 };
    }

    // Multi-hop indicators
    if (/\b(why|because|since|reason|caused|led\s+to|resulted\s+in|who\s+.*\s+where|what\s+.*\s+when)\b/.test(lower)) {
      return { intent: "multi-hop", confidence: 0.7 };
    }

    // Default: factual
    return { intent: "factual", confidence: 0.6 };
  }
}
