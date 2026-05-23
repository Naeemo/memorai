/* eslint-disable unicorn/prefer-add-event-listener --
   IndexedDB uses the `onerror`/`onsuccess` pattern as its standard API.
*/
import { BM25Index } from "../bm25.js";
import { cosineSimilarity } from "../utils.js";
import type { EventQueryOpts, EventStore, MemoryEvent } from "../types.js";
import type { VectorFilter, VectorIndex } from "../vector/types.js";

/**
 * Browser IndexedDB-backed `EventStore`.
 *
 * Mirrors the `IndexedDBAdapter` pattern: one DB with object stores for
 * events, participants, and topics. BM25 is maintained in-memory and
 * rebuilt from IDB on construction. Compatible with any browser that
 * supports IndexedDB.
 *
 * Can share a database handle with `IndexedDBAdapter` (pass `db`) or
 * open its own (pass `dbName`).
 */
export class IndexedDBEventStore implements EventStore {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly eventsStore = "events";
  private readonly participantsStore = "event_participants";
  private readonly topicsStore = "event_topics";
  private readonly version = 1;
  private bm25 = new BM25Index();
  private bm25Hydrated = false;
  private readonly vectorIndex?: VectorIndex;

  constructor(
    opts: {
      /** Database name when opening independently. */
      dbName?: string;
      /** Shared IDBDatabase handle (e.g. from IndexedDBAdapter). */
      db?: IDBDatabase;
      vectorIndex?: VectorIndex;
    } = {},
  ) {
    this.dbName = opts.dbName ?? "memorai-events";
    this.vectorIndex = opts.vectorIndex;
    if (opts.db) {
      this.db = opts.db;
      this.initSchemaFromDb(opts.db);
    }
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
        this.initSchemaFromDb(db);
      };
    });
  }

  private initSchemaFromDb(db: IDBDatabase): void {
    // Events store
    if (!db.objectStoreNames.contains(this.eventsStore)) {
      const store = db.createObjectStore(this.eventsStore, { keyPath: "id" });
      store.createIndex("kind", "kind", { unique: false });
      store.createIndex("occurredAt", "occurredAt", { unique: false });
      store.createIndex("userId", "userId", { unique: false });
      store.createIndex("actor", "actor", { unique: false });
      store.createIndex("invalidatedAt", "invalidatedAt", { unique: false });
    }

    // Participants junction
    if (!db.objectStoreNames.contains(this.participantsStore)) {
      const store = db.createObjectStore(this.participantsStore, {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("eventId", "eventId", { unique: false });
      store.createIndex("participant", "participant", { unique: false });
    }

    // Topics junction
    if (!db.objectStoreNames.contains(this.topicsStore)) {
      const store = db.createObjectStore(this.topicsStore, {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("eventId", "eventId", { unique: false });
      store.createIndex("topic", "topic", { unique: false });
    }
  }

  private async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB operation failed"));
      req.onsuccess = () => resolve(req.result as T);
    });
  }

  async putEvent(event: MemoryEvent): Promise<void> {
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [this.eventsStore, this.participantsStore, this.topicsStore],
        "readwrite",
      );
      const eventStore = tx.objectStore(this.eventsStore);
      const partStore = tx.objectStore(this.participantsStore);
      const topicStore = tx.objectStore(this.topicsStore);

      // Put event
      eventStore.put(this.serializeEvent(event));

      // Clear old participants/topics then rewrite
      this.clearJunction(tx, partStore, "eventId", event.id);
      this.clearJunction(tx, topicStore, "eventId", event.id);

      for (const p of event.participants) {
        partStore.add({ eventId: event.id, participant: p.toLowerCase() });
      }
      for (const t of event.topics) {
        topicStore.add({ eventId: event.id, topic: t.toLowerCase() });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB putEvent failed"));
    });

    this.bm25.put(event.id, this.indexableText(event));
    if (this.vectorIndex && event.embedding) {
      await this.vectorIndex.upsert({
        id: event.id,
        embedding: event.embedding,
        metadata: {
          userId: event.userId ?? null,
          kind: event.kind,
          occurredAt: event.occurredAt,
          invalidated: event.invalidatedAt !== undefined,
        },
      });
    }
  }

  private serializeEvent(event: MemoryEvent): Record<string, unknown> {
    // Store as plain object; embedding arrays serialize fine in structured clone.
    return { ...event } as Record<string, unknown>;
  }

  private deserializeEvent(obj: unknown): MemoryEvent {
    return obj as MemoryEvent;
  }

  private clearJunction(
    tx: IDBTransaction,
    store: IDBObjectStore,
    indexName: string,
    eventId: string,
  ): void {
    const index = store.index(indexName);
    const req = index.openCursor(eventId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    const result = await this.withStore(this.eventsStore, "readonly", (store) => store.get(id));
    return result ? this.deserializeEvent(result) : null;
  }

  async deleteEvent(id: string): Promise<void> {
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [this.eventsStore, this.participantsStore, this.topicsStore],
        "readwrite",
      );
      const eventStore = tx.objectStore(this.eventsStore);
      const partStore = tx.objectStore(this.participantsStore);
      const topicStore = tx.objectStore(this.topicsStore);

      eventStore.delete(id);
      this.clearJunction(tx, partStore, "eventId", id);
      this.clearJunction(tx, topicStore, "eventId", id);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB deleteEvent failed"));
    });

    this.bm25.remove(id);
    if (this.vectorIndex) await this.vectorIndex.delete(id);
  }

  async batchPutEvents(events: MemoryEvent[]): Promise<void> {
    for (const ev of events) {
      await this.putEvent(ev);
    }
  }

  async queryEventsByEmbedding(
    embedding: number[],
    opts: EventQueryOpts & { topK?: number } = {},
  ): Promise<MemoryEvent[]> {
    const topK = opts.topK ?? opts.limit ?? 30;

    if (this.vectorIndex) {
      const filter: VectorFilter = {};
      if (opts.userId !== undefined) filter.userId = opts.userId;
      if (opts.kind !== undefined) filter.kind = opts.kind;
      if (opts.excludeInvalidated) filter.invalidated = false;
      const hits = await this.vectorIndex.query(embedding, {
        topK: topK * 2,
        minScore: 0,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      });
      const out: MemoryEvent[] = [];
      for (const h of hits) {
        const ev = await this.getEvent(h.id);
        if (!ev) continue;
        if (!this.passesFilter(ev, opts)) continue;
        out.push(ev);
        if (out.length >= topK) break;
      }
      return out;
    }

    // Linear fallback
    const all = await this.listEvents();
    const scored: Array<{ ev: MemoryEvent; score: number }> = [];
    for (const ev of all) {
      if (!this.passesFilter(ev, opts)) continue;
      if (!ev.embedding) continue;
      scored.push({ ev, score: cosineSimilarity(embedding, ev.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.ev);
  }

  async queryEventsByText(
    text: string,
    opts: EventQueryOpts & { topK?: number } = {},
  ): Promise<MemoryEvent[]> {
    const topK = opts.topK ?? opts.limit ?? 30;
    if (!this.bm25Hydrated) {
      const all = await this.listEvents();
      for (const ev of all) this.bm25.put(ev.id, this.indexableText(ev));
      this.bm25Hydrated = true;
    }
    const hits = this.bm25.search(text, topK * 3);
    const events: MemoryEvent[] = [];
    for (const h of hits) {
      const ev = await this.getEvent(h.docId);
      if (!ev) continue;
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
      if (events.length >= topK) break;
    }
    return events;
  }

  async queryEventsByParticipant(
    participant: string,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    const ids = await this.queryJunction(this.participantsStore, "participant", participant.toLowerCase());
    return this.materialize(ids, opts);
  }

  async queryEventsByTopic(topic: string, opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const ids = await this.queryJunction(this.topicsStore, "topic", topic.toLowerCase());
    return this.materialize(ids, opts);
  }

  async queryEventsByTimeRange(
    start: number,
    end: number,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.eventsStore, "readonly");
      const store = tx.objectStore(this.eventsStore);
      const index = store.index("occurredAt");
      const range = IDBKeyRange.bound(start, end);
      const request = index.openCursor(range);
      const events: MemoryEvent[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const ev = this.deserializeEvent(cursor.value);
          if (this.passesFilter(ev, opts)) events.push(ev);
          cursor.continue();
        } else {
          resolve(this.applyOrderAndPagination(events, opts));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB timeRange query failed"));
    });
  }

  async listEvents(opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.eventsStore, "readonly");
      const store = tx.objectStore(this.eventsStore);
      const request = store.openCursor();
      const events: MemoryEvent[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const ev = this.deserializeEvent(cursor.value);
          if (this.passesFilter(ev, opts)) events.push(ev);
          cursor.continue();
        } else {
          resolve(this.applyOrderAndPagination(events, opts));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB listEvents failed"));
    });
  }

  async closeEventStore(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.bm25.clear();
    this.bm25Hydrated = false;
    if (this.vectorIndex) await this.vectorIndex.clear();
  }

  // ─── helpers ───

  private async queryJunction(
    storeName: string,
    indexName: string,
    value: string,
  ): Promise<Set<string>> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(value);
      const ids = new Set<string>();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          ids.add((cursor.value as { eventId: string }).eventId);
          cursor.continue();
        } else {
          resolve(ids);
        }
      };
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB junction query failed`));
    });
  }

  private indexableText(ev: MemoryEvent): string {
    return [ev.description, ev.participants.join(" "), ev.topics.join(" ")]
      .filter(Boolean)
      .join(" — ");
  }

  private passesFilter(ev: MemoryEvent, opts: EventQueryOpts): boolean {
    if (opts.userId !== undefined && ev.userId !== opts.userId) return false;
    if (opts.kind && ev.kind !== opts.kind) return false;
    if (opts.excludeInvalidated && ev.invalidatedAt !== undefined) return false;
    if (opts.validAt !== undefined) {
      if (ev.invalidatedAt !== undefined && ev.invalidatedAt <= opts.validAt) return false;
    }
    return true;
  }

  private materialize(ids: Set<string>, opts: EventQueryOpts): Promise<MemoryEvent[]> {
    return new Promise((resolve, reject) => {
      const events: MemoryEvent[] = [];
      let pending = ids.size;
      if (pending === 0) {
        resolve(this.applyOrderAndPagination([], opts));
        return;
      }
      for (const id of ids) {
        this.getEvent(id)
          .then((ev) => {
            if (ev && this.passesFilter(ev, opts)) events.push(ev);
          })
          .catch(reject)
          .finally(() => {
            pending--;
            if (pending === 0) resolve(this.applyOrderAndPagination(events, opts));
          });
      }
    });
  }

  private applyOrderAndPagination(events: MemoryEvent[], opts: EventQueryOpts): MemoryEvent[] {
    const orderBy = opts.orderBy ?? "occurredAt";
    const order = opts.order ?? "desc";
    events.sort((a, b) => {
      const va = this.orderKey(a, orderBy);
      const vb = this.orderKey(b, orderBy);
      const cmp = va - vb;
      return order === "asc" ? cmp : -cmp;
    });
    const start = opts.offset ?? 0;
    const end = opts.limit !== undefined ? start + opts.limit : events.length;
    return events.slice(start, end);
  }

  private orderKey(ev: MemoryEvent, orderBy: NonNullable<EventQueryOpts["orderBy"]>): number {
    switch (orderBy) {
      case "occurredAt":
        return ev.occurredAt;
      case "lastAccessed":
        return ev.meta.lastAccessed ?? 0;
      case "confidence":
        return ev.confidence ?? 0;
    }
  }
}
