import { cosineSimilarity } from "./utils.js";
import type {
  MemoryNode,
  RetrievalQuery,
  RetrievalResult,
  RetrievalStrategy,
  StorageAdapter,
  TraversalOrder,
  TraversalStats,
} from "./types.js";

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
  constructor(private readonly storage: StorageAdapter) {}

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
    let n = 0;
    if (query.embedding) n += 1;
    if (query.text) n += 2; // bm25 + tag
    if (query.timeRange) n += 1;
    if (query.strategy === "exploratory" || traversal === "salience") n += 1;
    if (query.userId) n += 1;
    if (query.actor) n += 1;
    if (query.target) n += 1;
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

    if (query.embedding) {
      tasks.push(this.runPathway("semantic", () => this.semanticPathway(query)));
    }
    if (query.text) {
      tasks.push(this.runPathway("bm25", () => this.bm25Pathway(query)));
      tasks.push(this.runPathway("tag", () => this.tagPathway(query)));
    }
    if (query.timeRange) {
      tasks.push(
        this.runPathway("time", () =>
          this.timePathway(query.timeRange!.start, query.timeRange!.end),
        ),
      );
    }
    if (query.strategy === "exploratory" || traversal === "salience") {
      tasks.push(this.runPathway("salience", () => this.saliencePathway()));
    }
    if (query.userId) {
      tasks.push(this.runPathway("userId", () => this.identityPathway("userId", query.userId!)));
    }
    if (query.actor) {
      tasks.push(this.runPathway("actor", () => this.identityPathway("actor", query.actor!)));
    }
    if (query.target) {
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
    const all = await this.storage.listAll();
    const candidates = all.filter((n) => n.annotations.embedding);
    const k = query.maxCandidates ?? PATHWAY_DEPTH;
    const minThreshold = 0.3;
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
          if (n.level === "event") boost *= 1.3;
          const ageHours = (Date.now() - n.timestamp) / 3600000;
          boost *= Math.max(0.5, 1 - ageHours / 168);
          return { ...n, _score: n._score * boost };
        });
        break;
      case "inferential":
        results = results.map((n) => {
          let boost = 1;
          if (n.level === "event") boost *= 1.4;
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
