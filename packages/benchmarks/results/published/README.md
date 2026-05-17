# Published Benchmark Results

This directory contains the canonical benchmark runs committed alongside Memorai's published versions. Day-to-day runs land in the parent `results/` directory (gitignored); only runs we want to cite go here.

## 2026-05-17 — Memorai 0.4.0 (MemoryEvent layer)

0.4.0 introduces the **MemoryEvent layer** (Tier 2.5): a fact-centric record extracted by an `EventIdentifier` and stored alongside raw MemoryNodes. Each event is one of three kinds — `state` (assertion that persists, can be superseded), `transition` (state change), or `happening` (anchored occurrence). Recall fuses raw-node retrieval with event-level retrieval via RRF and dedupes node hits backed by surfaced events.

### Headline (LoCoMo conv-26, full 152 QAs, default filter)

| Run | Accuracy | Δ vs 0.3.0 wrap | Ingest time | Notes |
|-----|---------:|----------------:|------------:|:------|
| 0.3.0 wrap | 21.71% (33/152) | — | 7.1 min | raw-text baseline |
| 0.3.0 llm (extract per turn) | 23.03% (35/152) | +1.3 | 51.0 min | LLM extraction only |
| **0.4.0 wrap + identifier llm** | **36.84% (56/152)** | **+15.1** | **17.9 min** | wrap raw + LLM event identification |
| 0.4.0 llm + identifier llm | 32.89% (50/152) | +11.2 | 71.9 min | both LLM stages |

**The MemoryEvent identifier alone (no LLM during extraction) beats the 0.3.0 LLM-extraction pipeline by 13.8pp AND runs ~3× faster** — one LLM call per session-boundary identification batch (~14 calls/conv) instead of one per raw turn (~419 calls/conv).

**Adding LLM extraction *on top of* identification is counterproductive** on this sample: -3.9pp vs identifier-only. Probable reasons: the LLM-extracted `annotations.summary` competes with the event-level canonical description in the composed embedding, and the answerer sees a noisier candidate set.

#### Per-category breakdown

| Category | 0.3.0 wrap | 0.3.0 llm | **0.4.0 wrap + id** | 0.4.0 llm + id |
|----------|-----------:|----------:|--------------------:|---------------:|
| multi_hop | 23.1% (3/13) | 38.5% (5/13) | **30.8%** (4/13) | 38.5% (5/13) |
| single_hop | 12.5% (4/32) | 15.6% (5/32) | **21.9%** (7/32) | 25.0% (8/32) |
| temporal | 2.7% (1/37) | 5.4% (2/37) | **8.1%** (3/37) | 8.1% (3/37) |
| open_domain | 35.7% (25/70) | 32.9% (23/70) | **60.0%** (42/70) | 48.6% (34/70) |

**Open-domain doubled** (35.7% → 60.0% with wrap+id), and every category climbed. Temporal still trails — timestamp reasoning isn't an extraction problem.

### LongMemEval oracle (first 20q)

| Run | Accuracy | Δ |
|-----|---------:|---:|
| 0.3.0 baseline | 60% (12/20) | — |
| **0.4.0 + identifier llm** | **75% (15/20)** | **+15.0pp** |

Oracle split is pre-filtered context — measures the downstream pipeline. The +15pp lift here comes from the event layer giving the answerer canonical state assertions to ground on, instead of asking it to assemble facts from raw turns.

### Configuration used

- Memorai 0.4.0 (MemoryEvent layer)
- Embedder: `nomic-embed-text` via Ollama (768-d)
- Extractor: `WrapExtractor` (no LLM during ingest extraction) for the headline run
- Event identifier: `LLMEventIdentifier` with `gemma4:31b-cloud` (Google Gemma 31B, hosted)
- Answerer: `gemma4:31b-cloud`
- Judge: `qwen3-coder-next:cloud` (different family — Alibaba Qwen)
- Top-K: 30
- Storage: in-memory; identifier batch size 30; one identification pass per session

### How to reproduce

