import { hasOpenAIKey, openaiChat } from "./openai.js";
import { ollamaGenerate } from "./ollama.js";

export interface LLMBackend {
  provider: "openai" | "ollama";
  model: string;
}

// Defaults — keep answerer and judge in *different families* so the judge
// doesn't self-favour the answerer's outputs.
//
//   answerer (predicts the answer):  gemma4:31b-cloud   (Google Gemma)
//   judge    (grades CORRECT/INCORRECT): qwen3-coder-next:cloud  (Alibaba Qwen)
//
// Both are Ollama-cloud free tier accessible. Override via JUDGE_MODEL /
// ANSWERER_MODEL env vars or `--judge-model` / `--answerer-model` CLI flags.

const DEFAULT_OLLAMA_ANSWERER = "gemma4:31b-cloud";
const DEFAULT_OLLAMA_JUDGE = "qwen3-coder-next:cloud";

export function pickJudgeBackend(override?: string): LLMBackend {
  if (hasOpenAIKey()) {
    return {
      provider: "openai",
      model: override ?? process.env.JUDGE_MODEL ?? "gpt-4o-mini",
    };
  }
  return {
    provider: "ollama",
    model: override ?? process.env.JUDGE_MODEL ?? DEFAULT_OLLAMA_JUDGE,
  };
}

export function pickAnswererBackend(override?: string): LLMBackend {
  if (hasOpenAIKey()) {
    return {
      provider: "openai",
      model: override ?? process.env.ANSWERER_MODEL ?? "gpt-4o-mini",
    };
  }
  return {
    provider: "ollama",
    model: override ?? process.env.ANSWERER_MODEL ?? DEFAULT_OLLAMA_ANSWERER,
  };
}

export async function backendComplete(
  backend: LLMBackend,
  systemPrompt: string,
  userPrompt: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  if (backend.provider === "openai") {
    return openaiChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      backend.model,
      opts,
    );
  }
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return ollamaGenerate(combined, backend.model, opts);
}
