import { matchFilter } from "./types.js";
import type {
  VectorIndex,
  VectorMetadata,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types.js";

/**
 * Minimal subset of the `hnswlib-node` `HierarchicalNSW` surface that
 * `HnswVectorIndex` actually exercises. Lets us mock it in tests without
 * pulling in the native binding, and keeps the dependency optional —
 * callers wire up the real `hnswlib-node` index themselves.
 *
 * Mirror of the upstream API:
 *   https://github.com/yoshoku/hnswlib-node
 */
export interface HnswlibIndex {
  initIndex(maxElements: number, M?: number, efConstruction?: number, randomSeed?: number): void;
  resizeIndex(newMaxElements: number): void;
  addPoint(point: number[], label: number, replaceDeleted?: boolean): void;
  markDelete(label: number): void;
  searchKnn(
    query: number[],
    k: number,
    filter?: (label: number) => boolean,
  ): { neighbors: number[]; distances: number[] };
  getCurrentCount(): number;
  getMaxElements(): number;
  setEf(ef: number): void;
}

export interface HnswVectorIndexOptions {
  /** Initial maxElements. Index auto-resizes to 2× when filled. Default 4096. */
  maxElements?: number;
  /** HNSW graph parameter `M`. Default 16. */
  M?: number;
  /** HNSW build parameter `efConstruction`. Default 200. */
  efConstruction?: number;
  /** Search-time `ef`. Higher → better recall, slower. Default 50. */
  ef?: number;
  /** Seed for HNSW's RNG — deterministic reruns. Default 100. */
  randomSeed?: number;
}

/**
 * HNSW-backed `VectorIndex`. Sub-linear ANN search over cosine space.
 *
 * Designed for the 100K–10M-vector range where `BruteForceVectorIndex`
 * is too slow. Recall is approximate (typically 0.95+ at `ef=50` with
 * 384-dim embeddings) — trades exactness for sub-millisecond queries.
 *
 * The `hnswlib-node` native binding is an **optional peer dependency**:
 * Memorai ships only the wrapper. Callers instantiate the underlying
 * `HierarchicalNSW` (with the correct `space` + `dim`) and pass it in:
 *
 * ```ts
 * // peer dep, install separately: pnpm add hnswlib-node
 * import { HierarchicalNSW } from "hnswlib-node";
 * import { HnswVectorIndex } from "memorai/vector";
 *
 * const hnsw = new HierarchicalNSW("cosine", 384);
 * const index = new HnswVectorIndex(hnsw, { maxElements: 100_000 });
 * ```
 *
 * Index semantics:
 *   - Cosine space — score = 1 - distance, matches BruteForceVectorIndex.
 *   - Upsert is idempotent: re-adding the same id replaces the vector
 *     and clears any prior delete marker.
 *   - `delete()` is a tombstone — the vector stays in the graph but is
 *     filtered out at query time (also via HNSW's native `markDelete`).
 *   - Auto-resize: when the current count would exceed `maxElements`,
 *     the index doubles its capacity (matching the upstream
 *     `resizeIndex` recommendation).
 *
 * Filters are pushed into HNSW's `searchKnn` filter callback: we
 * precompute the matching label set from our metadata map (O(N) once
 * per call), then HNSW walks only matching labels. This avoids the
 * "fetch 2× topK and post-filter" workaround that under-fills strict
 * filters (e.g. when only 5 of the top 20 vectors satisfy `userId=u1`).
 */
export class HnswVectorIndex implements VectorIndex {
  private readonly opts: Required<HnswVectorIndexOptions>;
  private initialized = false;
  // string id → integer label (HNSW uses integer labels)
  private readonly labelByid = new Map<string, number>();
  // integer label → string id (reverse lookup at search time)
  private readonly idByLabel = new Map<number, string>();
  // string id → metadata (HNSW stores only vectors)
  private readonly metadataByid = new Map<string, VectorMetadata | undefined>();
  // string ids currently deleted — second line of defense after markDelete.
  private readonly deleted = new Set<string>();
  // Reusable labels from prior deletes — keeps integer label space dense.
  private readonly freeLabels: number[] = [];
  // Monotonically-increasing label counter when no free label is available.
  private nextLabel = 0;
  // Embedding dimension — inferred from the first vector and never changes.
  private dim?: number;

  constructor(
    private readonly hnsw: HnswlibIndex,
    opts: HnswVectorIndexOptions = {},
  ) {
    this.opts = {
      maxElements: opts.maxElements ?? 4096,
      M: opts.M ?? 16,
      efConstruction: opts.efConstruction ?? 200,
      ef: opts.ef ?? 50,
      randomSeed: opts.randomSeed ?? 100,
    };
  }

  async upsert(record: VectorRecord): Promise<void> {
    this.upsertSync(record);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.upsertSync(r);
  }

  async delete(id: string): Promise<void> {
    const label = this.labelByid.get(id);
    if (label === undefined) return;
    try {
      this.hnsw.markDelete(label);
    } catch {
      // Some backends throw when marking an already-deleted label; the
      // tombstone in `this.deleted` is the source of truth either way.
    }
    this.deleted.add(id);
    this.freeLabels.push(label);
  }

  async query(embedding: number[], opts: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    if (!this.initialized) return [];
    if (this.dim !== undefined && embedding.length !== this.dim) return [];

    const topK = opts.topK ?? 50;
    const minScore = opts.minScore ?? 0.3;
    const filter = opts.filter;

    const liveCount = this.labelByid.size - this.deleted.size;
    if (liveCount === 0) return [];

    let result: { neighbors: number[]; distances: number[] };

    if (filter && Object.keys(filter).length > 0) {
      // Filter pushdown — precompute the set of HNSW labels that satisfy
      // the metadata filter, then pass an `(label) => acceptable.has(label)`
      // callback to `searchKnn`. HNSW walks only matching labels and we
      // get exactly topK results without the post-filter "fetch 2x topK,
      // hope enough pass" workaround that under-fills strict filters.
      //
      // Precompute cost: O(N) over `metadataByid` per call. For 100K
      // vectors that's microseconds — well under the search itself.
      // High-cardinality reverse indexes (per-userId label sets) would
      // make this O(1), worth doing if profiling flags it.
      const acceptable = new Set<number>();
      for (const [id, label] of this.labelByid) {
        if (this.deleted.has(id)) continue;
        if (matchFilter(this.metadataByid.get(id), filter)) acceptable.add(label);
      }
      if (acceptable.size === 0) return [];

      // Request topK from the filtered population, capped at how many
      // labels actually match (HNSW errors when k exceeds population).
      const k = Math.min(topK, acceptable.size);

      try {
        result = this.hnsw.searchKnn(embedding, k, (label) => acceptable.has(label));
      } catch {
        return [];
      }
    } else {
      // No filter — search the full live population. Request a small
      // headroom over topK so minScore drops don't under-fill.
      const k = Math.min(Math.max(topK + 5, topK), liveCount);
      try {
        result = this.hnsw.searchKnn(embedding, k);
      } catch {
        return [];
      }
    }

    const out: VectorQueryResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const id = this.idByLabel.get(label);
      if (id === undefined) continue;
      if (this.deleted.has(id)) continue;
      const score = 1 - result.distances[i];
      if (score < minScore) continue;
      out.push({ id, score, metadata: this.metadataByid.get(id) });
      if (out.length >= topK) break;
    }
    return out;
  }

  async size(): Promise<number> {
    return this.labelByid.size - this.deleted.size;
  }

  async clear(): Promise<void> {
    this.labelByid.clear();
    this.idByLabel.clear();
    this.metadataByid.clear();
    this.deleted.clear();
    this.freeLabels.length = 0;
    this.nextLabel = 0;
    this.initialized = false;
    this.dim = undefined;
  }

  private upsertSync(record: VectorRecord): void {
    if (this.dim === undefined) {
      this.dim = record.embedding.length;
    } else if (record.embedding.length !== this.dim) {
      // Reject mismatched-dim vectors — HNSW would crash the process otherwise.
      throw new Error(
        `HnswVectorIndex: embedding length ${record.embedding.length} does not match index dim ${this.dim}`,
      );
    }

    if (!this.initialized) {
      this.hnsw.initIndex(
        this.opts.maxElements,
        this.opts.M,
        this.opts.efConstruction,
        this.opts.randomSeed,
      );
      this.hnsw.setEf(this.opts.ef);
      this.initialized = true;
    }

    // Re-upsert path: replace the vector at the existing label.
    const existing = this.labelByid.get(record.id);
    if (existing !== undefined) {
      // hnswlib-node supports replaceDeleted=true for re-adding at a label;
      // simpler is to write a fresh point at a fresh label and remap.
      try {
        this.hnsw.addPoint(record.embedding, existing, true);
        this.metadataByid.set(record.id, record.metadata);
        // Re-upserts clear any prior tombstone.
        this.deleted.delete(record.id);
        return;
      } catch {
        // Fall through to the fresh-label path below.
      }
    }

    const label = this.freeLabels.pop() ?? this.nextLabel++;

    // Auto-resize before we'd exceed capacity.
    const liveCount = this.labelByid.size - this.deleted.size;
    if (liveCount + 1 > this.hnsw.getMaxElements()) {
      this.hnsw.resizeIndex(this.hnsw.getMaxElements() * 2);
    }

    this.hnsw.addPoint(record.embedding, label, true);
    this.labelByid.set(record.id, label);
    this.idByLabel.set(label, record.id);
    this.metadataByid.set(record.id, record.metadata);
    this.deleted.delete(record.id);
  }
}

/**
 * Convenience loader for the optional `hnswlib-node` peer dependency.
 * Returns a fresh `HierarchicalNSW` configured for cosine space, or
 * throws a friendly error if the package isn't installed.
 *
 * Most callers should construct the underlying index directly so they
 * can pick the space (`cosine` / `l2` / `ip`) — this helper exists to
 * make the common case (`cosine`, runtime dim) one line.
 */
export async function loadHnswlib(dim: number): Promise<HnswlibIndex> {
  try {
    // @ts-ignore — optional peer dep, resolved at runtime
    const mod = await import(/* @vite-ignore */ "hnswlib-node");
    const HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW;
    if (!HierarchicalNSW) {
      throw new Error("hnswlib-node: HierarchicalNSW export not found");
    }
    return new HierarchicalNSW("cosine", dim) as HnswlibIndex;
  } catch (err) {
    throw new Error(
      `HnswVectorIndex requires the 'hnswlib-node' peer dependency. Install it with: pnpm add hnswlib-node\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