```bash
pnpm --filter @memorai/benchmarks bench:locomo \
  --limit 1 \
  --extractor wrap \
  --identifier llm \
  --identifier-model gemma4:31b-cloud \
  --answerer-model gemma4:31b-cloud \
  --judge-model qwen3-coder-next:cloud
```

### Caveats

- Single conversation (conv-26 of 10). Cross-conv aggregate not yet run.
- Single seed per run; LLM-as-judge is non-deterministic; expect ±2pp run-to-run noise.
- The Gap to mem0's published full-LLM pipeline (65–70%) is still ~30pp on this slice. Identified next levers: cross-conv aggregation, stronger answerer (gpt-4o), domain-tuned identifier prompts.
- 0.4.0 has a known issue: combining `--extractor llm` with `--identifier llm` underperforms identifier-alone. Recommendation for v1: ship `--extractor wrap --identifier llm` as the default.

## 2026-05-17 — Memorai 0.3.0 (three-tier raw + annotations + indexes)

0.3.0 splits `MemoryNode` into immutable Tier 1 `raw` (the canonical timeline) and regenerable Tier 2 `annotations`. Tier 3 indexes (BM25 / vector / tag / time) are rebuilt automatically from both tiers by the storage adapter. The new `Memorai.reAnnotate()` method regenerates Tier 2 + Tier 3 over the existing store from the immutable Tier 1 — letting you upgrade the extractor or switch embedding models without losing the source timeline.

Indexing now uses `composeIndexableText(raw, annotations)` (raw text + summary + facts + tags, deduplicated) instead of just the summary. This is what changes the retrieval behavior at the per-query level.

### Headline (full conv-26, 152 QAs, default filter)

| Run | Accuracy | multi_hop | single_hop | temporal | open_domain | Ingest time |
|-----|---------:|----------:|-----------:|---------:|------------:|------------:|
| [`locomo-wrap-conv26-full-0.3.0.md`](./locomo-wrap-conv26-full-0.3.0.md) — `--extractor wrap` | **21.71%** (33/152) | 23.1% (3/13) | 12.5% (4/32) | 2.7% (1/37) | 35.7% (25/70) | 7.1 min |
| [`locomo-llm-conv26-full-0.3.0.md`](./locomo-llm-conv26-full-0.3.0.md) — `--extractor llm --extractor-model gemma4:31b-cloud` | **23.03%** (35/152) | **38.5%** (5/13) | 15.6% (5/32) | 5.4% (2/37) | 32.9% (23/70) | 51.0 min |

**The LLM extractor adds ~1.3pp overall, concentrated in `multi_hop` (+15.4pp).** Open-domain is essentially flat (and slightly *lower* with LLM — the canonical paraphrase moves further from the literal query text). Temporal stays terrible (timestamp reasoning is a separate problem from extraction quality). The 7x ingest cost is real and the headline isn't a magic bullet — but the multi-hop lift is a clean signal that LLM-extracted facts do enable cross-session reasoning that wrap mode literally cannot do.

For reference, mem0's published LoCoMo numbers are 25–45% for RAG-only configurations and 65–70% for their full LLM-extraction pipeline. We sit at the lower edge of their RAG range with `--extractor llm`. The gap to 65–70% is in **(a)** model strength (gemma4:31b-cloud vs OpenAI for the answerer), **(b)** prompt engineering of the extractor, and **(c)** running across all 10 conversations (we only ran conv-26 — 1986 QAs across 10 is the published comparison shape).

### Smoke runs (first 30 QAs only)

| File | Configuration | Headline |
|------|---------------|----------|
| [`custom-0.3.0.md`](./custom-0.3.0.md) | 8-test custom synthetic suite | 95.5% aggregate (vs 97.5% on 0.2.0). Drift is two stochastic Needle/Multi-Needle trials; six tests still 100%. |
| [`locomo-wrap-30q-rrf-0.3.0.md`](./locomo-wrap-30q-rrf-0.3.0.md) | LoCoMo conv-26, first 30 QAs, `--extractor wrap --reranker none` | 13.33% (4/30) — first 30 QAs happen to be 30/30 in default categories (no adversarial), so this number is valid. Comparable to the 0.2.0 baseline of 4/30. |
| [`locomo-wrap-30q-rerank-0.3.0.md`](./locomo-wrap-30q-rerank-0.3.0.md) | Same + `--reranker llm` | 13.33% (4/30). LLM rerank no-op at N=30. |
| [`longmemeval-oracle-20q-rrf-0.3.0.md`](./longmemeval-oracle-20q-rrf-0.3.0.md) | LongMemEval oracle, first 20 q | 60% (12/20) — matches 0.2.0. Oracle split measures the downstream pipeline only. |

