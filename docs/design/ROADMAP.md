# Memorai — World-Class Roadmap

> **Date:** 2026-07-18
> **Baseline:** v0.5.0 (LoCoMo conv-26 33.55%, LongMemEval oracle 92%)
> **Goal:** Architectural review + prioritized plan to take Memorai from "promising" to *the* canonical agent memory library, designed for today's agents and what's coming next.

---

## Where Memorai stands today

Memorai already has the right *spine* for a world-class agent memory library, and several things that genuinely differentiate it:

- **Three-tier (raw / annotations / indexes) with `reAnnotate()`** is a real moat. No JS-side competitor lets you upgrade extractor or embedding model without losing the timeline. Mem0/Letta destructively summarize at ingest.
- **MemoryEvent layer with explicit `supersedes` + `invalidatedAt`** (0.4.0) moves you toward knowledge-graph systems while keeping Tier 1 intact. The +15pp jump on LoCoMo conv-26 validates the design.
- **Multi-pathway RRF with per-pathway provenance** is rare and useful. Most libs return scored docs with no explanation; Memorai can trace *why* a memory surfaced.
- **Runtime-agnostic by design** is unusual — unlocks browser/embedded scenarios competitors don't reach.

The honest read on benchmarks: 33.55% on LoCoMo conv-26 is behind published mem0/Zep-class numbers on full LoCoMo (Zep ~75-85%, mem0 ~60s). **The Phase A infrastructure (temporal anchors, weighted graph paths, event cross-linking, LLM temporal resolution) is implemented; the remaining work is tuning defaults and verifying the new baseline.**

---

## Tier 1 — Foundations you can't be "world-class" without

### 1. Vector index abstraction (ANN) ✅

`VectorIndex` interface ships in `src/vector/types.ts` with `upsert`, `query`, `delete`, and `clear`. Implementations include `HnswVectorIndex` (`hnswlib-node`), `HnswWasmVectorIndex` (`hnswlib-wasm`), `USearchVectorIndex` (`usearch`), and `BruteForceVectorIndex`. `RetrievalEngine.semanticPathway` uses a configured `vectorIndex` when present and falls back to `storage.listAll()` + cosine otherwise.

**Remaining:** default to an ANN index automatically instead of requiring callers to wire it up.

### 2. First-class temporal grounding ✅

`resolveTimeExpression` heuristic resolver covers "yesterday", "last week", "in March", etc. `TemporalAnchor` metadata is extracted by `LightExtractor` and `LLMExtractor`, stored on nodes, and queried via `StorageAdapter.queryByTemporalAnchor`. A `temporalAnchorPathway` runs in retrieval for entity/temporal queries, and `Memorai.applyTemporalResolution` adds Tier 2 (anchor-relative) and Tier 3 (LLM-assisted) resolution. `resolveTime` now defaults to `true` in `recall()` (configurable via `MemoraiConfig.defaultResolveTime`).

### 3. Knowledge graph layer over triples ✅

`EntityGraph` interface ships in `src/graph/types.ts` with `upsertEntity`, `upsertEdge`, `queryPaths`, `queryPathsWeighted`, and `queryNeighbors`. Backends: `InMemoryEntityGraph`, `SQLiteEntityGraph`, `IndexedDBEntityGraph`. `LLMExtractor` emits `KnowledgeTriple`, `Memorai.write` persists them to the graph, and `RetrievalEngine.graphPathway` fuses graph neighbors into recall via RRF with confidence-weighted best-first traversal.

### 4. User profile / materialized "what I know about you" view ✅

State events (`MemoryEventKind: "state"`) are extracted by `LLMEventIdentifier`, invalidated via `supersedes` / `invalidatedAt`, and surfaced through the event-level recall pathway. `tests/profile.test.ts` validates profile-style recall. A dedicated materialized `getUserFacts(userId, topic?)` view remains future polish.

### 5. Working memory / scratchpad layer ✅

`Memorai.workingMemory` is exposed as a typed `WorkingMemory` scratchpad with `set`, `get`, `append`, `delete`, `clear`, and TTL support. Default implementation is `InMemoryWorkingMemory`; persistent backends can be injected via `MemoraiConfig.workingMemory`. Working entries are excluded from HME and default recall.

---

## Tier 2 — Differentiators for the next generation of agents

### 6. Procedural memory (tool calls / code / plans) ✅

