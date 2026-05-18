// Vector index interface — pluggable ANN backend for embedding retrieval.
//
// Memorai uses VectorIndex to scale semantic retrieval beyond brute-force
// linear cosine. A VectorIndex is optional: when omitted, Memorai falls
// back to listAll + cosine (correct, but O(N) per query).

export interface VectorRecord {
  id: string;
  embedding: number[];
  /**
   * Flat key/value metadata used for filter pushdown at query time.
   * Common keys: `userId`, `level`, `actor`, `target`, `timestamp`, `kind`.
   * Nested objects are not supported — collapse them to dotted keys if needed.
   */
  metadata?: VectorMetadata;
}

export type VectorMetadataValue = string | number | boolean | null | undefined;
export type VectorMetadata = Record<string, VectorMetadataValue>;

export interface VectorQueryResult {
  id: string;
  /** Cosine similarity in [-1, 1]. Higher is better. */
  score: number;
  metadata?: VectorMetadata;
}

/**
 * Filter applied to vector query results. All entries are ANDed.
 *
 * Value forms:
 *   - scalar               → equality
 *   - { in: [...] }        → membership
 *   - { range: {...} }     → numeric range [start, end] inclusive
 *   - undefined            → ignored (no filter on that key)
 */
export type VectorFilterClause =
  | VectorMetadataValue
  | { in: ReadonlyArray<string | number | boolean> }
  | { range: { start: number; end: number } };

export type VectorFilter = Record<string, VectorFilterClause>;

export interface VectorQueryOptions {
  /** Maximum results to return. Default 50. */
  topK?: number;
  /** Drop results scoring below this threshold. Default 0.3. */
  minScore?: number;
  /** ANDed metadata filter. */
  filter?: VectorFilter;
}

/**
 * Vector index — pluggable ANN backend.
 *
 * Implementations must:
 *   - upsert by id (overwrite when the same id is re-inserted)
 *   - return at most `topK` results, sorted descending by similarity
 *   - honor filters (post-filter is acceptable when the backend has no
 *     native predicate pushdown — but the contract is that returned results
 *     satisfy the filter)
 *
 * Adding a VectorIndex to Memorai is a drop-in upgrade: accuracy is identical
 * to the linear-scan fallback for exact backends like BruteForceVectorIndex,
 * and scales further when an ANN backend (HNSW, IVF, ScaNN) is plugged in.
 */
export interface VectorIndex {
  upsert(record: VectorRecord): Promise<void>;
  upsertBatch(records: VectorRecord[]): Promise<void>;
  delete(id: string): Promise<void>;
  query(embedding: number[], opts?: VectorQueryOptions): Promise<VectorQueryResult[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

/** Apply a {@link VectorFilter} clause to a metadata value. */
export function matchFilterClause(value: VectorMetadataValue, clause: VectorFilterClause): boolean {
  if (clause === undefined) return true;
  if (clause === null) return value === null;
  if (typeof clause === "object") {
    if ("in" in clause) {
      if (value === undefined || value === null) return false;
      return clause.in.includes(value as string | number | boolean);
    }
    if ("range" in clause) {
      if (typeof value !== "number") return false;
      return value >= clause.range.start && value <= clause.range.end;
    }
    return false;
  }
  return value === clause;
}

/** Apply a full {@link VectorFilter} to a metadata bag. */
export function matchFilter(
  metadata: VectorMetadata | undefined,
  filter: VectorFilter | undefined,
): boolean {
  if (!filter) return true;
  for (const [key, clause] of Object.entries(filter)) {
    const value = metadata?.[key];
    if (!matchFilterClause(value, clause)) return false;
  }
  return true;
}
