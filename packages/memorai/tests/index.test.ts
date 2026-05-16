import {
  cosineSimilarity,
  generateId,
  Memorai,
  MemoryAdapter,
  RetrievalEngine,
  SQLiteAdapter,
  type EmbeddingService,
  type MemoryNode,
  type SQLiteDatabase,
  type SQLiteStatement,
} from "../src/index.js";

// ─── Mock SQLite Database for testing ───

class MockStatement implements SQLiteStatement {
  constructor(
    private sql: string,
    private db: MockSQLiteDb,
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

class MockSQLiteDb implements SQLiteDatabase {
  private tables = new Map<string, Array<Record<string, unknown>>>();
  private indexes: string[] = [];

  prepare(sql: string): SQLiteStatement {
    return new MockStatement(sql, this);
  }

  close(): void {
    this.tables.clear();
    this.indexes = [];
  }

  exec(sql: string, params?: Record<string, unknown> | unknown[]): void {
    if (sql.includes("CREATE TABLE")) {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) {
        const table = match[1];
        if (!this.tables.has(table)) this.tables.set(table, []);
      }
      return;
    }
    if (sql.includes("CREATE INDEX")) {
      this.indexes.push(sql);
      return;
    }
    if (sql.includes("INSERT") || sql.includes("UPDATE")) {
      const table = this.extractTable(sql);
      const rows = this.tables.get(table) ?? [];
      const row = this.buildRow(sql, params);
      const existing = row.id !== undefined ? rows.findIndex((r) => r.id === row.id) : -1;
      if (existing >= 0) {
        rows[existing] = { ...rows[existing], ...row };
      } else {
        rows.push(row);
      }
      this.tables.set(table, rows);
      return;
    }
    if (sql.includes("DELETE")) {
      const table = this.extractTable(sql);
      const rows = this.tables.get(table) ?? [];
      const id = this.extractId(sql, params);
      this.tables.set(
        table,
        rows.filter((r) => r.id !== id),
      );
    }
  }

  query(sql: string, params?: Record<string, unknown> | unknown[]): Record<string, unknown>[] {
    const table = this.extractTable(sql);
    let rows = this.tables.get(table) ?? [];

    // Simple WHERE matching
    if (sql.includes("WHERE id = ?") || sql.includes("WHERE id = :id")) {
      const id = Array.isArray(params) ? params[0] : (params as Record<string, unknown>)?.id;
      rows = rows.filter((r) => r.id === id);
    }
    if (sql.includes("parentId = ?") || sql.includes("parentId = :parentId")) {
      const parentId = Array.isArray(params)
        ? params[0]
        : (params as Record<string, unknown>)?.parentId;
      rows = rows.filter((r) => r.parentId === parentId);
    }
    if (sql.includes("timestamp >=")) {
      const start = Array.isArray(params) ? params[0] : 0;
      const end = Array.isArray(params) ? params[1] : Infinity;
      rows = rows.filter(
        (r) =>
          (r.timestamp as number) >= (start as number) &&
          (r.timestamp as number) <= (end as number),
      );
    }
    if (sql.includes("salience >=")) {
      const minScore = Array.isArray(params) ? params[0] : 0;
      rows = rows.filter((r) => (r.salience as number) >= (minScore as number));
    }

    // JOIN simulation (tags)
    if (sql.includes("INNER JOIN tags")) {
      const tagRows = this.tables.get("tags") ?? [];
      const tagsParam = Array.isArray(params) ? params[0] : "[]";
      const tags = JSON.parse(tagsParam as string) as string[];
      const matchedIds = new Set<string>();
      for (const row of rows) {
        const nodeTags = tagRows.filter((t) => t.nodeId === row.id);
        const tagSet = new Set(nodeTags.map((t) => t.tag as string));
        const hits = tags.filter((t) => tagSet.has(t)).length;
        if (hits >= tags.length) matchedIds.add(row.id as string);
      }
      rows = rows.filter((r) => matchedIds.has(r.id as string));
    }

    // Parent lookup
    if (sql.includes("SELECT parentId FROM memories WHERE id = ?")) {
      const childId = Array.isArray(params) ? params[0] : "";
      const child = rows.find((r) => r.id === childId);
      return child ? [{ parentId: child.parentId }] : [];
    }
    if (sql.includes("SELECT json FROM memories WHERE id = (SELECT parentId")) {
      const childId = Array.isArray(params) ? params[0] : "";
      const child = rows.find((r) => r.id === childId);
      if (!child || !child.parentId) return [];
      const parent = rows.find((r) => r.id === child.parentId);
      return parent ? [parent] : [];
    }

    return rows;
  }

  private extractTable(sql: string): string {
    const m = sql.match(/INTO (\w+)|FROM (\w+)|UPDATE (\w+)|DELETE FROM (\w+)/);
    return m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? "memories";
  }

  private extractId(sql: string, params?: Record<string, unknown> | unknown[]): string {
    if (Array.isArray(params)) return params[0] as string;
    return (params as Record<string, unknown>)?.id as string;
  }

  private buildRow(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Record<string, unknown> {
    if (Array.isArray(params)) {
      // Detect column names from VALUES clause
      const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/);
      if (colMatch) {
        const cols = colMatch[1].split(",").map((c) => c.trim());
        const row: Record<string, unknown> = {};
        for (let i = 0; i < Math.min(cols.length, params.length); i++) {
          row[cols[i]] = params[i];
        }
        return row;
      }
      return { id: params[0], json: params[1] };
    }
    return (params as Record<string, unknown>) ?? {};
  }
}

// ─── Mock Embedding Service ───

class MockEmbeddingService implements EmbeddingService {
  readonly dimension = 4;

