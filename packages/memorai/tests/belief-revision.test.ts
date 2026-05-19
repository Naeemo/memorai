import {
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
  type EventIdentifier,
  type IdentifiedEvent,
  type IdentifyContext,
  type LLMService,
  type MemoryEvent,
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

class StubLLM implements LLMService {
  complete(): Promise<string> {
    return Promise.resolve("[]");
  }
}

/**
 * Scripted identifier that turns each MemoryNode into one state event
 * keyed off the raw text. Lets us seed the event store cheaply.
 */
class ScriptedIdentifier implements EventIdentifier {
  readonly version = "scripted-v1";
  constructor(
    private readonly script: (text: string) => {
      participants: string[];
      topics: string[];
      description: string;
    } | null,
  ) {}
  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    const out: IdentifiedEvent[] = [];
    for (const n of ctx.nodes) {
      const s = this.script(n.raw.text ?? "");
      if (!s) continue;
      out.push({
        kind: "state",
        description: s.description,
        participants: s.participants,
        topics: s.topics,
        occurredAt: n.timestamp,
        sourceNodeIds: [n.id],
      });
    }
    return out;
  }
}

async function seedState(memory: Memorai, texts: string[]): Promise<MemoryEvent[]> {
  const baseTs = Date.now() - texts.length * 1000;
  for (let i = 0; i < texts.length; i++) {
    await memory.recordEvent({
      at: baseTs + i * 1000,
      actor: "user",
      content: { kind: "observation", text: texts[i] },
    }).nodes;
  }
  await memory.evolve();
  return memory.listEvents({ kind: "state" });
}

// ─── reviseBelief ───

describe("Memorai.reviseBelief", () => {
  test("creates a new state event superseding the old one", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("tea"))
          return {
            participants: ["alice"],
            topics: ["preferences"],
            description: "Alice prefers tea",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });
    const initial = await seedState(memory, ["alice loves tea"]);
    expect(initial).toHaveLength(1);
    const oldId = initial[0].id;

    const revised = await memory.reviseBelief({
      supersedes: oldId,
      description: "Alice now prefers coffee",
      reason: "she told me on Monday",
    });
    expect(revised).not.toBeNull();
    expect(revised!.description).toBe("Alice now prefers coffee");
    expect(revised!.supersedes).toEqual([oldId]);
    expect(revised!.meta.revisionReason).toBe("she told me on Monday");
    expect(revised!.meta.revisionDepth).toBe(1);

    const oldNow = await memory.getEvent(oldId);
    expect(oldNow!.invalidatedAt).toBe(revised!.occurredAt);
    await memory.close();
  });

  test("inherits participants/topics/userId from the predecessor when omitted", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("alice"))
          return {
            participants: ["alice"],
            topics: ["preferences", "drinks"],
            description: "Alice prefers tea",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now() - 1000,
      userId: "tenant-1",
      actor: "user",
      content: { kind: "observation", text: "alice prefers tea" },
    }).nodes;
    await memory.evolve();
    const [old] = await memory.listEvents({ kind: "state" });

    const revised = await memory.reviseBelief({
      supersedes: old.id,
      description: "Alice prefers coffee now",
    });
    expect(revised!.participants).toEqual(["alice"]);
    expect(revised!.topics).toEqual(["preferences", "drinks"]);
    expect(revised!.userId).toBe("tenant-1");
    await memory.close();
  });

  test("refuses cross-tenant supersedes", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("tenant-a"))
          return {
            participants: ["alice"],
            topics: ["preferences"],
            description: "Alice prefers tea (tenant A)",
          };
        if (text.includes("tenant-b"))
          return {
            participants: ["alice"],
            topics: ["preferences"],
            description: "Alice prefers tea (tenant B)",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });
    await memory.recordEvents([
      {
        at: Date.now() - 2000,
        userId: "tenant-a",
        actor: "user",
        content: { kind: "observation", text: "tenant-a alice prefers tea" },
      },
      {
        at: Date.now() - 1000,
        userId: "tenant-b",
        actor: "user",
        content: { kind: "observation", text: "tenant-b alice prefers tea" },
      },
    ]).nodes;
    await memory.evolve();
    const events = await memory.listEvents({ kind: "state" });
    const a = events.find((e) => e.userId === "tenant-a")!;
    const b = events.find((e) => e.userId === "tenant-b")!;

    // Attempt to supersede across tenants — should refuse silently and
    // only retain the same-tenant id.
    const revised = await memory.reviseBelief({
      supersedes: [a.id, b.id],
      userId: "tenant-a",
      description: "Updated within tenant A",
    });
    // Only tenant-a's old event should be in supersedes; tenant-b survives.
    expect(revised!.supersedes).toEqual([a.id]);
    const bAfter = await memory.getEvent(b.id);
    expect(bAfter!.invalidatedAt).toBeUndefined();
    await memory.close();
  });

  test("revisionDepth increments through the chain", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier(() => ({
        participants: ["alice"],
        topics: ["preferences"],
        description: "initial",
      })),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "observation", text: "seed" },
    }).nodes;
    await memory.evolve();
    const [seed] = await memory.listEvents({ kind: "state" });

    const v1 = await memory.reviseBelief({
      supersedes: seed.id,
      description: "v1",
    });
    expect(v1!.meta.revisionDepth).toBe(1);
    const v2 = await memory.reviseBelief({
      supersedes: v1!.id,
      description: "v2",
    });
    expect(v2!.meta.revisionDepth).toBe(2);
    const v3 = await memory.reviseBelief({
      supersedes: v2!.id,
      description: "v3",
    });
    expect(v3!.meta.revisionDepth).toBe(3);
    await memory.close();
  });

  test("returns null when no valid supersedes resolved", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    const result = await memory.reviseBelief({
      supersedes: "nonexistent-id",
      description: "no-op",
    });
    expect(result).toBeNull();
    await memory.close();
  });
});

// ─── revisionsOf ───

describe("Memorai.revisionsOf", () => {
  test("returns the full chain oldest-first", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier(() => ({
        participants: ["alice"],
        topics: ["preferences"],
        description: "initial",
      })),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: 1_000_000,
      actor: "user",
      content: { kind: "observation", text: "seed" },
    }).nodes;
    await memory.evolve();
    const [seed] = await memory.listEvents({ kind: "state" });

    const v1 = await memory.reviseBelief({
      supersedes: seed.id,
      occurredAt: 2_000_000,
      description: "v1",
    });
    const v2 = await memory.reviseBelief({
      supersedes: v1!.id,
      occurredAt: 3_000_000,
      description: "v2",
    });

    const chain = await memory.revisionsOf(v2!.id);
    expect(chain.map((e) => e.description)).toEqual(["initial", "v1", "v2"]);
    await memory.close();
  });

  test("returns single-element list when no supersedes", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier(() => ({
        participants: ["alice"],
        topics: ["preferences"],
        description: "only event",
      })),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "observation", text: "seed" },
    }).nodes;
    await memory.evolve();
    const [seed] = await memory.listEvents({ kind: "state" });
    const chain = await memory.revisionsOf(seed.id);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe(seed.id);
    await memory.close();
  });

  test("handles missing eventId gracefully", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    expect(await memory.revisionsOf("nonexistent")).toEqual([]);
    await memory.close();
  });
});
