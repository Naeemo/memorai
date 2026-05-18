import {
  InMemoryEntityGraph,
  Memorai,
  MemoryAdapter,
  WrapExtractor,
  edgePassesFilter,
  extractEntityTokens,
  graphCanonicalName,
  type EmbeddingService,
  type Event,
  type Extractor,
  type ExtractContext,
  type GraphEdge,
  type WritePayload,
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

/**
 * A test extractor that emits hand-crafted triples so we can exercise the
 * graph end-to-end without needing a real LLM.
 */
class TripleEmittingExtractor implements Extractor {
  constructor(
    private readonly triplesFor: (event: Event) => Array<{
      subject: string;
      predicate: string;
      object: string;
      confidence?: number;
    }>,
  ) {}

  async extract(event: Event, _ctx: ExtractContext): Promise<WritePayload[]> {
    const wrap = new WrapExtractor();
    const base = (await wrap.extract(event, _ctx))[0];
    const triples = this.triplesFor(event);
    return [
      {
        ...base,
        annotations: { ...base.annotations, triples },
      },
    ];
  }
}

// ─── InMemoryEntityGraph ───

describe("InMemoryEntityGraph", () => {
  test("upsertEntity is idempotent and canonical", async () => {
    const g = new InMemoryEntityGraph();
    const a = await g.upsertEntity("Alice", { type: "person" }, { now: 100 });
    const b = await g.upsertEntity("alice", undefined, { now: 200 });
    expect(a.name).toBe("alice");
    expect(b.name).toBe("alice");
    expect(b.firstSeenAt).toBe(100);
    expect(b.lastSeenAt).toBe(200);
    expect(b.attributes?.type).toBe("person");
    expect((await g.size()).entities).toBe(1);
  });

  test("upsertEdge auto-registers entities and indexes by both ends", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({
      subject: "Alice",
      predicate: "knows",
      object: "Bob",
      validAt: 100,
      userId: "tenant1",
    });
    expect((await g.size()).entities).toBe(2);
    expect((await g.size()).edges).toBe(1);

    const aliceNeighbors = await g.queryNeighbors("alice");
    expect(aliceNeighbors.length).toBe(1);
    expect(aliceNeighbors[0].object).toBe("bob");

    const bobNeighbors = await g.queryNeighbors("bob");
    expect(bobNeighbors.length).toBe(1);
    expect(bobNeighbors[0].subject).toBe("alice");
  });

  test("invalidatesOlder supersedes prior assertions with same (subject, predicate, userId)", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({
      subject: "alice",
      predicate: "prefers",
      object: "coffee",
      validAt: 100,
      userId: "u1",
    });
    await g.upsertEdge({
      subject: "alice",
      predicate: "prefers",
      object: "tea",
      validAt: 200,
      userId: "u1",
      invalidatesOlder: true,
    });

    const all = await g.queryEdges({ subject: "alice", predicate: "prefers" });
    expect(all.length).toBe(2);
    const coffeeEdge = all.find((e) => e.object === "coffee");
    expect(coffeeEdge?.invalidatedAt).toBe(200);

    const valid = await g.queryEdges({
      subject: "alice",
      predicate: "prefers",
      excludeInvalidated: true,
    });
    expect(valid.map((e) => e.object)).toEqual(["tea"]);
  });

  test("queryEdges honors userId tenant boundary", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({
      subject: "alice",
      predicate: "works_at",
      object: "acme",
      userId: "tenant1",
    });
    await g.upsertEdge({
      subject: "alice",
      predicate: "works_at",
      object: "globex",
      userId: "tenant2",
    });
    const t1 = await g.queryEdges({ subject: "alice", userId: "tenant1" });
    expect(t1.map((e) => e.object)).toEqual(["acme"]);
    const t2 = await g.queryEdges({ subject: "alice", userId: "tenant2" });
    expect(t2.map((e) => e.object)).toEqual(["globex"]);
  });

  test("queryPaths finds direct edge", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({ subject: "alice", predicate: "knows", object: "bob" });
    const paths = await g.queryPaths("alice", "bob");
    expect(paths.length).toBe(1);
    expect(paths[0].entities).toEqual(["alice", "bob"]);
    expect(paths[0].edges.length).toBe(1);
  });

  test("queryPaths walks multi-hop chain", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({ subject: "alice", predicate: "knows", object: "bob" });
    await g.upsertEdge({ subject: "bob", predicate: "knows", object: "carol" });
    await g.upsertEdge({ subject: "carol", predicate: "knows", object: "dan" });

    const paths = await g.queryPaths("alice", "dan", { maxDepth: 4 });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].entities).toEqual(["alice", "bob", "carol", "dan"]);
  });

  test("queryPaths respects maxDepth", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({ subject: "alice", predicate: "knows", object: "bob" });
    await g.upsertEdge({ subject: "bob", predicate: "knows", object: "carol" });
    await g.upsertEdge({ subject: "carol", predicate: "knows", object: "dan" });

    const tooShallow = await g.queryPaths("alice", "dan", { maxDepth: 2 });
    expect(tooShallow.length).toBe(0);
  });

  test("queryPaths skips invalidated edges", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({
      subject: "alice",
      predicate: "knows",
      object: "bob",
      validAt: 100,
      invalidatedAt: 150,
    });
    const paths = await g.queryPaths("alice", "bob");
    expect(paths).toEqual([]);
  });

  test("deleteEdge cleans up adjacency", async () => {
    const g = new InMemoryEntityGraph();
    const e = await g.upsertEdge({ subject: "a", predicate: "p", object: "b" });
    expect((await g.size()).edges).toBe(1);
    await g.deleteEdge(e.id);
    expect((await g.size()).edges).toBe(0);
    expect(await g.queryNeighbors("a")).toEqual([]);
  });

  test("clear empties the graph", async () => {
    const g = new InMemoryEntityGraph();
    await g.upsertEdge({ subject: "a", predicate: "p", object: "b" });
    await g.clear();
    expect(await g.size()).toEqual({ entities: 0, edges: 0 });
  });
});

