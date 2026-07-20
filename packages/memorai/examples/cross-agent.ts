/**
 * Example: Cross-Agent Shared Memory
 *
 * Two agents (Reasoning + Proactive) share the same SQLite store
 * but have different read/write policies.
 *
 * Reasoning Agent: Sees the big picture (events), thinks long-term.
 * Proactive Agent: Sees recent triggers (segments), acts on opportunities.
 */

import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";

// ─── Shared storage ───

const sharedStorage = new MemoryAdapter(); // In production: new SQLiteAdapter(db)

const embedding = new OllamaEmbeddingService({
  baseURL: "http://localhost:11434",
  model: "nomic-embed-text",
});

// ─── Agent 1: Reasoning ───

const reasoningAgent = new Memorai({
  storage: sharedStorage,
  embedding,
  agentProfile: {
    agentId: "reasoning-bot",
    role: "reasoning",
    writePolicy: {
      levels: ["segment", "atomic_action", "episode"],
      modalities: ["text", "vision"],
      salienceBoost: 1,
    },
    readPolicy: {
      defaultLevel: "episode", // Sees abstract episodes
      defaultTraversal: "reverse", // Recent events first
      timeHorizonMs: 7 * 24 * 60 * 60 * 1000, // 1 week
    },
  },
});

// ─── Agent 2: Proactive ───

const proactiveAgent = new Memorai({
  storage: sharedStorage,
  embedding,
  agentProfile: {
    agentId: "proactive-bot",
    role: "proactive",
    writePolicy: {
      levels: ["segment"], // Only writes raw triggers
      modalities: ["text"],
      salienceBoost: 1.5, // Higher salience for triggers
    },
    readPolicy: {
      defaultLevel: "segment", // Sees raw segments
      defaultTraversal: "salience", // Important triggers first
      timeHorizonMs: 60 * 60 * 1000, // 1 hour
    },
  },
});

// ─── Scenario ───

async function scenario() {
  // Proactive agent detects triggers
  await proactiveAgent.recordEvent({
    at: Date.now(),
    actor: "proactive-bot",
    content: { kind: "observation", text: "User has been idle for 10 minutes" },
    tags: ["idle", "trigger"],
    salienceHint: 0.9,
  }).nodes;

  await proactiveAgent.recordEvent({
    at: Date.now(),
    actor: "proactive-bot",
    content: { kind: "observation", text: "User opened Slack" },
    tags: ["slack", "trigger"],
    salienceHint: 0.7,
  }).nodes;

  // Reasoning agent adds context
  await reasoningAgent.recordEvent({
    at: Date.now(),
    actor: "reasoning-bot",
    content: { kind: "observation", text: "User is preparing for a meeting — context from calendar" },
    tags: ["meeting", "context"],
    salienceHint: 0.8,
  }).nodes;

  // Proactive agent queries: what should I do?
  const triggers = await proactiveAgent.recall("What should I suggest to the user?", {
    strategy: "factual",
    topK: 5,
  });
  console.log("\n[Proactive] Triggers found:");
  triggers.memories.forEach((m) => console.log(`  - ${m.summary} (${m.level})`));

  // Reasoning agent queries: what's the overall picture?
  const picture = await reasoningAgent.recall("What is the user doing today?", {
    strategy: "inferential",
    topK: 5,
  });
  console.log("\n[Reasoning] Big picture:");
  picture.memories.forEach((m) => console.log(`  - ${m.summary} (${m.level})`));

  // Both agents see the same data but at different granularity
  console.log("\nShared storage has:");
  const all = await sharedStorage.listAll();
  console.log(`  ${all.length} total nodes`);
  console.log(`  ${all.filter((n) => n.level === "segment").length} segments`);
  console.log(`  ${all.filter((n) => n.level === "atomic_action").length} atomic actions`);
  console.log(`  ${all.filter((n) => n.level === "episode").length} episodes`);

  await reasoningAgent.close();
  await proactiveAgent.close();
}

scenario().catch(console.error);
