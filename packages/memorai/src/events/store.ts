import { BM25Index } from "../bm25.js";
import { cosineSimilarity } from "../utils.js";
import type { EventQueryOpts, EventStore, MemoryEvent, MemoryEventKind } from "../types.js";

/**
 * Default in-memory MemoryEvent store. Suitable for tests, single-process
 * agents, and benchmarks. Persistent backends can implement the same
 * `EventStore` interface against SQLite / IndexedDB / a vector DB.
 *
 * Indexing strategy:
 *   - participants / topics / kind → inverted maps for O(1) filter
 *   - description → BM25 for sparse retrieval
 *   - embedding → linear-scan cosine (fine up to ~10⁵ events; swap for ANN
 *     when scale demands)
 *
 * Validity semantics:
 *   - `invalidatedAt` undefined means "still believed true"
 *   - filters honor `validAt` (event is valid if invalidatedAt > validAt OR
 *     invalidatedAt undefined) and `excludeInvalidated` (drop anything with
 *     invalidatedAt set)
 */
export class InMemoryEventStore implements EventStore {
  private byId = new Map<string, MemoryEvent>();
  private byParticipant = new Map<string, Set<string>>();
  private byTopic = new Map<string, Set<string>>();
  private byKind = new Map<MemoryEventKind, Set<string>>();
  private bm25 = new BM25Index();

  async putEvent(event: MemoryEvent): Promise<void> {
    const existing = this.byId.get(event.id);
    if (existing) {
      this.unindex(existing);
    }
    this.byId.set(event.id, event);
    this.index(event);
  }

  async getEvent(id: string): Promise<MemoryEvent | null> {
    return this.byId.get(id) ?? null;
  }

  async deleteEvent(id: string): Promise<void> {
    const ev = this.byId.get(id);
    if (!ev) return;
    this.unindex(ev);
    this.byId.delete(id);
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
    const scored: Array<{ ev: MemoryEvent; score: number }> = [];
    for (const ev of this.byId.values()) {
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
    const hits = this.bm25.search(text, topK * 3);
    const events: MemoryEvent[] = [];
    for (const h of hits) {
      const ev = this.byId.get(h.docId);
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
    const ids = this.byParticipant.get(participant.toLowerCase()) ?? new Set();
    return this.materialize(ids, opts);
  }

  async queryEventsByTopic(topic: string, opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const ids = this.byTopic.get(topic.toLowerCase()) ?? new Set();
    return this.materialize(ids, opts);
  }

  async queryEventsByTimeRange(
    start: number,
    end: number,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    const events: MemoryEvent[] = [];
    for (const ev of this.byId.values()) {
      if (ev.occurredAt < start || ev.occurredAt > end) continue;
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
    }
    return this.applyOrderAndPagination(events, opts);
  }

  async listEvents(opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const events: MemoryEvent[] = [];
    for (const ev of this.byId.values()) {
      if (!this.passesFilter(ev, opts)) continue;
      events.push(ev);
    }
    return this.applyOrderAndPagination(events, opts);
  }

  async closeEventStore(): Promise<void> {
    this.byId.clear();
    this.byParticipant.clear();
    this.byTopic.clear();
    this.byKind.clear();
    this.bm25 = new BM25Index();
  }

  // ─── helpers ───

  private index(ev: MemoryEvent): void {
    for (const p of ev.participants) {
      const key = p.toLowerCase();
      if (!this.byParticipant.has(key)) this.byParticipant.set(key, new Set());
      this.byParticipant.get(key)!.add(ev.id);
    }
    for (const t of ev.topics) {
      const key = t.toLowerCase();
      if (!this.byTopic.has(key)) this.byTopic.set(key, new Set());
      this.byTopic.get(key)!.add(ev.id);
    }
    if (!this.byKind.has(ev.kind)) this.byKind.set(ev.kind, new Set());
    this.byKind.get(ev.kind)!.add(ev.id);
    this.bm25.put(ev.id, this.indexableText(ev));
  }

  private unindex(ev: MemoryEvent): void {
    for (const p of ev.participants) {
      this.byParticipant.get(p.toLowerCase())?.delete(ev.id);
    }
    for (const t of ev.topics) {
      this.byTopic.get(t.toLowerCase())?.delete(ev.id);
    }
    this.byKind.get(ev.kind)?.delete(ev.id);
    this.bm25.remove(ev.id);
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

  private materialize(ids: Set<string>, opts: EventQueryOpts): MemoryEvent[] {
    const events: MemoryEvent[] = [];
    for (const id of ids) {
      const ev = this.byId.get(id);
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