`EventContent` includes `tool_call` and `plan_step` kinds. `RetrievalEngine` has a `procedural` strategy that boosts `tool_call` nodes (especially failed calls) and applies a faster recency decay. `SkillExtractor` / `SkillStore` turn repeated successful tool patterns into reusable `ProceduralSkill`s surfaced via `recallSkills()`.

### 7. Belief revision + self-reflection hooks ✅

`Memorai.reviseBelief()` creates a new state event that supersedes older ones, tracking `revisionDepth` and `revisionReason`. `LLMContradictionDetector` (and `detectContradictions()`) flags conflicts between new assertions and currently-valid state events. `Memorai.reflect()` generates insights from recent event patterns and persists them as new MemoryEvents.

### 8. Forgetting + consolidation policy ✅

`RetentionPolicy` interface and `DefaultRetentionPolicy` ship in `src/retention/`. `Memorai.forget()` scores nodes by salience + recency + access frequency and evicts Tier 2/3 while preserving the immutable Tier 1 raw timeline. Forgetting is opt-in; callers decide when to invoke it.

### 9. Multi-agent / shared memory primitives ✅

`namespace` is a first-class partition key across `MemoryAdapter`, `IndexedDBAdapter`, `SQLiteAdapter`, and `InMemoryEventStore`. `AgentMemoryProfile` defines per-agent read/write policies. `Memorai.subscribe(filter, callback)` delivers proactive notifications on matching writes. `MemoryFederation` provides serialized memory slices for cross-instance / cross-device sharing.

### 10. Streaming ingest with backpressure ✅

`Memorai.recordStream(events)` accepts an async iterable, batches events, dedupes by `(participant, topic, time-bucket)`, and uses `embedBatch` when available. A `StreamController` exposes backpressure signals (`isFull`, `isDrained`) and supports pause/resume. Tier-1-only fast path remains future optimization.

---

## Tier 3 — Quality, ops, and DX

### 11. Cross-encoder reranker (not LLM) ✅

`TransformersReranker` in `src/reranker-transformers.ts` loads `Xenova/bge-reranker-base` via `@xenova/transformers` and plugs into `MemoraiConfig.reranker`. `LLMReranker` is also available for setups without the transformers peer dependency.

### 12. Persistent EventStore implementations ✅

`SQLiteEventStore` and `IndexedDBEventStore` ship alongside the default `InMemoryEventStore`. They mirror the `EventStore` interface and persist MemoryEvents, validity windows, and access metadata.

### 13. Observability + eval framework ✅

`Memorai.explain(question, opts)` returns timing spans, pathway activation, fusion math, and per-pathway scores. `onRecall` callback exposes the same spans for external monitoring. The benchmark harness lives in `packages/benchmarks` and is not yet published as `memorai/eval`.

### 14. Resolve LLM-extractor + identifier noise ✅

When a node is covered by a `MemoryEvent`, `MemoryMeta.coveredByEvent` is set and `composeIndexableText` suppresses the node's `annotations.summary` so the event's canonical description remains the single source of truth. The node still indexes `raw.text`, `facts`, `description`, and `tags` for literal/paraphrased matching.

### 15. DX cleanup 🔄

- ✅ Examples updated to public Event API (`cross-agent.ts`, `openclaw-agent.ts`; `node-server.ts` and `browser-assistant.ts` already used it).
- ✅ `MemoryPayload` / `MemoryPayloadInput` back-compat aliases already removed.
- 🔄 `extensions` generic propagation (`Memorai<Ext>`) remains future 1.0 work.

---

## Highest-leverage next steps

The Tier 1–Tier 3 building blocks are now implemented. The remaining work is integration, tuning, and verification:

1. **Run LoCoMo conv-26 with current code** — establish the new baseline after the temporal-anchor fix and `resolveTime` default.
2. **Tune default configuration** — auto-enable ANN when available, verify pathway weights, and confirm `resolveTime` improves temporal questions without regressing others.
3. **Run full LoCoMo + ConvoMem** — publish head-to-head numbers vs. mem0 / Zep / Letta.
4. **Multimodal extraction** — move image/audio/video events from WrapExtractor passthrough to real captioning/transcription.

After these, Memorai can credibly claim the most complete TypeScript-native agent memory stack.

---

## Benchmark hygiene

The 100% scores on the synthetic suite in `README.md` aren't useful signal to outside readers — public datasets are. The published LoCoMo + LongMemEval numbers in `packages/benchmarks/results/published/` are the credible story; feature *those* in the README, not custom synthetics. A side-by-side vs. mem0 + Letta on full LoCoMo would dramatically strengthen the pitch even at current accuracy.
