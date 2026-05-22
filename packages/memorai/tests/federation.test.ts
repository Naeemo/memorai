import { describe, expect, test } from "vitest";
import {
  Memorai,
  MemoryAdapter,
  MemoryFederation,
  SubscriptionRegistry,
} from "../src/index.js";

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

describe("SubscriptionRegistry", () => {
  test("notifies matching subscribers", () => {
    const reg = new SubscriptionRegistry();
    const notified: string[] = [];
    const handle = reg.subscribe({ actor: "alice" }, (node) => {
      notified.push(node.actor ?? "");
    });

    reg.notify({ id: "1", actor: "alice" } as any);
    reg.notify({ id: "2", actor: "bob" } as any);

    expect(notified).toEqual(["alice"]);
    handle.unsubscribe();
    expect(reg.size).toBe(0);
  });

  test("tag filter matches any tag", () => {
    const reg = new SubscriptionRegistry();
    const notified: string[] = [];
    reg.subscribe({ tags: ["urgent"] }, (node) => {
      notified.push(node.id);
    });

    reg.notify({
      id: "a",
      actor: "x",
      annotations: { tags: ["urgent", "work"] },
    } as any);
    reg.notify({
      id: "b",
      actor: "x",
      annotations: { tags: ["low"] },
    } as any);

    expect(notified).toEqual(["a"]);
  });

  test("textContains filter", () => {
    const reg = new SubscriptionRegistry();
    const notified: string[] = [];
    reg.subscribe({ textContains: "migration" }, (node) => {
      notified.push(node.id);
    });

    reg.notify({ id: "a", actor: "x", raw: { text: "the database migration" } } as any);
    reg.notify({ id: "b", actor: "x", raw: { text: "lunch plans" } } as any);

    expect(notified).toEqual(["a"]);
  });

  test("predicate filter", () => {
    const reg = new SubscriptionRegistry();
    const notified: string[] = [];
    reg.subscribe(
      { predicate: (node) => node.annotations?.salienceScore > 0.7 },
      (node) => notified.push(node.id),
    );

    reg.notify({ id: "a", actor: "x", annotations: { salienceScore: 0.9 } } as any);
    reg.notify({ id: "b", actor: "x", annotations: { salienceScore: 0.3 } } as any);

    expect(notified).toEqual(["a"]);
  });

  test("subscriber errors do not break pipeline", () => {
    const reg = new SubscriptionRegistry();
    let okCalled = false;
    reg.subscribe({ actor: "alice" }, () => {
      throw new Error("boom");
    });
    reg.subscribe({ actor: "alice" }, () => {
      okCalled = true;
    });

    reg.notify({ id: "1", actor: "alice" } as any);
    expect(okCalled).toBe(true);
  });
});

describe("Memorai.subscribe", () => {
  test("fires callback on matching write", async () => {
    const memory = makeMemory();
    const received: string[] = [];
    const handle = memory.subscribe({ actor: "alice" }, (node) => {
      received.push(node.actor ?? "");
    });

    await memory.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "hello world" },
    }).nodes;

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toBe("alice");

    handle.unsubscribe();
    await memory.close();
  });
});

describe("MemoryFederation", () => {
  test("prepareImport remaps ids", () => {
    const fed = new MemoryFederation();
    const slice = {
      sourceAgentId: "agent-a",
      exportedAt: Date.now(),
      nodes: [
        { id: "old-1", actor: "alice", annotations: {} } as any,
        { id: "old-2", actor: "bob", annotations: {}, parentId: "old-1" } as any,
      ],
    };

    const prepared = fed.prepareImport(slice);
    expect(prepared.nodes[0].id).not.toBe("old-1");
    expect(prepared.nodes[1].id).not.toBe("old-2");
    expect(prepared.nodes[1].parentId).toBe(prepared.nodes[0].id);
    expect(prepared.nodes[0].meta.sourceAgent).toBe("agent-a");
    expect(prepared.idMap.get("old-1")).toBe(prepared.nodes[0].id);
  });

  test("mergeSlice imports nodes into memory", async () => {
    const storageA = new MemoryAdapter();
    const memoryA = new Memorai({
      storage: storageA,
      embedding: new MockEmbedder(),
      evolution: { mode: "manual" },
    });
    await memoryA.recordEvent({
      at: Date.now(),
      actor: "alice",
      content: { kind: "message", text: "shared secret" },
    }).nodes;

    const fed = new MemoryFederation();
    const slice = await fed.exportSlice({
      sourceAgentId: "agent-a",
      listNodes: () => storageA.listAll({ limit: 10 }),
    });

    const memoryB = makeMemory();
    const result = await memoryB.mergeSlice(slice);
    expect(result.importedNodes).toBeGreaterThanOrEqual(1);

    const recalled = await memoryB.recall("shared secret", { topK: 5 });
    expect(recalled.memories.length).toBeGreaterThan(0);

    await memoryA.close();
    await memoryB.close();
  });
});
