/**
 * Example: OpenClaw Agent Integration
 *
 * Shows how an OpenClaw agent can use memorai as its memory layer.
 *
 * In your OpenClaw workspace (e.g. ~/.kimi_openclaw/workspace/),
 * import memorai and hook it into the agent lifecycle.
 */

import process from "node:process";
import { IndexedDBAdapter, Memorai, OpenAIEmbeddingService } from "memorai";

// ─── Agent Memory Instance ───

let memory: Memorai | null = null;

export function initAgentMemory() {
  memory = new Memorai({
    storage: new IndexedDBAdapter({ dbName: "openclaw-agent" }),
    embedding: new OpenAIEmbeddingService({
      apiKey: process.env.OPENAI_API_KEY ?? "",
    }),
    agentProfile: {
      agentId: "openclaw-main",
      role: "reasoning",
      writePolicy: {
        levels: ["segment", "atomic_action", "episode"],
        modalities: ["text"],
        salienceBoost: 1,
      },
      readPolicy: {
        defaultLevel: "episode",
        defaultTraversal: "reverse",
        timeHorizonMs: 7 * 24 * 60 * 60 * 1000,
      },
    },
  });
  return memory;
}

// ─── Hook into OpenClaw Heartbeat ───

export async function onHeartbeat() {
  if (!memory) return;

  // Periodically evolve memories in the background
  await memory.evolve();

  // Check if there's anything important the agent should know
  const recent = await memory.retrieve({
    strategy: "temporal",
    timeRange: {
      start: Date.now() - 30 * 60 * 1000, // last 30 minutes
      end: Date.now(),
    },
    topK: 5,
  });

  if (recent.nodes.length > 0) {
    console.log(
      "[Heartbeat] Recent memories:",
      recent.nodes.map((n) => n.annotations.summary ?? n.raw.text ?? ""),
    );
  }
}

// ─── Hook into Message Processing ───

export async function onMessage(message: string, context: { channel: string; user: string }) {
  if (!memory) throw new Error("Memory not initialized");

  // Record the incoming message as an event — extraction runs in the background.
  memory.recordEvent({
    at: Date.now(),
    actor: context.user,
    content: { kind: "message", text: message },
    tags: ["message", context.channel],
    salienceHint: 0.6,
  });

  // Recall relevant context for generating a reply
  const relevant = await memory.recall(message, { topK: 5 });

  const contextLines = relevant.memories
    .map((m) => `[${new Date(m.at).toISOString()}] ${m.summary}`)
    .join("\n");

  return {
    reply: `I remember...`, // Your LLM call here
    memoryContext: contextLines,
  };
}

// ─── Cleanup ───

export async function shutdown() {
  if (memory) {
    await memory.close();
    memory = null;
  }
}
