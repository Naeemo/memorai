// Multimodal Recall benchmark — Memorai-specific
// Tests: do image / audio / video event refs survive ingest, evolve, and recall?

import { Memorai, MemoryAdapter, OllamaEmbeddingService } from "memorai";
import type { Event } from "memorai";
import { type BenchmarkResult } from "../../core/metrics.js";

const SAMPLES: Array<{ event: Event; query: string; expectedRef: string }> = [
  {
    event: {
      at: Date.now() - 600_000,
      actor: "alice",
      content: {
        kind: "image",
        image: "blob:incident-screenshot-001",
        caption: "Production dashboard showing red alert on api-gateway",
      },
    },
    query: "What did Alice share about the production dashboard?",
    expectedRef: "blob:incident-screenshot-001",
  },
  {
    event: {
      during: { start: Date.now() - 500_000, end: Date.now() - 200_000 },
      actor: "bob",
      content: {
        kind: "video",
        video: "blob:demo-recording-v3.mp4",
        transcript: "Walking through the new onboarding flow for enterprise customers",
      },
    },
    query: "What was in Bob's demo recording about onboarding?",
    expectedRef: "blob:demo-recording-v3.mp4",
  },
  {
    event: {
      at: Date.now() - 400_000,
      actor: "carol",
      content: {
        kind: "audio",
        audio: "blob:standup-2026-04-15.wav",
        transcript: "Daily standup with engineering team about Q2 roadmap",
      },
    },
    query: "What did Carol record in the standup?",
    expectedRef: "blob:standup-2026-04-15.wav",
  },
  {
    event: {
      at: Date.now() - 300_000,
      actor: "dave",
      content: {
        kind: "image",
        image: "blob:architecture-diagram-v4.png",
        caption: "Updated architecture diagram showing the new caching layer",
      },
    },
    query: "What did Dave share about the architecture caching layer?",
    expectedRef: "blob:architecture-diagram-v4.png",
  },
  {
    event: {
      at: Date.now() - 100_000,
      actor: "eve",
      content: {
        kind: "file",
        mime: "application/pdf",
        ref: "blob:security-audit-q2.pdf",
        text: "Security audit findings — three high-priority items in auth flow",
      },
    },
    query: "What did Eve share about the security audit findings?",
    expectedRef: "blob:security-audit-q2.pdf",
  },
];

export async function runMultimodalRecallBenchmark(): Promise<BenchmarkResult> {
  const embedding = new OllamaEmbeddingService({
    model: "nomic-embed-text",
    dimension: 768,
  });
  const memory = new Memorai({
    storage: new MemoryAdapter(),
    embedding,
    evolution: { mode: "manual" },
  });

  // Ingest all samples.
  for (const s of SAMPLES) {
    await memory.recordEvent(s.event).nodes;
  }
  await memory.evolve();

  let hits = 0;
  const latencies: number[] = [];
  const failures: string[] = [];

  for (const s of SAMPLES) {
    const start = performance.now();
    const result = await memory.recall(s.query, { topK: 5 });
    latencies.push(performance.now() - start);

    // Check if any recalled memory carries the expected media ref.
    const found = result.memories.some((m) => {
      const e = m.evidence;
      if (!e) return false;
      const refs = [
        ...(e.frames ?? []).filter((f): f is string => typeof f === "string"),
        typeof e.audio === "string" ? e.audio : undefined,
        e.video,
      ];
      return refs.includes(s.expectedRef);
    });

    if (found) {
      hits++;
    } else {
      failures.push(`${s.event.content.kind}:${s.expectedRef.slice(0, 40)}`);
    }
  }

  await memory.close();

  const score = hits / SAMPLES.length;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return {
    name: "Multimodal Recall",
    score,
    latencyMs: avgLatency,
    details: {
      samples: SAMPLES.length,
      hits,
      kinds: "image,video,audio,image,file",
      ...(failures.length > 0
        ? { failed: failures.join(" | ") }
        : { failed: "none" }),
    },
  };
}
