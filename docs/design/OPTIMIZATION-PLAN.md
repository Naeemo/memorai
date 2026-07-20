# Memorai — World-Class Optimization Plan

> **Date:** 2026-05-21 ｜ **Updated:** 2026-07-16
> **Baseline:** v0.5.0 (LongMemEval 92% via Kimi K2.6, LoCoMo conv-26 33.55%)
> **Goal:** Close the benchmark gap with Zep/Graphiti and become *the* canonical TypeScript agent memory library

## Status Update (2026-07-16)

**Surprise finding:** The Phase A features (temporal anchors, weighted graph paths, event cross-linking, LLM temporal resolution) are **already implemented** in v0.5.0. The infrastructure is complete:

- ✅ `TemporalAnchor` type + `extractTemporalAnchors` (LightExtractor + LLMExtractor)
- ✅ `temporalAnchorPathway` in retrieval engine
- ✅ `resolveRelativeToAnchor` (Tier 2) + `resolveTemporalViaLLM` (Tier 3)
- ✅ `queryPathsWeighted` in all three graph backends
- ✅ `MemoryEvent.relatedEventIds` + `LLMEventIdentifier` population
- ✅ `graphPathway` uses confidence-weighted best-first multi-hop walk

**Fix applied (2026-07-16):** `LightExtractor.extractTemporalAnchors` was not filling `start`/`end` fields, causing `resolveRelativeToAnchor` to fall back to `now`. Fixed to populate from `event.at`.

**Default applied (2026-07-18):** `recall()` now defaults `resolveTime` to `true` (configurable via `MemoraiConfig.defaultResolveTime`). Temporal expressions are resolved automatically instead of requiring an explicit opt-in.

**Open question:** If Phase A infrastructure is complete, why is LoCoMo still at 33.55%? Possible causes:
1. Benchmark configuration (extractor/identifier/reranker choice, parameter tuning)
2. Integration gaps (HNSW not default, pathway weights not tuned)
3. Need to run fresh benchmark with current code to establish new baseline

---
---

## Executive Summary

Memorai v0.5.0 has the right architectural spine — three-tier storage, HME, multi-pathway RRF, vector index, knowledge graph, working memory, and procedural memory. The architecture is more general than Mem0 and more portable than Zep. But **LoCoMo conv-26 at 33.55% is the critical gap** — Zep scores 75-85% on the same dataset. LongMemEval at 92% is competitive (Zep: 64-71%, Mem0: 49%).

This plan prioritizes the highest-leverage improvements to close the LoCoMo gap while building differentiators for the next generation of agents.

---

## Part 1 — Domain Analysis & Skills Installed

### Knowledge Domains Researched

| Domain | Source | Key Insight |
|--------|--------|-------------|
| **Agent Memory Landscape 2026** | Web search: Mem0 vs Zep vs Letta comparison | Zep leads on LoCoMo (75-85%) via temporal knowledge graphs. Hindsight leads LongMemEval (91.4%). Memorai is competitive on LongMemEval but weak on LoCoMo. |
| **Vector Search / ANN** | Web search: HNSW JS/TS performance 2026 | Pure JS HNSW hits a ceiling at ~50K vectors. WASM+SIMD (USearch, VecDB-WASM) is the production standard for browser. Quantization (f16/i8) reduces memory 2-4x. |
| **Knowledge Graph RAG** | Web search: GraphRAG agent memory 2026 | 2026 convergence: "Knowledge Runtime" = RAG + Agent Memory + KG. GraphRAG achieves 92% context accuracy vs 65% for vector-only. Multi-modal graphs are the new frontier. |
| **MCP Ecosystem** | Web search: npm/GitHub MCP servers | Installed npm-registry MCP (package search, vulnerabilities) and GitHub MCP (issues, PRs, code search) for ongoing research. |
| **Competitive Benchmarks** | GitHub repos, arXiv papers | Stompy benchmark report, MAGMA, HAGE, SkillGraph papers confirm temporal + graph + multi-pathway fusion is the winning architecture. |

### Skills Installed

1. **npm-registry MCP** (`@universal-mcp-toolkit/server-npm-registry`) — Package search, metadata, vulnerability audits, download stats
2. **GitHub MCP** (`@github/github-mcp-server`) — Repo issues, PRs, code search, release tracking
3. **Web search** — Research competitor releases, academic papers, architecture patterns

