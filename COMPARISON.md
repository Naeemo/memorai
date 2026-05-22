# Memorai vs Alternatives

An honest, feature-level comparison of agent memory libraries.

| Capability | Memorai | Zep | Mem0 |
|------------|---------|-----|------|
| **TypeScript-native** | Yes | Yes | JS SDK |
| **Browser support** | **Yes + WASM ANN** | No | No |
| **Three-tier storage** | **Yes (raw → annotations → indexes)** | No (flat) | No (summarize-and-drop) |
| **Temporal reasoning** | **Anchors + LLM resolution** | Native graph | No |
| **Knowledge graph** | **Yes + persistent backends** | Requires Neo4j | Optional (Pro tier) |
| **Procedural memory** | **Yes (HME: segment → action → episode)** | No | No |
| **Re-annotation** | **Yes (Tier 2 regeneration)** | No | No |
| **Cross-modal memory** | **Yes (caption → text pipeline)** | No | No |
| **Streaming ingest** | **Yes (backpressure + batching)** | No | No |
| **Observability** | **explain() + onRecall spans** | Limited | Limited |
| **Multi-agent federation** | **subscribe + MemoryFederation** | No | No |
| **Embedding quantization** | **ScalarQuantizer (f32 → i8/f16)** | No | No |
| **Self-hosting** | **Yes, zero external deps** | Requires graph DB | Yes |
| **Bundle size (core)** | ~45KB gzipped | N/A (server-only) | ~30KB gzipped |

## Architecture Comparison

### Memorai: Three-Tier Storage

```
Tier 1: Raw timeline (immutable, append-only)
  └─ Event content verbatim + media refs

Tier 2: Annotations (re-extractable)
  └─ Summary, facts, triples, temporal anchors, embeddings

Tier 3: Indexes (rebuildable)
  └─ Vector index, BM25, graph, temporal anchor index
```

**Why it matters**: You can change extractors, re-annotate everything, or swap vector backends without losing data. Tier 1 is sacred; Tiers 2-3 are disposable.

### Zep: Temporal Graph

```
Graph-centric: entities + relations in Neo4j
Sessions: conversation-level grouping
```

**Tradeoff**: Strong temporal reasoning and graph queries, but requires Neo4j (not browser-friendly) and lacks the raw/annotation separation — summarized data is destructive.

### Mem0: Summarize-and-Store

```
Extract facts → store as memories
Retrieve via embedding cosine
```

**Tradeoff**: Simple API, good for quick prototypes. Loses raw conversation history (can't re-extract), no graph, no temporal reasoning beyond recency bias.

## Benchmarks

| Benchmark | Memorai | Zep | Mem0 |
|-----------|---------|-----|------|
| LoCoMo conv-26 | 33.55% | ~35% | ~15% |
| LongMemEval | 92% | — | — |

> Benchmarks run with Kimi K2.6 via OpenAI-compatible API. See `packages/benchmarks/` for full methodology.

## When to Choose Each

**Choose Memorai when:**
- You need browser + Node.js from the same library
- You want persistent knowledge graphs without Neo4j
- Temporal reasoning ("before the migration", "after Alice arrived") matters
- You need to audit why a memory was recalled (`explain()`)
- You're building multi-agent systems that share memory

**Choose Zep when:**
- You're already invested in Neo4j
- You need enterprise-grade graph analytics (Cypher queries)
- Browser support is not a requirement

**Choose Mem0 when:**
- You want the simplest possible API
- You're building a quick prototype
- You don't need graphs, temporal reasoning, or browser support
