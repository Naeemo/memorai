# @memorai/benchmarks

Private package. Runs Memorai (and a naive-RAG baseline) against:

- **Custom synthetic** — `needle-haystack`, `multi-needle`, `evolution`, `temporal`, `scalability`, `cross-agent`, `multimodal-recall`, `time-window`
- **LoCoMo** ([snap-research/locomo](https://github.com/snap-research/locomo)) — CC-BY-4.0
- **LongMemEval** ([xiaowu0162/longmemeval](https://github.com/xiaowu0162/longmemeval)) — MIT

ConvoMem was evaluated and removed: its CC-BY-NC-4.0 license blocks any commercial use of derived numbers.

## Quick start

```bash
# install workspace deps
pnpm install

# run the custom suite (needs Ollama at $OLLAMA_HOST or localhost:11434)
pnpm --filter @memorai/benchmarks bench:custom

# fetch a public dataset, then run it
pnpm --filter @memorai/benchmarks bench:fetch locomo
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 20
```

Live results land in `results/<suite>-<provider>-<timestamp>.{json,md}` (gitignored). Canonical published runs are committed under `results/published/`.

## CLI

```
pnpm bench <suite> [options]

suites: custom | locomo | longmemeval | all
options:
  --provider memorai|naive-rag           (default: memorai)
  --extractor wrap|llm                   (default: wrap; llm uses Ollama for ingest extraction)
  --answerer-model <id>                  (default: gpt-4o-mini if OPENAI_API_KEY else gemma4:31b-cloud)
  --judge-model <id>                     (default: gpt-4o-mini or qwen3-coder-next:cloud — different family from answerer)
  --embedder ollama|openai               (default: ollama)
  --top-k <n>                            (default: 30)
  --limit <n>                            (process first N conversations; default: all)
  --limit-qas <n>                        (max N QAs per conversation; default: all)
  --categories <csv>                     (LoCoMo; default: 1,2,3,4)
  --no-evolve                            (skip memory.evolve() after each session)
  --out <path>                           (default: results/<suite>-<provider>-<ts>.{json,md})
```

Env vars: `OPENAI_API_KEY`, `OLLAMA_HOST`, `JUDGE_MODEL`, `ANSWERER_MODEL`, `HF_ENDPOINT` (set to `https://hf-mirror.com` when huggingface.co is unreachable).

## Why different judge and answerer

LLM-as-judge is biased toward outputs from the same model family. The defaults pair Google Gemma (answerer) with Alibaba Qwen (judge) — different families. Override via `--judge-model` / `--answerer-model` if your local setup prefers other models.

## Dataset licenses

LoCoMo is CC-BY-4.0, LongMemEval is MIT. Both permit commercial use of derived benchmark numbers. Datasets are downloaded into `datasets/` (gitignored) and are **not** redistributed by this package.
