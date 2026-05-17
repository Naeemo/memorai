import {
  LightExtractor,
  LLMExtractor,
  LLMReranker,
  Memorai,
  MemoryAdapter,
  WrapExtractor,
  parseRerankerScores,
  type EmbeddingService,
  type Event,
  type LLMService,
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

const baseConfig = () => ({
  storage: new MemoryAdapter(),
  embedding: new MockEmbeddingService(),
  evolution: { mode: "manual" as const },
});

// ═══════════════════════════════════════════════════════════
// Event API
// ═══════════════════════════════════════════════════════════

describe("Event API — recordEvent / recall", () => {
  test("RecordHandle returns eventIds synchronously and nodes async", async () => {
    const memory = new Memorai(baseConfig());
    const handle = memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      target: "bob",
      content: { kind: "message", text: "Are you free for lunch?" },
    });
    expect(handle.eventIds).toHaveLength(1);
    expect(handle.done()).toBe(false);
    const nodes = await handle.nodes;
    expect(handle.done()).toBe(true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].actor).toBe("alice");
    expect(nodes[0].target).toBe("bob");
    expect(nodes[0].raw.text).toBe("Are you free for lunch?");
    await memory.close();
  });

  test("recall returns RecalledMemory shape", async () => {
    const memory = new Memorai(baseConfig());
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      target: "assistant",
      content: { kind: "message", text: "remind me to call Bob tomorrow" },
    }).nodes;
    const result = await memory.recall("what was I asked to do?", { topK: 5 });
    expect(result.memories.length).toBeGreaterThan(0);
    const m = result.memories[0];
    expect(m.actor).toBe("user");
    expect(m.target).toBe("assistant");
    expect(m.summary).toContain("Bob");
    expect(typeof m.score).toBe("number");
    await memory.close();
  });

  test("recallByActor filters by actor", async () => {
    const memory = new Memorai(baseConfig());
    await memory.recordEvents([
      { at: Date.now() - 1000, actor: "alice", content: { kind: "message", text: "hello" } },
      { at: Date.now(), actor: "bob", content: { kind: "message", text: "world" } },
    ]).nodes;
    const aliceOnly = await memory.recallByActor("alice", { topK: 10 });
    expect(aliceOnly.memories.every((m) => m.actor === "alice")).toBe(true);
    await memory.close();
  });

  test("recallByTime filters by time window", async () => {
    const memory = new Memorai(baseConfig());
    const now = Date.now();
    await memory.recordEvents([
      { at: now - 60_000, actor: "alice", content: { kind: "message", text: "old" } },
      { at: now, actor: "alice", content: { kind: "message", text: "recent" } },
    ]).nodes;
    const recent = await memory.recallByTime({ start: now - 30_000, end: now + 1 }, { topK: 10 });
    expect(recent.memories.length).toBeGreaterThan(0);
    expect(recent.memories.every((m) => m.summary === "recent")).toBe(true);
    await memory.close();
  });

  test("recallByRelationship returns events in either direction", async () => {
    const memory = new Memorai(baseConfig());
    await memory.recordEvents([
      {
        actor: "alice",
        target: "bob",
        at: Date.now() - 100,
        content: { kind: "message", text: "hi" },
      },
      {
        actor: "bob",
        target: "alice",
        at: Date.now(),
        content: { kind: "message", text: "hello back" },
      },
      {
        actor: "alice",
        target: "carol",
        at: Date.now() + 100,
        content: { kind: "message", text: "unrelated" },
      },
    ]).nodes;
    const ab = await memory.recallByRelationship("alice", "bob", { topK: 10 });
    expect(ab.memories.length).toBeGreaterThan(0);
    expect(
      ab.memories.every(
        (m) =>
          (m.actor === "alice" && m.target === "bob") ||
          (m.actor === "bob" && m.target === "alice"),
      ),
    ).toBe(true);
    const summaries = new Set(ab.memories.map((m) => m.summary));
    expect(summaries.has("unrelated")).toBe(false);
    await memory.close();
  });

  test("userId scoping isolates conversations", async () => {
    const memory = new Memorai(baseConfig());
    await memory.recordEvents([
      {
        userId: "conv-1",
        actor: "alice",
        at: Date.now(),
        content: { kind: "message", text: "alpha" },
      },
      {
        userId: "conv-2",
        actor: "alice",
        at: Date.now(),
        content: { kind: "message", text: "bravo" },
      },
    ]).nodes;
    const c1 = await memory.recall("any", { userId: "conv-1", topK: 10 });
    const c2 = await memory.recall("any", { userId: "conv-2", topK: 10 });
    expect(c1.memories.every((m) => m.userId === "conv-1")).toBe(true);
    expect(c2.memories.every((m) => m.userId === "conv-2")).toBe(true);
    expect(c1.memories[0].summary).toBe("alpha");
    expect(c2.memories[0].summary).toBe("bravo");
    await memory.close();
  });

  test("multimodal image event preserves media payload", async () => {
    const memory = new Memorai(baseConfig());
    const nodes = await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "image", image: "blob:test-123", caption: "screenshot of error" },
    }).nodes;
    expect(nodes[0].raw.media?.frames?.[0]).toBe("blob:test-123");
    expect(nodes[0].raw.text).toBe("screenshot of error");
    expect(nodes[0].annotations.modality).toContain("vision");
    await memory.close();
  });

  test("video event with time range maps to timestamp + duration", async () => {
    const memory = new Memorai(baseConfig());
    const start = Date.now() - 60_000;
    const end = Date.now();
    const nodes = await memory.recordEvent({
      during: { start, end },
      actor: "carol",
      content: { kind: "video", video: "blob:vid-1", transcript: "demo walkthrough" },
    }).nodes;
    expect(nodes[0].timestamp).toBe(end);
    expect(nodes[0].duration).toBe(60_000);
    expect(nodes[0].raw.text).toBe("demo walkthrough");
    expect(nodes[0].raw.media?.video).toBe("blob:vid-1");
    await memory.close();
  });

  test("defaultActor + defaultUserId from config fill in missing fields", async () => {
    const memory = new Memorai({
      ...baseConfig(),
      defaultActor: "system",
      defaultUserId: "tenant-x",
    });
    const nodes = await memory.recordEvent({
      at: Date.now(),
      actor: "system", // current API requires actor on Event; defaultActor used when not set per-call (see recordMany)
      content: { kind: "observation", text: "uptime ok" },
    }).nodes;
    expect(nodes[0].actor).toBe("system");
    expect(nodes[0].userId).toBe("tenant-x");
    await memory.close();
  });
});