### Bug fix — category filter

The full-conv-26 runs above surfaced a pre-existing bug in `packages/benchmarks/src/benchmarks/locomo/run.ts`: the `--categories` default (`["single_hop", "temporal", "multi_hop", "open_domain"]`, i.e. exclude adversarial) was being clobbered by a trailing `...opts` spread that restored `undefined`. Smoke runs slicing the first 30 QAs were not affected because conv-26's first 30 happen to all fall into default categories. Full-conv runs *do* trip on it. Fixed in this PR — runner now spreads opts first, then applies defaults.

### Configuration used

- Memorai 0.3.0 (three-tier storage)
- Embedder: `nomic-embed-text` via Ollama (768-d)
- Extractor LLM (when `--extractor llm`): `gemma4:31b-cloud` (Google Gemma 31B, hosted)
- Answerer LLM: `gemma4:31b-cloud`
- Judge LLM: `qwen3-coder-next:cloud` (Alibaba Qwen 80B — different family from answerer)
- Top-K: 30
- Storage: in-memory `MemoryAdapter` (per-conversation isolated)
- Evolution: `mode: "manual"` with `evolve()` after each session

### Caveats

- All runs are on conv-26 only (1 of 10 LoCoMo conversations). Cross-conv aggregate is the publishable comparison shape and not yet run.
- Single-run numbers, no `mean ± stddev` over multiple seeds. LLM judges are non-deterministic at temp=0.
- `--extractor llm` ran a 31B model for 419 ingest calls + 199 retrieval/answer/judge cycles in 51 minutes. Smaller extractor models would be faster but lose extraction quality; this is the speed/quality trade-off the published number sits at.

## 2026-05-17 — Memorai 0.2.0 (multi-pathway retrieval)

The big change in 0.2.0 is the **multi-pathway retrieval layer**: every recall now runs semantic + BM25 + tag + temporal + identity (userId/actor/target) routes in parallel, fuses them via Reciprocal Rank Fusion, and tags every returned memory with the routes that surfaced it (`provenance.pathways`). Optional precision layers — LLM reranker, query expansion, and HyDE — sit on top of the fusion.

| File | Configuration | Headline |
|------|---------------|----------|
| [`custom-2026-05-17.md`](./custom-2026-05-17.md) | 8-test custom synthetic suite | **97.5%** aggregate (was 92.9% in 0.1.0). Multi-Needle 100% (was 68.9%), Needle-Haystack 100% (was 94.3%). |
| [`locomo-wrap-30q-rrf-2026-05-17.md`](./locomo-wrap-30q-rrf-2026-05-17.md) | LoCoMo conv-26, first 30 QAs, `--extractor wrap` | **13.33%** (4/30) — **4× improvement over the 0.1.0 baseline of 3.33%**. single_hop 20%, temporal 12.5%, multi_hop 0%. F1 0.105 / BLEU-1 0.071 (3× the 0.1.0 numbers). |
| [`locomo-wrap-30q-rerank-2026-05-17.md`](./locomo-wrap-30q-rerank-2026-05-17.md) | Same + `--reranker llm` | 13.33% overall (unchanged), but multi_hop jumped 0% → 25%, temporal dipped 12.5% → 6.3% — rerank trades precision across categories. |
| [`locomo-wrap-30q-fullstack-2026-05-17.md`](./locomo-wrap-30q-fullstack-2026-05-17.md) | Same + `--reranker llm --query-expansion 3 --hyde` | 13.33% overall — the full LLM-precision stack does not push past the RRF baseline at N=30 on conv-26. Useful as a cost-control reference: the LLM-only additions roughly 2× the wall time without moving the binary accuracy. |
| [`longmemeval-oracle-20q-rrf-2026-05-17.md`](./longmemeval-oracle-20q-rrf-2026-05-17.md) | LongMemEval oracle, first 20 q | **60%** (12/20) — up from 55% in 0.1.0. Latency also halved (140s → 77s). |
| [`ollama-cloud-model-audit-2026-05-16.md`](./ollama-cloud-model-audit-2026-05-16.md) | Judge model selection | Unchanged from 0.1.0. |

