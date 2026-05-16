import { describe, expect, it } from "vitest";
import type { EmbeddingService } from "memorai";
import { NaiveRagProvider } from "../src/providers/naive-rag.js";

class FakeEmbedder implements EmbeddingService {
  readonly dimension = 3;
  async embed(text: string): Promise<number[]> {
    // Deterministic 3-d vector keyed off first three char codes.
    const a = text.charCodeAt(0) || 0;
    const b = text.charCodeAt(1) || 0;
    const c = text.charCodeAt(2) || 0;
    const mag = Math.sqrt(a * a + b * b + c * c) || 1;
    return [a / mag, b / mag, c / mag];
  }
}

describe("NaiveRagProvider", () => {
  it("ingests turns and retrieves by cosine similarity", async () => {
    const provider = new NaiveRagProvider({
      embedder: "ollama",
      embedderInstance: new FakeEmbedder(),
    });
    await provider.init();

    await provider.ingestTurns(
      [
        { role: "user", content: "alpha bravo" },
        { role: "assistant", content: "charlie delta" },
        { role: "user", content: "echo foxtrot" },
      ],
      { userId: "u1" },
    );

    const hits = await provider.query("alpha bravo", { userId: "u1", topK: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe("alpha bravo");
    expect(hits[0].score).toBeGreaterThan(0.99);
  });

  it("isolates users", async () => {
    const provider = new NaiveRagProvider({
      embedder: "ollama",
      embedderInstance: new FakeEmbedder(),
    });
    await provider.init();

    await provider.ingestTurns(
      [{ role: "user", content: "alpha" }],
      { userId: "u1" },
    );
    await provider.ingestTurns(
      [{ role: "user", content: "bravo" }],
      { userId: "u2" },
    );

    const u1Hits = await provider.query("alpha", { userId: "u1", topK: 5 });
    const u2Hits = await provider.query("alpha", { userId: "u2", topK: 5 });
    expect(u1Hits).toHaveLength(1);
    expect(u2Hits).toHaveLength(1);
    expect(u1Hits[0].content).not.toBe(u2Hits[0].content);
  });

  it("resetUser clears the store", async () => {
    const provider = new NaiveRagProvider({
      embedder: "ollama",
      embedderInstance: new FakeEmbedder(),
    });
    await provider.init();

    await provider.ingestTurns(
      [{ role: "user", content: "alpha" }],
      { userId: "u1" },
    );
    await provider.resetUser("u1");
    const hits = await provider.query("alpha", { userId: "u1", topK: 5 });
    expect(hits).toHaveLength(0);
  });
});