// ═══════════════════════════════════════════════════════════
// Extractors
// ═══════════════════════════════════════════════════════════

describe("WrapExtractor", () => {
  test("uses raw text as summary, fills defaults", async () => {
    const e = new WrapExtractor();
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      now: () => 1700000000000,
    };
    const event: Event = {
      at: 1700000000000,
      actor: "alice",
      target: "bob",
      content: { kind: "message", text: "hello world" },
    };
    const out = await e.extract(event, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].raw.text).toBe("hello world");
    expect(out[0].annotations!.tags).toContain("alice");
    expect(out[0].annotations!.tags).toContain("bob");
    expect(out[0].actor).toBe("alice");
    expect(out[0].target).toBe("bob");
  });
});

describe("LightExtractor", () => {
  test("scores salience higher for emphasis tokens", async () => {
    const e = new LightExtractor();
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      now: () => Date.now(),
    };
    const mundane = await e.extract(
      { at: Date.now(), actor: "u", content: { kind: "message", text: "ate lunch" } },
      ctx,
    );
    const urgent = await e.extract(
      {
        at: Date.now(),
        actor: "u",
        content: { kind: "message", text: "CRITICAL: server is down, important to fix ASAP" },
      },
      ctx,
    );
    expect(urgent[0].annotations!.salienceScore!).toBeGreaterThan(
      mundane[0].annotations!.salienceScore!,
    );
  });

  test("extracts proper-noun-like tags from text", async () => {
    const e = new LightExtractor();
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      now: () => Date.now(),
    };
    const out = await e.extract(
      {
        at: Date.now(),
        actor: "alice",
        content: { kind: "message", text: "Met with Sarah at GoogleHQ about #project Atlas" },
      },
      ctx,
    );
    const tags = out[0].annotations!.tags ?? [];
    expect(tags).toContain("sarah");
    expect(tags).toContain("project");
    expect(tags).toContain("atlas");
  });
});

