import {
  TransformersReranker,
  loadXenovaCrossEncoder,
  type CrossEncoderScoreFn,
} from "../src/index.js";

describe("TransformersReranker", () => {
  test("ranks docs by scorer output, returns topK", async () => {
    const score: CrossEncoderScoreFn = async (pairs) =>
      pairs.map(({ doc }) => (doc.includes("relevant") ? 0.9 : 0.1));

    const reranker = new TransformersReranker({ score });
    const docs = [
      { id: "a", text: "totally unrelated" },
      { id: "b", text: "this is the relevant one" },
      { id: "c", text: "also unrelated" },
    ];
    const result = await reranker.rerank("anything", docs, 2);
    expect(result.map((r) => r.id)).toEqual(["b", "a"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  test("returns empty list for empty input", async () => {
    const reranker = new TransformersReranker({
      score: async () => [],
    });
    expect(await reranker.rerank("q", [], 5)).toEqual([]);
  });

  test("truncates doc text to snippetChars before scoring", async () => {
    let observedDoc = "";
    const score: CrossEncoderScoreFn = async (pairs) => {
      observedDoc = pairs[0].doc;
      return pairs.map(() => 0.5);
    };
    const reranker = new TransformersReranker({ score, snippetChars: 10 });
    await reranker.rerank("query", [{ id: "a", text: "x".repeat(100) }], 5);
    expect(observedDoc.length).toBeLessThanOrEqual(10);
  });

  test("respects maxDocs cap", async () => {
    let pairsSeen = 0;
    const score: CrossEncoderScoreFn = async (pairs) => {
      pairsSeen += pairs.length;
      return pairs.map(() => 0.5);
    };
    const reranker = new TransformersReranker({ score, maxDocs: 3, batchSize: 10 });
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, text: `doc ${i}` }));
    await reranker.rerank("q", docs, 5);
    expect(pairsSeen).toBe(3);
  });

  test("batches large doc lists", async () => {
    let batchCount = 0;
    const score: CrossEncoderScoreFn = async (pairs) => {
      batchCount += 1;
      return pairs.map(() => 0.5);
    };
    const reranker = new TransformersReranker({ score, maxDocs: 30, batchSize: 4 });
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, text: `doc ${i}` }));
    await reranker.rerank("q", docs, 5);
    expect(batchCount).toBe(3); // ceil(10 / 4)
  });

  test("scorer failure → zero scores, doesn't throw", async () => {
    const score: CrossEncoderScoreFn = async () => {
      throw new Error("boom");
    };
    const reranker = new TransformersReranker({ score });
    const result = await reranker.rerank("q", [{ id: "a", text: "x" }], 5);
    expect(result.map((r) => r.score)).toEqual([0]);
  });

  test("respects topK in the returned slice", async () => {
    const score: CrossEncoderScoreFn = async (pairs) => pairs.map(() => Math.random());
    const reranker = new TransformersReranker({ score });
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, text: `${i}` }));
    const result = await reranker.rerank("q", docs, 3);
    expect(result).toHaveLength(3);
  });
});

describe("loadXenovaCrossEncoder", () => {
  test("throws a helpful error when @xenova/transformers isn't installed", async () => {
    // We don't ship the package; the dynamic import should fail with a
    // clear message rather than crashing somewhere downstream.
    await expect(loadXenovaCrossEncoder("nonexistent-model")).rejects.toThrow(
      /@xenova\/transformers/,
    );
  });
});
