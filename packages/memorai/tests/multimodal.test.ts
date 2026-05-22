import { describe, expect, test } from "vitest";
import { MultimodalExtractor, WrapExtractor } from "../src/index.js";

describe("MultimodalExtractor", () => {
  test("passes through text-only events unchanged", async () => {
    const extractor = new MultimodalExtractor();
    const payloads = await extractor.extract(
      { actor: "user", content: { kind: "message", text: "hello" } },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(payloads.length).toBe(1);
    expect(payloads[0].raw.text).toBe("hello");
  });

  test("captions image and merges into payload", async () => {
    const extractor = new MultimodalExtractor({
      captionImage: async () => "a red apple on a table",
    });
    const payloads = await extractor.extract(
      { actor: "user", content: { kind: "image", image: "http://example.com/img.jpg" } },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(payloads[0].raw.text).toContain("red apple");
    expect(payloads[0].annotations?.summary).toContain("red apple");
  });

  test("does not caption if caption already present", async () => {
    let called = false;
    const extractor = new MultimodalExtractor({
      captionImage: async () => {
        called = true;
        return "override";
      },
    });
    const payloads = await extractor.extract(
      { actor: "user", content: { kind: "image", image: "x.jpg", caption: "existing" } },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(called).toBe(false);
    expect(payloads[0].raw.text).toBe("existing");
  });

  test("transcribes audio and merges into payload", async () => {
    const extractor = new MultimodalExtractor({
      transcribeAudio: async () => "hello world",
    });
    const payloads = await extractor.extract(
      { actor: "user", content: { kind: "audio", audio: "http://example.com/audio.mp3" } },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(payloads[0].raw.text).toContain("hello world");
  });

  test("video: captions frames + transcribes audio", async () => {
    const captions: string[] = [];
    const extractor = new MultimodalExtractor({
      captionImage: async (img) => {
        const label = typeof img === "string" ? img : "frame";
        captions.push(label);
        return `scene: ${label}`;
      },
      transcribeAudio: async () => "dialogue here",
    });
    const payloads = await extractor.extract(
      {
        actor: "user",
        content: {
          kind: "video",
          video: "http://example.com/vid.mp4",
          frames: ["frame1.jpg", "frame2.jpg"] as any,
        },
      },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(captions).toEqual(["frame1.jpg", "frame2.jpg"]);
    expect(payloads[0].raw.text).toContain("scene: frame1.jpg");
    expect(payloads[0].raw.text).toContain("scene: frame2.jpg");
    expect(payloads[0].raw.text).toContain("dialogue here");
  });

  test("wraps base extractor and merges captions on top", async () => {
    const base = new WrapExtractor();
    const extractor = new MultimodalExtractor({
      base,
      captionImage: async () => "caption",
    });
    const payloads = await extractor.extract(
      { actor: "user", content: { kind: "image", image: "x.jpg" } },
      { recent: [], embedding: { dimension: 4, embed: async () => [0, 0, 0, 0] }, now: () => 0 },
    );
    expect(payloads.length).toBe(1);
    expect(payloads[0].raw.text).toContain("caption");
  });
});
