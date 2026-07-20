/**
 * Ollama smoke test for Memorai.
 *
 * Requirements:
 *   - Ollama running locally (default http://localhost:11434)
 *   - `nomic-embed-text` pulled for embeddings
 *   - An LLM model pulled for extraction/identification (local: `gemma4:e2b`,
 *     or any `:cloud` model if signed in)
 *
 * Run:
 *   npx tsx packages/memorai/examples/ollama-smoke.ts
 */

import { Memorai } from "../src/index.js";
import { MemoryAdapter } from "../src/storage/memory.js";
import { OllamaEmbeddingService } from "../src/embeddings/ollama.js";
import { InMemoryEntityGraph } from "../src/graph/in-memory.js";
import type { LLMService, LLMCompletionOptions } from "../src/types.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_LLM_MODEL = process.env.OLLAMA_LLM_MODEL ?? "gemma4:e2b";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

class OllamaLLMService implements LLMService {
  constructor(
    private readonly model: string,
    private readonly baseURL: string,
  ) {}

  async complete(prompt: string, opts?: LLMCompletionOptions): Promise<string> {
    const response = await fetch(`${this.baseURL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        temperature: opts?.temperature ?? 0,
        options: {
          num_predict: opts?.maxTokens ?? 512,
        },
      }),
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama generate failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }
}

async function checkOllama(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: "GET" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = data.models?.map((m) => m.name) ?? [];
    console.log("Ollama models:", names.join(", "));
    const hasEmbed = names.some((n) => n === OLLAMA_EMBED_MODEL || n.startsWith(`${OLLAMA_EMBED_MODEL}:`));
    if (!hasEmbed) {
      throw new Error(`Embedding model '${OLLAMA_EMBED_MODEL}' not found. Run: ollama pull ${OLLAMA_EMBED_MODEL}`);
    }
    const hasLlm = names.some((n) => n === OLLAMA_LLM_MODEL || n.startsWith(`${OLLAMA_LLM_MODEL}:`));
    if (!hasLlm) {
      throw new Error(`LLM model '${OLLAMA_LLM_MODEL}' not found. Run: ollama pull ${OLLAMA_LLM_MODEL}`);
    }
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA_BASE_URL}. Is it running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function main() {
  await checkOllama();

  const embedding = new OllamaEmbeddingService({
    baseURL: OLLAMA_BASE_URL,
    model: OLLAMA_EMBED_MODEL,
    dimension: 768,
  });

  const llm = new OllamaLLMService(OLLAMA_LLM_MODEL, OLLAMA_BASE_URL);

  const memory = new Memorai({
    storage: new MemoryAdapter(),
    embedding,
    llm,
    entityGraph: new InMemoryEntityGraph(),
    evolution: { mode: "manual" },
  });

  // Show which ANN backend was auto-selected.
  const vectorIndex = (memory as unknown as { vectorIndex?: { backendName?: string } }).vectorIndex;
  console.log("Vector index backend:", vectorIndex?.backendName ?? "brute-force");

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  console.log("\n[1] Recording events...");
  await memory.recordEvents([
    {
      at: now - 3 * DAY,
      actor: "alice",
      content: { kind: "message", text: "I went to a LGBTQ support group yesterday and it was so powerful." },
    },
    {
      at: now - 2 * DAY,
      actor: "bob",
      content: { kind: "message", text: "Melanie painted a lake sunrise last year, it was beautiful." },
    },
    {
      at: now - 1 * DAY,
      actor: "alice",
      content: { kind: "message", text: "I am keen on counseling or working in mental health to support others." },
    },
    {
      at: now,
      actor: "bob",
      content: { kind: "message", text: "Let's grab lunch tomorrow and discuss the migration." },
    },
  ]).nodes;

  await memory.evolve();

  const allNodes = await memory.list({ topK: 100 });
  console.log(`   Stored ${allNodes.length} memory nodes.`);

  console.log("\n[2] Factual recall: 'What does Alice want to do?'");
  const factual = await memory.recall("What does Alice want to do?", { topK: 3 });
  console.log("Top result:", factual.memories[0]?.summary ?? "(none)");
  console.log("Confidence:", factual.confidence.toFixed(3));

  console.log("\n[3] Temporal recall: 'What did Alice say yesterday?'");
  const temporal = await memory.recall("What did Alice say yesterday?", { topK: 3 });
  console.log("Top result:", temporal.memories[0]?.summary ?? "(none)");
  console.log("Confidence:", temporal.confidence.toFixed(3));

  console.log("\n[4] Explain the temporal recall:");
  const explain = await memory.explain("What did Alice say yesterday?", { topK: 3 });
  console.log("Pathways:", explain.pathways);
  console.log("Spans:", explain.spans.map((s) => `${s.name}: ${(s.endMs - s.startMs).toFixed(1)}ms`).join(", "));

  await memory.close();
  console.log("\nSmoke test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
