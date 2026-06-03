import { matchFilter } from "./types.js";
import type {
  VectorIndex,
  VectorMetadata,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types.js";

/**
 * Minimal subset of the `hnswlib-wasm` `HierarchicalNSW` surface that
 * `HnswWasmVectorIndex` actually exercises. Mirrors `HnswlibIndex` from
 * `./hnsw.ts` but adapts for the WASM build's API differences
 * (`setEfSearch` instead of `setEf`, constructor arity, etc.).
 */
export interface HnswWasmIndex {
  initIndex(maxElements: number, M?: number, efConstruction?: number, randomSeed?: number): void;
  resizeIndex(newMaxElements: number): void;
  addPoint(point: number[] | Float32Array, label: number, replaceDeleted?: boolean): void;
  markDelete(label: number): void;
  searchKnn(
    query: number[] | Float32Array,
    k: number,
    filter?: (label: number) => boolean,
  ): { neighbors: number[]; distances: number[] };
  getCurrentCount(): number;
  getMaxElements(): number;
  setEfSearch(ef: number): void;
}

export interface HnswWasmVectorIndexOptions {
  /** Initial maxElements. Auto-resizes to 2x when filled. Default 4096. */
  maxElements?: number;
  /** HNSW graph parameter `M`. Default 16. */
  M?: number;
  /** HNSW build parameter `efConstruction`. Default 200. */
  efConstruction?: number;
  /** Search-time `ef`. Default 50. */
  ef?: number;
  /** Seed for HNSW's RNG. Default 100. */
  randomSeed?: number;
}

/**
 * Browser-compatible HNSW-backed `VectorIndex` using `hnswlib-wasm`.
 *
 * Identical behavior to `HnswVectorIndex` but backed by the WASM build of
 * hnswlib, which works in browsers (no native Node.js binding). The WASM
 * module is loaded lazily on first use via dynamic import.
 *
 * Usage:
 * ```ts
 * import { HnswWasmVectorIndex, loadHnswWasm } from "memorai/vector";
 *
 * const hnsw = await loadHnswWasm(384);
 * const index = new HnswWasmVectorIndex(hnsw, { maxElements: 50_000 });
 * ```
 *
 * Index semantics, auto-resize, and filter pushdown are identical to
 * `HnswVectorIndex` — see that class for full documentation.
 */
export class HnswWasmVectorIndex implements VectorIndex {
  private readonly opts: Required<HnswWasmVectorIndexOptions>;
  private initialized = false;
  private readonly labelById = new Map<string, number>();
  private readonly idByLabel = new Map<number, string>();
  private readonly metadataById = new Map<string, VectorMetadata | undefined>();
  private readonly deleted = new Set<string>();
  private readonly freeLabels: number[] = [];
  private nextLabel = 0;
  private dim?: number;

  constructor(
    private readonly hnsw: HnswWasmIndex,
    opts: HnswWasmVectorIndexOptions = {},
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
    const label = this.labelById.get(id);
    if (label === undefined) return;
    try {
      this.hnsw.markDelete(label);
    } catch {
      // swallow — tombstone in `deleted` is source of truth
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

    const liveCount = this.labelById.size - this.deleted.size;
    if (liveCount === 0) return [];

    let result: { neighbors: number[]; distances: number[] };

    if (filter && Object.keys(filter).length > 0) {
      const acceptable = new Set<number>();
      for (const [id, label] of this.labelById) {
        if (this.deleted.has(id)) continue;
        if (matchFilter(this.metadataById.get(id), filter)) acceptable.add(label);
      }
      if (acceptable.size === 0) return [];
      const k = Math.min(topK, acceptable.size);
      try {
        result = this.hnsw.searchKnn(embedding, k, (label) => acceptable.has(label));
      } catch {
        return [];
      }
    } else {
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
      out.push({ id, score, metadata: this.metadataById.get(id) });
      if (out.length >= topK) break;
    }
    return out;
  }

  async size(): Promise<number> {
    return this.labelById.size - this.deleted.size;
  }

  async clear(): Promise<void> {
    this.labelById.clear();
    this.idByLabel.clear();
    this.metadataById.clear();
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
      throw new Error(
        `HnswWasmVectorIndex: embedding length ${record.embedding.length} does not match index dim ${this.dim}`,
      );
    }

    if (!this.initialized) {
      this.hnsw.initIndex(
        this.opts.maxElements,
        this.opts.M,
        this.opts.efConstruction,
        this.opts.randomSeed,
      );
      this.hnsw.setEfSearch(this.opts.ef);
      this.initialized = true;
    }

    const existing = this.labelById.get(record.id);
    if (existing !== undefined) {
      try {
        this.hnsw.addPoint(record.embedding, existing, true);
        this.metadataById.set(record.id, record.metadata);
        this.deleted.delete(record.id);
        return;
      } catch {
        // fall through to fresh-label path
      }
    }

    const label = this.freeLabels.pop() ?? this.nextLabel++;
    const liveCount = this.labelById.size - this.deleted.size;
    if (liveCount + 1 > this.hnsw.getMaxElements()) {
      this.hnsw.resizeIndex(this.hnsw.getMaxElements() * 2);
    }

    this.hnsw.addPoint(record.embedding, label, true);
    this.labelById.set(record.id, label);
    this.idByLabel.set(label, record.id);
    this.metadataById.set(record.id, record.metadata);
    this.deleted.delete(record.id);
  }
}

/**
 * Convenience loader for the optional `hnswlib-wasm` peer dependency.
 *
 * Loads the WASM module and returns a fresh `HierarchicalNSW` configured
 * for cosine space, or throws a friendly error if the package isn't installed.
 *
 * ```ts
 * const hnsw = await loadHnswWasm(384);
 * const index = new HnswWasmVectorIndex(hnsw, { maxElements: 100_000 });
 * ```
 */
export async function loadHnswWasm(dim: number): Promise<HnswWasmIndex> {
  try {
    // @vite-ignore — optional peer dep, resolved at runtime
    const { loadHnswlib } = await import("hnswlib-wasm");
    if (typeof loadHnswlib !== "function") {
      throw new Error("hnswlib-wasm: loadHnswlib export not found");
    }
    const module = await loadHnswlib();
    const HierarchicalNSW = module.HierarchicalNSW;
    if (!HierarchicalNSW) {
      throw new Error("hnswlib-wasm: HierarchicalNSW not found in loaded module");
    }
    // WASM constructor takes 3 args: (spaceName, numDimensions, autoSaveFilename)
    // autoSaveFilename is required per the typedef but unused at runtime; pass empty.
    return new HierarchicalNSW("cosine", dim, "") as HnswWasmIndex;
  } catch (err) {
    throw new Error(
      `HnswWasmVectorIndex requires the 'hnswlib-wasm' peer dependency. Install it with: pnpm add hnswlib-wasm\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
