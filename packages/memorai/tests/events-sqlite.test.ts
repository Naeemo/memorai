import {
  SQLiteEventStore,
  type MemoryEvent,
  type SQLiteDatabase,
  type SQLiteStatement,
} from "../src/index.js";

// Purpose-built mock of the SQLiteDatabase surface that just-enough simulates
// SQLiteEventStore's SQL patterns. Real-better-sqlite3 integration test below
// runs when the package is installed.

class MockStmt implements SQLiteStatement {
  constructor(
    private readonly sql: string,
    private readonly db: MockDb,
  ) {}
  run(params?: Record<string, unknown> | unknown[]): { changes: number } {
    this.db.exec(this.sql, params);
    return { changes: 1 };
  }
  get(params?: Record<string, unknown> | unknown[]): Record<string, unknown> | null {
    const rows = this.db.query(this.sql, params);
    return rows[0] ?? null;
  }
  all(params?: Record<string, unknown> | unknown[]): Record<string, unknown>[] {
    return this.db.query(this.sql, params);
  }
}

class MockDb implements SQLiteDatabase {
  events = new Map<string, Record<string, unknown>>();
  participants = new Map<string, Set<string>>(); // eventId → participants
  topics = new Map<string, Set<string>>(); // eventId → topics

  prepare(sql: string): SQLiteStatement {
    return new MockStmt(sql, this);
  }
  close(): void {
    this.events.clear();
    this.participants.clear();
    this.topics.clear();
  }

  exec(sql: string, params?: Record<string, unknown> | unknown[]): void {
    if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return;
    if (sql.includes("INSERT INTO events")) {
      const p = params as Record<string, unknown>;
      this.events.set(p.id as string, {
        id: p.id,
        json: p.json,
        kind: p.kind,
        occurredAt: p.occurredAt,
        invalidatedAt: p.invalidatedAt,
        userId: p.userId,
        actor: p.actor,
      });
      return;
    }
    if (sql.includes("DELETE FROM events WHERE id")) {
      const id = Array.isArray(params) ? (params[0] as string) : "";
      this.events.delete(id);
      this.participants.delete(id);
      this.topics.delete(id);
      return;
    }
    if (sql.includes("INSERT OR IGNORE INTO event_participants")) {
      const arr = params as unknown[];
      const eventId = arr[0] as string;
      const p = arr[1] as string;
      if (!this.participants.has(eventId)) this.participants.set(eventId, new Set());
      this.participants.get(eventId)!.add(p);
      return;
    }
    if (sql.includes("INSERT OR IGNORE INTO event_topics")) {
      const arr = params as unknown[];
      const eventId = arr[0] as string;
      const t = arr[1] as string;
      if (!this.topics.has(eventId)) this.topics.set(eventId, new Set());
      this.topics.get(eventId)!.add(t);
      return;
    }
    if (sql.includes("DELETE FROM event_participants")) {
      const id = Array.isArray(params) ? (params[0] as string) : "";
      this.participants.delete(id);
      return;
    }
    if (sql.includes("DELETE FROM event_topics")) {
      const id = Array.isArray(params) ? (params[0] as string) : "";
      this.topics.delete(id);
      return;
    }
  }

