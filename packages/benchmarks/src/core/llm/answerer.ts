import { backendComplete, type LLMBackend } from "./pick.js";
import type { MemoryHit } from "../provider.js";

const ANSWERER_SYSTEM =
  "You are answering a question based only on memories from prior conversation. Answer in one sentence. If the memories don't contain the answer, reply exactly: I don't know.";

const MAX_HIT_CHARS = 24000;

export async function generateAnswer(
  backend: LLMBackend,
  question: string,
  hits: MemoryHit[],
): Promise<string> {
  let budget = MAX_HIT_CHARS;
  const lines: string[] = [];
  for (const [i, h] of hits.entries()) {
    const ts = h.timestampMs
      ? new Date(h.timestampMs).toISOString().slice(0, 10)
      : "";
    const prefix = `${i + 1}. ${ts ? `[t=${ts}] ` : ""}`;
    const remaining = budget - prefix.length;
    if (remaining <= 0) break;
    const body = h.content.length > remaining ? h.content.slice(0, remaining) : h.content;
    lines.push(`${prefix}${body}`);
    budget -= prefix.length + body.length + 1;
  }

  const user = `MEMORIES (most relevant first):\n${lines.join("\n")}\n\nQUESTION: ${question}`;
  return backendComplete(backend, ANSWERER_SYSTEM, user, {
    temperature: 0,
    maxTokens: 256,
  });
}
