interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

const OPENAI_BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

export function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function openaiChat(
  messages: ChatMessage[],
  model = "gpt-4o-mini",
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0,
      max_tokens: opts?.maxTokens ?? 256,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI chat failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return data.choices[0]?.message?.content?.trim() ?? "";
}

export async function openaiEmbed(
  text: string,
  model = "text-embedding-3-small",
): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!response.ok) {
    const t = await response.text();
    throw new Error(`OpenAI embed failed: ${response.status} ${t}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  return data.data[0]?.embedding ?? [];
}
