import {
  InMemoryWorkingMemory,
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
  type WorkingMemory,
} from "../src/index.js";

class MockEmbeddingService implements EmbeddingService {
  readonly dimension = 4;
  embed(): Promise<number[]> {
    return Promise.resolve([0, 0, 0, 0]);
  }
}

// ─── InMemoryWorkingMemory ───

describe("InMemoryWorkingMemory", () => {
  test("set then get returns the value", async () => {
    const wm = new InMemoryWorkingMemory();
    await wm.set("task", "summarize the doc");
    expect(await wm.get("task")).toBe("summarize the doc");
  });

  test("get on missing key returns null", async () => {
    const wm = new InMemoryWorkingMemory();
    expect(await wm.get("absent")).toBeNull();
  });

  test("set overwrites previous value but preserves createdAt", async () => {
    let t = 1000;
    const wm = new InMemoryWorkingMemory({ now: () => t });
    await wm.set("k", "v1");
    t = 2000;
    await wm.set("k", "v2");
    const aged = await wm.agedEntries(0);
    expect(aged).toHaveLength(1);
    expect(aged[0].createdAt).toBe(1000);
    expect(aged[0].updatedAt).toBe(2000);
    expect(aged[0].value).toBe("v2");
  });

  test("has reflects presence", async () => {
    const wm = new InMemoryWorkingMemory();
    await wm.set("k", "v");
    expect(await wm.has("k")).toBe(true);
    expect(await wm.has("missing")).toBe(false);
  });

  test("delete removes the entry", async () => {
    const wm = new InMemoryWorkingMemory();
    await wm.set("k", "v");
    await wm.delete("k");
    expect(await wm.get("k")).toBeNull();
    expect(await wm.has("k")).toBe(false);
  });

  test("clear empties the store", async () => {
    const wm = new InMemoryWorkingMemory();
    await wm.set("a", 1);
    await wm.set("b", 2);
    await wm.clear();
    expect(await wm.size()).toBe(0);
    expect(await wm.keys()).toEqual([]);
  });

  test("snapshot returns all live entries by key", async () => {
    const wm = new InMemoryWorkingMemory();
    await wm.set("a", 1);
    await wm.set("b", "two");
    expect(await wm.snapshot()).toEqual({ a: 1, b: "two" });
  });

  test("TTL expires entries at read time", async () => {
    let t = 1000;
    const wm = new InMemoryWorkingMemory({ now: () => t });
    await wm.set("ephemeral", "vanishes", { ttlMs: 500 });
    expect(await wm.get("ephemeral")).toBe("vanishes");
    t = 1500; // exactly at expiry
    expect(await wm.get("ephemeral")).toBeNull();
    expect(await wm.has("ephemeral")).toBe(false);
    expect(await wm.size()).toBe(0);
  });

  test("agedEntries returns entries past the threshold, sorted by creation", async () => {
    let t = 1000;
    const wm = new InMemoryWorkingMemory({ now: () => t });
    await wm.set("first", "a");
    t = 2000;
    await wm.set("second", "b");
    t = 3000;
    await wm.set("third", "c");
    t = 4000;
    const aged = await wm.agedEntries(1500); // age >= 1500 → first(3000ms) + second(2000ms)
    expect(aged.map((e) => e.key)).toEqual(["first", "second"]);
  });

  test("agedEntries excludes expired entries", async () => {
    let t = 1000;
    const wm = new InMemoryWorkingMemory({ now: () => t });
    await wm.set("expires", "soon", { ttlMs: 500 });
    await wm.set("persists", "long");
    t = 5000;
    const aged = await wm.agedEntries(0);
    expect(aged.map((e) => e.key)).toEqual(["persists"]);
  });

  test("complex JSON-serializable values round-trip", async () => {
    const wm = new InMemoryWorkingMemory();
    const value = { plan: ["step1", "step2"], context: { user: "alice" } };
    await wm.set("plan", value);
    expect(await wm.get("plan")).toEqual(value);
  });
});

// ─── Memorai integration ───

describe("Memorai.workingMemory", () => {
  test("defaults to an in-memory implementation", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    expect(memory.workingMemory).toBeDefined();
    await memory.workingMemory.set("task", "test");
    expect(await memory.workingMemory.get("task")).toBe("test");
    await memory.close();
  });

  test("uses the configured backend when supplied", async () => {
    class TrackingWorkingMemory implements WorkingMemory {
      sets = 0;
      private inner = new InMemoryWorkingMemory();
      set<T>(key: string, value: T): Promise<void> {
        this.sets += 1;
        return this.inner.set(key, value);
      }
      get<T = unknown>(key: string): Promise<T | null> {
        return this.inner.get(key);
      }
      has(key: string): Promise<boolean> {
        return this.inner.has(key);
      }
      delete(key: string): Promise<void> {
        return this.inner.delete(key);
      }
      clear(): Promise<void> {
        return this.inner.clear();
      }
      keys(): Promise<string[]> {
        return this.inner.keys();
      }
      snapshot(): Promise<Record<string, unknown>> {
        return this.inner.snapshot();
      }
      agedEntries(minAgeMs: number) {
        return this.inner.agedEntries(minAgeMs);
      }
      size(): Promise<number> {
        return this.inner.size();
      }
    }
    const wm = new TrackingWorkingMemory();
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      workingMemory: wm,
      evolution: { mode: "manual" },
    });
    await memory.workingMemory.set("k", "v");
    expect(wm.sets).toBe(1);
    await memory.close();
  });

  test("working memory is independent of LTM — no interaction with recall", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory.workingMemory.set("hidden", "I am scratch state");
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "message", text: "hello world" },
    }).nodes;
    const result = await memory.recall("scratch state", { topK: 5 });
    // The working-memory value is NOT exposed through recall.
    expect(result.memories.some((m) => m.summary === "I am scratch state")).toBe(false);
    await memory.close();
  });
});