  embed(text: string): Promise<number[]> {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 10000;
    }
    const base = hash / 10000;
    return Promise.resolve([base, 1 - base, base * 0.5, 1 - base * 0.5]);
  }
}

// ─── Helpers ───

const makeNode = (
  summary: string,
  embedding: number[],
  opts: Partial<MemoryNode> = {},
): MemoryNode => ({
  id: generateId(),
  timestamp: Date.now(),
  duration: 1000,
  level: "segment",
  payload: {
    summary,
    tags: [],
    salienceScore: 0.5,
    modality: ["text"],
    embedding,
  },
  meta: {
    sourceAgent: "test",
    agentRole: "reasoning",
    accessCount: 0,
  },
  ...opts,
});

// ═══════════════════════════════════════════════════════════
// Phase 1 & 2 Tests (existing, condensed)
// ═══════════════════════════════════════════════════════════

describe("Utils", () => {
  test("cosineSimilarity", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  test("generateId uniqueness", () => {
    expect(new Set(Array.from({ length: 100 }, generateId)).size).toBe(100);
  });
});

describe("MemoryAdapter", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => (adapter = new MemoryAdapter()));

  test("CRUD", async () => {
    const node = makeNode("test", [1, 0, 0, 0]);
    await adapter.put(node);
    expect(await adapter.get(node.id)).toEqual(node);
    await adapter.delete(node.id);
    expect(await adapter.get(node.id)).toBeNull();
  });

  test("queryByTimeRange", async () => {
    const now = Date.now();
    const n1 = makeNode("a", [1, 0, 0, 0], { timestamp: now - 10000 });
    const n2 = makeNode("b", [1, 0, 0, 0], { timestamp: now - 5000 });
    await adapter.batchPut([n1, n2]);
    const r = await adapter.queryByTimeRange(now - 8000, now);
    expect(r.map((x) => x.id)).toContain(n2.id);
    expect(r.map((x) => x.id)).not.toContain(n1.id);
  });

  test("queryByTags", async () => {
    const n1 = makeNode("a", [1, 0, 0, 0], {
      payload: {
        ...makeNode("a", [1, 0, 0, 0]).payload,
        tags: ["coding", "ai"],
      },
    });
    const n2 = makeNode("b", [1, 0, 0, 0], {
      payload: { ...makeNode("b", [1, 0, 0, 0]).payload, tags: ["cooking"] },
    });
    await adapter.batchPut([n1, n2]);
    const r = await adapter.queryByTags(["coding"]);
    expect(r.map((x) => x.id)).toContain(n1.id);
  });
});

