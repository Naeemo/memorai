import {
  DefaultRetentionPolicy,
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
  type MemoryNode,
  type RetentionPolicy,
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

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeNode(opts: {
  id?: string;
  timestamp: number;
  salience: number;
  accessCount?: number;
}): MemoryNode {
  return {
    id: opts.id ?? `node-${Math.random()}`,
    timestamp: opts.timestamp,
    duration: 0,
    level: "segment",
    raw: { content: { kind: "observation", text: "x" }, text: "x" },
    annotations: { tags: [], salienceScore: opts.salience, modality: ["text"] },
    meta: {
      sourceAgent: "test",
      agentRole: "test",
      accessCount: opts.accessCount ?? 0,
    },
  };
}

// ─── DefaultRetentionPolicy ───

describe("DefaultRetentionPolicy", () => {
  test("fresh high-salience nodes score high", () => {
    const policy = new DefaultRetentionPolicy();
    const node = fakeNode({ timestamp: Date.now(), salience: 0.9, accessCount: 10 });
    const score = policy.score(node, { now: Date.now() });
    expect(score).toBeGreaterThan(0.6);
  });

  test("old low-salience never-accessed nodes score low", () => {
    const policy = new DefaultRetentionPolicy();
    const now = Date.now();
    const node = fakeNode({
      timestamp: now - 90 * DAY_MS,
      salience: 0.1,
      accessCount: 0,
    });
    const score = policy.score(node, { now });
    expect(score).toBeLessThan(0.2);
  });

  test("shouldEvict respects minAgeMs floor", () => {
    const policy = new DefaultRetentionPolicy({ minAgeMs: DAY_MS });
    const now = Date.now();
    const young = fakeNode({ timestamp: now - 60_000, salience: 0, accessCount: 0 });
    expect(policy.shouldEvict(young, { now })).toBe(false);
  });

  test("shouldEvict fires when score drops below threshold", () => {
    const policy = new DefaultRetentionPolicy({ threshold: 0.3, minAgeMs: 0 });
    const now = Date.now();
    const old = fakeNode({
      timestamp: now - 60 * DAY_MS,
      salience: 0.05,
      accessCount: 0,
    });
    expect(policy.shouldEvict(old, { now })).toBe(true);
  });

  test("recency weight decays exponentially with half-life", () => {
    const policy = new DefaultRetentionPolicy({
      recencyHalfLifeMs: DAY_MS,
      weights: { salience: 0, recency: 1, access: 0 },
    });
    const now = Date.now();
    const fresh = fakeNode({ timestamp: now, salience: 0 });
    const oneHalf = fakeNode({ timestamp: now - DAY_MS, salience: 0 });
    const quarter = fakeNode({ timestamp: now - 2 * DAY_MS, salience: 0 });
    const ctx = { now };
    expect(policy.score(fresh, ctx)).toBeCloseTo(1, 2);
    expect(policy.score(oneHalf, ctx)).toBeCloseTo(0.5, 2);
    expect(policy.score(quarter, ctx)).toBeCloseTo(0.25, 2);
  });

  test("access frequency lifts score logarithmically", () => {
    const policy = new DefaultRetentionPolicy({
      accessSaturation: 50,
      weights: { salience: 0, recency: 0, access: 1 },
    });
    const now = Date.now();
    const a0 = fakeNode({ timestamp: now, salience: 0, accessCount: 0 });
    const a10 = fakeNode({ timestamp: now, salience: 0, accessCount: 10 });
    const a50 = fakeNode({ timestamp: now, salience: 0, accessCount: 50 });
    const ctx = { now };
    expect(policy.score(a0, ctx)).toBe(0);
    expect(policy.score(a10, ctx)).toBeGreaterThan(0);
    expect(policy.score(a10, ctx)).toBeLessThan(1);
    expect(policy.score(a50, ctx)).toBeCloseTo(1, 2);
  });
});

// ─── Memorai.forget ───

describe("Memorai.forget", () => {
  test("default policy + delete mode evicts low-retention nodes", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      retentionPolicy: new DefaultRetentionPolicy({ threshold: 0.5, minAgeMs: 0 }),
      evolution: { mode: "manual" },
    });

    // Two old low-salience writes — should evict.
    const oldTs = Date.now() - 60 * DAY_MS;
    await memory.recordEvent({
      at: oldTs,
      actor: "user",
      content: { kind: "observation", text: "stale 1" },
      salienceHint: 0.05,
    }).nodes;
    await memory.recordEvent({
      at: oldTs,
      actor: "user",
      content: { kind: "observation", text: "stale 2" },
      salienceHint: 0.05,
    }).nodes;
    // One fresh high-salience write — should keep.
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "observation", text: "important" },
      salienceHint: 0.95,
    }).nodes;

    const result = await memory.forget();
    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.evicted).toBeGreaterThanOrEqual(2);
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(result.mode).toBe("delete");
    // The "important" node should survive.
    const survivors = await memory.list();
    expect(survivors.some((n) => n.raw.text === "important")).toBe(true);
    expect(survivors.some((n) => n.raw.text === "stale 1")).toBe(false);
    await memory.close();
  });

  test("dryRun computes counts without evicting", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      retentionPolicy: new DefaultRetentionPolicy({ threshold: 0.5, minAgeMs: 0 }),
      evolution: { mode: "manual" },
    });
    const oldTs = Date.now() - 60 * DAY_MS;
    await memory.recordEvent({
      at: oldTs,
      actor: "user",
      content: { kind: "observation", text: "stale" },
      salienceHint: 0.05,
    }).nodes;

    const before = (await memory.list()).length;
    const result = await memory.forget({ dryRun: true });
    expect(result.evicted).toBeGreaterThanOrEqual(1);
    expect(result.wouldEvictIds).toBeDefined();
    const after = (await memory.list()).length;
    expect(after).toBe(before); // dry run preserved everything
    await memory.close();
  });

  test("strip mode preserves Tier 1 raw + clears annotations", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      retentionPolicy: new DefaultRetentionPolicy({ threshold: 0.5, minAgeMs: 0 }),
      evolution: { mode: "manual" },
    });
    const oldTs = Date.now() - 60 * DAY_MS;
    const nodes = await memory.recordEvent({
      at: oldTs,
      actor: "user",
      content: { kind: "observation", text: "stale but rememberable" },
      salienceHint: 0.05,
    }).nodes;
    const nodeId = nodes[0].id;

    await memory.forget({ mode: "strip" });

    const stripped = await memory.get(nodeId);
    expect(stripped).not.toBeNull();
    // Tier 1 raw stays.
    expect(stripped!.raw.text).toBe("stale but rememberable");
    // Tier 2 annotations cleared.
    expect(stripped!.annotations.embedding).toBeUndefined();
    expect(stripped!.annotations.summary).toBeUndefined();
    expect(stripped!.annotations.tags).toEqual([]);
    expect(stripped!.annotations.salienceScore).toBe(0);
    // forgottenAt stamped.
    expect((stripped!.meta as { forgottenAt?: number }).forgottenAt).toBeDefined();
    await memory.close();
  });

  test("filter scopes eviction to a subset", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      retentionPolicy: new DefaultRetentionPolicy({ threshold: 0.5, minAgeMs: 0 }),
      evolution: { mode: "manual" },
    });
    const oldTs = Date.now() - 60 * DAY_MS;
    await memory.recordEvent({
      at: oldTs,
      actor: "alice",
      content: { kind: "observation", text: "alice stale" },
      salienceHint: 0.05,
    }).nodes;
    await memory.recordEvent({
      at: oldTs,
      actor: "bob",
      content: { kind: "observation", text: "bob stale" },
      salienceHint: 0.05,
    }).nodes;

    const result = await memory.forget({
      filter: (n) => n.actor === "alice",
    });
    expect(result.evicted).toBeGreaterThan(0);
    const survivors = await memory.list();
    expect(survivors.some((n) => n.actor === "alice")).toBe(false);
    expect(survivors.some((n) => n.actor === "bob")).toBe(true);
    await memory.close();
  });

  test("custom policy is honored over the configured default", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "u",
      content: { kind: "observation", text: "kept by default policy" },
      salienceHint: 0.95,
    }).nodes;

    // A custom policy that evicts everything.
    const scorchedEarth: RetentionPolicy = {
      score: () => 0,
      shouldEvict: () => true,
    };
    const result = await memory.forget({ policy: scorchedEarth });
    expect(result.evicted).toBeGreaterThan(0);
    expect((await memory.list()).length).toBe(0);
    await memory.close();
  });
});
