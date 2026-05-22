import { describe, expect, test } from "vitest";
import { Memorai, MemoryAdapter, StreamIngestor } from "../src/index.js";

class MockEmbedder {
  readonly dimension = 4;
  async embed(text: string): Promise<number[]> {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) % 10000;
    }
    const base = hash / 10000;
    return [base, 1 - base, base * 0.5, 1 - base * 0.5];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function makeMemory(): Memorai {
  return new Memorai({
    storage: new MemoryAdapter(),
    embedding: new MockEmbedder(),
    evolution: { mode: "manual" },
  });
}

function event(text: string): {
  at: number;
  actor: string;
  content: { kind: "message"; text: string };
} {
  return { at: Date.now(), actor: "user", content: { kind: "message", text } };
}

describe("StreamIngestor", () => {
  test("push returns true when queue is healthy", () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory, { maxQueueDepth: 10 });
    expect(s.push(event("a"))).toBe(true);
    expect(s.depth).toBe(1);
    memory.close();
  });

  test("push returns false when backpressure kicks in (≥80%)", async () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory, { maxQueueDepth: 10, batchSize: 100 });
    // Fill to 70% = 7 events (all healthy)
    for (let i = 0; i < 7; i++) {
      expect(s.push(event(`e${i}`))).toBe(true);
    }
    // 8th event pushes us to exactly 80% — backpressure signal
    expect(s.push(event("e7"))).toBe(false);
    expect(s.depth).toBe(8);
    await s.close();
    await memory.close();
  });

  test("push drops events when queue is at 100%", async () => {
    const memory = makeMemory();
    const dropped: string[] = [];
    const s = new StreamIngestor(memory, {
      maxQueueDepth: 5,
      batchSize: 100, // prevent auto-flush
      onDrop: (ev) => dropped.push(ev.content.kind === "message" ? ev.content.text : ""),
    });
    for (let i = 0; i < 5; i++) s.push(event(`e${i}`));
    expect(s.depth).toBe(5);
    s.push(event("overflow"));
    expect(dropped).toContain("overflow");
    expect(s.dropped).toBeGreaterThanOrEqual(1);
    await s.close();
    await memory.close();
  });

  test("flush writes queued events", async () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory, { batchSize: 100 });
    s.push(event("alpha"));
    s.push(event("beta"));
    expect(s.depth).toBe(2);
    await s.flush();
    expect(s.depth).toBe(0);
    expect(s.written).toBe(2);
    await s.close();
    await memory.close();
  });

  test("recordStream consumes async iterable", async () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory, { batchSize: 2 });

    async function* source() {
      yield event("one");
      yield event("two");
      yield event("three");
      yield event("four");
    }

    const result = await s.recordStream(source());
    expect(result.written).toBe(4);
    expect(result.dropped).toBe(0);
    await s.close();
    await memory.close();
  });

  test("onFlush fires after each batch", async () => {
    const memory = makeMemory();
    const flushCounts: number[] = [];
    const s = new StreamIngestor(memory, {
      batchSize: 2,
      onFlush: (nodes) => flushCounts.push(nodes.length),
    });

    s.push(event("a"));
    s.push(event("b"));
    s.push(event("c"));
    await s.flush();
    expect(flushCounts.length).toBeGreaterThanOrEqual(1);
    await s.close();
    await memory.close();
  });

  test("close is idempotent", async () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory);
    await s.close();
    await s.close(); // should not throw
    await memory.close();
  });

  test("push after close is rejected", async () => {
    const memory = makeMemory();
    const s = new StreamIngestor(memory);
    await s.close();
    expect(s.push(event("late"))).toBe(false);
    expect(s.dropped).toBeGreaterThanOrEqual(1);
    await memory.close();
  });
});
