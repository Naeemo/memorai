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

/**
 * Some endpoints expose reasoning models that:
 *   - reject any `temperature` other than their built-in default
 *   - burn a large chunk of `max_tokens` on internal chain-of-thought
 *     before emitting the final answer
 *
 * Callers need to know about both so they can drop the temperature and
 * provision a larger token budget (4k+ instead of 256). Detected by name
 * prefix; covers Moonshot's `kimi-k2.6` / `kimi-k2.5` / `kimi-k2-thinking`
 * and OpenAI's o-series.
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^kimi-k2\.\d/.test(m) ||
    m.startsWith("kimi-k2-thinking") ||
    /^o1(-|$)/.test(m) ||
    /^o3(-|$)/.test(m)
  );
}

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

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts?.maxTokens ?? 256,
  };
  if (!isReasoningModel(model)) {
    body.temperature = opts?.temperature ?? 0;
  }
  const payload = JSON.stringify(body);

  // Retry on transient 5xx + network failures (same shape as
  // ollamaGenerate). Cloud endpoints sporadically drop reads or
  // gateway-time-out under sustained load; one transient failure
  // shouldn't take down a multi-hour benchmark.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoffMs = 4000 * Math.pow(4, attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    try {
      const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: payload,
      });

      if (!response.ok) {
        const text = await response.text();
        const transient = response.status >= 500 && response.status < 600;
        const err = new Error(`OpenAI chat failed: ${response.status} ${text}`);
        if (!transient) throw err;
        lastErr = err;
        continue;
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return data.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      // 4xx errors are caller bugs — don't retry. Otherwise (5xx, network
      // failures like ECONNRESET / fetch failed / read timeout): retry.
      if (/4\d\d/.test(message) && !/5\d\d/.test(message)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
