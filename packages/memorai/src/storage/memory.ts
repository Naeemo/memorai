import type { MemoryNode, QueryOpts, StorageAdapter } from "../types.js";

/**
 * In-memory storage adapter.
 * Fast, ephemeral. Ideal for testing and development.
 * All operations are synchronous under the hood but wrapped in Promises
 * to satisfy the StorageAdapter interface.
 */
export class MemoryAdapter implements StorageAdapter {
  private nodes = new Map<string, MemoryNode>();
  private tagIndex = new Map<string, Set<string>>();
  private userIndex = new Map<string, Set<string>>();
  private actorIndex = new Map<string, Set<string>>();
  private targetIndex = new Map<string, Set<string>>();

  put(node: MemoryNode): Promise<void> {
    this.unindex(node.id);
    this.nodes.set(node.id, node);
    this.index(node);
    return Promise.resolve();
  }

  get(id: string): Promise<MemoryNode | null> {
    return Promise.resolve(this.nodes.get(id) ?? null);
  }

  delete(id: string): Promise<void> {
    this.unindex(id);
    this.nodes.delete(id);
    return Promise.resolve();
  }

  batchPut(nodes: MemoryNode[]): Promise<void> {
    for (const node of nodes) {
      this.unindex(node.id);
      this.nodes.set(node.id, node);
      this.index(node);
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
    const idSet = new Set<string>();
    for (const tag of tagSet) {
      const ids = this.tagIndex.get(tag);
      if (ids) {
        for (const id of ids) {
          idSet.add(id);
        }
      }
    }
    const results = Array.from(idSet)
      .map((id) => this.nodes.get(id)!)
      .filter(Boolean);
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const results = Array.from(this.nodes.values()).filter(
      (n) => n.payload.salienceScore >= minScore,
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryByUserId(userId: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.userIndex, userId), opts));
  }

  queryByActor(actor: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.actorIndex, actor), opts));
  }

  queryByTarget(target: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.targetIndex, target), opts));
  }

  getChildren(parentId: string): Promise<MemoryNode[]> {
    return Promise.resolve(
      Array.from(this.nodes.values()).filter((n) => n.parentId === parentId),
    );
  }

  getParent(childId: string): Promise<MemoryNode | null> {
    const child = this.nodes.get(childId);
    if (!child?.parentId) return Promise.resolve(null);
    return Promise.resolve(this.nodes.get(child.parentId) ?? null);
  }

  listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(Array.from(this.nodes.values()), opts));
  }

  close(): Promise<void> {
    this.nodes.clear();
    this.tagIndex.clear();
    this.userIndex.clear();
    this.actorIndex.clear();
    this.targetIndex.clear();
    return Promise.resolve();
  }

  // ─── Helpers ───

  private index(node: MemoryNode): void {
    for (const tag of node.payload.tags) {
      addToIndex(this.tagIndex, tag.toLowerCase(), node.id);
    }
    if (node.userId) addToIndex(this.userIndex, node.userId, node.id);
    if (node.actor) addToIndex(this.actorIndex, node.actor, node.id);
    if (node.target) addToIndex(this.targetIndex, node.target, node.id);
  }

  private unindex(id: string): void {
    const existing = this.nodes.get(id);
    if (!existing) return;
    for (const tag of existing.payload.tags) {
      removeFromIndex(this.tagIndex, tag.toLowerCase(), id);
    }
    if (existing.userId) removeFromIndex(this.userIndex, existing.userId, id);
    if (existing.actor) removeFromIndex(this.actorIndex, existing.actor, id);
    if (existing.target) removeFromIndex(this.targetIndex, existing.target, id);
  }

  private lookup(index: Map<string, Set<string>>, key: string): MemoryNode[] {
    const ids = index.get(key);
    if (!ids) return [];
    return [...ids].map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  private applyOpts(nodes: MemoryNode[], opts?: QueryOpts): MemoryNode[] {
    let results = nodes;

    if (opts?.level) {
      results = results.filter((n) => n.level === opts.level);
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

function addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(id);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) index.delete(key);
}
