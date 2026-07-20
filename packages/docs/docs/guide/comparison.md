# Memorai vs Alternatives

A head-to-head comparison of Memorai with other agent memory libraries.

## Architecture

| Aspect | Memorai | Mem0 | Zep | Letta |
|---|---|---|---|---|
| Language / runtime | TypeScript — Browser, Node, Bun, Deno | Python / JS SDK | TypeScript / Node | Python |
| Storage philosophy | **Three-tier** (raw / annotations / indexes) | Destructive summarize at ingest | Temporal knowledge graph | Agent state blocks |
| Re-annotation | ✅ Upgrade extractors without data loss | ❌ Old memories frozen | ❌ | ❌ |
| Multimodal | References + embeddings + text | Text only | Text + metadata | Text |
| Hierarchical evolution | Segment → Atomic Action → Event | Flat | Flat | Flat |
| Working memory | ✅ Built-in scratchpad | ❌ | ❌ | ✅ |
| Procedural memory | ✅ `tool_call` / `plan_step` / skills | ❌ | ❌ | Partial |
| Belief revision | ✅ `supersedes` + `invalidatedAt` | ❌ | Partial | ❌ |
| Bi-temporal queries | ✅ `validAt` | ❌ | Partial | ❌ |

## Benchmarks

| Benchmark | Memorai | Zep | Mem0 | Letta |
|---|---|---|---|---|
| LongMemEval | **92%** | 64–71% | 49% | — |
| LoCoMo conv-26 | 33.55% (tuning) | 75–85% | ~60s | — |
| Runtime portability | **Browser + Node + Bun + Deno** | Node | Node | Server |

## Feature Matrix

| Feature | Memorai | Mem0 | Zep | Letta |
|---|---|---|---|---|
| Vector index (ANN) | ✅ HNSW / USearch / WASM | ✅ | ✅ | ✅ |
| BM25 sparse retrieval | ✅ | ✅ | ✅ | ✅ |
| Knowledge graph | ✅ (triples + pathways) | Optional | ✅ (required) | ❌ |
| Temporal anchors | ✅ | ❌ | ✅ | ❌ |
| Query expansion / HyDE / decompose | ✅ | Partial | Partial | ❌ |
| Cross-encoder reranker | ✅ local, no API | ❌ | ❌ | ❌ |
| Observability (`explain()` + spans) | ✅ | Partial | Partial | Partial |
| ESM + CJS dual build | ✅ | ❌ | ✅ | ❌ |
| Zero external service deps | ✅ | ❌ (needs vector DB) | ❌ (needs graph DB) | ❌ |
| Self-hosting | ✅ | ✅ | ✅ | ✅ |

## When to choose Memorai

- You need **browser-local** or **edge-runtime** memory.
- You want to **preserve raw events** and upgrade extraction quality later.
- Your agents are **tool-using** and need procedural memory.
- You need **bi-temporal** "what was true at time T" queries.
- You want a **single TypeScript-native** library with no external graph DB.

## When to choose an alternative

- **Zep**: you need the absolute highest LoCoMo scores today and are okay running a graph database.
- **Mem0**: you want a mature SaaS/API and don't need browser support or re-annotation.
- **Letta**: you want a full agent framework with opinionated state management rather than a library.
