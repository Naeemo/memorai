import { BM25Index } from "../bm25.js";
import { cosineSimilarity } from "../utils.js";
import type { EventQueryOpts, EventStore, MemoryEvent, MemoryEventKind } from "../types.js";
import type { VectorFilter, VectorIndex } from "../vector/types.js";

interface NamespaceData {
  byId: Map<string, MemoryEvent>;
  byParticipant: Map<string, Set<string>>;
  byTopic: Map<string, Set<string>>;
  byKind: Map<MemoryEventKind, Set<string>>;
  bm25: BM25Index;
}

/**
 * Default in-memory MemoryEvent store. Suitable for tests, single-process
 * agents, and benchmarks. Persistent backends can implement the same
 * `EventStore` interface against SQLite / IndexedDB / a vector DB.
 *
 * Indexing strategy:
 *   - participants / topics / kind -> inverted maps for O(1) filter
 *   - description -> BM25 for sparse retrieval
 *   - embedding -> linear-scan cosine (fine up to ~10^5 events; swap for ANN
 *     when scale demands)
 *
 * When `namespace` is set, the store physically partitions data so that each
 * namespace has its own isolated event set and indexes.
 *
 * Validity semantics:
 *   - `invalidatedAt` undefined means "still believed true"
 *   - filters honor `validAt` (event is valid if invalidatedAt > validAt OR
 *     invalidatedAt undefined) and `excludeInvalidated` (drop anything with
 *     invalidatedAt set)
 */
export class InMemoryEventStore implements EventStore {
  private readonly namespace: string | undefined;
  private readonly partitions = new Map<string, NamespaceData>();
  private readonly vectorIndex?: VectorIndex;

  constructor(opts: { vectorIndex?: VectorIndex; namespace?: string } = {}) {
    this.vectorIndex = opts.vectorIndex;
    this.namespace = opts.namespace;
  }

  private getData(): NamespaceData {
    const key = this.namespace ?? "__default__";
    let data = this.partitions.get(key);
    if (!data) {
      data = {
        byId: new Map(),
        byParticipant: new Map(),
        byTopic: new Map(),
        byKind: new Map(),
        bm25: new BM25Index(),
      };
      this.partitions.set(key, data);
    }
    return data;
  }

  async putEvent(event: MemoryEvent): Promise<void> {
    const d = this.getData();
    const existing = d.byId.get(event.id);
    if (existing) {
      this.unindex(d, existing);
    }
    d.byId.set(event.id, event);
    this.index(d, event);
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

  async getEvent(id: string): Promise<MemoryEvent | null> {
    return this.getData().byId.get(id) ?? null;
  }

  async deleteEvent(id: string): Promise<void> {
    const d = this.getData();
    const ev = d.byId.get(id);
    if (!ev) return;
    this.unindex(d, ev);
    d.byId.delete(id);
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
    const d = this.getData();

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
      const events: MemoryEvent[] = [];
      for (const h of hits) {
        const ev = d.byId.get(h.id);
        if (!ev) continue;
        if (!this.passesFilter(ev, opts)) continue;
        events.push(ev);
        if (events.length >= topK) break;
      }
      return events;
    }

    const scored: Array<{ ev: MemoryEvent; score: number }> = [];
    for (const ev of d.byId.values()) {
      if (!this.passesFilter(ev, opts)) continue;
      if (!ev.embedding) continue;
      const score = cosineSimilarity(embedding, ev.embedding);
      scored.push({ ev, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.ev);
  }

  async queryEventsByText(
    text: string,
    opts: EventQueryOpts & { topK?: number } = {},
  ): Promise<MemoryEvent[]> {
    const topK = opts.topK ?? opts.limit ?? 30;
    const d = this.getData();
    const hits = d.bm25.search(text, topK * 3);
    const events: MemoryEvent[] = [];
    for (const h of hits) {
      const ev = d.byId.get(h.docId);
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
    const d = this.getData();
    const ids = d.byParticipant.get(participant.toLowerCase()) ?? new Set();
    return this.materialize(d, ids, opts);
  }

  async queryEventsByTopic(topic: string, opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const d = this.getData();
    const ids = d.byTopic.get(topic.toLowerCase()) ?? new Set();
    return this.materialize(d, ids, opts);
  }

  async queryEventsByTimeRange(
    start: number,
    end: number,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    const d = this.getData();
    const events: MemoryEvent[] = [];
    for (const ev of d.byId.values()) {
      if (ev.occurredAt < start || ev.occurredAt > end) continue;
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
    }
    return this.applyOrderAndPagination(events, opts);
  }

  async listEvents(opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const d = this.getData();
    const events: MemoryEvent[] = [];
    for (const ev of d.byId.values()) {
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
    }
    return this.applyOrderAndPagination(events, opts);
  }

  async closeEventStore(): Promise<void> {
    this.partitions.clear();
    if (this.vectorIndex) await this.vectorIndex.clear();
  }

  // --- helpers ---

  private index(d: NamespaceData, ev: MemoryEvent): void {
    for (const p of ev.participants) {
      const key = p.toLowerCase();
      if (!d.byParticipant.has(key)) d.byParticipant.set(key, new Set());
      d.byParticipant.get(key)!.add(ev.id);
    }
    for (const t of ev.topics) {
      const key = t.toLowerCase();
      if (!d.byTopic.has(key)) d.byTopic.set(key, new Set());
      d.byTopic.get(key)!.add(ev.id);
    }
    if (!d.byKind.has(ev.kind)) d.byKind.set(ev.kind, new Set());
    d.byKind.get(ev.kind)!.add(ev.id);
    d.bm25.put(ev.id, this.indexableText(ev));
  }

  private unindex(d: NamespaceData, ev: MemoryEvent): void {
    for (const p of ev.participants) {
      d.byParticipant.get(p.toLowerCase())?.delete(ev.id);
    }
    for (const t of ev.topics) {
      d.byTopic.get(t.toLowerCase())?.delete(ev.id);
    }
    d.byKind.get(ev.kind)?.delete(ev.id);
    d.bm25.remove(ev.id);
  }

  private indexableText(ev: MemoryEvent): string {
    const parts = [ev.description, ev.participants.join(" "), ev.topics.join(" ")].filter(Boolean);
    return parts.join(" — ");
  }

  private passesFilter(ev: MemoryEvent, opts: EventQueryOpts): boolean {
    if (opts.userId !== undefined && ev.userId !== opts.userId) return false;
    if (opts.kind && ev.kind !== opts.kind) return false;
    if (opts.excludeInvalidated && ev.invalidatedAt !== undefined) return false;
    if (opts.validAt !== undefined) {
      if (ev.invalidatedAt !== undefined && ev.invalidatedAt <= opts.validAt) {
        return false;
      }
    }
    return true;
  }

  private materialize(d: NamespaceData, ids: Set<string>, opts: EventQueryOpts): MemoryEvent[] {
    const events: MemoryEvent[] = [];
    for (const id of ids) {
      const ev = d.byId.get(id);
      if (!ev) continue;
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
    }
    return this.applyOrderAndPagination(events, opts);
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
