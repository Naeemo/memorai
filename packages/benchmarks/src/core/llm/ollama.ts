interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

interface OllamaEmbedResponse {
  embedding: number[];
}

export const OLLAMA_BASE: string =
  process.env.OLLAMA_HOST ?? "http://localhost:11434";

export async function ollamaGenerate(
  prompt: string,
  model = "gemma4:31b-cloud",
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: opts?.temperature ?? 0.1,
        num_predict: opts?.maxTokens ?? 256,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama generate failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  return data.response.trim();
}

export async function ollamaEmbed(
  text: string,
  model = "nomic-embed-text",
): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama embed failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as OllamaEmbedResponse;
  return data.embedding;
}

// LLM-as-a-judge (relevance, 0–1). Used by the *custom* synthetic suite. The
// public benchmarks use the binary correctness judge in ./judge.ts.
export async function judgeRelevance(
  query: string,
  retrieved: string,
  expected: string,
  model = "gemma4:31b-cloud",
): Promise<number> {
  const prompt = `You are an expert evaluator. Rate how well the RETRIEVED text answers the QUERY, compared to the EXPECTED answer.

QUERY: ${query}
EXPECTED: ${expected}
RETRIEVED: ${retrieved}

Rate on a scale of 0-10 where:
- 0 = completely irrelevant
- 5 = partially correct but missing key details
- 10 = fully correct with all key details

Respond with ONLY a single number (0-10). No explanation.`;

  const raw = await ollamaGenerate(prompt, model, {
    temperature: 0,
    maxTokens: 8,
  });
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const score = Number.parseFloat(match[1]);
  return Math.min(10, Math.max(0, score)) / 10;
}
