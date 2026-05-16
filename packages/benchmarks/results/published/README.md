# Published Benchmark Results

This directory contains the canonical benchmark runs committed alongside Memorai's published versions. Day-to-day runs land in the parent `results/` directory (gitignored); only runs we want to cite go here.

## 2026-05-16 — Memorai 0.1.0

| File | What it captures |
|------|------------------|
| [`custom-2026-05-16.md`](./custom-2026-05-16.md) / `.json` | Full 8-test custom synthetic suite. Aggregate 92.9%. Multimodal Recall 80%, Time-Window Recall 100%, the rest 94–100%. |
| [`locomo-wrap-30q-2026-05-16.md`](./locomo-wrap-30q-2026-05-16.md) / `.json` | LoCoMo conv-26, first 30 QAs, `--extractor wrap` (no LLM during ingest). Accuracy 3.33% (1/30). Documents the baseline of "no extraction" against a real-world chat dataset. |
| [`longmemeval-oracle-20q-2026-05-16.md`](./longmemeval-oracle-20q-2026-05-16.md) / `.json` | LongMemEval oracle split, first 20 questions (all temporal-reasoning). Accuracy 55% (11/20). The oracle split provides ground-truth context to the haystack, so this isolates Memorai's answer-generation + judging quality from its retrieval quality. |
| [`ollama-cloud-model-audit-2026-05-16.md`](./ollama-cloud-model-audit-2026-05-16.md) | Audit of all 18 Ollama-cloud models for free-tier accessibility and judge-task suitability. Picked `qwen3-coder-next:cloud` as the default judge to avoid same-family bias with the Gemma answerer. |

### Configuration used

- Memorai 0.1.0
- Embedder: `nomic-embed-text` via Ollama (768-d)
- Answerer LLM: `gemma4:31b-cloud` (Google Gemma)
- Judge LLM: `qwen3-coder-next:cloud` (Alibaba Qwen — different family from answerer)
- Top-K: 30
- Storage: in-memory `MemoryAdapter` (per-conversation isolated instances)
- Evolution: `mode: "manual"` (benchmark-deterministic) with `evolve()` after each session

### Caveats on these numbers

The LoCoMo `--extractor wrap` baseline is honest but very low — the answerer mostly returns "I don't know" because raw conversational turns rarely surface in semantic retrieval for specific fact lookups. The right comparable to mem0/Zep/Letta is `--extractor llm`, which we attempted but did not finish in this round because local LLM extraction at gemma4:e2b takes ~5 s/turn × ~380 turns/conversation = ~30 min ingest. Logged here for reproduction in a longer run window.

The LongMemEval oracle smoke (55% on 20 temporal-reasoning questions) is **not** a retrieval benchmark — the oracle split feeds Memorai a small haystack of already-relevant sessions per question. It measures the downstream pipeline (ingest → recall → answerer → judge) on pre-curated context. Useful as a sanity-check that the answerer + judge work; not comparable to the full `_s` split (115K tokens with distractor sessions). The `_s` split was downloaded but not yet run.

See [`/guide/benchmarks`](https://memorai-docs/guide/benchmarks) on the docs site for full methodology, reproduction commands, and the open caveats list.