---

## Part 2 — Benchmark Gap Analysis

### Where Memorai Wins

| Benchmark | Memorai | Zep | Mem0 | Notes |
|-----------|---------|-----|------|-------|
| LongMemEval | **92%** | 64-71% | 49% | Event-level recall + query expansion pays off |
| Runtime portability | **Browser/Node/Bun/Deno** | Node only | Node only | Memorai's core differentiator |
| Re-annotation | **Yes (three-tier)** | No | No | Upgrade extractors without data loss |
| Native TypeScript | **Yes** | Yes | JS SDK | Both Memorai and Zep are TS-native |
| Procedural memory | **Yes (tool_call/plan_step)** | No | No | Unique to Memorai |

### Where Memorai Loses

| Benchmark | Memorai | Zep | Gap | Root Cause |
|-----------|---------|-----|-----|------------|
| LoCoMo conv-26 | 33.55% | 75-85% | **-41 to -51pp** | Temporal reasoning + multi-hop graph traversal |
| LoCoMo temporal | 8.1% | ~60% | **-52pp** | Time-expression resolver too conservative |
| Full LoCoMo | Not published | ~75% | Unknown | Need to run full suite |
| Graph persistence | In-memory only | Neo4j/FalkorDB/Kuzu | — | No production graph backend |

### Diagnosis: Why LoCoMo Is Hard for Memorai

LoCoMo tests **multi-turn conversational memory** over 26 turns. The questions are:
- **Temporal**: "What did Alice say *before* she mentioned the migration?"
- **Multi-hop**: "Who was at the meeting where Bob raised the budget concern?"
- **Contradiction**: "Did Alice prefer tea or coffee? When did that change?"

Memorai's gaps:
1. **Temporal anchors** — Events have `timestamp` but no `relativeTo` anchors. "Before the migration" requires graph traversal, not just time-range filtering.
2. **Graph path depth** — `queryPaths` uses BFS up to `maxDepth=4`, but LoCoMo needs 3-5 hop reasoning with confidence-weighted edge traversal.
3. **Event cross-referencing** — MemoryEvents track `sourceNodeIds` but don't link to *other* events. A "meeting" event should link to all participant state events.
4. **Temporal expression parsing** — `resolveTimeExpression` is heuristic-only, no LLM fallback for ambiguous expressions.

---

## Part 3 — The Optimization Roadmap

### Phase A: Close the LoCoMo Gap (P0 — 4-6 weeks)

**Goal: Reach 60%+ on LoCoMo conv-26 (from 33.55%)**

#### A1. Temporal Anchor System (2 weeks)

**Problem**: "Before the migration" can't be answered with just `timestamp` and `timeRange`.

**Plan**:
- Add `temporalAnchors` field to `MemoryNode`:
  ```typescript
  interface TemporalAnchor {
    type: "absolute" | "relative" | "duration" | "recurring";
    absolute?: number;           // Unix ms
    relativeTo?: string;         // eventId or nodeId
    deltaMs?: number;            // "2 hours before X"
    description?: string;        // "the Tuesday meeting"
  }
  ```
- `LLMExtractor` extracts temporal anchors from event text ("tomorrow", "last week", "before the migration")
- `TemporalAnchorIndex` storage-adapter method for efficient relative-time queries
- New retrieval pathway: `temporalAnchorPathway` — for queries with relative time expressions, resolve the anchor first, then query the neighborhood

**Expected impact**: +10-15pp on temporal LoCoMo questions

#### A2. Graph Path Scoring with Edge Confidence (1 week)

**Problem**: BFS paths are unweighted — a high-confidence edge and a low-confidence edge get equal treatment.

**Plan**:
- Weighted path search: `pathScore = product(edge.confidence ?? 0.5)` along the path
- Personalized PageRank (PPR) variant for graph retrieval: seed on query entities, run PPR over the graph, collect sourceNodeIds from top-ranked edges
- Add `queryPathsWeighted(from, to, opts)` to `EntityGraph` interface
- Fall back to BFS when PPR is too slow (graph < 1K edges)

