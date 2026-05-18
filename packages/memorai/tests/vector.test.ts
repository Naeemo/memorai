import {
  BruteForceVectorIndex,
  matchFilter,
  matchFilterClause,
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
} from "../src/index.js";

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

// ─── BruteForceVectorIndex ───

describe("BruteForceVectorIndex", () => {
  test("upsert + query returns top-K by cosine", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "a", embedding: [1, 0, 0, 0] },
      { id: "b", embedding: [0.9, 0.1, 0, 0] },
      { id: "c", embedding: [0, 1, 0, 0] },
    ]);
    expect(await idx.size()).toBe(3);
    const hits = await idx.query([1, 0, 0, 0], { topK: 2 });
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  test("upsert is idempotent on id collision", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsert({ id: "x", embedding: [1, 0, 0, 0] });
    await idx.upsert({ id: "x", embedding: [0, 1, 0, 0] });
    expect(await idx.size()).toBe(1);
    const hits = await idx.query([0, 1, 0, 0], { topK: 5 });
    expect(hits[0].id).toBe("x");
  });

  test("delete removes the entry", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsert({ id: "a", embedding: [1, 0, 0, 0] });
    await idx.upsert({ id: "b", embedding: [0, 1, 0, 0] });
    await idx.delete("a");
    expect(await idx.size()).toBe(1);
    const hits = await idx.query([1, 0, 0, 0], { topK: 5 });
    expect(hits.find((h) => h.id === "a")).toBeUndefined();
  });

  test("minScore drops noise below threshold", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "near", embedding: [1, 0, 0, 0] },
      { id: "orthogonal", embedding: [0, 1, 0, 0] },
    ]);
    const hits = await idx.query([1, 0, 0, 0], { topK: 5, minScore: 0.5 });
    expect(hits.map((h) => h.id)).toEqual(["near"]);
  });

  test("filter — equality clause", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "a", embedding: [1, 0, 0, 0], metadata: { userId: "alice" } },
      { id: "b", embedding: [1, 0, 0, 0], metadata: { userId: "bob" } },
    ]);
    const hits = await idx.query([1, 0, 0, 0], {
      topK: 5,
      filter: { userId: "alice" },
    });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  test("filter — range clause on timestamp", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "old", embedding: [1, 0, 0, 0], metadata: { timestamp: 100 } },
      { id: "mid", embedding: [1, 0, 0, 0], metadata: { timestamp: 200 } },
      { id: "new", embedding: [1, 0, 0, 0], metadata: { timestamp: 300 } },
    ]);
    const hits = await idx.query([1, 0, 0, 0], {
      topK: 5,
      filter: { timestamp: { range: { start: 150, end: 250 } } },
    });
    expect(hits.map((h) => h.id)).toEqual(["mid"]);
  });

  test("filter — `in` clause", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "a", embedding: [1, 0, 0, 0], metadata: { level: "segment" } },
      { id: "b", embedding: [1, 0, 0, 0], metadata: { level: "atomic_action" } },
      { id: "c", embedding: [1, 0, 0, 0], metadata: { level: "episode" } },
    ]);
    const hits = await idx.query([1, 0, 0, 0], {
      topK: 5,
      filter: { level: { in: ["atomic_action", "episode"] } },
    });
    expect(hits.map((h) => h.id).sort()).toEqual(["b", "c"]);
  });

  test("query rejects mismatched dimensions silently", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsert({ id: "a", embedding: [1, 0, 0, 0] });
    const hits = await idx.query([1, 0], { topK: 5 });
    expect(hits).toEqual([]);
  });

  test("clear empties the index", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsertBatch([
      { id: "a", embedding: [1, 0, 0, 0] },
      { id: "b", embedding: [0, 1, 0, 0] },
    ]);
    await idx.clear();
    expect(await idx.size()).toBe(0);
    const hits = await idx.query([1, 0, 0, 0], { topK: 5 });
    expect(hits).toEqual([]);
  });

  test("zero-magnitude query returns empty", async () => {
    const idx = new BruteForceVectorIndex();
    await idx.upsert({ id: "a", embedding: [1, 0, 0, 0] });
    const hits = await idx.query([0, 0, 0, 0], { topK: 5 });
    expect(hits).toEqual([]);
  });
});

describe("matchFilterClause + matchFilter", () => {
  test("equality matches scalar", () => {
    expect(matchFilterClause("x", "x")).toBe(true);
    expect(matchFilterClause("x", "y")).toBe(false);
    expect(matchFilterClause(undefined, "x")).toBe(false);
  });

  test("undefined clause is permissive", () => {
    expect(matchFilterClause("x", undefined)).toBe(true);
  });

  test("range matches numbers only", () => {
    expect(matchFilterClause(150, { range: { start: 100, end: 200 } })).toBe(true);
    expect(matchFilterClause(50, { range: { start: 100, end: 200 } })).toBe(false);
    expect(matchFilterClause("150", { range: { start: 100, end: 200 } })).toBe(false);
  });

  test("`in` matches membership", () => {
    expect(matchFilterClause("a", { in: ["a", "b"] })).toBe(true);
    expect(matchFilterClause("c", { in: ["a", "b"] })).toBe(false);
  });

  test("matchFilter ANDs multiple clauses", () => {
    expect(
      matchFilter({ userId: "alice", kind: "state" }, { userId: "alice", kind: "state" }),
    ).toBe(true);
    expect(
      matchFilter({ userId: "alice", kind: "state" }, { userId: "alice", kind: "happening" }),
    ).toBe(false);
  });

  test("matchFilter with missing metadata", () => {
    expect(matchFilter(undefined, { userId: "alice" })).toBe(false);
    expect(matchFilter(undefined, undefined)).toBe(true);
  });
});

