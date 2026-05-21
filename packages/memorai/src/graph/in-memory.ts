import { generateId } from "../utils.js";
import {
  canonicalName,
  edgePassesFilter,
  type EdgeFilter,
  type EntityGraph,
  type GraphEdge,
  type GraphEntity,
  type GraphPath,
  type UpsertEdgeInput,
} from "./types.js";

/**
 * In-memory `EntityGraph` implementation.
 *
 * Adjacency lists keyed on canonical entity names. Edge bookkeeping mirrors
 * how `InMemoryEventStore` tracks events — adjacency maps for O(1) neighbor
 * lookups, plus a predicate inverted index for "who has predicate X?" queries.
 *
 * Path search uses BFS bounded by `maxDepth`. For agent-scale graphs
 * (≤ 10⁵ edges), this is comfortably fast. Persistent backends can
 * implement the same interface against SQLite / native graph DBs.
 */
export class InMemoryEntityGraph implements EntityGraph {
  private entities = new Map<string, GraphEntity>();
  private edges = new Map<string, GraphEdge>();
  /** subject canonical name → set of edge ids */
  private subjectIndex = new Map<string, Set<string>>();
  /** object canonical name → set of edge ids */
  private objectIndex = new Map<string, Set<string>>();
  /** predicate canonical name → set of edge ids */
  private predicateIndex = new Map<string, Set<string>>();

  // ─── Entities ───

  async upsertEntity(
    name: string,
    attributes?: Record<string, unknown>,
    opts: { now?: number; userId?: string } = {},
  ): Promise<GraphEntity> {
    const canonical = canonicalName(name);
    if (!canonical) {
      throw new Error("InMemoryEntityGraph.upsertEntity: name cannot be empty");
    }
    const now = opts.now ?? Date.now();
    const existing = this.entities.get(canonical);
    if (existing) {
      existing.lastSeenAt = now;
      if (attributes) {
        existing.attributes = { ...existing.attributes, ...attributes };
      }
      if (opts.userId !== undefined && existing.userId === undefined) {
        existing.userId = opts.userId;
      }
      return existing;
    }
    const created: GraphEntity = {
      name: canonical,
      attributes,
      firstSeenAt: now,
      lastSeenAt: now,
      userId: opts.userId,
    };
    this.entities.set(canonical, created);
    return created;
  }

  async getEntity(name: string, opts: { userId?: string } = {}): Promise<GraphEntity | null> {
    const e = this.entities.get(canonicalName(name));
    if (!e) return null;
    if (opts.userId !== undefined && e.userId !== opts.userId) return null;
    return e;
  }

