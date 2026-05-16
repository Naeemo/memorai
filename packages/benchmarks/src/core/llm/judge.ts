import { backendComplete, type LLMBackend } from "./pick.js";

const JUDGE_SYSTEM =
  "You are a strict grader. A prediction is CORRECT iff it conveys the same answer as the gold. Reply with exactly one token: CORRECT or INCORRECT.";

export type JudgeLabel = "CORRECT" | "INCORRECT";

export async function judgeBinary(
  backend: LLMBackend,
  question: string,
  gold: string,
  prediction: string,
): Promise<JudgeLabel> {
  const user = `QUESTION: ${question}\nGOLD: ${gold}\nPREDICTION: ${prediction}`;
  // maxTokens=256 — non-thinking judges (Gemma, Qwen) emit "CORRECT" / "INCORRECT"
  // and stop; thinking judges (GLM, MiniMax, Nemotron) burn budget on internal
  // reasoning before producing the final token, and silently emit empty output
  // below ~128 tokens. 256 is a safe upper bound for both modes.
  const raw = await backendComplete(backend, JUDGE_SYSTEM, user, {
    temperature: 0,
    maxTokens: 256,
  });
  return parseJudgeLabel(raw);
}

export function parseJudgeLabel(raw: string): JudgeLabel {
  const upper = raw.trim().toUpperCase();
  if (upper.startsWith("CORRECT")) return "CORRECT";
  if (upper.startsWith("INCORRECT")) return "INCORRECT";
  // Fallback: look for the first token-like word
  if (upper.includes("INCORRECT")) return "INCORRECT";
  if (upper.includes("CORRECT")) return "CORRECT";
  return "INCORRECT";
}
