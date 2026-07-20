import { BruteForceVectorIndex } from "./brute-force.js";
import { HnswVectorIndex, loadHnswlib } from "./hnsw.js";
import { HnswWasmVectorIndex, loadHnswWasm } from "./hnsw-wasm.js";
import { USearchVectorIndex, loadUSearch } from "./usearch.js";
import type { VectorIndex, VectorQueryOptions, VectorQueryResult, VectorRecord } from "./types.js";

export type AutoVectorBackend = "auto" | "hnsw" | "usearch" | "brute-force";

export interface AutoVectorIndexOptions {
  /**
   * Embedding dimension. Used to pre-load the ANN backend eagerly instead of
   * waiting for the first `upsert`. Defaults to deferred loading.
   */
  dimension?: number;
  /**
   * Preferred backend. `"auto"` (default) probes in order:
   *   1. `hnswlib-node` (Node.js native HNSW)
   *   2. `usearch` (Node.js / WASM USearch)
   *   3. `hnswlib-wasm` (browser WASM HNSW)
   *   4. `BruteForceVectorIndex` (exact cosine, in-memory)
   */
  prefer?: AutoVectorBackend;
  /**
   * Initial capacity hint for ANN backends that support it.
   * Default 10_000.
   */
  initialCapacity?: number;
}

/**
 * Vector index that lazily selects the best available ANN backend.
 *
 * Use this when you want production-grade approximate nearest neighbor search
 * without manually wiring `hnswlib-node` / `usearch` / `hnswlib-wasm`. The
 * first write (or first call after construction when `dimension` is known)
 * probes optional peer dependencies in order and falls back to an exact
 * brute-force index when none are installed.
 *
 * Example:
 * ```ts
 * const memory = new Memorai({
 *   storage,
 *   embedding,
 *   // Automatically picks HNSW if hnswlib-node is installed,
 *   // otherwise usearch, otherwise WASM, otherwise brute-force.
 *   vectorIndex: new AutoVectorIndex({ dimension: embedding.dimension }),
 * });
 * ```
 */
export class AutoVectorIndex implements VectorIndex {
  private inner?: Promise<VectorIndex>;
  private resolved?: VectorIndex;

  constructor(private readonly opts: AutoVectorIndexOptions = {}) {}

  /**
   * Resolve the underlying backend. Starts loading eagerly when `dimension`
   * is provided; otherwise defers until the first `upsert`.
   */
  private ensure(dim?: number): Promise<VectorIndex> {
    if (this.resolved) return Promise.resolve(this.resolved);
    if (!this.inner) {
      this.inner = this.loadBestBackend(dim ?? this.opts.dimension);
    }
    return this.inner.then((idx) => {
      this.resolved = idx;
      return idx;
    });
  }

  async upsert(record: VectorRecord): Promise<void> {
    const idx = await this.ensure(record.embedding.length);
    return idx.upsert(record);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const idx = await this.ensure(records[0].embedding.length);
    return idx.upsertBatch(records);
  }

  async delete(id: string): Promise<void> {
    const idx = await this.ensure();
    return idx.delete(id);
  }

  async query(embedding: number[], opts: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    const idx = await this.ensure(embedding.length);
    return idx.query(embedding, opts);
  }

  async size(): Promise<number> {
    const idx = await this.ensure();
    return idx.size();
  }

  async clear(): Promise<void> {
    const idx = await this.ensure();
    return idx.clear();
  }

  /** The backend that was actually selected. Undefined until first use. */
  get backendName(): string | undefined {
    const idx = this.resolved;
    if (!idx) return undefined;
    if (idx instanceof HnswVectorIndex) return "hnswlib-node";
    if (idx instanceof HnswWasmVectorIndex) return "hnswlib-wasm";
    if (idx instanceof USearchVectorIndex) return "usearch";
    return "brute-force";
  }

  private async loadBestBackend(dim?: number): Promise<VectorIndex> {
    const prefer = this.opts.prefer ?? "auto";
    const initialCapacity = this.opts.initialCapacity ?? 10_000;
    const isNode = typeof process !== "undefined" && typeof process.versions?.node === "string";

    if (prefer === "brute-force") {
      return new BruteForceVectorIndex();
    }

    if (isNode) {
      if (prefer === "auto" || prefer === "hnsw") {
        try {
          if (dim === undefined) throw new Error("dimension unknown");
          const hnsw = await loadHnswlib(dim);
          return new HnswVectorIndex(hnsw, { maxElements: initialCapacity });
        } catch {
          // hnswlib-node not available
        }
      }

      if (prefer === "auto" || prefer === "usearch") {
        try {
          if (dim === undefined) throw new Error("dimension unknown");
          const index = await loadUSearch(dim, "cos", initialCapacity);
          return new USearchVectorIndex({ index });
        } catch {
          // usearch not available
        }
      }
    } else {
      if (prefer === "auto" || prefer === "hnsw") {
        try {
          if (dim === undefined) throw new Error("dimension unknown");
          const hnsw = await loadHnswWasm(dim);
          return new HnswWasmVectorIndex(hnsw, { maxElements: initialCapacity });
        } catch {
          // hnswlib-wasm not available
        }
      }
    }

    return new BruteForceVectorIndex();
  }
}

/**
 * Convenience factory — picks the best available ANN backend eagerly.
 * Useful when you want to inspect or configure the concrete backend before
 * passing it to `Memorai`.
 */
export async function createAutoVectorIndex(
  dim: number,
  opts: Omit<AutoVectorIndexOptions, "dimension"> = {},
): Promise<VectorIndex> {
  const idx = new AutoVectorIndex({ ...opts, dimension: dim });
  await idx.size(); // force eager resolution
  return idx;
}