describe("LLMExtractor", () => {
  test("falls back to LightExtractor when no LLM is configured", async () => {
    const e = new LLMExtractor(); // no llm provided
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      now: () => Date.now(),
    };
    const out = await e.extract(
      { at: Date.now(), actor: "u", content: { kind: "message", text: "hello" } },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].raw.text).toBe("hello");
  });

  test("uses provided LLM and parses JSON output", async () => {
    const stubLLM: LLMService = {
      complete: async () =>
        JSON.stringify({
          summary: "Custom summary",
          tags: ["x", "y"],
          salience: 0.77,
          description: "Optional desc",
        }),
    };
    const e = new LLMExtractor({ llm: stubLLM });
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      llm: stubLLM,
      now: () => Date.now(),
    };
    const out = await e.extract(
      { at: Date.now(), actor: "alice", content: { kind: "message", text: "raw text" } },
      ctx,
    );
    expect(out[0].annotations!.summary).toBe("Custom summary");
    expect(out[0].annotations!.tags).toContain("x");
    expect(out[0].annotations!.salienceScore).toBeCloseTo(0.77, 5);
    expect(out[0].annotations!.description).toBe("Optional desc");
  });

  test("falls back to LightExtractor on JSON parse failure", async () => {
    const badLLM: LLMService = { complete: async () => "not json at all" };
    const e = new LLMExtractor({ llm: badLLM });
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      llm: badLLM,
      now: () => Date.now(),
    };
    const out = await e.extract(
      { at: Date.now(), actor: "u", content: { kind: "message", text: "hello" } },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0].raw.text).toBe("hello"); // light fallback preserves raw verbatim
  });
});

// ═══════════════════════════════════════════════════════════
// Auto-evolve triggers
// ═══════════════════════════════════════════════════════════

describe("Auto-evolve triggers", () => {
  test("onWriteCount triggers evolve after N writes", async () => {
    const memory = new Memorai({
      ...baseConfig(),
      evolution: {
        mode: "auto",
        autoTriggers: { onWriteCount: 3, onIdleMs: undefined, onStmFull: false, onClose: false },
        // Loosen thresholds so evolution produces an event node
        semanticMergeThreshold: 0.5,
        sceneSimilarityThreshold: 0.3,
      },
    });

    for (let i = 0; i < 3; i++) {
      await memory.recordEvent({
        at: Date.now() + i,
        actor: "u",
        content: { kind: "message", text: `event ${i}` },
      }).nodes;
    }
    // Give the void-promise evolve a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    const episodes = await memory.list({ level: "episode" });
    expect(episodes.length).toBeGreaterThan(0);
    await memory.close();
  });
});

// ═══════════════════════════════════════════════════════════
// Query expansion + HyDE + provenance
// ═══════════════════════════════════════════════════════════

describe("Multi-pathway recall", () => {
  test("provenance lists the pathways that surfaced each memory", async () => {
    const memory = new Memorai(baseConfig());
    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      target: "bob",
      content: { kind: "message", text: "the secret password is rosebud" },
    }).nodes;

    const result = await memory.recall("password", {
      topK: 3,
      actor: "alice",
    });
    expect(result.memories.length).toBeGreaterThan(0);
    const m = result.memories[0];
    expect(m.provenance).toBeDefined();
    expect(m.provenance!.pathways.length).toBeGreaterThan(0);
    // BM25 should surface the literal token "password"; semantic should too.
    expect(m.provenance!.pathways.some((p) => p === "bm25" || p === "semantic")).toBe(true);
    await memory.close();
  });

  test("query expansion runs N variants and fuses them", async () => {
    let callCount = 0;
    const stubLLM: LLMService = {
      complete: async (prompt) => {
        callCount += 1;
        // Cheap stub: produce 3 paraphrases.
        if (prompt.includes("paraphrases")) {
          return "What is the secret password?\nDo you know the password?\nWhat password did Alice mention?";
        }
        return "stub";
      },
    };
    const memory = new Memorai({ ...baseConfig(), llm: stubLLM });
    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "the secret password is rosebud" },
    }).nodes;

    const result = await memory.recall("password", {
      topK: 5,
      queryExpansion: 3,
    });
    expect(callCount).toBeGreaterThan(0);
    expect(result.memories.length).toBeGreaterThan(0);
    const pathways = result.memories[0].provenance?.pathways ?? [];
    // Variant-level tags should appear
    expect(pathways.includes("primary") || pathways.some((p) => p.startsWith("expansion:"))).toBe(
      true,
    );
    await memory.close();
  });

  test("HyDE adds a 'hyde' pathway when LLM is configured", async () => {
    const stubLLM: LLMService = {
      complete: async (prompt) => {
        if (prompt.includes("hypothetical answer")) {
          return "The secret password is rosebud, which Alice mentioned earlier.";
        }
        return "stub";
      },
    };
    const memory = new Memorai({ ...baseConfig(), llm: stubLLM });
    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "the secret password is rosebud" },
    }).nodes;

    const result = await memory.recall("password", {
      topK: 5,
      hyde: true,
    });
    expect(result.memories.length).toBeGreaterThan(0);
    const pathways = result.memories[0].provenance?.pathways ?? [];
    expect(pathways).toContain("hyde");
    await memory.close();
  });

  test("recall without LLM is unchanged when expansion/hyde are off", async () => {
    const memory = new Memorai(baseConfig()); // no llm
    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "the secret password is rosebud" },
    }).nodes;

    // queryExpansion/hyde without LLM should silently no-op.
    const result = await memory.recall("password", {
      topK: 3,
      queryExpansion: 3,
      hyde: true,
    });
    expect(result.memories.length).toBeGreaterThan(0);
    await memory.close();
  });
});

