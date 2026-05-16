import { describe, expect, it } from "vitest";
import { parseJudgeLabel } from "../src/core/llm/judge.js";

describe("parseJudgeLabel", () => {
  it("parses bare CORRECT", () => {
    expect(parseJudgeLabel("CORRECT")).toBe("CORRECT");
  });
  it("parses bare INCORRECT", () => {
    expect(parseJudgeLabel("INCORRECT")).toBe("INCORRECT");
  });
  it("handles lowercase + whitespace", () => {
    expect(parseJudgeLabel("  correct  ")).toBe("CORRECT");
    expect(parseJudgeLabel("  incorrect  ")).toBe("INCORRECT");
  });
  it("handles trailing punctuation", () => {
    expect(parseJudgeLabel("CORRECT.")).toBe("CORRECT");
  });
  it("INCORRECT beats CORRECT when both present (e.g. 'INCORRECT, not CORRECT')", () => {
    expect(parseJudgeLabel("INCORRECT, not CORRECT")).toBe("INCORRECT");
  });
  it("defaults to INCORRECT on garbage", () => {
    expect(parseJudgeLabel("¯\\_(ツ)_/¯")).toBe("INCORRECT");
  });
});
