import { BM25Index } from "../bm25.js";
import { cosineSimilarity } from "../utils.js";
import type { EventQueryOpts, EventStore, MemoryEvent } from "../types.js";
import type { SQLiteDatabase, SQLiteStatement } from "../storage/sqlite.js";
import type { VectorFilter, VectorIndex } from "../vector/types.js";

/**
 * SQLite-backed `EventStore`.
 *
 * Mirrors the `SQLiteAdapter` pattern: prepared statements, JSON blob +
 * indexed scalar columns, in-memory BM25 index rebuilt on construction.
 * Compatible with any SQLite library that satisfies the `SQLiteDatabase`
 * interface (better-sqlite3 / bun:sqlite / @db/sqlite).
 *
 * Schema:
 *   events(id, json, kind, occurredAt, invalidatedAt, userId, actor)
 *   event_participants(eventId, participant)
 *   event_topics(eventId, topic)
 *
 * Vector queries fall back to a linear scan over rows that have an
 * `embedding` field in their JSON unless `opts.vectorIndex` is supplied —
 * same shape as `InMemoryEventStore`.
 */
export class SQLiteEventStore implements EventStore {
  private readonly insertStmt: SQLiteStatement;
  private readonly deleteStmt: SQLiteStatement;
  private readonly getStmt: SQLiteStatement;
  private readonly listStmt: SQLiteStatement;
  private readonly byKindStmt: SQLiteStatement;
  private readonly byUserStmt: SQLiteStatement;
  private readonly byParticipantStmt: SQLiteStatement;
  private readonly byTopicStmt: SQLiteStatement;
  private readonly byTimeRangeStmt: SQLiteStatement;
  private readonly insertParticipant: SQLiteStatement;
  private readonly insertTopic: SQLiteStatement;
  private readonly deleteParticipants: SQLiteStatement;
  private readonly deleteTopics: SQLiteStatement;
  private bm25 = new BM25Index();
  private readonly vectorIndex?: VectorIndex;

