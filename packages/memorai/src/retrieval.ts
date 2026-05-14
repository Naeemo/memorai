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

/**
 * Advanced retrieval engine (Phase 3).
 *
 * Features:
 * 1. Command-driven retrieval — strategy (factual / temporal / inferential /
 *    exploratory) determines traversal depth, ranking weights, and early-stop.
 * 2. Concurrent candidate pipeline — semantic + tag + temporal + salience
 *    searches run in parallel, merged and re-ranked.
 * 3. Self-directed temporal traversal — forward (causal), reverse
 *    (recent-first), salience-first.
 * 4. Early-stop — stop when confidence threshold or enough evidence is met.
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

    // Step 1: Resolve traversal order (self-directed)
    const traversal = query.traversalOrder ?? "reverse";

    // Step 2: Build candidate set (concurrent pipeline)
    const candidates = await this.buildCandidateSet(query, traversal, stats);

    // Step 3: Apply command-driven filters
    const filtered = this.applyStrategyFilters(query, candidates);

    // Step 4: Re-rank
    const ranked = this.reRank(query, filtered, traversal);

    // Step 5: Early-stop / slice
    const result = this.applyStopCriteria(query, ranked);

    stats.matched = result.nodes.length;
    stats.pruned = stats.scanned - stats.matched;
    stats.timeMs = Math.round(performance.now() - startTime);

    // Aggregate confidence
    const avgScore =
      result.nodes.length > 0
        ? result.nodes.reduce((sum, n) => sum + (n._score ?? 0), 0) / result.nodes.length
        : 0;
    const confidence = Math.min(1, Math.max(0, avgScore));

    // Clean up internal _score field
    for (const node of result.nodes) {
      delete (node as MemoryNode & { _score?: number })._score;
    }

    return { nodes: result.nodes, confidence, traversalStats: stats };
  }

  // ─── Concurrent candidate pipeline ───

  private async buildCandidateSet(
    query: RetrievalQuery,
    traversal: TraversalOrder,
    stats: TraversalStats,
  ): Promise<Array<MemoryNode & { _score: number }>> {
    const promises: Promise<MemoryNode[]>[] = [];

    // Branch A: semantic search (embedding cosine)
    if (query.embedding) {
      promises.push(this.semanticSearch(query));
    }

    // Branch B: tag/keyword search
    if (query.text) {
      promises.push(this.tagSearch(query), this.keywordSearch(query));
    }

    // Branch C: temporal range
    if (query.timeRange) {
      promises.push(this.storage.queryByTimeRange(query.timeRange.start, query.timeRange.end));
    }

    // Branch D: salience pre-filter (if strategy wants high-salience)
    if (query.strategy === "exploratory" || traversal === "salience") {
      promises.push(this.storage.queryBySalience(0.5));
    }

    // Branch E: fallback — all nodes (small datasets only)
    if (promises.length === 0) {
      promises.push(this.storage.listAll());
    }

    // Run all in parallel
    const results = await Promise.allSettled(promises);
    const allNodes: MemoryNode[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        allNodes.push(...r.value);
      }
    }

    // Deduplicate by ID
    const unique = new Map<string, MemoryNode>();
    for (const n of allNodes) {
      unique.set(n.id, n);
    }
    stats.scanned = unique.size;

    // Compute base semantic score for each candidate
    const scored: Array<MemoryNode & { _score: number }> = [];
    for (const n of unique.values()) {
      let score = 0;
      if (query.embedding && n.payload.embedding) {
        score = cosineSimilarity(query.embedding, n.payload.embedding);
      } else if (query.text) {
        score = this.keywordScore(n, query.text);
      } else {
        score = n.payload.salienceScore;
      }
      scored.push({ ...n, _score: score });
    }

    return scored;
  }

  private async semanticSearch(query: RetrievalQuery): Promise<MemoryNode[]> {
    // Get all nodes with embeddings and compute similarity
    const all = await this.storage.listAll();
    const candidates = all.filter((n) => n.payload.embedding);
    const scored = candidates
      .map((n) => ({
        node: n,
        score: cosineSimilarity(query.embedding!, n.payload.embedding!),
      }))
      .filter((s) => s.score > 0.3) // min relevance threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, query.maxCandidates ?? 100);

    return scored.map((s) => s.node);
  }

  private tagSearch(query: RetrievalQuery): Promise<MemoryNode[]> {
    // Extract likely tags from query text
    const words = query
      .text!.toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return Promise.resolve([]);
    return this.storage.queryByTags(words);
  }

  private keywordSearch(query: RetrievalQuery): Promise<MemoryNode[]> {
    // Simple keyword scan — storage adapter may not support full-text
    // so we do it client-side over a reasonable window
    return this.storage.listAll().then((all) => {
      const lowerText = query.text!.toLowerCase();
      return all.filter(
        (n) =>
          n.payload.summary.toLowerCase().includes(lowerText) ||
          n.payload.description?.toLowerCase().includes(lowerText) ||
          n.payload.tags.some((t) => lowerText.includes(t.toLowerCase())),
      );
    });
  }

  // ─── Strategy-driven filters ───

  private applyStrategyFilters(
    query: RetrievalQuery,
    candidates: Array<MemoryNode & { _score: number }>,
  ): Array<MemoryNode & { _score: number }> {
    let results = candidates;

    // Level filter
    if (query.level) {
      results = results.filter((n) => n.hierarchy.level === query.level);
    }

    // Agent role filter
    if (query.agentRole) {
      results = results.filter((n) => n.meta.agentRole === query.agentRole);
    }

    // Strategy-specific adjustments
    switch (query.strategy) {
      case "factual":
        // Boost exact / high-similarity matches, prefer atomic_actions
        results = results.map((n) => {
          let boost = 1;
          if (n.hierarchy.level === "atomic_action") boost *= 1.2;
          if (n.payload.salienceScore > 0.8) boost *= 1.1;
          return { ...n, _score: n._score * boost };
        });
        break;

      case "temporal":
        // Boost recent nodes and events (which span time)
        results = results.map((n) => {
          let boost = 1;
          if (n.hierarchy.level === "event") boost *= 1.3;
          // Recency decay: newer = higher boost
          const ageHours = (Date.now() - n.timestamp) / 3600000;
          boost *= Math.max(0.5, 1 - ageHours / 168); // 1 week half-life
          return { ...n, _score: n._score * boost };
        });
        break;

      case "inferential":
        // Need cross-level evidence — don't filter by level, boost events
        // because they aggregate multiple atomic actions
        results = results.map((n) => {
          let boost = 1;
          if (n.hierarchy.level === "event") boost *= 1.4;
          if (n.hierarchy.childrenIds && n.hierarchy.childrenIds.length > 2) boost *= 1.2;
          return { ...n, _score: n._score * boost };
        });
        break;

      case "exploratory":
        // Diversity: boost variety, don't over-weight exact matches
        results = results.map((n) => {
          let boost = 1;
          if (n.payload.modality.includes("multimodal")) boost *= 1.2;
          return { ...n, _score: n._score * boost };
        });
        break;
    }

    return results;
  }

  // ─── Temporal traversal ordering ───

  private reRank(
    query: RetrievalQuery,
    candidates: Array<MemoryNode & { _score: number }>,
    traversal: TraversalOrder,
  ): Array<MemoryNode & { _score: number }> {
    switch (traversal) {
      case "forward":
        // Sort by timestamp ascending (causal order), break ties by score
        candidates.sort((a, b) => {
          const timeDiff = a.timestamp - b.timestamp;
          if (timeDiff !== 0) return timeDiff;
          return b._score - a._score;
        });
        break;

      case "reverse":
        // Sort by timestamp descending (recent-first), break ties by score
        candidates.sort((a, b) => {
          const timeDiff = b.timestamp - a.timestamp;
          if (timeDiff !== 0) return timeDiff;
          return b._score - a._score;
        });
        break;

      case "salience":
        // Sort by composite: 60% score + 40% salience
        candidates.sort((a, b) => {
          const compositeA = 0.6 * a._score + 0.4 * a.payload.salienceScore;
          const compositeB = 0.6 * b._score + 0.4 * b.payload.salienceScore;
          return compositeB - compositeA;
        });
        break;
    }

    return candidates;
  }

  // ─── Early-stop ───

  private applyStopCriteria(
    query: RetrievalQuery,
    ranked: Array<MemoryNode & { _score: number }>,
  ): { nodes: Array<MemoryNode & { _score: number }> } {
    const topK = query.topK ?? 5;
    const maxDepth = query.maxCandidates ?? topK * 2;
    let results = ranked.slice(0, maxDepth);

    if (query.earlyStop) {
      const strategyStopThreshold: Record<RetrievalStrategy, number> = {
        factual: 0.85,
        temporal: 0.75,
        inferential: 0.7,
        exploratory: 0.6,
      };
      const threshold = strategyStopThreshold[query.strategy];

      // Find how many top results exceed the threshold
      let stopIndex = results.length;
      for (const [i, result] of results.entries()) {
        if (result._score < threshold && i >= topK) {
          stopIndex = i;
          break;
        }
      }
      results = results.slice(0, Math.max(topK, stopIndex));
    }

    // Final slice to topK
    results = results.slice(0, topK);

    return { nodes: results };
  }

  private keywordScore(node: MemoryNode, text: string): number {
    const lowerText = text.toLowerCase();
    let score = 0;
    if (node.payload.summary.toLowerCase().includes(lowerText)) score += 0.5;
    if (node.payload.description?.toLowerCase().includes(lowerText)) score += 0.3;
    const tagHits = node.payload.tags.filter((t) => lowerText.includes(t.toLowerCase())).length;
    score += tagHits * 0.1;
    return Math.min(1, score);
  }
}
