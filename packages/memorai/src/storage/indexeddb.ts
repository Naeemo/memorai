/* eslint-disable unicorn/prefer-add-event-listener --
   IndexedDB uses the `onerror`/`onsuccess` pattern as its standard API.
   `addEventListener` on IDBRequest is supported but unconventional.
*/
import type { MemoryNode, QueryOpts, StorageAdapter } from "../types.js";
import { BM25Index } from "../bm25.js";
import { composeIndexableText } from "../extraction/shared.js";

/**
 * Browser IndexedDB storage adapter.
 * Stores MemoryNodes as JSON in an object store named 'memories'.
 * Uses a single DB with object store keyed by node.id.
 *
 * IndexedDB operations are wrapped in Promises for async/await ergonomics.
 *
 * BM25: maintained in-memory alongside the persisted store. The index is
 * lazily rebuilt from IDB on the first `queryByText` call.
 */
export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly storeName = "memories";
  // v3: salience index keyPath moved from "payload.salienceScore" to
  // "annotations.salienceScore" (Memorai 0.3.0 raw/annotations split).
  private readonly version = 4;
  private bm25 = new BM25Index();
  private bm25Hydrated = false;

  constructor(opts: { dbName?: string } = {}) {
    this.dbName = opts.dbName ?? "memorai";
  }

  private getDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = (event.target as IDBOpenDBRequest).transaction;
        const oldVersion = event.oldVersion;
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(this.storeName)) {
          store = db.createObjectStore(this.storeName, { keyPath: "id" });
        } else {
          store = tx!.objectStore(this.storeName);
        }
        // The salience index was repointed in v3 (payload → annotations);
        // drop+recreate so existing DBs migrate cleanly.
        if (store.indexNames.contains("salience")) {
          store.deleteIndex("salience");
        }
        // Indexes — created idempotently
        ensureIndex(store, "timestamp", "timestamp");
        ensureIndex(store, "salience", "annotations.salienceScore");
        ensureIndex(store, "level", "level");
        ensureIndex(store, "parentId", "parentId");
        ensureIndex(store, "agentRole", "meta.agentRole");
        ensureIndex(store, "userId", "userId");
        ensureIndex(store, "actor", "actor");
        ensureIndex(store, "target", "target");

        // v4: MemoryLevel "event" → "episode" rename. Migrate existing rows.
        if (oldVersion > 0 && oldVersion < 4) {
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = (ev) => {
            const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            const node = cursor.value as MemoryNode & { level: string };
            if ((node.level as string) === "event") {
              node.level = "episode";
              cursor.update(node);
            }
            cursor.continue();
          };
        }
      };
    });
  }

  private async withStore(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      const req = fn(store);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB operation failed"));
      req.onsuccess = () => resolve(req.result);
    });
  }

  async put(node: MemoryNode): Promise<void> {
    await this.withStore("readwrite", (store) => store.put(node));
    this.bm25.put(node.id, this.indexableText(node));
  }

  async get(id: string): Promise<MemoryNode | null> {
    const result = await this.withStore("readonly", (store) => store.get(id));
    return (result as MemoryNode | undefined) ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.withStore("readwrite", (store) => store.delete(id));
    this.bm25.remove(id);
  }

  async batchPut(nodes: MemoryNode[]): Promise<void> {
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      for (const node of nodes) {
        store.put(node);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB batch put failed"));
    });
    for (const node of nodes) {
      this.bm25.put(node.id, this.indexableText(node));
    }
  }

  async queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    return this.applyOpts(await this.scanIndex("timestamp", IDBKeyRange.bound(start, end)), opts);
  }

  async queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]> {
    // IndexedDB doesn't support array-contains natively; scan all
    const all = await this.listAll();
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const filtered = all.filter((n) => n.annotations.tags.some((t) => tagSet.has(t.toLowerCase())));
    return this.applyOpts(filtered, opts);
  }

  async queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    return this.applyOpts(await this.scanIndex("salience", IDBKeyRange.lowerBound(minScore)), opts);
  }

  async queryByUserId(userId: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return this.applyOpts(await this.scanIndex("userId", userId), opts);
  }

  async queryByActor(actor: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return this.applyOpts(await this.scanIndex("actor", actor), opts);
  }

  async queryByTarget(target: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    return this.applyOpts(await this.scanIndex("target", target), opts);
  }

  async queryByText(text: string, opts?: QueryOpts & { limit?: number }): Promise<MemoryNode[]> {
    if (!this.bm25Hydrated) {
      const all = await this.listAll();
      for (const n of all) this.bm25.put(n.id, this.indexableText(n));
      this.bm25Hydrated = true;
    }
    const limit = opts?.limit ?? 50;
    const hits = this.bm25.search(text, Math.max(limit, 50));
    const nodes: MemoryNode[] = [];
    for (const h of hits) {
      const n = await this.get(h.docId);
      if (n) nodes.push(n);
    }
    return this.applyOpts(nodes, opts);
  }

  async getChildren(parentId: string): Promise<MemoryNode[]> {
    return this.scanIndex("parentId", parentId);
  }

  async getParent(childId: string): Promise<MemoryNode | null> {
    const child = await this.get(childId);
    if (!child?.parentId) return null;
    return this.get(child.parentId);
  }

  async listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.openCursor();

      const results: MemoryNode[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value as MemoryNode);
          cursor.continue();
        } else {
          resolve(this.applyOpts(results, opts));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB listAll failed"));
    });
  }

  close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.bm25.clear();
    this.bm25Hydrated = false;
    return Promise.resolve();
  }

  // ─── Helpers ───

  private indexableText(node: MemoryNode): string {
    return composeIndexableText(node.raw, node.annotations);
  }

  private async scanIndex(name: string, range: IDBKeyRange | IDBValidKey): Promise<MemoryNode[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const index = store.index(name);
      const request = index.openCursor(range);
      const results: MemoryNode[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value as MemoryNode);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error(`IndexedDB scanIndex(${name}) failed`));
    });
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

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, { unique: false });
  }
}