**Expected impact**: +5-8pp on multi-hop LoCoMo questions

#### A3. Event Cross-Linking (1 week)

**Problem**: MemoryEvents are isolated — a "meeting" event doesn't reference the state events of its participants.

**Plan**:
- `MemoryEvent.relatedEventIds`: IDs of other events that are semantically or temporally related
- `LLMEventIdentifier` populates this by asking the LLM: "Which existing events are related to this new event?"
- Graph edges get `sourceEventId` (already exists) — use it to traverse from event → related nodes → other events
- Event-level retrieval: when a MemoryEvent is surfaced, also surface its `relatedEventIds`

**Expected impact**: +5-10pp on multi-hop questions

#### A4. LLM-Assisted Temporal Resolution (1 week)

**Problem**: `resolveTimeExpression` is heuristic-only and fires on phrases it doesn't understand.

**Plan**:
- Two-tier resolution: heuristic first (fast, covers "yesterday", "last week"), LLM fallback for ambiguous cases ("when we last spoke", "before the migration")
- LLM fallback prompt: `Given these events [...], what time range does "before the migration" refer to?`
- Cache resolved expressions by (question + recent event hash) to avoid repeated LLM calls
- Only enable LLM fallback when `opts.resolveTime === true` (lesson from v0.5.0 regression)

**Expected impact**: +3-5pp on temporal questions

---

### Phase B: Scale & Production Readiness (P1 — 3-4 weeks)

#### B1. WASM Vector Search for Browser (2 weeks)

**Problem**: `hnswlib-node` is a native binding — doesn't work in browser. Browser users are stuck with `BruteForceVectorIndex` (O(N)).

**Plan**:
- Add `USearchVectorIndex` wrapper around `usearch` (C++ → WASM with SIMD128)
- Add `VecDBVectorIndex` wrapper around `vecdb-wasm` (pure WASM HNSW)
- Runtime detection: in browser, auto-select WASM index; in Node.js, prefer `hnswlib-node`
- Benchmark: target <10ms/query at 100K vectors in browser (vs ~132ms for pure JS)
- Add quantization support: `f16` embeddings halve memory, `i8` quarter it

**Why**: Browser portability is Memorai's core differentiator. Losing it for vector search undermines the value prop.

#### B2. Persistent Graph Backends (1 week)

**Problem**: `InMemoryEntityGraph` loses all data on restart. No production graph option.

**Plan**:
- `SQLiteEntityGraph`: stores (entity, edge) tables in SQLite, Cypher-like adjacency queries
- `IndexedDBEntityGraph`: browser-persistent graph via IndexedDB
- Both implement the same `EntityGraph` interface — drop-in replacements
- Schema:
  ```sql
  CREATE TABLE entities (name TEXT PRIMARY KEY, attributes JSON, first_seen INTEGER, last_seen INTEGER, user_id TEXT);
  CREATE TABLE edges (id TEXT PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_at INTEGER, invalidated_at INTEGER, confidence REAL, source_node_id TEXT, source_event_id TEXT, user_id TEXT);
  CREATE INDEX idx_edges_subject ON edges(subject, predicate, user_id);
  CREATE INDEX idx_edges_object ON edges(object, predicate, user_id);
  ```

#### B3. Streaming Ingest with Backpressure (1 week)

**Problem**: `recordEvent` is synchronous-return but async-extraction. Observation-heavy agents write 50-500 events/sec — current pipeline can't keep up.

**Plan**:
- `recordStream(asyncIter<Event>)` that batches, dedupes, and throttles
- Configurable backpressure: STM at 80% → slow producers; at 100% → drop or downgrade extractor
- `appendRaw(content)` fast path: skip extraction, queue for batch processing later
- Batch embedding: `embedBatch` is already supported by `EmbeddingService` — use it in the stream pipeline

---

### Phase C: Differentiators for Next-Gen Agents (P2 — 4-6 weeks)

#### C1. Cross-Modal Memory (2 weeks)

**Problem**: Multimodal events (image, audio, video) pass through `WrapExtractor` with no actual extraction. The `media` field is stored but not searchable.

