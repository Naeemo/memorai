# Benchmarks

Memorai is benchmarked from a sibling workspace package, `@memorai/benchmarks`, against two complementary suites:

- **Custom synthetic** (8 tests) — exercises Memorai's internals: retrieval, evolution, isolation, scalability, multimodal payload preservation, time-window queries
- **Public datasets** — [LoCoMo](https://github.com/snap-research/locomo) (CC-BY-4.0) and [LongMemEval](https://github.com/xiaowu0162/longmemeval) (MIT), the same datasets used by mem0, Zep, Letta, MemPalace, MemMachine, and Mastra

[ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem) was evaluated and removed from the harness: its CC-BY-NC-4.0 license blocks any commercial use of derived numbers, and the package targets a commercial-friendly publication path.

Canonical results are committed under [`packages/benchmarks/results/published/`](https://github.com/Naeemo/memorai/tree/main/packages/benchmarks/results/published) — `*.md` for human reading, `*.json` for machine-readable record. Day-to-day runs land in the (gitignored) parent `results/` directory.

## Running benchmarks

```bash
pnpm install

# custom suite (8 benchmarks, ~10 min on Apple Silicon + Ollama)
pnpm --filter @memorai/benchmarks bench:custom

# fetch and smoke-test a public dataset
pnpm --filter @memorai/benchmarks bench:fetch locomo
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30
```

**Requirements**

- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`, override with `OLLAMA_HOST`)
- `nomic-embed-text` model pulled: `ollama pull nomic-embed-text`
- For the LLM-as-judge pipeline: either a generation-capable Ollama model (`gemma4:31b-cloud` answerer + `qwen3-coder-next:cloud` judge are the defaults — different model families to avoid self-judgment bias) **or** `OPENAI_API_KEY=sk-...` to use `gpt-4o-mini` for both.
- When `huggingface.co` is unreachable (e.g. from China), set `HF_ENDPOINT=https://hf-mirror.com` before `pnpm bench:fetch longmemeval`. The fetcher honours the standard `HF_ENDPOINT` env var.

## Custom synthetic suite

These tests exercise Memorai's distinctive design points — hierarchical evolution, multi-strategy retrieval, multimodal payload, time-window queries, cross-agent isolation — independent of any third-party dataset.

| Benchmark | What it tests |
|-----------|---------------|
| Needle-in-a-Haystack | Single critical fact retrieval across corpus sizes 10, 50, 100, 250 |
| Multi-Needle Retrieval | Recall when 1, 3, or 5 distinct needles share a 100-item corpus |
| Hierarchical Evolution Preservation | Segment → atomic_action → episode aggregation retains the original facts |
| Temporal Retrieval | Time-range queries return only in-window memories |
| Scalability | Write throughput + retrieval latency at sizes 50, 100, 250, 500, 1,000 |
| Cross-Agent Isolation | Per-agent `agentProfile` keeps three agents' memories disjoint |
| **Multimodal Recall** | image / audio / video / file event refs survive `recordEvent` → evolve → `recall` |
| **Time-Window Recall** | `recallByTime({start,end})` returns only in-window events across a 24h span |

The last two ("Multimodal Recall" and "Time-Window Recall") were added in 0.1.0 to cover Memorai's differentiated surfaces (multimodal payload preservation and the public `recallByTime` API) that the public chat benchmarks don't reach.

## Public benchmarks

The benchmarks package ships runners + dataset loaders + a `MemoryProvider` abstraction. Memorai is the default provider; a `naive-rag` baseline (cosine over per-user embeddings) is bundled for comparison.

| Suite | Source | License | What it tests |
|-------|--------|---------|---------------|
| LoCoMo | [snap-research/locomo](https://github.com/snap-research/locomo) — ACL 2024 | CC-BY-4.0 | 10 long conversations, 1,500+ QAs across single-hop, multi-hop, open-domain, temporal, adversarial |
| LongMemEval | [xiaowu0162/longmemeval](https://github.com/xiaowu0162/longmemeval) — ICLR 2025 | MIT | 500 QAs across information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention |
| ~~ConvoMem~~ | ~~Salesforce~~ | ~~CC-BY-NC-4.0~~ | Removed: non-commercial license |

### Pipeline

For each QA, the harness:

1. **Resets** the provider for the conversation's `userId`
2. **Ingests** every turn in every session by calling `Memorai.recordEvents(events)` — events are time-anchored (`at`/`during`) and actor-tagged (`user`/`assistant`)
3. **Queries** with `Memorai.recall(question, { userId, topK: 30, strategy: "factual" })`
4. **Generates** a one-sentence prediction with an answerer LLM seeing only the retrieved memories
5. **Judges** the prediction vs. the gold with a strict binary `CORRECT | INCORRECT` LLM judge

Per-category accuracy, token-level F1, and BLEU-1 are reported alongside avg/p95 query latency.

### Extractor modes

Memorai's `recordEvent` runs through an `Extractor` that converts the raw event into a structured `WritePayload`. The benchmark supports two modes:

- **`wrap`** (default) — `WrapExtractor` passes the text through as-is. No LLM call during ingest. Measures Memorai's storage + retrieval + evolution layer in isolation. Fast.
- **`llm`** — `LLMExtractor` calls a small Ollama model (default `gemma4:e2b`) to produce a structured `{summary, tags, salience}` per event. Slower, but matches what mem0/Letta do internally and is the right path for a head-to-head comparison with their published numbers.

```bash
# baseline (wrap)
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30

# with LLM extraction (slow — ~30 min for one LoCoMo conv at 380 turns)
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30 --extractor llm
```

### Judge ≠ answerer model family

LLM-as-judge biases toward outputs from its own model family. The harness defaults pair:

| Role | Default | Family |
|------|---------|--------|
| Answerer | `gemma4:31b-cloud` | Google Gemma |
| Judge | `qwen3-coder-next:cloud` | Alibaba Qwen |

This was the only pair we found on the Ollama Cloud free tier that satisfies "different family + fast + reliable judging" (tested 18 cloud models, see [the model audit](https://github.com/Naeemo/memorai/blob/main/packages/benchmarks/results/published/ollama-cloud-model-audit-2026-05-16.md)). Override either side with `--judge-model` / `--answerer-model` or env vars `JUDGE_MODEL` / `ANSWERER_MODEL`.

### Reproducing a published run

```bash
# everything: install deps, fetch datasets, run the canonical configuration
pnpm install
pnpm --filter @memorai/benchmarks bench:fetch locomo

# Custom suite (8 benchmarks)
pnpm --filter @memorai/benchmarks bench:custom

# LoCoMo, 1 conversation, 30 QAs, wrap extractor (~2 min)
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30

# Baseline: same scope but on a naive-RAG provider
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30 --provider naive-rag
```

The runner writes `results/<suite>-<provider>-<timestamp>.{json,md}` after each run. Copy chosen runs into `results/published/<name>.md` to commit them.

## Canonical results

### 2026-05-17 — Memorai 0.4.0 (MemoryEvent layer)

0.4.0 introduces the **MemoryEvent layer** (Tier 2.5): a fact-centric record extracted by an `EventIdentifier` and stored alongside raw `MemoryNode`s. Each event is one of `state` / `transition` / `happening`, with lifecycle (state events can be superseded), valid-time semantics, and graph-style participant + topic indexes. Recall fans out to both raw nodes and the event layer, fuses via RRF, and dedupes raw-node hits that an event already covers. See [`/concepts/memory-events`](/concepts/memory-events) for the data model.

#### LoCoMo — full conv-26 (152 QAs, default filter)

| Configuration | Accuracy | Ingest |
|---------------|---------:|------:|
| 0.3.0 wrap | 21.71% (33/152) | 7.1 min |
| 0.3.0 llm (extract per turn) | 23.03% (35/152) | 51.0 min |
| **0.4.0 `--extractor wrap --identifier llm`** | **36.84%** (56/152) | **17.9 min** |
| 0.4.0 `--extractor llm --identifier llm` | 32.89% (50/152) | 71.9 min |

**+15.1pp over the 0.3.0 wrap baseline.** Just turning on the event identifier — without LLM-based extraction during ingest — buys most of the lift, and runs ~3× faster than 0.3.0's LLM-extraction pipeline. The cost is ~14 identifier calls per conversation (one per session boundary), compared with ~419 extractor calls for LLM extraction.

**Combining LLM extraction with the identifier is worse on this sample** (32.89% < 36.84%). The composed embedding accumulates the LLM-extracted `summary` alongside the event-level canonical description, and the answerer ends up with a noisier candidate set. Recommendation: ship `--extractor wrap --identifier llm` as the default config.

Per-category jumps from 0.3.0 wrap → 0.4.0 wrap + identifier:

| Category | 0.3.0 wrap | 0.4.0 wrap + id | Δ |
|----------|-----------:|----------------:|--:|
| multi_hop | 23.1% (3/13) | 30.8% (4/13) | +7.7 |
| single_hop | 12.5% (4/32) | 21.9% (7/32) | +9.4 |
| temporal | 2.7% (1/37) | 8.1% (3/37) | +5.4 |
| open_domain | 35.7% (25/70) | 60.0% (42/70) | **+24.3** |

Open-domain almost doubles. Temporal still trails — extraction quality doesn't fix timestamp reasoning, that's a separate retrieval/answer problem.

For context: mem0 reports 25–45% on LoCoMo for RAG configurations and 65–70% for their full LLM-extraction pipeline. We now sit **mid-range of their RAG band on a single conversation**. The remaining gap to 65–70% is mostly cross-conv aggregation (we ran 1 of 10) plus answerer-model strength (gemma 31B vs OpenAI gpt-4o).

#### LongMemEval oracle — 20 questions

| Configuration | Accuracy |
|---------------|---------:|
| 0.3.0 baseline | 60% (12/20) |
| **0.4.0 + identifier llm** | **75% (15/20)** |

+15pp lift. Oracle split is pre-filtered context, so this measures the downstream pipeline. The improvement comes from the event layer giving the answerer canonical state assertions instead of raw turns to ground on.

#### Reproducing the headline

```bash
pnpm --filter @memorai/benchmarks bench:locomo \
  --limit 1 \
  --extractor wrap \
  --identifier llm \
  --identifier-model gemma4:31b-cloud \
  --answerer-model gemma4:31b-cloud \
  --judge-model qwen3-coder-next:cloud
```

### 2026-05-17 — Memorai 0.3.0 (three-tier raw + annotations + indexes)

0.3.0 splits `MemoryNode` into immutable Tier 1 `raw` and regenerable Tier 2 `annotations`. Tier 3 indexes (BM25 / vector / tag / time) rebuild automatically from both. The new `Memorai.reAnnotate()` regenerates Tier 2 + Tier 3 over the existing store from the immutable Tier 1 — letting you upgrade the extractor or switch embedding models without losing the source timeline.

Indexing now uses `composeIndexableText(raw, annotations)` (raw text + summary + facts + tags, deduplicated) instead of just the summary.

#### LoCoMo — full conv-26 (152 QAs, default category filter)

The publishable comparison: same conv, same QAs, two extractor strategies.

| Configuration | Accuracy | multi_hop | single_hop | temporal | open_domain | Ingest time |
|---------------|---------:|----------:|-----------:|---------:|------------:|------------:|
| `--extractor wrap` | 21.71% (33/152) | 23.1% (3/13) | 12.5% (4/32) | 2.7% (1/37) | 35.7% (25/70) | 7.1 min |
| `--extractor llm --extractor-model gemma4:31b-cloud` | **23.03%** (35/152) | **38.5%** (5/13) | 15.6% (5/32) | 5.4% (2/37) | 32.9% (23/70) | 51.0 min |

**LLM extraction adds ~1.3pp overall, concentrated in `multi_hop` (+15.4pp).** That category is where canonical fact extraction matters most — wrap mode stores raw conversation turns and can't easily stitch a fact across multiple sessions, LLM extraction produces summaries / triples that retrieval can hit directly. Open-domain and single-hop are flat-ish (LLM paraphrase moves further from the literal query text, partially cancelling out). Temporal is still terrible (2.7% → 5.4%) — extraction quality doesn't fix timestamp reasoning, that's a separate retrieval/answer problem.

For context: mem0 reports 25–45% for RAG-only LoCoMo and 65–70% for their full LLM-extraction pipeline. We sit at the bottom edge of their RAG range with `--extractor llm`. The gap to 65–70% is in **(a)** model strength (gemma4:31b-cloud vs OpenAI for the answerer), **(b)** prompt engineering of the extractor, and **(c)** running across all 10 conversations (we ran only conv-26 — 1986 QAs across 10 is the published comparison shape).

#### Bug fix surfaced by these runs

The full-conv-26 runs above tripped a pre-existing bug: the `--categories` default in `packages/benchmarks/src/benchmarks/locomo/run.ts` was being clobbered by a trailing `...opts` spread, so adversarial QAs (category 5) were being included against the default filter. Fixed in this PR — runner now spreads opts first, then applies defaults. Smoke runs with `--limit-qas 30` weren't affected (conv-26's first 30 QAs happen to all fall into default categories).

#### Custom suite — `published/custom-0.3.0.md`

Aggregate **95.5%** (vs **97.5%** on 0.2.0).

| Benchmark | 0.2.0 | 0.3.0 | Notes |
|-----------|-------|-------|-------|
| Needle-in-a-Haystack | 100% | 95.5% | one n=100 trial below 0.72 similarity threshold (sim=0.589) |
| Multi-Needle Retrieval | 100% | 88.9% | one needles=3 trial at recall 0.67 |
| Evolution / Temporal / Scalability / CrossAgent / TimeWindow | 100% | 100% | — |
| Multimodal Recall | 80% | 80% | — |

The drift on the two synthetic-needle tests is single-trial noise (random distractor mix + nomic-embed-text batching nondeterminism); the other six tests are flat.

#### LongMemEval oracle — 20 questions

| Configuration | Accuracy | Latency |
|---------------|---------|---------|
| 0.2.0 | 60% (12/20) | 77s |
| **0.3.0** | **60% (12/20)** | **85s** |

Oracle split is pre-filtered — measures the downstream pipeline (Event ingest → recall → answerer → judge) on curated context, not retrieval quality.

### 2026-05-17 — Memorai 0.2.0 (multi-pathway retrieval)

0.2.0 added a multi-pathway retrieval layer: every recall now fans out to semantic + BM25 + tag + temporal + identity routes in parallel, fuses them via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), and tags every returned memory with its `provenance.pathways`. Optional LLM-driven precision layers (`--reranker llm`, `--query-expansion N`, `--hyde`) sit on top of the fusion.

#### Custom suite — `published/custom-2026-05-17.md`

Aggregate **97.5%** (up from 92.9% in 0.1.0).

| Benchmark | 0.1.0 | 0.2.0 | Δ |
|-----------|------|------|---|
| Needle-in-a-Haystack | 94.3% | **100%** | +5.7 |
| Multi-Needle Retrieval | 68.9% | **100%** | +31.1 |
| Hierarchical Evolution Preservation | 100% | 100% | — |
| Temporal Retrieval | 100% | 100% | — |
| Scalability | 100% | 100% | — |
| Cross-Agent Isolation | 100% | 100% | — |
| Multimodal Recall | 80% | 80% | — |
| Time-Window Recall | 100% | 100% | — |

Multi-Needle's 31-point jump and Needle-Haystack's 5.7-point jump confirm that BM25 was missing real recall before — the multi-pathway fusion picks up exact-token hits that pure cosine similarity was scoring below threshold.

#### LoCoMo — wrap mode, conv-26, 30 QAs

| Configuration | Accuracy | Notes |
|---------------|---------|-------|
| 0.1.0 (cosine only) | 3.33% (1/30) | 29/30 "I don't know" — retrieval bottleneck |
| 0.2.0 (RRF + BM25) | **13.33% (4/30)** | **4× lift, no extra LLM cost at recall time** |
| 0.2.0 + `--reranker llm` | 13.33% (4/30) | multi_hop 0%→25%, temporal 12.5%→6.3% — rerank shifts the categorical distribution but the total didn't move at N=30 |
| 0.2.0 + reranker + expansion + HyDE | 13.33% (4/30) | full LLM precision stack doesn't beat rerank-only at N=30; roughly 2× wall-clock |

F1 also improved: 0.000–0.286 (0.1.0) → 0.029–0.206 (0.2.0 baseline) → 0.031–0.240 (with reranker). Token-level proximity to the gold answers is up across the board even where the binary accuracy didn't move.

The headline number: **RRF + BM25 alone is responsible for the 4× improvement.** The LLM-driven precision layers (reranker, expansion, HyDE) at N=30 are mostly trading categories rather than improving the total. They're still useful escape hatches for harder workloads.

#### LongMemEval oracle — 20 questions

| Configuration | Accuracy | Latency |
|---------------|---------|---------|
| 0.1.0 | 55% (11/20) | 140s |
| 0.2.0 | **60% (12/20)** | **77s** (faster — RRF dedup is more efficient than the old naive merge) |

The oracle split feeds pre-filtered context to the answerer; this number measures the downstream pipeline (Event ingest → recall → answerer → judge), not retrieval quality. Still a useful sanity check that the multi-pathway changes didn't regress anything on the answer-generation side.

### 2026-05-16 — Memorai 0.1.0 (Event API baseline)

### Custom suite — `published/custom-2026-05-16.md`

8 of 8 tests passed end-to-end; aggregate score 92.9%.

| Benchmark | Score | Avg latency | Notes |
|-----------|-------|-------------|-------|
| Needle-in-a-Haystack | 94.3% | 23ms | one mis-rank at n=100 |
| Multi-Needle Retrieval | 68.9% | 21ms | recall drops at 5 simultaneous needles (variance, see below) |
| Hierarchical Evolution Preservation | 100% | 22ms | |
| Temporal Retrieval | 100% | 18ms | |
| Scalability | 100% | 28ms | batch writes 2.5× sequential |
| Cross-Agent Isolation | 100% | 14ms | |
| **Multimodal Recall** | 80% | 20ms | 4/5 media refs preserved; PDF file ref missed |
| **Time-Window Recall** | 100% | <1ms | precision and recall both 1.0 across 8 windows |

The Multi-Needle dip and the Needle-Haystack mis-rank are both within Ollama-embedding noise; values fluctuate ±5–15pp across runs at temperature 0 because of nomic-embed-text's batching nondeterminism. Treat these as approximate.

### LoCoMo — `published/locomo-wrap-30q-2026-05-16.md`

| Setting | Value |
|---------|-------|
| Provider | Memorai 0.1.0 |
| Extractor | `WrapExtractor` (no LLM during ingest) |
| Embedder | Ollama `nomic-embed-text` (768-d) |
| Answerer | Ollama `gemma4:31b-cloud` |
| Judge | Ollama `qwen3-coder-next:cloud` |
| Top-K | 30 |
| Conversations | 1 (`conv-26`) |
| QAs | 30 (first 30 of conv-26's 199) |
| Categories | single_hop, multi_hop, temporal, open_domain |

**Result: 3.33% accuracy (1/30)**, avg query latency 3.6s, p95 12.5s.

| Category | Count | Correct | Accuracy |
|----------|-------|---------|----------|
| single_hop | 10 | 1 | 10.0% |
| multi_hop | 4 | 0 | 0.0% |
| temporal | 16 | 0 | 0.0% |

**Why so low?** Inspection of the per-record JSON shows **29 of 30 predictions are "I don't know"** — the answerer correctly refuses when memory doesn't surface the relevant fact. The bottleneck is *retrieval*, not judging: `WrapExtractor` stores raw conversation turns, but the right turn is rarely top-30 against semantic queries like "what did Caroline research?" Single-hop fact lookups are the easiest case and where the one CORRECT hit landed ("What is Caroline's identity?" → "Caroline is a transgender woman").

This is the predictable shape of "structured-storage but no LLM extraction" baselines. Mem0's published LoCoMo paper reports 25–45% for RAG-only configurations and 65–70% for their full LLM-extraction pipeline. The 3% number here reflects an even sparser retrieval surface (no LLM-canonicalized facts at all), not a Memorai defect.

**Next step for publishable LoCoMo numbers**: run with `--extractor llm`, which routes ingest through `LLMExtractor` and produces canonical `{summary, tags, salience}` per event. That run takes ~30 min for one conversation on local hardware and is omitted from the v0.1.0 published set pending a longer benchmark window.

### LongMemEval

| Setting | Value |
|---------|-------|
| Provider | Memorai 0.1.0 |
| Split | `oracle` (each question's haystack is the ground-truth context only) |
| Conversations | 20 (the first 20 of the oracle split) |
| QAs | 20 (one QA per haystack — the LongMemEval convention) |
| Categories sampled | temporal-reasoning (the first 20 happened to be all in this category) |

**Result: 55.00% accuracy (11/20)**, avg latency 5.8s, p95 25.4s. Per-record JSON committed under `published/longmemeval-oracle-20q-2026-05-16.json`.

**What this measures (and doesn't)**: the oracle split hands Memorai a small haystack of already-relevant sessions per question. So the 55% number reflects the **downstream pipeline** (Event ingest → `recall` → answerer → judge) on pre-curated context — it isolates answer-generation and judging quality from retrieval quality. The `longmemeval_s` split (115K tokens with distractor sessions) is downloaded but not yet run; that's the number that compares against published mem0/Zep/Letta scores.

To fetch LongMemEval behind a regional network restriction, set `HF_ENDPOINT=https://hf-mirror.com` and re-run `pnpm bench:fetch longmemeval`.

## What these results say about Memorai

✅ **Confirmed** (custom + canonical wrap run):
- Hierarchical evolution preserves facts across segment → atomic_action → episode aggregation
- Multi-strategy retrieval routes correctly (factual vs temporal vs inferential)
- Cross-agent isolation is exact at the storage + retrieval boundary
- Multimodal payloads (image / audio / video / file refs) survive ingest and recall end-to-end
- Time-window queries (`recallByTime`) are precise and complete across a 24-hour span
- The Event API → Extractor → Memorai → recall → answerer → judge pipeline runs cleanly against real-world chat data

❌ **Not yet validated**:
- LLM-extraction-mode LoCoMo numbers (the publishable head-to-head with mem0/Zep)
- LongMemEval (blocked on dataset access)
- Streaming / long-horizon retention (no public benchmark exists; future custom test)

## Methodology caveats

LLM-as-judge has known biases. We addressed two of the main ones explicitly:

1. **Self-favouring judges**: answerer and judge use different model families (Gemma vs Qwen).
2. **Truncated reasoning**: the judge's `maxTokens` is set to 256 to leave room for "thinking" models like `glm-4.7:cloud` that consume internal tokens before producing their final answer.

What we have NOT addressed yet:

- **Single-run variance**: numbers are from one run each. LLM judges are non-deterministic at temperature 0 (sampling-aware features); a proper publication run would report `mean ± stddev` over N=3.
- **Sample size**: 30 LoCoMo QAs is a smoke test, not a benchmark number. The full 199-QA run for conv-26 (and the full 1,986-QA run across all 10 conversations) is on the to-do list.
- **Cross-provider comparison**: we did not run mem0/Zep locally to verify our harness reproduces their published numbers. Until we do, any "Memorai vs. mem0" claim is unsubstantiated.

When publishing numbers from this harness:
1. State the **extractor mode** (wrap vs llm), **embedder**, **answerer model**, **judge model**, and **judge ≠ answerer family**.
2. State the **sample slice** (N conversations, M QAs, which categories).
3. Report `mean ± stddev` over multiple seeds when the use case justifies it.
4. Link to the canonical `published/*.md` for full per-record auditability.

## Non-goals (0.1.0)

- No mem0 / Zep / Letta cross-provider runs in this harness — adding those providers is a v0.2 candidate
- No `longmemeval_m` split (the 1.5M-token tier) — too costly for the current local-LLM setup
- No CI integration — benchmarks are run on demand and committed selectively
- No leaderboard auto-publishing — canonical numbers move from `results/*.md` to `results/published/` and into this page by hand