// ─── Memorai integration ───

describe("Memorai with VectorIndex", () => {
  test("populates index on write and uses it in recall", async () => {
    const idx = new BruteForceVectorIndex();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      vectorIndex: idx,
      evolution: { mode: "manual" },
    });
    await memory.recordEvents([
      {
        at: Date.now() - 1000,
        actor: "alice",
        content: { kind: "message", text: "lunch plans" },
      },
      { at: Date.now(), actor: "bob", content: { kind: "message", text: "weather is nice" } },
    ]).nodes;
    // Both segments should be in the index (one per write).
    expect(await idx.size()).toBeGreaterThanOrEqual(2);
    const result = await memory.recall("lunch plans", { topK: 3 });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].summary).toContain("lunch");
    await memory.close();
  });

  test("removes from index on delete", async () => {
    const idx = new BruteForceVectorIndex();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      vectorIndex: idx,
      evolution: { mode: "manual" },
    });
    const nodes = await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "remove me" },
    }).nodes;
    const beforeDelete = await idx.size();
    expect(beforeDelete).toBeGreaterThanOrEqual(1);
    await memory.delete(nodes[0].id);
    expect(await idx.size()).toBe(beforeDelete - 1);
    await memory.close();
  });

  test("rebuildVectorIndex rebuilds from storage", async () => {
    // Start with no vector index → recall uses linear scan.
    const storage = new MemoryAdapter();
    const memory1 = new Memorai({
      storage,
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory1.recordEvents([
      { at: Date.now() - 2000, actor: "alice", content: { kind: "message", text: "alpha" } },
      { at: Date.now() - 1000, actor: "alice", content: { kind: "message", text: "beta" } },
      { at: Date.now(), actor: "alice", content: { kind: "message", text: "gamma" } },
    ]).nodes;
    // Don't close memory1 — we want to keep storage data alive.
    // Attach a fresh Memorai with a vector index over the same storage.
    const idx = new BruteForceVectorIndex();
    const memory2 = new Memorai({
      storage,
      embedding: new MockEmbeddingService(),
      vectorIndex: idx,
      evolution: { mode: "manual" },
    });
    expect(await idx.size()).toBe(0);
    const { indexed } = await memory2.rebuildVectorIndex();
    expect(indexed).toBeGreaterThanOrEqual(3);
    expect(await idx.size()).toBeGreaterThanOrEqual(3);
    const result = await memory2.recall("beta", { topK: 5 });
    expect(result.memories.some((m) => m.summary === "beta")).toBe(true);
    await memory2.close();
  });

  test("rebuildVectorIndex throws when no index configured", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await expect(memory.rebuildVectorIndex()).rejects.toThrow(/no vectorIndex/i);
    await memory.close();
  });

  test("recall finds the same memory with and without VectorIndex", async () => {
    // Use far-apart timestamps so each event lands in its own atomic_action.
    const sharedEmbed = new MockEmbeddingService();
    const events = [
      {
        at: 1_000_000,
        actor: "alice",
        content: { kind: "message" as const, text: "alpha bravo" },
      },
      {
        at: 2_000_000,
        actor: "alice",
        content: { kind: "message" as const, text: "charlie delta" },
      },
      {
        at: 3_000_000,
        actor: "alice",
        content: { kind: "message" as const, text: "echo foxtrot" },
      },
    ];

    const m1 = new Memorai({
      storage: new MemoryAdapter(),
      embedding: sharedEmbed,
      evolution: { mode: "manual" },
    });
    await m1.recordEvents(events).nodes;
    const r1 = await m1.recall("alpha bravo", { topK: 5 });

    const m2 = new Memorai({
      storage: new MemoryAdapter(),
      embedding: sharedEmbed,
      vectorIndex: new BruteForceVectorIndex(),
      evolution: { mode: "manual" },
    });
    await m2.recordEvents(events).nodes;
    const r2 = await m2.recall("alpha bravo", { topK: 5 });

    // Both pathways should surface the segment whose raw text matches the query.
    const hasAlpha = (r: typeof r1) =>
      r.memories.some((m) => m.summary === "alpha bravo" || m.summary?.includes("alpha bravo"));
    expect(hasAlpha(r1)).toBe(true);
    expect(hasAlpha(r2)).toBe(true);
    await m1.close();
    await m2.close();
  });
});