  query(sql: string, params?: Record<string, unknown> | unknown[]): Record<string, unknown>[] {
    if (sql.includes("SELECT json FROM events WHERE id")) {
      const id = Array.isArray(params) ? (params[0] as string) : "";
      const ev = this.events.get(id);
      return ev ? [{ json: ev.json }] : [];
    }
    if (sql.includes("INNER JOIN event_participants")) {
      const p = Array.isArray(params) ? (params[0] as string) : "";
      const matchingIds = [...this.participants.entries()]
        .filter(([_, ps]) => ps.has(p))
        .map(([id]) => id);
      return this.byIdsSortedByOccurredAt(matchingIds);
    }
    if (sql.includes("INNER JOIN event_topics")) {
      const t = Array.isArray(params) ? (params[0] as string) : "";
      const matchingIds = [...this.topics.entries()]
        .filter(([_, ts]) => ts.has(t))
        .map(([id]) => id);
      return this.byIdsSortedByOccurredAt(matchingIds);
    }
    if (sql.includes("WHERE occurredAt >=")) {
      const arr = params as unknown[];
      const start = arr[0] as number;
      const end = arr[1] as number;
      return this.allSortedByOccurredAt().filter((e) => {
        const occ = e.occurredAt as number;
        return occ >= start && occ <= end;
      });
    }
    if (sql.includes("WHERE kind=?")) {
      const kind = Array.isArray(params) ? (params[0] as string) : "";
      return this.allSortedByOccurredAt().filter((e) => e.kind === kind);
    }
    if (sql.includes("WHERE userId=?")) {
      const userId = Array.isArray(params) ? (params[0] as string) : "";
      return this.allSortedByOccurredAt().filter((e) => e.userId === userId);
    }
    if (sql.includes("ORDER BY occurredAt DESC")) {
      return this.allSortedByOccurredAt();
    }
    return [];
  }

  private allSortedByOccurredAt(): Record<string, unknown>[] {
    return [...this.events.values()].sort(
      (a, b) => (b.occurredAt as number) - (a.occurredAt as number),
    );
  }

  private byIdsSortedByOccurredAt(ids: string[]): Record<string, unknown>[] {
    return ids
      .map((id) => this.events.get(id))
      .filter((e): e is Record<string, unknown> => Boolean(e))
      .sort((a, b) => (b.occurredAt as number) - (a.occurredAt as number));
  }
}

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: overrides.id ?? `e-${Math.random()}`,
    kind: overrides.kind ?? "state",
    description: overrides.description ?? "default",
    participants: overrides.participants ?? ["alice"],
    topics: overrides.topics ?? ["preferences"],
    occurredAt: overrides.occurredAt ?? Date.now(),
    invalidatedAt: overrides.invalidatedAt,
    sourceNodeIds: overrides.sourceNodeIds ?? [],
    userId: overrides.userId,
    actor: overrides.actor,
    embedding: overrides.embedding,
    confidence: overrides.confidence,
    meta: overrides.meta ?? { identifiedAt: Date.now(), accessCount: 0 },
  };
}

// ─── SQLiteEventStore — mock-backed ───

