import {
  Memorai,
  MemoryAdapter,
  resolveTimeExpression,
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

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── resolveTimeExpression ───

describe("resolveTimeExpression", () => {
  test("today / yesterday / tomorrow span the right day", () => {
    const now = new Date(2026, 4, 18, 14, 30).getTime(); // 2026-05-18 14:30
    const today = resolveTimeExpression("what happened today?", now);
    expect(today).not.toBeNull();
    expect(new Date(today!.start).toDateString()).toBe("Mon May 18 2026");
    expect(new Date(today!.end).toDateString()).toBe("Mon May 18 2026");

    const yesterday = resolveTimeExpression("what did I do yesterday?", now);
    expect(yesterday).not.toBeNull();
    expect(new Date(yesterday!.start).toDateString()).toBe("Sun May 17 2026");

    const tomorrow = resolveTimeExpression("plans for tomorrow", now);
    expect(tomorrow).not.toBeNull();
    expect(new Date(tomorrow!.start).toDateString()).toBe("Tue May 19 2026");
  });

  test("'two days ago' resolves to a window around 2*24h prior", () => {
    const now = Date.now();
    const r = resolveTimeExpression("two days ago, alice called", now);
    expect(r).not.toBeNull();
    const center = (r!.start + r!.end) / 2;
    expect(Math.abs(center - (now - 2 * DAY_MS))).toBeLessThan(DAY_MS);
  });

  test("'last week' spans a 7-day window before this week", () => {
    const now = new Date(2026, 4, 18, 12).getTime(); // 2026-05-18 Mon
    const r = resolveTimeExpression("did anything happen last week?", now);
    expect(r).not.toBeNull();
    expect(r!.end - r!.start).toBeGreaterThan(6 * DAY_MS);
    expect(r!.end).toBeLessThan(now);
  });

  test("'last month' spans the previous calendar month", () => {
    const now = new Date(2026, 4, 18).getTime(); // May 2026
    const r = resolveTimeExpression("orders from last month", now);
    expect(r).not.toBeNull();
    expect(new Date(r!.start).getMonth()).toBe(3); // April
    expect(new Date(r!.end).getMonth()).toBe(3);
  });

  test("'last Tuesday' resolves to most recent Tuesday", () => {
    const now = new Date(2026, 4, 18).getTime(); // Mon May 18 2026
    const r = resolveTimeExpression("what happened last Tuesday?", now);
    expect(r).not.toBeNull();
    expect(new Date(r!.start).getDay()).toBe(2); // Tuesday
    expect(r!.start).toBeLessThan(now);
  });

  test("month name resolves to that month of the most recent year", () => {
    const now = new Date(2026, 6, 1).getTime(); // July 2026
    const r = resolveTimeExpression("highlights from March", now);
    expect(r).not.toBeNull();
    expect(new Date(r!.start).getMonth()).toBe(2); // March
    expect(new Date(r!.start).getFullYear()).toBe(2026);
  });

  test("returns null for phrases without temporal markers", () => {
    expect(resolveTimeExpression("how do I bake bread?")).toBeNull();
    expect(resolveTimeExpression("alice prefers tea over coffee")).toBeNull();
    expect(resolveTimeExpression("")).toBeNull();
  });

  test("'this morning' falls in morning hours", () => {
    const now = new Date(2026, 4, 18, 14, 30).getTime();
    const r = resolveTimeExpression("did Alice email this morning?", now);
    expect(r).not.toBeNull();
    expect(new Date(r!.start).getHours()).toBe(6);
    // End of morning slot is start + 6 hours.
    expect(new Date(r!.end).getHours()).toBeGreaterThanOrEqual(11);
  });

  test("'in N hours' resolves forward", () => {
    const now = Date.now();
    const r = resolveTimeExpression("a meeting in 3 hours", now);
    expect(r).not.toBeNull();
    const center = (r!.start + r!.end) / 2;
    expect(center).toBeGreaterThan(now);
    expect(center - now).toBeLessThan(4 * 60 * 60 * 1000);
  });

  test("confidence — explicit day phrasings are high", () => {
    const now = new Date(2026, 4, 18, 14, 0).getTime();
    expect(resolveTimeExpression("yesterday's meeting", now)?.confidence).toBe("high");
    expect(resolveTimeExpression("what about today", now)?.confidence).toBe("high");
    expect(resolveTimeExpression("two weeks ago", now)?.confidence).toBe("high");
    expect(resolveTimeExpression("last tuesday", now)?.confidence).toBe("high");
    expect(resolveTimeExpression("next week", now)?.confidence).toBe("high");
    expect(resolveTimeExpression("last march", now)?.confidence).toBe("high");
  });

  test("confidence — day-parts anchored to today are medium", () => {
    const now = new Date(2026, 4, 18, 14, 0).getTime();
    expect(resolveTimeExpression("this morning", now)?.confidence).toBe("medium");
    expect(resolveTimeExpression("this evening", now)?.confidence).toBe("medium");
    expect(resolveTimeExpression("this afternoon", now)?.confidence).toBe("medium");
  });

  test("confidence — bare month names without modifier are low", () => {
    const now = new Date(2026, 4, 18, 14, 0).getTime();
    expect(resolveTimeExpression("in march sometime", now)?.confidence).toBe("low");
  });
});

// ─── Integration: recall auto-applies temporal resolution ───

describe("Memorai.recall with temporal resolution", () => {
  test("query with 'yesterday' filters to yesterday's window", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const now = Date.now();
    await memory.recordEvents([
      {
        at: now - 2 * DAY_MS, // two days ago
        actor: "alice",
        content: { kind: "message", text: "older event" },
      },
      {
        at: now - DAY_MS, // yesterday
        actor: "alice",
        content: { kind: "message", text: "yesterday event" },
      },
      {
        at: now, // today
        actor: "alice",
        content: { kind: "message", text: "today event" },
      },
    ]).nodes;

    const result = await memory.recall("what did alice say yesterday?", {
      topK: 10,
      resolveTime: true,
    });
    // Only the yesterday event should fall in the window.
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories.every((m) => m.summary === "yesterday event")).toBe(true);
    await memory.close();
  });

  test("explicit timeRange overrides auto-resolution", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const now = Date.now();
    await memory.recordEvents([
      { at: now - DAY_MS, actor: "u", content: { kind: "message", text: "yesterday note" } },
      { at: now, actor: "u", content: { kind: "message", text: "today note" } },
    ]).nodes;

    // Explicit "today" range should NOT be overridden by the "yesterday" in the question.
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const result = await memory.recall("yesterday", {
      timeRange: { start: todayStart.getTime(), end: todayEnd.getTime() },
      topK: 5,
    });
    // The explicit window should win — yesterday note must NOT appear.
    expect(result.memories.some((m) => m.summary === "yesterday note")).toBe(false);
    await memory.close();
  });

  test("query without temporal tokens is unchanged", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now() - DAY_MS,
      actor: "u",
      content: { kind: "message", text: "interesting note" },
    }).nodes;
    const result = await memory.recall("interesting note", { topK: 3 });
    expect(result.memories.length).toBeGreaterThan(0);
    await memory.close();
  });

  test("resolveTime defaults to true", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const now = Date.now();
    await memory.recordEvents([
      { at: now - 2 * DAY_MS, actor: "u", content: { kind: "message", text: "older note" } },
      { at: now - DAY_MS, actor: "u", content: { kind: "message", text: "yesterday note" } },
    ]).nodes;

    // No explicit resolveTime — should behave like resolveTime: true.
    const result = await memory.recall("what did I do yesterday?", { topK: 5 });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories.every((m) => m.summary === "yesterday note")).toBe(true);
    await memory.close();
  });

  test("resolveTime can be disabled via config", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
      defaultResolveTime: false,
    });
    const now = Date.now();
    await memory.recordEvents([
      { at: now - 2 * DAY_MS, actor: "u", content: { kind: "message", text: "older note" } },
      { at: now - DAY_MS, actor: "u", content: { kind: "message", text: "yesterday note" } },
    ]).nodes;

    const result = await memory.recall("what did I do yesterday?", { topK: 5 });
    // Without resolution, the query matches both notes semantically/BM25.
    expect(result.memories.some((m) => m.summary === "older note")).toBe(true);
    expect(result.memories.some((m) => m.summary === "yesterday note")).toBe(true);
    await memory.close();
  });

  test("low-confidence resolution is dropped even with resolveTime: true", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const recentTs = Date.now() - DAY_MS;
    await memory.recordEvent({
      at: recentTs,
      actor: "u",
      content: { kind: "message", text: "discussed march budget" },
    }).nodes;
    // "in march" alone is low-confidence — resolver returns a range but
    // applyTemporalResolution drops it. The recall should match the
    // recent note via semantic / BM25 without being anchored to a
    // guessed March window.
    const result = await memory.recall("discussed march budget", {
      topK: 3,
      resolveTime: true,
    });
    expect(result.memories.some((m) => m.summary === "discussed march budget")).toBe(true);
    await memory.close();
  });
});
