import type { MemoryNode, QueryOpts, StorageAdapter } from "../types.js";
import { BM25Index } from "../bm25.js";
import { composeIndexableText } from "../extraction/shared.js";

interface NamespaceData {
  nodes: Map<string, MemoryNode>;
  tagIndex: Map<string, Set<string>>;
  userIndex: Map<string, Set<string>>;
  actorIndex: Map<string, Set<string>>;
  targetIndex: Map<string, Set<string>>;
  temporalAnchorIndex: Map<string, Set<string>>;
  bm25: BM25Index;
}

/**
 * In-memory storage adapter.
 * Fast, ephemeral. Ideal for testing and development.
 * All operations are synchronous under the hood but wrapped in Promises
 * to satisfy the StorageAdapter interface.
 *
 * When `namespace` is set, the adapter physically partitions data so that
 * each namespace has its own isolated node set, indexes, and BM25 corpus.
 * This is the behavior used by `Memorai` when `MemoraiConfig.namespace`
 * is provided with the default in-memory adapter.
 */
export class MemoryAdapter implements StorageAdapter {
  private readonly namespace: string | undefined;
  private readonly partitions = new Map<string, NamespaceData>();

  constructor(opts: { namespace?: string } = {}) {
    this.namespace = opts.namespace;
  }

  private getData(): NamespaceData {
    const key = this.namespace ?? "__default__";
    let data = this.partitions.get(key);
    if (!data) {
      data = {
        nodes: new Map(),
        tagIndex: new Map(),
        userIndex: new Map(),
        actorIndex: new Map(),
        targetIndex: new Map(),
        temporalAnchorIndex: new Map(),
        bm25: new BM25Index(),
      };
      this.partitions.set(key, data);
    }
    return data;
  }

  put(node: MemoryNode): Promise<void> {
    const d = this.getData();
    this.unindex(d, node.id);
    d.nodes.set(node.id, node);
    this.index(d, node);
    return Promise.resolve();
  }

  get(id: string): Promise<MemoryNode | null> {
    return Promise.resolve(this.getData().nodes.get(id) ?? null);
  }

  delete(id: string): Promise<void> {
    const d = this.getData();
    this.unindex(d, id);
    d.nodes.delete(id);
    return Promise.resolve();
  }

  batchPut(nodes: MemoryNode[]): Promise<void> {
    const d = this.getData();
    for (const node of nodes) {
      this.unindex(d, node.id);
      d.nodes.set(node.id, node);
      this.index(d, node);
    }
    return Promise.resolve();
  }

  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const results = Array.from(this.getData().nodes.values()).filter(
      (n) => n.timestamp >= start && n.timestamp <= end,
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]> {
    const d = this.getData();
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const idSet = new Set<string>();
    for (const tag of tagSet) {
      const ids = d.tagIndex.get(tag);
      if (ids) {
        for (const id of ids) {
          idSet.add(id);
        }
      }
    }
    const results = Array.from(idSet)
      .map((id) => d.nodes.get(id)!)
      .filter(Boolean);
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const results = Array.from(this.getData().nodes.values()).filter(
      (n) => n.annotations.salienceScore >= minScore,
    );
    return Promise.resolve(this.applyOpts(results, opts));
  }

  queryByUserId(userId: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.getData().userIndex, userId), opts));
  }

  queryByActor(actor: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.getData().actorIndex, actor), opts));
  }

  queryByTarget(target: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(this.lookup(this.getData().targetIndex, target), opts));
  }

  queryByTemporalAnchor(name: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    const normalized = name.toLowerCase().trim();
    return Promise.resolve(
      this.applyOpts(this.lookup(this.getData().temporalAnchorIndex, normalized), opts),
    );
  }

  queryByText(text: string, opts?: QueryOpts & { limit?: number }): Promise<MemoryNode[]> {
    const d = this.getData();
    const limit = opts?.limit ?? 50;
    const hits = d.bm25.search(text, limit);
    const nodes = hits
      .map((h) => d.nodes.get(h.docId))
      .filter((n): n is MemoryNode => Boolean(n));
    return Promise.resolve(this.applyOpts(nodes, opts));
  }

  getChildren(parentId: string): Promise<MemoryNode[]> {
    return Promise.resolve(
      Array.from(this.getData().nodes.values()).filter((n) => n.parentId === parentId),
    );
  }

  getParent(childId: string): Promise<MemoryNode | null> {
    const d = this.getData();
    const child = d.nodes.get(childId);
    if (!child?.parentId) return Promise.resolve(null);
    return Promise.resolve(d.nodes.get(child.parentId) ?? null);
  }

  listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    return Promise.resolve(this.applyOpts(Array.from(this.getData().nodes.values()), opts));
  }

  close(): Promise<void> {
    this.partitions.clear();
    return Promise.resolve();
  }

  // ─── Helpers ───

  private index(d: NamespaceData, node: MemoryNode): void {
    for (const tag of node.annotations.tags) {
      addToIndex(d.tagIndex, tag.toLowerCase(), node.id);
    }
    if (node.userId) addToIndex(d.userIndex, node.userId, node.id);
    if (node.actor) addToIndex(d.actorIndex, node.actor, node.id);
    if (node.target) addToIndex(d.targetIndex, node.target, node.id);
    if (node.annotations.temporalAnchors) {
      for (const a of node.annotations.temporalAnchors) {
        addToIndex(d.temporalAnchorIndex, a.name.toLowerCase().trim(), node.id);
      }
    }
    d.bm25.put(node.id, this.indexableText(node));
  }

  private unindex(d: NamespaceData, id: string): void {
    const existing = d.nodes.get(id);
    if (!existing) return;
    for (const tag of existing.annotations.tags) {
      removeFromIndex(d.tagIndex, tag.toLowerCase(), id);
    }
    if (existing.userId) removeFromIndex(d.userIndex, existing.userId, id);
    if (existing.actor) removeFromIndex(d.actorIndex, existing.actor, id);
    if (existing.target) removeFromIndex(d.targetIndex, existing.target, id);
    if (existing.annotations.temporalAnchors) {
      for (const a of existing.annotations.temporalAnchors) {
        removeFromIndex(d.temporalAnchorIndex, a.name.toLowerCase().trim(), id);
      }
    }
    d.bm25.remove(id);
  }

  private indexableText(node: MemoryNode): string {
    return composeIndexableText(node.raw, node.annotations, {
      coveredByEvent: node.meta.coveredByEvent,
    });
  }

  private lookup(index: Map<string, Set<string>>, key: string): MemoryNode[] {
    const ids = index.get(key);
    if (!ids) return [];
    return [...ids].map((id) => this.getData().nodes.get(id)!).filter(Boolean);
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
          av = a.annotations.salienceScore;
          bv = b.annotations.salienceScore;
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
