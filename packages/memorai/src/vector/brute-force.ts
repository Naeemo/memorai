import { matchFilter } from "./types.js";
import type {
  VectorIndex,
  VectorMetadata,
  VectorQueryOptions,
  VectorQueryResult,
  VectorRecord,
} from "./types.js";

/**
 * Exact-cosine vector index — brute force, in-memory.
 *
 * Faster than `storage.listAll() + cosineSimilarity` because:
 *   - vectors are stored separately (no node deserialization on query)
 *   - per-vector L2 norm is precomputed once at upsert
 *   - cosine reduces to a dot product over O(d) per candidate
 *
 * Suitable up to ~50K–100K vectors per index. Beyond that, swap in
 * `HnswVectorIndex` (or another ANN backend) — same `VectorIndex` interface.
 */
export class BruteForceVectorIndex implements VectorIndex {
  private vectors = new Map<
    string,
    { embedding: number[]; norm: number; metadata?: VectorMetadata }
  >();

  async upsert(record: VectorRecord): Promise<void> {
    this.upsertSync(record);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.upsertSync(r);
  }

  async delete(id: string): Promise<void> {
    this.vectors.delete(id);
  }

  async query(embedding: number[], opts: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    const topK = opts.topK ?? 50;
    const minScore = opts.minScore ?? 0.3;
    const filter = opts.filter;

    const queryNorm = l2Norm(embedding);
    if (queryNorm === 0) return [];

    const scored: VectorQueryResult[] = [];
    for (const [id, entry] of this.vectors) {
      if (!matchFilter(entry.metadata, filter)) continue;
      if (entry.embedding.length !== embedding.length) continue;
      if (entry.norm === 0) continue;

      const dot = dotProduct(embedding, entry.embedding);
      const score = dot / (queryNorm * entry.norm);
      if (score < minScore) continue;

      scored.push({ id, score, metadata: entry.metadata });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async size(): Promise<number> {
    return this.vectors.size;
  }

  async clear(): Promise<void> {
    this.vectors.clear();
  }

  private upsertSync(record: VectorRecord): void {
    const embedding = record.embedding.slice();
    const norm = l2Norm(embedding);
    this.vectors.set(record.id, {
      embedding,
      norm,
      metadata: record.metadata,
    });
  }
}

function l2Norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}