  constructor(
    private readonly db: SQLiteDatabase,
    opts: { vectorIndex?: VectorIndex } = {},
  ) {
    this.vectorIndex = opts.vectorIndex;
    this.initSchema();

    this.insertStmt = db.prepare(
      `INSERT INTO events (id, json, kind, occurredAt, invalidatedAt, userId, actor)
       VALUES (:id, :json, :kind, :occurredAt, :invalidatedAt, :userId, :actor)
       ON CONFLICT(id) DO UPDATE SET
         json=excluded.json, kind=excluded.kind,
         occurredAt=excluded.occurredAt, invalidatedAt=excluded.invalidatedAt,
         userId=excluded.userId, actor=excluded.actor`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM events WHERE id=?`);
    this.getStmt = db.prepare(`SELECT json FROM events WHERE id=?`);
    this.listStmt = db.prepare(`SELECT json FROM events ORDER BY occurredAt DESC`);
    this.byKindStmt = db.prepare(`SELECT json FROM events WHERE kind=? ORDER BY occurredAt DESC`);
    this.byUserStmt = db.prepare(`SELECT json FROM events WHERE userId=? ORDER BY occurredAt DESC`);
    this.byParticipantStmt = db.prepare(
      `SELECT e.json FROM events e INNER JOIN event_participants p ON e.id = p.eventId
       WHERE p.participant = ? ORDER BY e.occurredAt DESC`,
    );
    this.byTopicStmt = db.prepare(
      `SELECT e.json FROM events e INNER JOIN event_topics t ON e.id = t.eventId
       WHERE t.topic = ? ORDER BY e.occurredAt DESC`,
    );
    this.byTimeRangeStmt = db.prepare(
      `SELECT json FROM events WHERE occurredAt >= ? AND occurredAt <= ?
       ORDER BY occurredAt DESC`,
    );
    this.insertParticipant = db.prepare(
      `INSERT OR IGNORE INTO event_participants (eventId, participant) VALUES (?, ?)`,
    );
    this.insertTopic = db.prepare(
      `INSERT OR IGNORE INTO event_topics (eventId, topic) VALUES (?, ?)`,
    );
    this.deleteParticipants = db.prepare(`DELETE FROM event_participants WHERE eventId = ?`);
    this.deleteTopics = db.prepare(`DELETE FROM event_topics WHERE eventId = ?`);

    // Rebuild in-memory BM25 from pre-existing rows on construction.
    const all = this.listStmt.all() as Array<{ json: string }>;
    for (const row of all) {
      const ev = this.parse(row.json);
      this.bm25.put(ev.id, this.indexableText(ev));
    }
  }

  private initSchema(): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurredAt INTEGER NOT NULL,
      invalidatedAt INTEGER,
      userId TEXT,
      actor TEXT
    )`,
      )
      .run();
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_events_occurredAt ON events(occurredAt DESC)`)
      .run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_userId ON events(userId)`).run();
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_events_invalidated ON events(invalidatedAt)`)
      .run();

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS event_participants (
      eventId TEXT NOT NULL,
      participant TEXT NOT NULL,
      PRIMARY KEY (eventId, participant),
      FOREIGN KEY (eventId) REFERENCES events(id) ON DELETE CASCADE
    )`,
      )
      .run();
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_event_participants ON event_participants(participant)`,
      )
      .run();

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS event_topics (
      eventId TEXT NOT NULL,
      topic TEXT NOT NULL,
      PRIMARY KEY (eventId, topic),
      FOREIGN KEY (eventId) REFERENCES events(id) ON DELETE CASCADE
    )`,
      )
      .run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_event_topics ON event_topics(topic)`).run();
  }

  async putEvent(event: MemoryEvent): Promise<void> {
    const json = JSON.stringify(event);
    this.insertStmt.run({
      id: event.id,
      json,
      kind: event.kind,
      occurredAt: event.occurredAt,
      invalidatedAt: event.invalidatedAt ?? null,
      userId: event.userId ?? null,
      actor: event.actor ?? null,
    });
    // Rewrite inverted tables — small per-event cost, simpler than diffing.
    this.deleteParticipants.run([event.id]);
    this.deleteTopics.run([event.id]);
    for (const p of event.participants) {
      this.insertParticipant.run([event.id, p.toLowerCase()]);
    }
    for (const t of event.topics) {
      this.insertTopic.run([event.id, t.toLowerCase()]);
    }
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

  async getEvent(id: string): Promise<MemoryEvent | null> {
    const row = this.getStmt.get([id]) as { json: string } | null;
    return row ? this.parse(row.json) : null;
  }

  async deleteEvent(id: string): Promise<void> {
    this.deleteStmt.run([id]);
    this.bm25.remove(id);
    if (this.vectorIndex) await this.vectorIndex.delete(id);
  }

  async batchPutEvents(events: MemoryEvent[]): Promise<void> {
    for (const ev of events) await this.putEvent(ev);
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

    // Linear fallback over rows that have an embedding in their JSON.
    const rows = this.listStmt.all() as Array<{ json: string }>;
    const scored: Array<{ ev: MemoryEvent; score: number }> = [];
    for (const row of rows) {
      const ev = this.parse(row.json);
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
    const rows = this.byParticipantStmt.all([participant.toLowerCase()]) as Array<{
      json: string;
    }>;
    return this.materializeAndPaginate(rows, opts);
  }

  async queryEventsByTopic(topic: string, opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    const rows = this.byTopicStmt.all([topic.toLowerCase()]) as Array<{ json: string }>;
    return this.materializeAndPaginate(rows, opts);
  }

  async queryEventsByTimeRange(
    start: number,
    end: number,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    const rows = this.byTimeRangeStmt.all([start, end]) as Array<{ json: string }>;
    return this.materializeAndPaginate(rows, opts);
  }

  async queryEventsByValidTime(
    start: number,
    end: number,
    opts: EventQueryOpts = {},
  ): Promise<MemoryEvent[]> {
    // Validity lives inside the JSON blob — scan all rows and filter in JS.
    const rows = this.listStmt.all() as Array<{ json: string }>;
    let events = rows.map((r) => this.parse(r.json)).filter((e) => this.passesFilter(e, opts));
    events = events.filter((ev) => {
      const vs = ev.validity?.validStart ?? ev.occurredAt;
      const ve = ev.validity?.validEnd;
      if (vs > end) return false;
      if (ve !== undefined && ve < start) return false;
      return true;
    });
    return this.applyOrderAndPagination(events, opts);
  }

  private applyOrderAndPagination(events: MemoryEvent[], opts: EventQueryOpts): MemoryEvent[] {
    if (opts.orderBy) {
      const orderBy = opts.orderBy;
      const order = opts.order ?? "desc";
      events.sort((a, b) => {
        const va = this.orderKey(a, orderBy);
        const vb = this.orderKey(b, orderBy);
        return order === "asc" ? va - vb : vb - va;
      });
    }
    const start = opts.offset ?? 0;
    const end = opts.limit !== undefined ? start + opts.limit : events.length;
    return events.slice(start, end);
  }

  async listEvents(opts: EventQueryOpts = {}): Promise<MemoryEvent[]> {
    let rows: Array<{ json: string }>;
    if (opts.kind) {
      rows = this.byKindStmt.all([opts.kind]) as Array<{ json: string }>;
    } else if (opts.userId !== undefined) {
      rows = this.byUserStmt.all([opts.userId]) as Array<{ json: string }>;
    } else {
      rows = this.listStmt.all() as Array<{ json: string }>;
    }
    return this.materializeAndPaginate(rows, opts);
  }

  async closeEventStore(): Promise<void> {
    this.bm25.clear();
    if (this.vectorIndex) await this.vectorIndex.clear();
    // We don't close the underlying db handle — callers own its lifecycle
    // (storage adapter may share it).
  }

  // ─── helpers ───

  private indexableText(ev: MemoryEvent): string {
    return [ev.description, ev.participants.join(" "), ev.topics.join(" ")]
      .filter(Boolean)
      .join(" — ");
  }

  private parse(json: string): MemoryEvent {
    return JSON.parse(json) as MemoryEvent;
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

  private materializeAndPaginate(
    rows: Array<{ json: string }>,
    opts: EventQueryOpts,
  ): MemoryEvent[] {
    let events = rows.map((r) => this.parse(r.json)).filter((e) => this.passesFilter(e, opts));

    if (opts.orderBy) {
      const orderBy = opts.orderBy;
      const order = opts.order ?? "desc";
      events.sort((a, b) => {
        const va = this.orderKey(a, orderBy);
        const vb = this.orderKey(b, orderBy);
        return order === "asc" ? va - vb : vb - va;
      });
    }

    const start = opts.offset ?? 0;
    const end = opts.limit !== undefined ? start + opts.limit : events.length;
    events = events.slice(start, end);

    return events;
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
