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
      levels: ["segment", "atomic_action", "event"],
      modalities: ["text", "vision"],
      salienceBoost: 1,
    },
    readPolicy: {
      defaultLevel: "event",
      defaultTraversal: "reverse",
      timeHorizonMs: 7 * 24 * 60 * 60 * 1000, // 1 week
    },
  },
});

// ─── 2. Record page visits ───

async function recordPageVisit(url: string, title: string, screenshot?: ImageData) {
  await memory.write({
    timestamp: Date.now(),
    payload: {
      summary: `Visited page: ${title}`,
      description: `URL: ${url}`,
      tags: ["page-visit", ...extractDomainTags(url)],
      salienceScore: 0.6,
      modality: screenshot ? ["text", "vision"] : ["text"],
      media: screenshot ? { frames: [screenshot] } : undefined,
    },
  });
}

// ─── 3. Record user actions ───

async function recordClick(elementText: string, context: string) {
  await memory.write({
    payload: {
      summary: `Clicked: ${elementText}`,
      description: context,
      tags: ["click", "interaction"],
      salienceScore: 0.5,
      modality: ["text"],
    },
  });
}

// ─── 4. Ask the assistant ───

async function ask(question: string) {
  const result = await memory.retrieve({
    strategy: "factual",
    text: question,
    topK: 10,
  });

  // Build context for LLM
  const context = result.nodes
    .map((n) => `[${new Date(n.timestamp).toISOString()}] ${n.payload.summary}`)
    .join("\n");

  return {
    answer: `Based on your recent activity...`, // LLM call here
    context,
    sources: result.nodes,
  };
}

// ─── 5. Ask about recent activity ───

async function summarizeToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await memory.retrieve({
    strategy: "temporal",
    timeRange: {
      start: today.getTime(),
      end: Date.now(),
    },
    traversalOrder: "forward",
    topK: 20,
  });

  return result.nodes.map((n) => n.payload.summary);
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
  await recordPageVisit(
    "https://github.com/Naeemo/memorai",
    "Naeemo/memorai: Streaming memory for AI agents",
  );

  await recordClick("README.md", "Navigated to README in the memorai repo");

  const summary = await summarizeToday();
  console.log("Today you:", summary.join("; "));

  const { context } = await ask("What repos did I look at today?");
  console.log("Context for LLM:", context);

  await memory.close();
}

main().catch(console.error);