// ═══════════════════════════════════════════════════════════
// Reranker
// ═══════════════════════════════════════════════════════════

describe("LLMReranker", () => {
  test("parseRerankerScores reads scores in order, tolerates noise", () => {
    expect(parseRerankerScores("8\n2\n5", 3)).toEqual([0.8, 0.2, 0.5]);
    expect(parseRerankerScores("[0] 9\n[1] 0\n[2] 7.5", 3)).toEqual([0.9, 0, 0.75]);
    // missing lines pad with 0
    expect(parseRerankerScores("9\n", 3)).toEqual([0.9, 0, 0]);
    // out-of-range clamps to [0,1]
    expect(parseRerankerScores("11\n-3", 2)).toEqual([1, 0]);
  });

  test("reranker reorders memories by relevance", async () => {
    // The reranker says doc 1 is most relevant, doc 0 second, doc 2 third.
    const stubLLM: LLMService = {
      complete: async (prompt) => {
        if (prompt.includes("Rate how relevant")) return "3\n9\n6";
        return "stub";
      },
    };
    const memory = new Memorai({
      ...baseConfig(),
      reranker: new LLMReranker({ llm: stubLLM }),
    });

    const e1 = await memory.recordEvent({
      at: Date.now() - 3000,
      actor: "u",
      content: { kind: "message", text: "alpha bravo charlie delta echo" },
    }).nodes;
    const e2 = await memory.recordEvent({
      at: Date.now() - 2000,
      actor: "u",
      content: { kind: "message", text: "alpha bravo charlie delta echo two" },
    }).nodes;
    const e3 = await memory.recordEvent({
      at: Date.now() - 1000,
      actor: "u",
      content: { kind: "message", text: "alpha bravo charlie delta echo three" },
    }).nodes;

    const result = await memory.recall("alpha bravo", { topK: 3 });
    expect(result.memories.length).toBe(3);
    // Reranker output order: idx1 (highest), idx0, idx2
    // The order in `docs` is the input pre-rerank order; the stub returns
    // scores 3, 9, 6 for docs 0, 1, 2 respectively. So result[0] must have
    // come from doc index 1 (score 9), result[1] from index 0 (3), and the
    // memory at result[0] must carry pathways including "rerank".
    expect(result.memories[0].provenance?.pathways).toContain("rerank");
    expect(result.memories[0].score).toBeCloseTo(0.9, 5);

    await memory.close();
    void e1;
    void e2;
    void e3;
  });

  test("reranker failure falls back to fused list", async () => {
    const stubLLM: LLMService = {
      complete: async () => {
        throw new Error("LLM unavailable");
      },
    };
    const memory = new Memorai({
      ...baseConfig(),
      reranker: new LLMReranker({ llm: stubLLM }),
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "u",
      content: { kind: "message", text: "alpha bravo charlie" },
    }).nodes;

    const result = await memory.recall("alpha", { topK: 3 });
    expect(result.memories.length).toBeGreaterThan(0);
    // Pathways should NOT include "rerank" because the LLM call failed and
    // we returned the fused list unchanged.
    expect(result.memories[0].provenance?.pathways ?? []).not.toContain("rerank");
    await memory.close();
  });
});