describe("graphCanonicalName + edgePassesFilter", () => {
  test("canonicalName lowercases and trims", () => {
    expect(graphCanonicalName("  Alice  ")).toBe("alice");
    expect(graphCanonicalName(undefined)).toBe("");
    expect(graphCanonicalName(null)).toBe("");
  });

  test("edgePassesFilter respects all clauses", () => {
    const edge: GraphEdge = {
      id: "x",
      subject: "alice",
      predicate: "knows",
      object: "bob",
      validAt: 100,
      userId: "t1",
    };
    expect(edgePassesFilter(edge, { subject: "Alice" })).toBe(true);
    expect(edgePassesFilter(edge, { subject: "bob" })).toBe(false);
    expect(edgePassesFilter(edge, { userId: "t2" })).toBe(false);
    expect(edgePassesFilter(edge, { predicate: "knows" })).toBe(true);
    expect(edgePassesFilter(edge, { excludeInvalidated: true })).toBe(true);

    const invalidated: GraphEdge = { ...edge, invalidatedAt: 200 };
    expect(edgePassesFilter(invalidated, { excludeInvalidated: true })).toBe(false);
    // Edge was valid before 200, so a `validAt: 150` query keeps it.
    expect(edgePassesFilter(invalidated, { validAt: 150 })).toBe(true);
    // After 200 it's been superseded — filter drops it.
    expect(edgePassesFilter(invalidated, { validAt: 250 })).toBe(false);
  });
});

describe("extractEntityTokens", () => {
  test("drops stopwords and short tokens", () => {
    const tokens = extractEntityTokens("What did Alice tell Bob about the migration?");
    expect(tokens).toContain("alice");
    expect(tokens).toContain("bob");
    expect(tokens).toContain("migration");
    expect(tokens).not.toContain("what");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("did");
    expect(tokens).not.toContain("tell");
    expect(tokens).not.toContain("about");
  });

  test("handles empty / null input", () => {
    expect(extractEntityTokens("")).toEqual([]);
  });

  test("deduplicates", () => {
    const tokens = extractEntityTokens("alice alice ALICE");
    expect(tokens).toEqual(["alice"]);
  });
});

