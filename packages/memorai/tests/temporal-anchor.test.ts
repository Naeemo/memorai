import { describe, expect, test } from "vitest";
import {
  LLMExtractor,
  Memorai,
  MemoryAdapter,
  RetrievalEngine,
  WrapExtractor,
  extractTemporalAnchors,
  type EmbeddingService,
  type Event,
  type LLMService,
  type MemoryNode,
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

function makeEvent(text: string, actor = "alice", at?: number): Event {
  return {
    actor,
    at: at ?? Date.now(),
    content: { kind: "message" as const, text },
  };
}

function makeNode(
  id: string,
  timestamp: number,
  text: string,
  opts: {
    tags?: string[];
    salienceScore?: number;
    embedding?: number[];
    temporalAnchors?: NonNullable<MemoryNode["annotations"]["temporalAnchors"]>;
  } = {},
): MemoryNode {
  return {
    id,
    timestamp,
    duration: 0,
    level: "segment",
    raw: { content: { kind: "message", text } },
    annotations: {
      tags: opts.tags ?? [],
      salienceScore: opts.salienceScore ?? 0.5,
      modality: ["text"],
      ...(opts.embedding ? { embedding: opts.embedding } : {}),
      ...(opts.temporalAnchors ? { temporalAnchors: opts.temporalAnchors } : {}),
    },
    meta: { sourceAgent: "test", agentRole: "reasoning", accessCount: 0 },
  };
}

describe("extractTemporalAnchors", () => {
  test("extracts 'before the migration'", () => {
    const anchors = extractTemporalAnchors("We need to finish testing before the migration");
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    expect(anchors.some((a) => a.name === "migration")).toBe(true);
  });

  test("extracts 'the Q3 review' as milestone", () => {
    const anchors = extractTemporalAnchors("The team discussed the Q3 review yesterday");
    const review = anchors.find((a) => a.name.includes("review"));
    expect(review).toBeDefined();
    expect(review?.type).toBe("range");
  });

  test("returns empty array for plain text", () => {
    const anchors = extractTemporalAnchors("Hello world, nothing special here");
    expect(anchors).toHaveLength(0);
  });
});

describe("LLMExtractor — temporal anchors", () => {
  test("parses temporal anchors from LLM JSON output", async () => {
    const llm: LLMService = {
      complete: async () =>
        JSON.stringify({
          summary: "Project migration scheduled",
          tags: ["migration", "project"],
          salience: 0.8,
          temporalAnchors: [
            { name: "the-migration", type: "milestone", label: "the migration", confidence: 0.9 },
          ],
        }),
    };

    const extractor = new LLMExtractor({ llm });
    const event = makeEvent("We are planning the migration for next week");
    const ctx = {
      recent: [],
      embedding: new MockEmbeddingService(),
      llm,
      now: () => Date.now(),
    };
    const payloads = await extractor.extract(event, ctx);
    expect(payloads[0].annotations?.temporalAnchors).toBeDefined();
    expect(payloads[0].annotations?.temporalAnchors?.[0].name).toBe("the-migration");
  });
});

describe("MemoryAdapter — queryByTemporalAnchor", () => {
  test("finds nodes by anchor name", async () => {
    const adapter = new MemoryAdapter();
    const node = makeNode("n1", Date.now(), "test", {
      tags: ["migration"],
      salienceScore: 0.8,
      temporalAnchors: [
        { name: "the-migration", type: "milestone", label: "the migration", confidence: 0.9 },
      ],
    });
    await adapter.put(node);

    const found = await adapter.queryByTemporalAnchor("the-migration");
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe("n1");

    const notFound = await adapter.queryByTemporalAnchor("nonexistent");
    expect(notFound).toHaveLength(0);
  });

  test("case-insensitive anchor lookup", async () => {
    const adapter = new MemoryAdapter();
    const node = makeNode("n1", Date.now(), "test", {
      temporalAnchors: [
        { name: "the-migration", type: "milestone", label: "the migration", confidence: 0.9 },
      ],
    });
    await adapter.put(node);

    const found = await adapter.queryByTemporalAnchor("THE-MIGRATION");
    expect(found).toHaveLength(1);
  });
});

describe("RetrievalEngine — temporalAnchorPathway", () => {
  test("surfaces nodes with matching temporal anchors", async () => {
    const adapter = new MemoryAdapter();
    const engine = new RetrievalEngine(adapter);
    const now = Date.now();

    const nodes = [
      makeNode("n1", now - 86400000, "migration planning", {
        tags: ["migration"],
        salienceScore: 0.9,
        embedding: [1, 0, 0, 0],
        temporalAnchors: [
          { name: "the-migration", type: "milestone", label: "the migration", confidence: 0.9 },
        ],
      }),
      makeNode("n2", now - 3600000, "regular update", {
        tags: ["update"],
        salienceScore: 0.5,
        embedding: [0, 1, 0, 0],
      }),
    ];
    await adapter.batchPut(nodes);

    const result = await engine.retrieve({
      strategy: "factual",
      text: "what happened before the migration?",
      topK: 5,
    });

    const n1Hit = result.nodes.find((n) => n.id === "n1");
    expect(n1Hit).toBeDefined();
  });
});

describe("Memorai — end-to-end temporal anchor recall", () => {
  test("recalls events relative to a temporal anchor", async () => {
    const adapter = new MemoryAdapter();
    const memory = new Memorai({
      storage: adapter,
      embedding: new MockEmbeddingService(),
      extractor: new WrapExtractor(),
    });

    const now = Date.now();
    await memory.write({
      timestamp: now - 86400000 * 2,
      raw: {
        content: { kind: "message", text: "We finished the database schema" },
        text: "We finished the database schema",
      },
      annotations: {
        tags: ["schema"],
        salienceScore: 0.7,
        modality: ["text"],
        temporalAnchors: [
          { name: "schema-work", type: "milestone", label: "database schema work", confidence: 0.8 },
        ],
      },
    });

    await memory.write({
      timestamp: now - 86400000,
      raw: {
        content: { kind: "message", text: "The migration started today" },
        text: "The migration started today",
      },
      annotations: {
        tags: ["migration"],
        salienceScore: 0.9,
        modality: ["text"],
        temporalAnchors: [
          { name: "migration", type: "milestone", label: "the migration", confidence: 0.95 },
        ],
      },
    });

    const result = await memory.recall("what happened before the migration?", {
      resolveTime: true,
      topK: 5,
    });

    expect(result.memories.length).toBeGreaterThan(0);
    const schemaHit = result.memories.find((m) => m.summary?.includes("schema"));
    expect(schemaHit).toBeDefined();

    await memory.close();
  });
});