### Configuration used

- Memorai 0.2.0 (multi-pathway retrieval)
- Embedder: `nomic-embed-text` via Ollama (768-d)
- Answerer LLM: `gemma4:31b-cloud` (Google Gemma)
- Judge LLM: `qwen3-coder-next:cloud` (Alibaba Qwen — different family from answerer)
- Top-K: 30 (pre-rerank), 30 (post-rerank)
- Storage: in-memory `MemoryAdapter` (per-conversation isolated instances)
- Evolution: `mode: "manual"` (benchmark-deterministic) with `evolve()` after each session

### What the numbers actually show

1. **RRF + BM25 is the single biggest lift.** Going from cosine-only retrieval to multi-pathway fusion (PR-1) drove LoCoMo wrap from 3.33% to 13.33% — a 4× improvement with **zero extra LLM cost at recall time**. The wrap mode (no LLM during ingest) is the cleanest comparison.
2. **Reranker shifts categories without changing the total at N=30.** LLM rerank lifted multi_hop from 0% to 25% but cost a temporal QA. The total stays 4/30. At larger N this should stabilize but we don't have the data yet.
3. **Query expansion + HyDE didn't beat the rerank-only run at N=30.** The full LLM stack roughly doubles wall-clock with no binary-accuracy benefit on this sample. Both flags are still useful escape hatches for harder workloads, but they're not free wins.
4. **The custom suite numbers tell a cleaner story.** Multi-pathway fusion pushed two synthetic retrieval tasks from low-90s to a perfect 100% — confirming that BM25 was missing real recall before. Multimodal-Recall is the one remaining gap (80%, the PDF file-ref case).

### Caveats

- N=30 LoCoMo and N=20 LongMemEval are smoke runs, not benchmark numbers. The full LoCoMo (1986 QAs across 10 conversations) and full LongMemEval (500 questions) are not in this round.
- LongMemEval oracle still measures *only the downstream pipeline* — it hands you a pre-filtered haystack. The `_s` split (115K tokens with distractor sessions) is the real retrieval test and is not yet run.
- All `--extractor wrap` runs. The `--extractor llm` path (mem0/Letta comparison shape) is still slow on local hardware and not in this round.

## 2026-05-16 — Memorai 0.1.0 (Event API baseline)

| File | What it captures |
|------|------------------|
| [`custom-2026-05-16.md`](./custom-2026-05-16.md) / `.json` | Full 8-test custom synthetic suite. Aggregate 92.9%. Multimodal Recall 80%, Time-Window Recall 100%, the rest 94–100%. |
| [`locomo-wrap-30q-2026-05-16.md`](./locomo-wrap-30q-2026-05-16.md) / `.json` | LoCoMo conv-26, first 30 QAs, `--extractor wrap`. Accuracy 3.33% (1/30). Documents the cosine-only baseline before the multi-pathway retrieval layer landed. |
| [`longmemeval-oracle-20q-2026-05-16.md`](./longmemeval-oracle-20q-2026-05-16.md) / `.json` | LongMemEval oracle split, first 20 questions. Accuracy 55% (11/20). |
| [`ollama-cloud-model-audit-2026-05-16.md`](./ollama-cloud-model-audit-2026-05-16.md) | Audit of all 18 Ollama-cloud models. |

See [`/guide/benchmarks`](https://memorai-docs/guide/benchmarks) on the docs site for full methodology, reproduction commands, and the open caveats list.
