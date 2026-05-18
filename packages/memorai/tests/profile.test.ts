import {
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
  type EventIdentifier,
  type IdentifiedEvent,
  type IdentifyContext,
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

class StubLLM implements LLMService {
  complete(): Promise<string> {
    return Promise.resolve("[]");
  }
}

/**
 * Identifier that turns each MemoryNode into a single state event using a
 * scripted (participants, topics, description) tuple. Lets us drive the
 * profile-view tests without a real LLM in the loop.
 */
class ScriptedIdentifier implements EventIdentifier {
  readonly version = "scripted-v1";
  constructor(
    private readonly script: (text: string) => {
      participants: string[];
      topics: string[];
      description: string;
      supersedesIds?: string[];
    } | null,
  ) {}

  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    const out: IdentifiedEvent[] = [];
    for (const n of ctx.nodes) {
      const text = n.raw.text ?? "";
      const s = this.script(text);
      if (!s) continue;
      out.push({
        kind: "state",
        description: s.description,
        participants: s.participants,
        topics: s.topics,
        occurredAt: n.timestamp,
        sourceNodeIds: [n.id],
        supersedes: s.supersedesIds,
      });
    }
    return out;
  }
}

describe("Memorai.getUserFacts", () => {
  test("returns valid state events for the given participant", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("alice prefers tea"))
          return {
            participants: ["alice"],
            topics: ["preferences"],
            description: "Alice prefers tea over coffee",
          };
        if (text.includes("bob prefers coffee"))
          return {
            participants: ["bob"],
            topics: ["preferences"],
            description: "Bob prefers coffee over tea",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });

    await memory.recordEvents([
      {
        at: Date.now() - 2000,
        actor: "user",
        content: { kind: "message", text: "alice prefers tea" },
      },
      {
        at: Date.now() - 1000,
        actor: "user",
        content: { kind: "message", text: "bob prefers coffee" },
      },
    ]).nodes;
    await memory.evolve(); // run identifier

    const aliceFacts = await memory.getUserFacts({ participant: "alice" });
    expect(aliceFacts.length).toBeGreaterThan(0);
    expect(aliceFacts[0].description).toBe("Alice prefers tea over coffee");
    expect(aliceFacts[0].participants).toContain("alice");

    const bobFacts = await memory.getUserFacts({ participant: "bob" });
    expect(bobFacts.length).toBeGreaterThan(0);
    expect(bobFacts[0].description).toBe("Bob prefers coffee over tea");
    await memory.close();
  });

  test("filters by topic", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("loves jazz"))
          return {
            participants: ["alice"],
            topics: ["music", "preferences"],
            description: "Alice loves jazz",
          };
        if (text.includes("lives in tokyo"))
          return {
            participants: ["alice"],
            topics: ["location"],
            description: "Alice lives in Tokyo",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });

    await memory.recordEvents([
      { at: Date.now() - 2000, actor: "u", content: { kind: "message", text: "alice loves jazz" } },
      {
        at: Date.now() - 1000,
        actor: "u",
        content: { kind: "message", text: "alice lives in tokyo" },
      },
    ]).nodes;
    await memory.evolve();

    const musicFacts = await memory.getUserFacts({ participant: "alice", topic: "music" });
    expect(musicFacts.length).toBe(1);
    expect(musicFacts[0].description).toBe("Alice loves jazz");

    const locationFacts = await memory.getUserFacts({ participant: "alice", topic: "location" });
    expect(locationFacts.length).toBe(1);
    expect(locationFacts[0].description).toBe("Alice lives in Tokyo");
    await memory.close();
  });

  test("excludes superseded state events", async () => {
    let firstId: string;
    const identifier = new ScriptedIdentifier((text) => {
      if (text.includes("alice prefers tea")) {
        return {
          participants: ["alice"],
          topics: ["preferences"],
          description: "Alice prefers tea",
        };
      }
      if (text.includes("alice prefers coffee now")) {
        return {
          participants: ["alice"],
          topics: ["preferences"],
          description: "Alice prefers coffee",
          supersedesIds: [firstId],
        };
      }
      return null;
    });

    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier,
      evolution: { mode: "manual" },
    });

    await memory.recordEvent({
      at: Date.now() - 1000,
      actor: "u",
      content: { kind: "message", text: "alice prefers tea" },
    }).nodes;
    await memory.evolve();

    const beforeSwitch = await memory.getUserFacts({ participant: "alice" });
    expect(beforeSwitch.length).toBe(1);
    firstId = beforeSwitch[0].id;

    await memory.recordEvent({
      at: Date.now(),
      actor: "u",
      content: { kind: "message", text: "alice prefers coffee now" },
    }).nodes;
    await memory.evolve();

    const facts = await memory.getUserFacts({ participant: "alice" });
    expect(facts.length).toBe(1);
    expect(facts[0].description).toBe("Alice prefers coffee");
    await memory.close();
  });

  test("listUserTopics enumerates topic vocabulary", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("alice loves jazz"))
          return {
            participants: ["alice"],
            topics: ["music"],
            description: "Alice loves jazz",
          };
        if (text.includes("alice lives in tokyo"))
          return {
            participants: ["alice"],
            topics: ["location"],
            description: "Alice lives in Tokyo",
          };
        if (text.includes("alice is a designer"))
          return {
            participants: ["alice"],
            topics: ["role"],
            description: "Alice is a designer",
          };
        return null;
      }),
      evolution: { mode: "manual" },
    });

    await memory.recordEvents([
      { at: Date.now() - 3000, actor: "u", content: { kind: "message", text: "alice loves jazz" } },
      {
        at: Date.now() - 2000,
        actor: "u",
        content: { kind: "message", text: "alice lives in tokyo" },
      },
      {
        at: Date.now() - 1000,
        actor: "u",
        content: { kind: "message", text: "alice is a designer" },
      },
    ]).nodes;
    await memory.evolve();

    const topics = await memory.listUserTopics({ participant: "alice" });
    expect(topics).toEqual(["location", "music", "role"]);
    await memory.close();
  });

  test("userId scoping isolates tenants", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      llm: new StubLLM(),
      identifier: new ScriptedIdentifier((text) => {
        if (text.includes("alice")) {
          return {
            participants: ["alice"],
            topics: ["preferences"],
            description: text,
          };
        }
        return null;
      }),
      evolution: { mode: "manual" },
    });

    await memory.recordEvents([
      {
        at: Date.now() - 2000,
        userId: "tenant-1",
        actor: "u",
        content: { kind: "message", text: "alice likes red" },
      },
      {
        at: Date.now() - 1000,
        userId: "tenant-2",
        actor: "u",
        content: { kind: "message", text: "alice likes blue" },
      },
    ]).nodes;
    await memory.evolve();

    const t1 = await memory.getUserFacts({ userId: "tenant-1", participant: "alice" });
    expect(t1.length).toBe(1);
    expect(t1[0].description).toBe("alice likes red");

    const t2 = await memory.getUserFacts({ userId: "tenant-2", participant: "alice" });
    expect(t2.length).toBe(1);
    expect(t2[0].description).toBe("alice likes blue");
    await memory.close();
  });

  test("getUserFacts returns empty when no identifier wired", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      evolution: { mode: "manual" },
    });
    await memory.recordEvent({
      at: Date.now(),
      actor: "u",
      content: { kind: "message", text: "alice prefers tea" },
    }).nodes;
    await memory.evolve();
    const facts = await memory.getUserFacts({ participant: "alice" });
    expect(facts).toEqual([]);
    await memory.close();
  });
});
