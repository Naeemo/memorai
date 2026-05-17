# locomo — memorai

**Run at:** 2026-05-17T04:58:10.300Z
**Duration:** 3060.0s
**Provider:** memorai
**Ingest mode:** llm (extractor: `gemma4:31b-cloud`)
**Embedder:** ollama
**Answerer model:** ollama:gemma4:31b-cloud
**Judge model:** ollama:qwen3-coder-next:cloud

**Conversations:** 1 (conv-26)
**Total QAs (raw):** 199
**Default-filter QAs (excludes adversarial, matches mem0 convention):** 152
**Correct (default filter):** 35
**Accuracy (default filter):** 23.03%

## By category (default filter — excludes adversarial)

| Category | Count | Correct | Accuracy |
|----------|-------|---------|----------|
| multi_hop | 13 | 5 | 38.5% |
| open_domain | 70 | 23 | 32.9% |
| single_hop | 32 | 5 | 15.6% |
| temporal | 37 | 2 | 5.4% |

## Including adversarial (raw result)

| Category | Count | Correct | Accuracy | F1 | BLEU-1 |
|----------|-------|---------|----------|-----|--------|
| adversarial | 47 | 29 | 61.7% | 0.000 | 0.000 |
| multi_hop | 13 | 5 | 38.5% | 0.094 | 0.063 |
| open_domain | 70 | 23 | 32.9% | 0.163 | 0.120 |
| single_hop | 32 | 5 | 15.6% | 0.123 | 0.083 |
| temporal | 37 | 2 | 5.4% | 0.037 | 0.028 |
| **All** | **199** | **64** | **32.16%** | — | — |

## Caveat

The raw run included adversarial QAs because of a now-fixed bug in `packages/benchmarks/src/benchmarks/locomo/run.ts` (the `--categories` spread was being overridden by `...opts`, restoring `undefined` and disabling the filter). The per-category metrics above are valid; the default-filter rollup is computed post-hoc from the raw per-record JSON. A fresh re-run with the fixed CLI should reproduce the 152-QA filtered number within judge noise.

## Comparison vs wrap mode

See [`locomo-wrap-conv26-full-0.3.0.md`](./locomo-wrap-conv26-full-0.3.0.md) for the matched wrap-mode baseline on the same conv (152 QAs, 21.71%). The LLM extractor adds ~1.3 percentage points overall (35/152 vs 33/152), concentrated in `multi_hop` (38.5% vs 23.1%, +15.4pp) — exactly where LLM-extracted canonical facts help the most. Single-hop and open-domain are roughly tied. Temporal is still terrible (5.4% vs 2.7%) — the LLM doesn't help with timestamp reasoning, which is a separate retrieval/answer problem.
