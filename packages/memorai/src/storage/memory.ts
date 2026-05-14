import type { MemoryNode, QueryOpts, StorageAdapter } from "../types.js";

/**
 * In-memory storage adapter.
 * Fast, ephemeral. Ideal for testing and development.
 * All operations are synchronous under the hood but wrapped in Promises
 * to satisfy the StorageAdapter interface.
 */
export class MemoryAdapter implements StorageAdapter {
  private nodes = new Map<string, MemoryNode>();

  put(node: MemoryNode): Promise<void> {
    this.nodes.set(node.id, node);
    return Promise.resolve();
  }

  get(id: string): Promise<MemoryNode | null> {
    return Promise.resolve(this.nodes.get(id) ?? null);
  }

  delete(id: string): Promise<void> {
    this.nodes.delete(id);
    return Promise.resolve();
  }

  batchPut(nodes: MemoryNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
    return Promise.resolve();
  }

  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const results = Array.from(this.nodes.values()).filter(
      (n) => n.timestamp >= start && n.timestamp <= end,
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]> {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const results = Array.from(this.nodes.values()).filter((n) =>
      n.payload.tags.some((t) => tagSet.has(t.toLowerCase())),
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const results = Array.from(this.nodes.values()).filter(
      (n) => n.payload.salienceScore >= minScore,
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  getChildren(parentId: string): Promise<MemoryNode[]> {
    return Promise.resolve(
      Array.from(this.nodes.values()).filter((n) => n.hierarchy.parentId === parentId),
    );
  }

  getParent(childId: string): Promise<MemoryNode | null> {
    const child = this.nodes.get(childId);
    if (!child?.hierarchy.parentId) return Promise.resolve(null);
    return Promise.resolve(this.nodes.get(child.hierarchy.parentId) ?? null);
  }

  listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(Array.from(this.nodes.values()), opts));
  }

  close(): Promise<void> {
    this.nodes.clear();
    return Promise.resolve();
  }

  // ─── Helpers ───

  private applyOpts(nodes: MemoryNode[], opts?: QueryOpts): MemoryNode[] {
    let results = nodes;

    if (opts?.level) {
      results = results.filter((n) => n.hierarchy.level === opts.level);
    }

    if (opts?.orderBy) {
      const dir = opts.order === "asc" ? 1 : -1;
      results.sort((a, b) => {
        const key = opts.orderBy!;
        let av: number;
        let bv: number;
        if (key === "timestamp") {
          av = a.timestamp;
          bv = b.timestamp;
        } else if (key === "salience") {
          av = a.payload.salienceScore;
          bv = b.payload.salienceScore;
        } else {
          // lastAccessed
          av = a.meta.lastAccessed ?? 0;
          bv = b.meta.lastAccessed ?? 0;
        }
        return (av - bv) * dir;
      });
    }

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? results.length;
      results = results.slice(offset, offset + limit);
    }

    return results;
  }
}