**Plan**:
- `MultimodalExtractor`: uses vision model for image captioning, Whisper for audio transcription
- Cross-modal embeddings: CLIP-style (image+text joint embedding) via `@xenova/transformers`
- `CrossModalRetrievalEngine`: query with text, retrieve images/video segments whose embeddings match
- Store compressed frame keyframes alongside video references for visual search

#### C2. Observability + Explainability (1 week)

**Problem**: No visibility into why a memory was recalled. Debugging recall quality is guesswork.

**Plan**:
- `Memorai.explain(question, opts)` → returns candidate set, per-pathway scores, filter decisions, fusion math
- OTel-style spans for every recall phase: semantic query, BM25, graph traversal, HyDE, rerank
- Optional callback: `onRecall?.(question, result, spans)` for external monitoring
- Structured logging: JSON logs for every `recordEvent` and `recall` with timing, token counts, pathway activation

#### C3. Multi-Agent Federation (1 week)

**Problem**: `namespace` is a filter, not a partition. No subscriptions or cross-instance memory sharing.

**Plan**:
- `namespace` becomes a true partition key — adapters physically separate data
- `Memorai.subscribe(filter, callback)` — proactive memory: register interest, get notified on matching writes
- `MemoryFederation` primitive: serialized read API for peer instances to pull memory slices
- Seed for multi-device / multi-agent memory sync

#### C4. Memory Compression & Quantization (1 week)

**Problem**: Embeddings are full `f32` arrays. At 1536 dims × 1M nodes = 6GB of vector data.

**Plan**:
- `EmbeddingQuantizer` interface: `f32 → f16`, `f32 → i8` (scalar quantization)
- `ScalarQuantizer`: compute min/max per dimension from a calibration set, map to 8-bit
- Product Quantization (PQ) for very large indices: split vectors into subspaces, cluster each
- Compression is transparent to callers — `VectorIndex` handles it internally

---

### Phase D: Benchmark & Ecosystem Hardening (P3 — 2-3 weeks)

#### D1. Full LoCoMo + ConvoMem Benchmarks

**Plan**:
- Run full LoCoMo (not just conv-26) and publish results
- Add ConvoMem benchmark to the harness
- Side-by-side comparison table: Memorai vs Mem0 vs Zep vs Letta
- Automated benchmark regression detection in CI

#### D2. Head-to-Head Comparison Page

**Plan**:
- VitePress docs page: "Memorai vs Alternatives"
- Feature matrix: architecture, TS support, benchmarks, pricing, self-hosting
- Architecture comparison diagram showing three-tier vs Mem0's destructive summarize vs Zep's temporal graph

#### D3. DX & API Polish

**Plan**:
- `examples/` rewrite: all examples use public Event API, no `@internal` methods
- `Memorai<Ext>` generic for typed `extensions`
- 1.0 cleanup: remove `MemoryPayload` / `MemoryPayloadInput` aliases
- ESM/CJS dual build for maximum compatibility
- Bundle size analysis: target <50KB gzipped for core (tree-shakeable)

---

## Part 4 — Priority Matrix

| Item | LoCoMo Impact | Effort | Risk | Status | Priority |
|------|--------------|--------|------|--------|----------|
| A1 Temporal anchors | +10-15pp | 2w | Low | ✅ **Implemented** — `start`/`end` fix applied 2026-07-16 | **P0 — Verify** |
| A2 Weighted graph paths | +5-8pp | 1w | Low | ✅ **Implemented** — `queryPathsWeighted` + `graphPathway` | **P0 — Verify** |
| A3 Event cross-linking | +5-10pp | 1w | Medium | ✅ **Implemented** — `relatedEventIds` + identifier support | **P0 — Verify** |
| A4 LLM temporal resolution | +3-5pp | 1w | Low | ✅ **Implemented** — `resolveTemporalViaLLM` | **P0 — Verify** |
| B1 WASM vector search | — | 2w | Medium | 🔜 Not started | **P1** |
| B2 Persistent graph | — | 1w | Low | 🔜 Not started | **P1** |
| B3 Streaming ingest | — | 1w | Medium | 🔜 Not started | **P1** |
| C1 Cross-modal memory | — | 2w | High | 🔜 Not started | **P2** |
| C2 Observability | — | 1w | Low | 🔜 Not started | **P2** |
| C3 Multi-agent federation | — | 1w | High | 🔜 Not started | **P2** |
| C4 Quantization | — | 1w | Low | 🔜 Not started | **P2** |
| D1 Full benchmarks | — | 1w | Low | 🔜 Not started | **P3** |
| D2 Comparison docs | — | 1w | Low | 🔜 Not started | **P3** |
| D3 DX polish | — | 1w | Low | 🔜 Not started | **P3** |