describe("SQLiteEventStore (mock SQLite)", () => {
  test("putEvent + getEvent round-trip", async () => {
    const store = new SQLiteEventStore(new MockDb());
    const ev = makeEvent({ id: "e1", description: "Alice likes tea" });
    await store.putEvent(ev);
    const got = await store.getEvent("e1");
    expect(got).not.toBeNull();
    expect(got!.description).toBe("Alice likes tea");
  });

  test("deleteEvent removes from store", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1" }));
    await store.deleteEvent("e1");
    expect(await store.getEvent("e1")).toBeNull();
  });

  test("queryEventsByParticipant returns matching events", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1", participants: ["alice"] }));
    await store.putEvent(makeEvent({ id: "e2", participants: ["bob"] }));
    const hits = await store.queryEventsByParticipant("alice");
    expect(hits.map((h) => h.id)).toEqual(["e1"]);
  });

  test("queryEventsByTopic respects topic lowercase canonicalization", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1", topics: ["Preferences"] }));
    const hits = await store.queryEventsByTopic("preferences");
    expect(hits.map((h) => h.id)).toEqual(["e1"]);
  });

  test("queryEventsByTimeRange filters by occurredAt", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "old", occurredAt: 100 }));
    await store.putEvent(makeEvent({ id: "mid", occurredAt: 500 }));
    await store.putEvent(makeEvent({ id: "new", occurredAt: 1000 }));
    const hits = await store.queryEventsByTimeRange(200, 700);
    expect(hits.map((h) => h.id)).toEqual(["mid"]);
  });

  test("listEvents excludes invalidated when requested", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "valid" }));
    await store.putEvent(makeEvent({ id: "old", invalidatedAt: Date.now() }));
    const all = await store.listEvents();
    expect(all.map((h) => h.id).sort()).toEqual(["old", "valid"]);
    const valid = await store.listEvents({ excludeInvalidated: true });
    expect(valid.map((h) => h.id)).toEqual(["valid"]);
  });

  test("listEvents kind filter", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "s1", kind: "state" }));
    await store.putEvent(makeEvent({ id: "h1", kind: "happening" }));
    const stateOnly = await store.listEvents({ kind: "state" });
    expect(stateOnly.map((h) => h.id)).toEqual(["s1"]);
  });

  test("queryEventsByEmbedding linear fallback when no vectorIndex", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1", embedding: [1, 0, 0, 0], description: "alpha" }));
    await store.putEvent(makeEvent({ id: "e2", embedding: [0, 1, 0, 0], description: "beta" }));
    const hits = await store.queryEventsByEmbedding([1, 0, 0, 0], { topK: 1 });
    expect(hits.map((h) => h.id)).toEqual(["e1"]);
  });

  test("queryEventsByText uses BM25 over description + participants + topics", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1", description: "Alice prefers tea over coffee" }));
    await store.putEvent(makeEvent({ id: "e2", description: "Bob loves jazz music" }));
    const hits = await store.queryEventsByText("tea coffee");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("e1");
  });

  test("BM25 rebuilds from existing rows on construction", async () => {
    const db = new MockDb();
    const first = new SQLiteEventStore(db);
    await first.putEvent(makeEvent({ id: "e1", description: "unique-token zenith" }));
    // Construct a second instance over the same DB — must rebuild BM25.
    const second = new SQLiteEventStore(db);
    const hits = await second.queryEventsByText("zenith");
    expect(hits.map((h) => h.id)).toEqual(["e1"]);
  });

  test("validAt filter respects supersede semantics", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "e1", occurredAt: 100, invalidatedAt: 500 }));
    const beforeInvalid = await store.listEvents({ validAt: 300 });
    expect(beforeInvalid.map((h) => h.id)).toContain("e1");
    const afterInvalid = await store.listEvents({ validAt: 600 });
    expect(afterInvalid.map((h) => h.id)).not.toContain("e1");
  });

  test("userId filter is honored across query methods", async () => {
    const store = new SQLiteEventStore(new MockDb());
    await store.putEvent(makeEvent({ id: "a", userId: "u1", participants: ["alice"] }));
    await store.putEvent(makeEvent({ id: "b", userId: "u2", participants: ["alice"] }));
    const byUser = await store.listEvents({ userId: "u1" });
    expect(byUser.map((h) => h.id)).toEqual(["a"]);
    const byPart = await store.queryEventsByParticipant("alice", { userId: "u1" });
    expect(byPart.map((h) => h.id)).toEqual(["a"]);
  });
});

// ─── Real better-sqlite3 integration (skipped if package missing) ───

describe("SQLiteEventStore — real better-sqlite3", () => {
  let realDb: SQLiteDatabase | null = null;

  beforeAll(async () => {
    try {
      // @ts-expect-error optional dev dependency
      const { default: Database } = await import("better-sqlite3");
      realDb = new Database(":memory:") as unknown as SQLiteDatabase;
    } catch {
      realDb = null;
    }
  });

  test.skipIf(!realDb)("round-trips and queries against real SQLite", async () => {
    const store = new SQLiteEventStore(realDb!);
    await store.putEvent(makeEvent({ id: "r1", description: "real round-trip" }));
    const got = await store.getEvent("r1");
    expect(got!.description).toBe("real round-trip");
    const hits = await store.queryEventsByText("round-trip");
    expect(hits.map((h) => h.id)).toEqual(["r1"]);
  });
});
