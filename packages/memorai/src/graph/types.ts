// Entity graph — knowledge-graph layer over `KnowledgeTriple` annotations.
//
// Memorai already extracts (subject, predicate, object) triples from raw
// events (LLMExtractor). The EntityGraph indexes those triples for
// neighbor queries, path queries, and graph-fused retrieval, closing the
// "Zep / Graphiti / Mem0-graph" gap in the JS ecosystem.

export interface GraphEntity {
  /** Canonical lowercase name. */
  name: string;
  /**
   * Free-form attributes — common keys: `aliases`, `type`, `description`.
   * The graph itself never interprets these; they exist for callers who
   * want to attach domain-specific data to a node.
   */
  attributes?: Record<string, unknown>;
  /** First Unix-ms this entity was observed. */
  firstSeenAt: number;
  /** Last Unix-ms this entity was touched (upserted or referenced). */
  lastSeenAt: number;
  /** Multi-tenant scope, mirrored from the originating triple. */
  userId?: string;
}

export interface GraphEdge {
  id: string;
  /** Canonical lowercase subject. */
  subject: string;
  /** Canonical lowercase predicate. */
  predicate: string;
  /** Canonical lowercase object (entity name or literal). */
  object: string;
  /** Unix ms — when this assertion was first observed. */
  validAt: number;
  /**
   * Unix ms — when this assertion was contradicted by a newer one.
   * Undefined means "still believed true".
   */
  invalidatedAt?: number;
  confidence?: number;
  /** Originating raw MemoryNode (Tier 1 provenance). */
  sourceNodeId?: string;
  /** Originating MemoryEvent (Tier 2.5 provenance). */
  sourceEventId?: string;
  /** Multi-tenant scope. */
  userId?: string;
}

export interface EdgeFilter {
  subject?: string;
  predicate?: string;
  object?: string;
  userId?: string;
  /**
   * Drop edges that have been invalidated at or before `validAt`. Useful
   * for asking "what does the agent currently believe?" queries.
   */
  validAt?: number;
  /** Drop everything with `invalidatedAt` set. */
  excludeInvalidated?: boolean;
}

export interface GraphPath {
  /** Edges traversed in order. */
  edges: GraphEdge[];
  /** Entity names visited in order. `entities[0] === from`, `entities[N] === to`. */
  entities: string[];
}

export interface UpsertEdgeInput {
  subject: string;
  predicate: string;
  object: string;
  validAt?: number;
  invalidatedAt?: number;
  confidence?: number;
  sourceNodeId?: string;
  sourceEventId?: string;
  userId?: string;
  /**
   * If true, any existing non-invalidated edges with the same
   * `(subject, predicate, userId)` get `invalidatedAt = validAt` set.
   * The default is `false` — the graph stores all assertions, and the
   * caller decides when supersedes apply.
   */
  invalidatesOlder?: boolean;
}

/**
 * Pluggable knowledge-graph store.
 *
 * Memorai uses EntityGraph to:
 *   - persist (subject, predicate, object) triples extracted from events
 *   - answer "who has X worked with on Y?" via neighbor / path queries
 *   - fuse a graph-aware retrieval pathway with the embedding + BM25 routes
 *
 * The default in-memory implementation ships with the package. Backends can
 * persist to SQLite / IndexedDB / a native graph DB and still satisfy this
 * interface.
 */
export interface EntityGraph {
  // ─── Entities ───
  upsertEntity(
    name: string,
    attributes?: Record<string, unknown>,
    opts?: { now?: number; userId?: string },
  ): Promise<GraphEntity>;
  getEntity(name: string, opts?: { userId?: string }): Promise<GraphEntity | null>;
  listEntities(opts?: { userId?: string; limit?: number; offset?: number }): Promise<GraphEntity[]>;

  // ─── Edges ───
  upsertEdge(edge: UpsertEdgeInput): Promise<GraphEdge>;
  upsertEdges(edges: UpsertEdgeInput[]): Promise<GraphEdge[]>;
  getEdge(id: string): Promise<GraphEdge | null>;
  deleteEdge(id: string): Promise<void>;

  // ─── Queries ───
  /** Edges where `entity` is subject OR object. */
  queryNeighbors(entity: string, opts?: EdgeFilter & { limit?: number }): Promise<GraphEdge[]>;
  queryEdges(filter: EdgeFilter, opts?: { limit?: number }): Promise<GraphEdge[]>;
  /**
   * Shortest paths from `from` to `to`, up to `maxDepth` hops.
   * Returns at most `limit` paths sorted by hop count.
   */
  queryPaths(
    from: string,
    to: string,
    opts?: { maxDepth?: number; limit?: number; userId?: string },
  ): Promise<GraphPath[]>;

  size(): Promise<{ entities: number; edges: number }>;
  clear(): Promise<void>;
}

/** Lowercase + trim a graph identifier. Returns `""` for falsy input. */
export function canonicalName(name: string | undefined | null): string {
  if (!name) return "";
  return String(name).toLowerCase().trim();
}

/** Whether `edge` passes the given `filter`. */
export function edgePassesFilter(edge: GraphEdge, filter: EdgeFilter): boolean {
  if (filter.subject !== undefined && edge.subject !== canonicalName(filter.subject)) return false;
  if (filter.predicate !== undefined && edge.predicate !== canonicalName(filter.predicate))
    return false;
  if (filter.object !== undefined && edge.object !== canonicalName(filter.object)) return false;
  if (filter.userId !== undefined && edge.userId !== filter.userId) return false;
  if (filter.excludeInvalidated && edge.invalidatedAt !== undefined) return false;
  if (filter.validAt !== undefined) {
    if (edge.invalidatedAt !== undefined && edge.invalidatedAt <= filter.validAt) return false;
  }
  return true;
}