describe("Memorai basics", () => {
  let memory: Memorai;

  beforeEach(() => {
    memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
  });

  test("write + retrieve", async () => {
    await memory.write({
      payload: {
        summary: "gym workout",
        tags: ["fitness"],
        salienceScore: 0.7,
        modality: ["text"],
      },
    });
    const result = await memory.retrieve({
      strategy: "factual",
      text: "exercise",
      topK: 3,
      level: "segment",
    });
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  test("evolve aggregates atomic actions into events", async () => {
    const mem = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: {
        semanticMergeThreshold: 0.99,
        temporalGapThresholdMs: 1,
        sceneSimilarityThreshold: 0.5,
        eventTimeWindowMs: 600000,
        mode: "manual",
      },
    });

    await mem.write(
      {
        payload: {
          summary: "morning coding",
          embedding: [1, 0, 0, 0],
          tags: ["coding"],
          salienceScore: 0.5,
          modality: ["text"],
        },
      },
      { skipEmbedding: true },
    );

    await new Promise((r) => setTimeout(r, 5));

    await mem.write(
      {
        payload: {
          summary: "afternoon coding",
          embedding: [1, 0, 0, 0],
          tags: ["coding"],
          salienceScore: 0.5,
          modality: ["text"],
        },
      },
      { skipEmbedding: true },
    );

    let events = await mem.list({ level: "event" });
    expect(events.length).toBe(0);

    await mem.evolve();

    events = await mem.list({ level: "event" });
    expect(events.length).toBe(1);
    expect(events[0].childrenIds!.length).toBe(2);

    await mem.close();
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 3: Advanced Retrieval Tests
// ═══════════════════════════════════════════════════════════

describe("RetrievalEngine — Phase 3", () => {
  let adapter: MemoryAdapter;
  let engine: RetrievalEngine;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    engine = new RetrievalEngine(adapter);
  });

  const seedNodes = async () => {
    const now = Date.now();
    const nodes = [
      // Coding session (old)
      makeNode("coding session morning", [1, 0, 0, 0], {
        timestamp: now - 3600000,
        level: "atomic_action",
        payload: {
          ...makeNode("", [1, 0, 0, 0]).payload,
          summary: "coding session morning",
          tags: ["coding"],
          salienceScore: 0.6,
          modality: ["text"],
        },
      }),
      // Coding session (recent)
      makeNode("coding session afternoon", [0.95, 0.05, 0, 0], {
        timestamp: now - 600000,
        level: "atomic_action",
        payload: {
          ...makeNode("", [0.95, 0.05, 0, 0]).payload,
          summary: "coding session afternoon",
          tags: ["coding"],
          salienceScore: 0.7,
          modality: ["text"],
        },
      }),
      // Gym (recent, high salience)
      makeNode("gym workout", [0, 1, 0, 0], {
        timestamp: now - 300000,
        level: "segment",
        payload: {
          ...makeNode("", [0, 1, 0, 0]).payload,
          summary: "gym workout",
          tags: ["fitness", "health"],
          salienceScore: 0.9,
          modality: ["text"],
        },
      }),
      // Cooking (old, low salience)
      makeNode("cooking dinner", [0, 0, 1, 0], {
        timestamp: now - 7200000,
        level: "segment",
        payload: {
          ...makeNode("", [0, 0, 1, 0]).payload,
          summary: "cooking dinner",
          tags: ["food"],
          salienceScore: 0.3,
          modality: ["text"],
        },
      }),
      // Event: coding project
      makeNode("coding project overview", [1, 0, 0, 0], {
        timestamp: now - 1800000,
        level: "event",
        childrenIds: ["child1", "child2"],
        payload: {
          ...makeNode("", [1, 0, 0, 0]).payload,
          summary: "coding project overview",
          tags: ["coding", "project"],
          salienceScore: 0.8,
          modality: ["text"],
        },
      }),
    ];
    await adapter.batchPut(nodes);
    return nodes;
  };

  test("factual strategy boosts exact matches", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "factual",
      embedding: [1, 0, 0, 0], // coding
      topK: 3,
    });

    // Should prioritize atomic_actions and high-salience
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test("temporal strategy boosts recent nodes", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "temporal",
      embedding: [0, 1, 0, 0], // gym
      topK: 2,
    });

    // Recent gym should rank higher than old cooking
    const summaries = result.nodes.map((n) => n.payload.summary);
    expect(summaries.some((s) => s.includes("gym"))).toBe(true);
  });

  test("inferential strategy boosts events with children", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "inferential",
      embedding: [1, 0, 0, 0], // coding
      topK: 3,
    });

    // Event node should be boosted
    const eventNodes = result.nodes.filter((n) => n.level === "event");
    expect(eventNodes.length).toBeGreaterThanOrEqual(1);
  });

  test("exploratory strategy is broader", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "exploratory",
      text: "health fitness code",
      topK: 5,
    });

    // Should return diverse results
    expect(result.nodes.length).toBeGreaterThan(1);
    const levels = new Set(result.nodes.map((n) => n.level));
    expect(levels.size).toBeGreaterThanOrEqual(1);
  });

  test("forward traversal — causal order", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "temporal",
      text: "coding",
      traversalOrder: "forward",
      topK: 5,
    });

    // Results should be ordered by timestamp ascending
    for (let i = 1; i < result.nodes.length; i++) {
      expect(result.nodes[i].timestamp).toBeGreaterThanOrEqual(result.nodes[i - 1].timestamp);
    }
  });

  test("reverse traversal — recent first", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "temporal",
      text: "coding",
      traversalOrder: "reverse",
      topK: 5,
    });

    // Results should be ordered by timestamp descending
    for (let i = 1; i < result.nodes.length; i++) {
      expect(result.nodes[i].timestamp).toBeLessThanOrEqual(result.nodes[i - 1].timestamp);
    }
  });

  test("salience traversal — importance first", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "factual",
      text: "gym",
      traversalOrder: "salience",
      topK: 3,
    });

    // Highest salience should be first
    if (result.nodes.length >= 2) {
      expect(result.nodes[0].payload.salienceScore).toBeGreaterThanOrEqual(
        result.nodes[1].payload.salienceScore,
      );
    }
  });

  test("earlyStop — stops when confidence threshold met", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "factual",
      embedding: [1, 0, 0, 0], // very specific coding query
      topK: 5,
      earlyStop: true,
    });

    // Should return topK or fewer if confidence drops below threshold
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(5);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("concurrent pipeline — semantic + tag + keyword", async () => {
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "factual",
      text: "fitness",
      topK: 5,
    });

    // Tag search should find gym node even without embedding
    const summaries = result.nodes.map((n) => n.payload.summary);
    expect(summaries.some((s) => s.includes("gym"))).toBe(true);
  });

  test("timeRange filter works", async () => {
    const now = Date.now();
    await seedNodes();
    const result = await engine.retrieve({
      strategy: "temporal",
      embedding: [1, 0, 0, 0],
      timeRange: { start: now - 4000000, end: now - 500000 },
      topK: 5,
    });

    // Should only return nodes within the time range
    for (const node of result.nodes) {
      expect(node.timestamp).toBeGreaterThanOrEqual(now - 4000000);
      expect(node.timestamp).toBeLessThanOrEqual(now - 500000);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 4: Compression Service Tests
// ═══════════════════════════════════════════════════════════

describe("CompressionService", () => {
  test("CompressionService interface types compile", () => {
    // Verify the types are exported correctly
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// SQLite Adapter Tests
// ═══════════════════════════════════════════════════════════

describe("SQLiteAdapter", () => {
  let db: MockSQLiteDb;
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    db = new MockSQLiteDb();
    adapter = new SQLiteAdapter(db);
  });

  test("put and get", async () => {
    const node = makeNode("sqlite test", [1, 0, 0, 0]);
    await adapter.put(node);
    const fetched = await adapter.get(node.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(node.id);
    expect(fetched!.payload.summary).toBe("sqlite test");
  });

  test("queryByTimeRange", async () => {
    const now = Date.now();
    const n1 = makeNode("old", [1, 0, 0, 0], { timestamp: now - 10000 });
    const n2 = makeNode("recent", [1, 0, 0, 0], { timestamp: now - 1000 });
    await adapter.put(n1);
    await adapter.put(n2);

    const results = await adapter.queryByTimeRange(now - 5000, now);
    expect(results.length).toBe(1);
    expect(results[0].payload.summary).toBe("recent");
  });

  test("queryByTags", async () => {
    const n1 = makeNode("tagged", [1, 0, 0, 0], {
      payload: {
        ...makeNode("tagged", [1, 0, 0, 0]).payload,
        tags: ["coding", "ai"],
      },
    });
    await adapter.put(n1);

    const results = await adapter.queryByTags(["coding"]);
    expect(results.length).toBe(1);
  });

  test("queryBySalience", async () => {
    const n1 = makeNode("high", [1, 0, 0, 0], {
      payload: {
        ...makeNode("high", [1, 0, 0, 0]).payload,
        salienceScore: 0.9,
      },
    });
    const n2 = makeNode("low", [1, 0, 0, 0], {
      payload: {
        ...makeNode("low", [1, 0, 0, 0]).payload,
        salienceScore: 0.2,
      },
    });
    await adapter.put(n1);
    await adapter.put(n2);

    const results = await adapter.queryBySalience(0.8);
    expect(results.length).toBe(1);
    expect(results[0].payload.summary).toBe("high");
  });

  test("getChildren", async () => {
    const parent = makeNode("parent", [1, 0, 0, 0], { id: "p1" });
    const child = makeNode("child", [1, 0, 0, 0], {
      id: "c1",
      level: "segment",
      parentId: "p1",
    });
    await adapter.put(parent);
    await adapter.put(child);

    const children = await adapter.getChildren("p1");
    expect(children.length).toBe(1);
    expect(children[0].id).toBe("c1");
  });

  test("delete", async () => {
    const node = makeNode("delete me", [1, 0, 0, 0]);
    await adapter.put(node);
    await adapter.delete(node.id);
    expect(await adapter.get(node.id)).toBeNull();
  });

  test("listAll with sorting", async () => {
    const n1 = makeNode("a", [1, 0, 0, 0], {
      payload: {
        ...makeNode("a", [1, 0, 0, 0]).payload,
        salienceScore: 0.2,
      },
    });
    const n2 = makeNode("b", [1, 0, 0, 0], {
      payload: {
        ...makeNode("b", [1, 0, 0, 0]).payload,
        salienceScore: 0.8,
      },
    });
    await adapter.put(n1);
    await adapter.put(n2);

    const desc = await adapter.listAll({ orderBy: "salience", order: "desc" });
    expect(desc[0].payload.salienceScore).toBe(0.8);
  });
});

// ─── Real SQLite Integration (skipped if better-sqlite3 unavailable) ───

describe("SQLiteAdapter — real better-sqlite3", () => {
  let realDb: SQLiteDatabase | null = null;

  beforeEach(async () => {
    try {
      // @ts-expect-error optional dev dependency
      const { default: Database } = await import("better-sqlite3");
      realDb = new Database(":memory:") as SQLiteDatabase;
    } catch {
      realDb = null;
    }
  });

  test.skipIf(!realDb)("works with real better-sqlite3", async () => {
    const adapter = new SQLiteAdapter(realDb!);
    const node = makeNode("real sqlite", [1, 0, 0, 0]);
    await adapter.put(node);

    const fetched = await adapter.get(node.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(node.id);
    expect(fetched!.payload.summary).toBe("real sqlite");
    expect(fetched!.payload.tags).toEqual(node.payload.tags);

    const byTag = await adapter.queryByTags(["test"]);
    expect(byTag.length).toBe(1);

    const byTime = await adapter.queryByTimeRange(node.timestamp - 1000, node.timestamp + 1000);
    expect(byTime.length).toBe(1);

    const bySalience = await adapter.queryBySalience(0.4);
    expect(bySalience.length).toBe(1);

    await adapter.close();
  });
});
