# Benchmarks

Memorai ships with a built-in benchmark suite that measures retrieval accuracy, hierarchical evolution quality, temporal query precision, scalability, and cross-agent isolation.

## Running Benchmarks

```bash
cd packages/memorai
pnpm add -D tsx
pnpm exec tsx benchmarks/index.ts
```

Requirements:
- [Ollama](https://ollama.com) running locally
- `nomic-embed-text` model pulled (`ollama pull nomic-embed-text`)
- `gemma4:31b-cloud` or another generation-capable model for LLM-as-judge evaluation

## Benchmark Suite

### Needle-in-a-Haystack

Tests whether a single critical fact (the "needle") can be retrieved from an increasingly large corpus of distractor memories (the "haystack"). Corpus sizes tested: 10, 50, 100, 250.

**Result: 100%** — the needle is ranked #1 in all corpus sizes.

### Multi-Needle Retrieval

Tests recall when multiple distinct needles are hidden in a 100-item corpus. Tests with 1, 3, and 5 simultaneous needles.

**Result: 100%** — all needles retrieved in top-K results.

### Hierarchical Evolution Preservation

Writes segments, triggers Level-2 evolution (atomic_action → event), then queries at the event level to verify that abstracted long-term memories still contain the original facts.

**Result: 100%** — full preservation ratio after evolution.

### Temporal Retrieval

Writes 60 timestamped memories spanning 24 hours, then queries random 4-hour windows to measure recall of memories within the requested time range.

**Result: 100%** — perfect time-range filtering accuracy.

### Scalability

Measures write throughput and retrieval latency at corpus sizes: 50, 100, 250, 500, 1,000.

**Result: 100%** — retrieval stays under 35ms even at 1,000 memories. Batch writes are **2.3× faster** than sequential writes thanks to parallelized embedding generation.

### Cross-Agent Isolation

Three agents (alpha, beta, gamma) each write 30 memories. Queries as each agent verify that only the querying agent's memories are returned.

**Result: 100%** — perfect isolation per agent profile.

## Latest Results

| Benchmark | Score | Latency |
|-----------|-------|---------|
| Needle-in-a-Haystack | 100% | 25ms |
| Multi-Needle Retrieval | 100% | 19ms |
| Hierarchical Evolution Preservation | 100% | 29ms |
| Temporal Retrieval | 100% | 16ms |
| Scalability | 100% | 25ms |
| Cross-Agent Isolation | 100% | 13ms |

**Overall Score: 100%** · **Run Date: 2026-05-15**

## Optimization History

| Change | Impact |
|--------|--------|
| Level fallback in retrieval | Fixed empty results when no events exist yet |
| Time-range filtering | Fixed temporal queries returning out-of-range memories |
| Heap-based top-K semantic search | O(N log K) vs O(N log N) for large corpora |
| Tag index in MemoryAdapter | O(1) tag lookup vs O(N) linear scan |
| Batch embedding parallelization | 2.3× speedup for bulk ingestion |
