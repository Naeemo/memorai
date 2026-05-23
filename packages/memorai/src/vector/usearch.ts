import { matchFilter } from "./types.js";
import type {
  VectorIndex,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types.js";

/**
 * Minimal subset of the `usearch` JS API that `USearchVectorIndex`
 * exercises. Lets us mock it in tests and keeps the dependency optional.
 *
 * https://github.com/unum-cloud/usearch
 */
export interface USearchIndex {
  add(key: number, vector: number[]): void;
  remove(key: number): void;
  search(vector: number[], count: number): { keys: bigint[]; distances: number[] };
  size: number;
  capacity: () => number;
  clear(): void;
}

export interface USearchIndexOptions {
  metric?: "cos" | "ip" | "l2sq" | "haversine";
  dimensions?: number;
  connectivity?: number;
  expansionAdd?: number;
  expansionSearch?: number;
}

export interface USearchVectorIndexOptions {
  /**
   * Pre-created `usearch.Index` instance. If omitted, the index is created
   * lazily on first `upsert` using the dimension inferred from the first
   * embedding.
   */
  index?: USearchIndex;
  /**
   * Options passed to `new usearch.Index()` when creating internally.
   * Only used when `index` is not provided.
   */
  indexOpts?: USearchIndexOptions;
  /**
   * Initial capacity. Grows automatically when exceeded.
   * Default 10_000.
   */
  initialCapacity?: number;
}

/**
 * Vector index backed by USearch (Unum Cloud).
 *
 * USearch is a fast HNSW implementation with SIMD acceleration. It is
 * available as:
 *   - A native Node.js addon (`npm install usearch`)
 *   - A WASM build for browsers (`usearch/wasm`)
 *
 * This adapter works with either — callers pass the appropriate `index`
 * instance via `opts.index`.
 *
 * Usage (Node.js):
 * ```ts
 * import usearch from "usearch";
 * const index = new usearch.Index({ metric: "cos", dimensions: 1536 });
 * const vectorIndex = new USearchVectorIndex({ index });
 * ```
 *
 * Usage (Browser with WASM):
 * ```ts
 * import { usearch } from "usearch/wasm";
 * await usearch.init();
 * const index = new usearch.Index({ metric: "cos", dimensions: 1536 });
 * const vectorIndex = new USearchVectorIndex({ index });
 * ```
 */
export class USearchVectorIndex implements VectorIndex {
  private index: USearchIndex | undefined;
  private records = new Map<string, VectorRecord>();
  private labelCounter = 1;
  private labelToId = new Map<number, string>();
  private idToLabel = new Map<string, number>();

  constructor(opts: USearchVectorIndexOptions = {}) {
    this.index = opts.index;
    // indexOpts + initialCapacity are reserved for future auto-creation.
    void opts.indexOpts;
    void opts.initialCapacity;
  }

  private ensureIndex(dimensions: number): USearchIndex {
    if (this.index) return this.index;
    throw new Error(
      "USearchVectorIndex: no index provided and auto-creation is not supported. " +
        "Pass a pre-created usearch.Index instance via opts.index.",
    );
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.upsertBatch([record]);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const dims = records[0].embedding.length;
    const idx = this.ensureIndex(dims);

    for (const record of records) {
      // Remove existing entry first (USearch supports update via add with same key).
      const existingLabel = this.idToLabel.get(record.id);
      if (existingLabel !== undefined) {
        idx.remove(existingLabel);
      }

      const label = existingLabel ?? this.labelCounter++;
      this.idToLabel.set(record.id, label);
      this.labelToId.set(label, record.id);
      this.records.set(record.id, record);

      idx.add(label, record.embedding);
    }
  }

  async size(): Promise<number> {
    return this.records.size;
  }

  async query(embedding: number[], opts: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    const topK = opts.topK ?? 10;
    const minScore = opts.minScore ?? 0;
    const idx = this.index;
    if (!idx || idx.size === 0) return [];

    const result = idx.search(embedding, topK * 2);
    const out: VectorQueryResult[] = [];

    for (let i = 0; i < result.keys.length; i++) {
      const label = Number(result.keys[i]);
      const id = this.labelToId.get(label);
      if (!id) continue;

      const record = this.records.get(id);
      if (!record) continue;

      // Apply metadata filter.
      if (opts.filter && !matchFilter(record.metadata, opts.filter)) continue;

      // USearch returns distances, not similarities. For cosine metric,
      // distance = 1 - similarity. Convert to similarity score.
      const distance = result.distances[i]!;
      const score = distance <= 1 ? 1 - distance : Math.max(0, 1 / (1 + distance));

      if (score < minScore) continue;

      out.push({ id, score, metadata: record.metadata });
      if (out.length >= topK) break;
    }

    return out;
  }

  async delete(id: string): Promise<void> {
    const label = this.idToLabel.get(id);
    if (label !== undefined) {
      this.index?.remove(label);
      this.labelToId.delete(label);
      this.idToLabel.delete(id);
    }
    this.records.delete(id);
  }

  async clear(): Promise<void> {
    if (this.index) {
      this.index.clear();
    }
    this.records.clear();
    this.labelToId.clear();
    this.idToLabel.clear();
    this.labelCounter = 1;
  }
}

/**
 * Convenience loader for USearch.
 *
 * Dynamically imports `usearch` so it stays an optional peer dependency.
 * Returns a pre-configured `USearchIndex` ready to be passed to
 * `USearchVectorIndex`.
 *
 * @param dims Embedding dimensions (e.g. 1536 for OpenAI, 768 for MiniLM)
 * @param metric Distance metric. "cos" for cosine similarity (default),
 *   "ip" for inner product, "l2sq" for squared Euclidean.
 * @param capacity Initial capacity. Default 10_000.
 */
export async function loadUSearch(
  dims: number,
  metric: "cos" | "ip" | "l2sq" = "cos",
  capacity = 10_000,
): Promise<USearchIndex> {
  let mod: { Index?: new (opts: Record<string, unknown>) => USearchIndex };
  try {
    // @ts-ignore — optional peer dep, resolved at runtime
    mod = (await import(/* @vite-ignore */ "usearch")) as {
      Index?: new (opts: Record<string, unknown>) => USearchIndex;
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadUSearch: failed to load usearch — ${reason}. ` +
        `Install it with: npm install usearch`,
    );
  }

  if (typeof mod.Index !== "function") {
    throw new Error("loadUSearch: usearch.Index is not a constructor");
  }

  return new mod.Index({
    metric,
    dimensions: dims,
    capacity,
  });
}