### P0 Action: Verify Phase A Infrastructure (1 week)

Since A1-A4 are already implemented, the immediate priority is to **run benchmarks and verify** whether the infrastructure works as expected:

1. **Run LoCoMo conv-26 with current code** — establish new baseline after `start`/`end` fix
2. **Profile which questions still fail** — temporal? multi-hop? contradiction?
3. **Check if pathways are enabled in default config** — `temporalAnchorPathway`, `graphPathway` weights
4. **Tune RRF weights** — graph vs semantic vs temporal pathway fusion

If the score doesn't improve significantly (>5pp), the issue is likely:
- Benchmark configuration (wrong extractor/identifier/reranker combo)
- Integration gap (pathways not wired in default `RetrievalEngine` config)
- Parameter tuning (pathway weights, topK, threshold values)

If the score improves to 45-55%, the remaining gap is likely:
- Full LoCoMo (not conv-26) — need to run complete benchmark
- Persistent graph backend for larger datasets
- Cross-encoder reranker replacing LLMReranker

---

## Part 5 — Competitive Positioning After This Plan

| Capability | Memorai (post-plan) | Zep | Mem0 |
|------------|---------------------|-----|------|
| TypeScript-native | Yes | Yes | JS SDK |
| Browser support | **Yes + WASM ANN** | No | No |
| Temporal reasoning | **Anchors + LLM resolution** | Yes (native) | No |
| Knowledge graph | **Yes + persistent backends** | Yes (Neo4j req'd) | Optional (Pro tier) |
| Three-tier storage | **Yes (unique)** | No | No |
| Procedural memory | **Yes (unique)** | No | No |
| Re-annotation | **Yes (unique)** | No | No |
| Cross-modal | **Yes (planned)** | No | No |
| Self-hosting | **Yes, zero external deps** | Requires graph DB | Yes |
| Observability | **Yes (spans + explain)** | Limited | Limited |
| LoCoMo (projected) | **65-75%** | 75-85% | ~64% |
| LongMemEval | **92%** | 64-71% | 49% |

**The narrative**: Memorai becomes the only memory library that is (1) fully TypeScript-native, (2) runs in the browser with production-grade ANN, (3) preserves raw data for re-annotation, (4) supports procedural/cross-modal memory, and (5) competes on accuracy without requiring external graph databases.

---

## Part 6 — Recommended New Skills to Acquire

Based on the research, these additional MCP servers/tools would accelerate execution:

1. **Qdrant MCP** (`qdrant-mcp`) — For benchmarking Memorai's vector search against a production-grade ANN backend. Useful for validating HNSW recall/latency.
2. **Neo4j MCP** (`neo4j-contrib/mcp-neo4j`) — For testing graph queries, comparing Cypher path search against Memorai's BFS/PPR implementations.
3. **USearch benchmark harness** — For WASM vector search performance validation in browser environment.

---

*Sources:*
- [Mem0 vs Zep vs LangMem vs MemoClaw: AI Agent Memory Comparison 2026](https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k)
- [AI Agent Memory Systems in 2026: Mem0, Zep, Hindsight, Memvid](https://blog.devgenius.io/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Vector Database News April 2026: MCP Arrives](https://ranksquire.com/2026/05/01/vector-database-news-april-2026/)
- [WebANNS: Fast ANN Search in Web Browsers](https://arxiv.org/html/2507.00521)
- [RAG Complete Guide 2026: GraphRAG, Agentic Memory](https://timewell.jp/en/columns/ai-rag-agi)
- [Agent Memory vs RAG: What Breaks at Scale 2026](https://ranksquire.com/2026/03/31/agent-memory-vs-rag-what-breaks-at-scale-2026/)
- [Awesome-GraphMemory: Graph-based Agent Memory Survey](https://github.com/DEEP-PolyU/Awesome-GraphMemory)