// ─── Memorai integration ───

describe("Memorai with EntityGraph", () => {
  test("populates graph from extracted triples on write", async () => {
    const graph = new InMemoryEntityGraph();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      entityGraph: graph,
      extractor: new TripleEmittingExtractor(() => [
        { subject: "alice", predicate: "prefers", object: "coffee", confidence: 0.9 },
        { subject: "bob", predicate: "prefers", object: "tea", confidence: 0.9 },
      ]),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "message", text: "I prefer coffee. Bob prefers tea." },
    }).nodes;

    const { entities, edges } = await graph.size();
    expect(entities).toBeGreaterThanOrEqual(4);
    expect(edges).toBe(2);

    const aliceNeighbors = await memory.graphNeighbors("alice");
    expect(aliceNeighbors.some((e) => e.object === "coffee")).toBe(true);
    await memory.close();
  });

  test("graph queries are scoped to userId", async () => {
    const graph = new InMemoryEntityGraph();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      entityGraph: graph,
      extractor: new TripleEmittingExtractor((ev) =>
        ev.userId === "tenant-alice"
          ? [{ subject: "alice", predicate: "prefers", object: "coffee" }]
          : [{ subject: "alice", predicate: "prefers", object: "tea" }],
      ),
      evolution: { mode: "manual" },
    });
    await memory.recordEvents([
      {
        at: Date.now() - 1000,
        userId: "tenant-alice",
        actor: "user",
        content: { kind: "message", text: "I love coffee" },
      },
      {
        at: Date.now(),
        userId: "tenant-bob",
        actor: "user",
        content: { kind: "message", text: "I love tea" },
      },
    ]).nodes;

    const aliceTenant = await memory.graphNeighbors("alice", { userId: "tenant-alice" });
    expect(aliceTenant.every((e) => e.object === "coffee")).toBe(true);
    const bobTenant = await memory.graphNeighbors("alice", { userId: "tenant-bob" });
    expect(bobTenant.every((e) => e.object === "tea")).toBe(true);
    await memory.close();
  });

  test("recall surfaces graph-pathway hits in provenance", async () => {
    const graph = new InMemoryEntityGraph();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      entityGraph: graph,
      extractor: new TripleEmittingExtractor(() => [
        { subject: "alice", predicate: "works_on", object: "migration", confidence: 0.95 },
      ]),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "I'm leading the database migration project" },
    }).nodes;

    const result = await memory.recall("what is alice doing with migration?", { topK: 5 });
    expect(result.memories.length).toBeGreaterThan(0);
    const top = result.memories[0];
    expect(top.provenance?.pathways).toContain("graph");
    await memory.close();
  });

  test("graphPaths surfaces relationship chains", async () => {
    const graph = new InMemoryEntityGraph();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      entityGraph: graph,
      extractor: new TripleEmittingExtractor((ev) => {
        if (ev.content.kind !== "message") return [];
        const t = ev.content.text;
        if (t.includes("alice met bob"))
          return [{ subject: "alice", predicate: "knows", object: "bob" }];
        if (t.includes("bob works with carol"))
          return [{ subject: "bob", predicate: "works_with", object: "carol" }];
        return [];
      }),
      evolution: { mode: "manual" },
    });
    await memory.recordEvents([
      { at: 1_000_000, actor: "u", content: { kind: "message", text: "alice met bob today" } },
      {
        at: 2_000_000,
        actor: "u",
        content: { kind: "message", text: "bob works with carol on infrastructure" },
      },
    ]).nodes;

    const paths = await memory.graphPaths("alice", "carol", { maxDepth: 3 });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].entities).toEqual(["alice", "bob", "carol"]);
    await memory.close();
  });
});
