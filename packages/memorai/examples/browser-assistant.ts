/**
 * Example: Browser AI Assistant with Memorai
 *
 * This example shows how to use memorai in a browser extension
 * to build a session memory system for an AI assistant.
 *
 * The assistant remembers what pages the user visited,
 * what they clicked, and what they typed — across sessions.
 */

import { IndexedDBAdapter, Memorai, OpenAIEmbeddingService } from "memorai";

// ─── 1. Initialize ───

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: "browser-assistant" }),
  embedding: new OpenAIEmbeddingService({
    apiKey: "your-openai-key",
    model: "text-embedding-3-small",
  }),
  agentProfile: {
    agentId: "browser-assistant",
    role: "reasoning",
    writePolicy: {
      levels: ["segment", "atomic_action", "episode"],
      modalities: ["text", "vision"],
      salienceBoost: 1,
    },
    readPolicy: {
      defaultLevel: "episode",
      defaultTraversal: "reverse",
      timeHorizonMs: 7 * 24 * 60 * 60 * 1000, // 1 week
    },
  },
});

// ─── 2. Record page visits ───

function recordPageVisit(url: string, title: string, screenshot?: ImageData) {
  if (screenshot) {
    memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "image", image: screenshot, caption: `${title} — ${url}` },
      tags: ["page-visit", ...extractDomainTags(url)],
      salienceHint: 0.6,
    });
  } else {
    memory.recordEvent({
      at: Date.now(),
      actor: "user",
      content: { kind: "observation", text: `Visited page: ${title} (${url})` },
      tags: ["page-visit", ...extractDomainTags(url)],
      salienceHint: 0.6,
    });
  }
}

// ─── 3. Record user actions ───

function recordClick(elementText: string, context: string) {
  memory.recordEvent({
    at: Date.now(),
    actor: "user",
    content: { kind: "observation", text: `Clicked: ${elementText} — ${context}` },
    tags: ["click", "interaction"],
    salienceHint: 0.5,
  });
}

// ─── 4. Ask the assistant ───

async function ask(question: string) {
  const result = await memory.recall(question, { topK: 10 });

  const context = result.memories
    .map((m) => `[${new Date(m.at).toISOString()}] ${m.summary}`)
    .join("\n");

  return {
    answer: `Based on your recent activity...`, // LLM call here
    context,
    sources: result.memories,
  };
}

// ─── 5. Ask about recent activity ───

async function summarizeToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await memory.recallByTime(
    { start: today.getTime(), end: Date.now() },
    { traversalOrder: "forward", topK: 20 },
  );

  return result.memories.map((m) => m.summary);
}

// ─── Helpers ───

function extractDomainTags(url: string): string[] {
  try {
    const host = new URL(url).hostname;
    return [host.replace(/^www\./, "")];
  } catch {
    return [];
  }
}

// ─── Usage ───

async function main() {
  recordPageVisit(
    "https://github.com/Naeemo/memorai",
    "Naeemo/memorai: Streaming memory for AI agents",
  );

  recordClick("README.md", "Navigated to README in the memorai repo");

  const summary = await summarizeToday();
  console.log("Today you:", summary.join("; "));

  const { context } = await ask("What repos did I look at today?");
  console.log("Context for LLM:", context);

  await memory.close();
}

main().catch(console.error);