  async listEntities(
    opts: { userId?: string; limit?: number; offset?: number } = {},
  ): Promise<GraphEntity[]> {
    const out: GraphEntity[] = [];
    for (const e of this.entities.values()) {
      if (opts.userId !== undefined && e.userId !== opts.userId) continue;
      out.push(e);
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? out.length;
    return out.slice(offset, offset + limit);
  }

  // ─── Edges ───

  async upsertEdge(input: UpsertEdgeInput): Promise<GraphEdge> {
    const subject = canonicalName(input.subject);
    const predicate = canonicalName(input.predicate);
    const object = canonicalName(input.object);
    if (!subject || !predicate || !object) {
      throw new Error("InMemoryEntityGraph.upsertEdge: subject/predicate/object cannot be empty");
    }
    const validAt = input.validAt ?? Date.now();

    // Defensive entity registration — keeps the entity table in sync with
    // edge writes even when callers haven't explicitly called upsertEntity.
    await this.upsertEntity(subject, undefined, { now: validAt, userId: input.userId });
    await this.upsertEntity(object, undefined, { now: validAt, userId: input.userId });

    if (input.invalidatesOlder) {
      for (const e of this.edges.values()) {
        if (e.invalidatedAt !== undefined) continue;
        if (e.subject !== subject) continue;
        if (e.predicate !== predicate) continue;
        if (e.userId !== input.userId) continue;
        e.invalidatedAt = validAt;
      }
    }

    const edge: GraphEdge = {
      id: generateId(),
      subject,
      predicate,
      object,
      validAt,
      invalidatedAt: input.invalidatedAt,
      confidence: input.confidence,
      sourceNodeId: input.sourceNodeId,
      sourceEventId: input.sourceEventId,
      userId: input.userId,
    };

    this.edges.set(edge.id, edge);
    addToIndex(this.subjectIndex, subject, edge.id);
    addToIndex(this.objectIndex, object, edge.id);
    addToIndex(this.predicateIndex, predicate, edge.id);
    return edge;
  }

  async upsertEdges(inputs: UpsertEdgeInput[]): Promise<GraphEdge[]> {
    const out: GraphEdge[] = [];
    for (const i of inputs) out.push(await this.upsertEdge(i));
    return out;
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    return this.edges.get(id) ?? null;
  }

  async deleteEdge(id: string): Promise<void> {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    removeFromIndex(this.subjectIndex, e.subject, id);
    removeFromIndex(this.objectIndex, e.object, id);
    removeFromIndex(this.predicateIndex, e.predicate, id);
  }

  // ─── Queries ───

  async queryNeighbors(
    entity: string,
    opts: EdgeFilter & { limit?: number } = {},
  ): Promise<GraphEdge[]> {
    const canonical = canonicalName(entity);
    const subjectHits = this.subjectIndex.get(canonical);
    const objectHits = this.objectIndex.get(canonical);
    const ids = new Set<string>();
    if (subjectHits) for (const id of subjectHits) ids.add(id);
    if (objectHits) for (const id of objectHits) ids.add(id);
    return this.materializeAndFilter(ids, opts);
  }

  async queryEdges(filter: EdgeFilter, opts: { limit?: number } = {}): Promise<GraphEdge[]> {
    // Pick the smallest covering index for the most-selective field.
    let candidateIds: Iterable<string>;
    if (filter.subject !== undefined) {
      candidateIds = this.subjectIndex.get(canonicalName(filter.subject)) ?? new Set();
    } else if (filter.object !== undefined) {
      candidateIds = this.objectIndex.get(canonicalName(filter.object)) ?? new Set();
    } else if (filter.predicate !== undefined) {
      candidateIds = this.predicateIndex.get(canonicalName(filter.predicate)) ?? new Set();
    } else {
      candidateIds = this.edges.keys();
    }
    const out: GraphEdge[] = [];
    for (const id of candidateIds) {
      const edge = this.edges.get(id);
      if (!edge) continue;
      if (!edgePassesFilter(edge, filter)) continue;
      out.push(edge);
    }
    out.sort((a, b) => b.validAt - a.validAt);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async queryPaths(
    from: string,
    to: string,
    opts: { maxDepth?: number; limit?: number; userId?: string } = {},
  ): Promise<GraphPath[]> {
    const start = canonicalName(from);
    const goal = canonicalName(to);
    if (!start || !goal || start === goal) return [];
    const maxDepth = opts.maxDepth ?? 4;
    const limit = opts.limit ?? 5;

    const paths: GraphPath[] = [];
    type Frontier = { node: string; edges: GraphEdge[]; entities: string[] };
    const queue: Frontier[] = [{ node: start, edges: [], entities: [start] }];

    while (queue.length > 0 && paths.length < limit) {
      const cur = queue.shift()!;
      if (cur.entities.length - 1 >= maxDepth) continue;

      const neighborEdges = await this.queryNeighbors(cur.node, {
        userId: opts.userId,
        excludeInvalidated: true,
      });

      for (const e of neighborEdges) {
        const other = e.subject === cur.node ? e.object : e.subject;
        if (cur.entities.includes(other) && other !== goal) continue; // no cycles
        const nextEntities = [...cur.entities, other];
        const nextEdges = [...cur.edges, e];
        if (other === goal) {
          paths.push({ edges: nextEdges, entities: nextEntities });
          if (paths.length >= limit) break;
          continue;
        }
        if (nextEntities.length - 1 < maxDepth) {
          queue.push({ node: other, edges: nextEdges, entities: nextEntities });
        }
      }
    }

    paths.sort((a, b) => a.edges.length - b.edges.length);
    return paths.slice(0, limit);
  }

  /**
   * Best-first search scored by product of edge confidence.
   * Higher-confidence paths are explored first; the score of a path is the
   * geometric mean of its edge confidences (product^(1/n)) so longer paths
   * are not unfairly penalized against short high-confidence ones.
   */
  async queryPathsWeighted(
    from: string,
    to: string,
    opts: { maxDepth?: number; limit?: number; userId?: string } = {},
  ): Promise<GraphPath[]> {
    const start = canonicalName(from);
    const goal = canonicalName(to);
    if (!start || !goal || start === goal) return [];
    const maxDepth = opts.maxDepth ?? 4;
    const limit = opts.limit ?? 5;

    type ScoredFrontier = {
      node: string;
      edges: GraphEdge[];
      entities: string[];
      score: number;
    };

    // Priority queue: highest score first
    const heap: ScoredFrontier[] = [{ node: start, edges: [], entities: [start], score: 1 }];
    const paths: GraphPath[] = [];

    while (heap.length > 0 && paths.length < limit) {
      // Pop highest-scoring frontier
      let bestIdx = 0;
      for (let i = 1; i < heap.length; i++) {
        if (heap[i].score > heap[bestIdx].score) bestIdx = i;
      }
      const cur = heap.splice(bestIdx, 1)[0];
      if (cur.entities.length - 1 >= maxDepth) continue;

      const neighborEdges = await this.queryNeighbors(cur.node, {
        userId: opts.userId,
        excludeInvalidated: true,
      });

      for (const e of neighborEdges) {
        const other = e.subject === cur.node ? e.object : e.subject;
        if (cur.entities.includes(other) && other !== goal) continue;
        const edgeConfidence = e.confidence ?? 0.5;
        const nextScore = cur.score * edgeConfidence;
        const nextEdges = [...cur.edges, e];
        const nextEntities = [...cur.entities, other];
        if (other === goal) {
          paths.push({ edges: nextEdges, entities: nextEntities });
          if (paths.length >= limit) break;
          continue;
        }
        if (nextEntities.length - 1 < maxDepth) {
          heap.push({ node: other, edges: nextEdges, entities: nextEntities, score: nextScore });
        }
      }
    }

    // Sort by geometric-mean confidence (score^(1/len)) so short and long
    // paths are comparable.
    paths.sort((a, b) => {
      const scoreA = Math.pow(pathScore(a), 1 / a.edges.length);
      const scoreB = Math.pow(pathScore(b), 1 / b.edges.length);
      return scoreB - scoreA;
    });
    return paths.slice(0, limit);
  }

  async size(): Promise<{ entities: number; edges: number }> {
    return { entities: this.entities.size, edges: this.edges.size };
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.edges.clear();
    this.subjectIndex.clear();
    this.objectIndex.clear();
    this.predicateIndex.clear();
  }

  // ─── helpers ───

  private materializeAndFilter(
    ids: Iterable<string>,
    opts: EdgeFilter & { limit?: number },
  ): GraphEdge[] {
    const out: GraphEdge[] = [];
    for (const id of ids) {
      const e = this.edges.get(id);
      if (!e) continue;
      if (!edgePassesFilter(e, opts)) continue;
      out.push(e);
    }
    out.sort((a, b) => b.validAt - a.validAt);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }
}

function pathScore(path: GraphPath): number {
  let score = 1;
  for (const e of path.edges) {
    score *= e.confidence ?? 0.5;
  }
  return score;
}

function addToIndex(map: Map<string, Set<string>>, key: string, id: string): void {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  s.add(id);
}

function removeFromIndex(map: Map<string, Set<string>>, key: string, id: string): void {
  const s = map.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) map.delete(key);
}
