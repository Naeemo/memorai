import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLoCoMoItem } from "../src/benchmarks/locomo/dataset.js";
import { normalizeLongMemEvalItem } from "../src/benchmarks/longmemeval/dataset.js";
import { loadLoCoMo } from "../src/benchmarks/locomo/dataset.js";

describe("LoCoMo loader", () => {
  it("normalizes a single item with multiple sessions", () => {
    const conv = normalizeLoCoMoItem({
      sample_id: "s1",
      conversation: {
        speaker_a: "Alice",
        speaker_b: "Bob",
        session_1: [
          { speaker: "Alice", dia_id: "D1:1", text: "hello bob" },
          { speaker: "Bob", dia_id: "D1:2", text: "hi alice" },
        ],
        session_2: [
          { speaker: "Alice", dia_id: "D2:1", text: "are you free tomorrow?" },
        ],
      },
      qa: [
        { question: "who greeted first?", answer: "Alice", evidence: ["D1:1"], category: 1 },
        { question: "when did Alice ask about meeting?", answer: "session 2", evidence: ["D2:1"], category: 2 },
      ],
    });
    expect(conv.id).toBe("s1");
    expect(conv.sessions).toHaveLength(2);
    expect(conv.sessions[0]).toHaveLength(2);
    expect(conv.sessions[0][0].role).toBe("user");
    expect(conv.sessions[0][1].role).toBe("assistant");
    expect(conv.qas).toHaveLength(2);
    expect(conv.qas[0].category).toBe("single_hop");
    expect(conv.qas[1].category).toBe("temporal");
  });

  it("sorts sessions by numeric index, not lex", () => {
    const conv = normalizeLoCoMoItem({
      sample_id: "s2",
      conversation: {
        speaker_a: "A",
        speaker_b: "B",
        session_10: [{ speaker: "A", dia_id: "x", text: "tenth" }],
        session_2: [{ speaker: "A", dia_id: "y", text: "second" }],
        session_1: [{ speaker: "A", dia_id: "z", text: "first" }],
      },
      qa: [],
    });
    expect(conv.sessions.map((s) => s[0].content)).toEqual(["first", "second", "tenth"]);
  });

  it("loads from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-locomo-"));
    const file = join(dir, "locomo.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          sample_id: "x",
          conversation: { speaker_a: "A", speaker_b: "B", session_1: [{ speaker: "A", dia_id: "d", text: "hi" }] },
          qa: [{ question: "?", answer: "yes", evidence: [], category: 1 }],
        },
      ]),
    );
    const convs = await loadLoCoMo(file);
    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe("x");
    await rm(dir, { recursive: true });
  });
});

describe("LongMemEval loader", () => {
  it("normalizes an item with date-anchored timestamps", () => {
    const conv = normalizeLongMemEvalItem({
      question_id: "q1",
      question: "what color did the user choose?",
      answer: "blue",
      question_type: "single-session-user",
      haystack_dates: ["2024-01-01", "2024-01-02"],
      haystack_sessions: [
        [{ role: "user", content: "I picked blue" }, { role: "assistant", content: "noted" }],
        [{ role: "user", content: "unrelated chatter" }],
      ],
    });
    expect(conv.qas).toHaveLength(1);
    expect(conv.qas[0].category).toBe("single-session-user");
    expect(conv.sessions).toHaveLength(2);
    expect(conv.sessions[0][0].timestampMs).toBeGreaterThan(0);
    expect(conv.sessions[1][0].timestampMs).toBeGreaterThan(
      conv.sessions[0][0].timestampMs ?? 0,
    );
  });

  it("handles missing dates", () => {
    const conv = normalizeLongMemEvalItem({
      question_id: "q2",
      question: "?",
      answer: "a",
      question_type: "x",
      haystack_dates: [],
      haystack_sessions: [[{ role: "user", content: "hi" }]],
    });
    expect(conv.sessions[0][0].timestampMs).toBeUndefined();
  });
});
