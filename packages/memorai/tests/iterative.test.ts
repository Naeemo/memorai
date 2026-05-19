import {
  LightExtractor,
  Memorai,
  MemoryAdapter,
  type EmbeddingService,
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

/**
 * Scripted LLM that returns predetermined responses per call. Lets us
 * drive the judge through specific verdict sequences deterministically.
 */
class ScriptedLLM implements LLMService {
  private call = 0;
  constructor(private readonly responses: string[]) {}
  complete(): Promise<string> {
    return Promise.resolve(this.responses[this.call++] ?? "");
  }
}

async function seedTwoFacts(memory: Memorai): Promise<void> {
  await memory.recordEvents([
    {
      at: Date.now() - 2000,
      actor: "user",
      content: { kind: "observation", text: "alice likes chocolate cake" },
    },
    {
      at: Date.now() - 1000,
      actor: "user",
      content: { kind: "observation", text: "bob prefers vanilla ice cream" },
    },
  ]).nodes;
}

describe("Memorai.iterativeRecall", () => {
  test("stops at iteration 1 when judge returns SUFFICIENT", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM(["SUFFICIENT"]),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("what desserts do people like?", { topK: 5 });
    expect(result.iterations).toBe(1);
    expect(result.steps[0].judgment).toBe("sufficient");
    expect(result.memories.length).toBeGreaterThan(0);
    await memory.close();
  });

  test("runs a second pass when judge requests more, then stops", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM(["NEEDS: bob desserts", "SUFFICIENT"]),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("what desserts do people like?", { topK: 5 });
    expect(result.iterations).toBe(2);
    expect(result.steps[0].judgment).toBe("insufficient");
    expect(result.steps[1].judgment).toBe("sufficient");
    expect(result.steps[0].query).toBe("what desserts do people like?");
    expect(result.steps[1].query).toBe("bob desserts");
    await memory.close();
  });

  test("hits max_iterations when judge never says SUFFICIENT", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM([
        "NEEDS: variant query 1",
        "NEEDS: variant query 2",
        "NEEDS: variant query 3",
      ]),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("question", { topK: 5, maxIterations: 3 });
    expect(result.iterations).toBe(3);
    expect(result.steps[result.steps.length - 1].judgment).toBe("max_iterations");
    await memory.close();
  });

  test("stops with no_progress when LLM rewrites to a query we've already tried", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM(["NEEDS: same again", "NEEDS: same again"]),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    // Iteration 1 query = "question", judge says NEEDS: "same again".
    // Iteration 2 query = "same again", judge says NEEDS: "same again" (already used).
    const result = await memory.iterativeRecall("question", { topK: 5, maxIterations: 5 });
    const last = result.steps[result.steps.length - 1];
    expect(last.judgment).toBe("no_progress");
    await memory.close();
  });

  test("stops with judge_error when LLM throws", async () => {
    const throwingLlm: LLMService = {
      complete: () => Promise.reject(new Error("llm down")),
    };
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: throwingLlm,
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("question", { topK: 5 });
    expect(result.iterations).toBe(1);
    expect(result.steps[0].judgment).toBe("judge_error");
    await memory.close();
  });

  test("falls back to single-pass recall when no LLM is configured", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("desserts", { topK: 5 });
    expect(result.iterations).toBe(1);
    expect(result.steps[0].judgment).toBe("no_llm");
    expect(result.memories.length).toBeGreaterThan(0);
    await memory.close();
  });

  test("dedupes memories across iterations and tags provenance with iter:N", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM(["NEEDS: alice chocolate", "SUFFICIENT"]),
      evolution: { mode: "manual" },
    });
    await seedTwoFacts(memory);

    const result = await memory.iterativeRecall("dessert preferences", { topK: 5 });
    // Memories should be unique by id.
    const ids = result.memories.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // At least one memory should carry the iter:1 provenance tag.
    const tagged = result.memories.some((m) =>
      m.provenance?.pathways.some((p) => p.startsWith("iter:")),
    );
    expect(tagged).toBe(true);
    await memory.close();
  });

  test("memories are sorted by score and capped at topK", async () => {
    const memory = new Memorai({
      storage: new MemoryAdapter(),
      embedding: new MockEmbeddingService(),
      extractor: new LightExtractor(),
      llm: new ScriptedLLM(["SUFFICIENT"]),
      evolution: { mode: "manual" },
    });
    await memory.recordEvents(
      Array.from({ length: 8 }, (_, i) => ({
        at: Date.now() - (8 - i) * 1000,
        actor: "user",
        content: { kind: "observation" as const, text: `fact number ${i}` },
      })),
    ).nodes;

    const result = await memory.iterativeRecall("fact", { topK: 3 });
    expect(result.memories.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].score).toBeGreaterThanOrEqual(result.memories[i].score);
    }
    await memory.close();
  });
});
