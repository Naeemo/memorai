import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import { generateAgentMemories } from "./data.js";
import { type BenchmarkResult } from "../../core/metrics.js";

const AGENTS = ["alpha", "beta", "gamma"];
const MEMORIES_PER_AGENT = 30;

export async function runCrossAgentBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });

  const storage = new MemoryAdapter();
  const memories = generateAgentMemories(AGENTS, MEMORIES_PER_AGENT);

  for (const m of memories) {
    const memory = new Memorai({
      storage,
      embedding,
      agentProfile: {
        agentId: m.agent,
        role: m.agent === "alpha" ? "reasoning" : "proactive",
        writePolicy: {
          levels: ["segment", "atomic_action", "event"],
          modalities: ["text"],
          salienceBoost: 1,
        },
        readPolicy: {
          defaultLevel: "segment",
          defaultTraversal: "reverse",
          timeHorizonMs: 86400000,
        },
      },
    });

    await memory.write({
      raw: m.raw,
      annotations: m.annotations,
      meta: m.meta,
    });
    await memory.close();
  }

  const isolationScores: number[] = [];
  const latencies: number[] = [];

  for (const agent of AGENTS) {
    const memory = new Memorai({
      storage,
      embedding,
      agentProfile: {
        agentId: agent,
        role: agent === "alpha" ? "reasoning" : "proactive",
        writePolicy: {
          levels: ["segment", "atomic_action", "event"],
          modalities: ["text"],
          salienceBoost: 1,
        },
        readPolicy: {
          defaultLevel: "segment",
          defaultTraversal: "reverse",
          timeHorizonMs: 86400000,
        },
      },
    });

    const start = performance.now();
    const result = await memory.retrieve({
      text: "action",
      strategy: "factual",
      topK: MEMORIES_PER_AGENT * 2,
      agentRole: agent === "alpha" ? "reasoning" : "proactive",
      earlyStop: false,
    });
    const latency = performance.now() - start;
    latencies.push(latency);

    const ownMemories = result.nodes.filter(
      (n) => n.meta.sourceAgent === agent,
    );
    const totalRetrieved = result.nodes.length;

    const isolationScore =
      totalRetrieved > 0 ? ownMemories.length / totalRetrieved : 1;
    isolationScores.push(isolationScore);

    await memory.close();
  }

  return {
    name: "Cross-Agent Isolation",
    score: isolationScores.reduce((a, b) => a + b, 0) / isolationScores.length,
    latencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    details: {
      agents: AGENTS.length,
      memories_per_agent: MEMORIES_PER_AGENT,
      isolation_scores: isolationScores.map((s) => s.toFixed(2)).join(", "),
    },
  };
}
