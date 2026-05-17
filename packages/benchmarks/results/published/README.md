# Published Benchmark Results

This directory contains the canonical benchmark runs committed alongside Memorai's published versions. Day-to-day runs land in the parent `results/` directory (gitignored); only runs we want to cite go here.

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
