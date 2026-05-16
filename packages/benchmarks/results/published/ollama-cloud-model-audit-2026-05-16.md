# Ollama Cloud Free-Tier Model Audit — 2026-05-16

Audit performed while wiring up the benchmark judge for Memorai 0.1.0. The goal: find a chat-cloud model that's (a) free-tier accessible, (b) from a different model family than the answerer (Google Gemma), and (c) reliable enough to grade `CORRECT | INCORRECT` over a thousand QAs.

## Probe methodology

For each model listed at https://ollama.com/search?c=cloud (18 total), POST a simple completion to `/api/generate` on the local Ollama daemon (which forwards to Ollama Cloud). Classify the response:

- **200 + output** → accessible
- **403** → subscription required (Pro/Max tier)
- **404** → model name not in registry

Then re-test accessible models with an actual judge-style prompt (`QUESTION / GOLD / PREDICTION → CORRECT or INCORRECT`) over three control cases:

1. `"What is 2+2?"` GOLD `"4"` PRED `"four"` → expect CORRECT
2. `"Capital of France?"` GOLD `"Paris"` PRED `"London"` → expect INCORRECT
3. `"Who wrote Hamlet?"` GOLD `"Shakespeare"` PRED `"William Shakespeare"` → expect CORRECT

## Results

| Model | Family | Access | Judge accuracy | Notes |
|-------|--------|--------|----------------|-------|
| `gemma4:31b-cloud` | Google Gemma | ✅ Free | 3/3 | Currently used as answerer; reusing as judge would self-favour |
| `qwen3-coder-next:cloud` | Alibaba Qwen | ✅ Free | 3/3 | **Selected as judge default** |
| `glm-4.7:cloud` | Zhipu GLM | ✅ Free | 3/3 (with maxTokens ≥ 128) | "Thinking" model — emits internal CoT, needs larger output budget |
| `minimax-m2.5:cloud` | MiniMax | ✅ Free | 3/3 (with maxTokens ≥ 128) | Same: thinking model |
| `minimax-m2.1:cloud` | MiniMax | ✅ Free | 3/3 (with maxTokens ≥ 128) | Same |
| `nemotron-3-super:cloud` | NVIDIA Nemotron | ✅ Free | 3/3 (with maxTokens ≥ 128) | Same |
| `qwen3.5:cloud` | Alibaba Qwen | ❌ 403 | — | Subscription |
| `qwen3-next:cloud` | Alibaba Qwen | ❌ 404 | — | Not in registry |
| `deepseek-v3.2:cloud` | DeepSeek | ❌ 403 | — | Subscription |
| `deepseek-v4-flash:cloud` | DeepSeek | ❌ 403 | — | Subscription |
| `deepseek-v4-pro:cloud` | DeepSeek | ❌ 403 | — | Subscription |
| `glm-5:cloud` | Zhipu GLM | ❌ 403 | — | Subscription |
| `minimax-m2.7:cloud` | MiniMax | ❌ 403 | — | Subscription |
| `kimi-k2.6:cloud` | Moonshot Kimi | ❌ 403 | — | Subscription (despite being locally pulled) |
| `gemini-3-flash-preview:cloud` | Google Gemini | ❌ 403 | — | Subscription |
| `ministral-3:cloud` | Mistral | ❌ 404 | — | Not in registry |
| `devstral-small-2:cloud` | Mistral | ❌ 404 | — | Not in registry |
| `nemotron-3-nano:cloud` | NVIDIA Nemotron | ❌ 404 | — | Not in registry |

## Decision

**`qwen3-coder-next:cloud`** as the default Ollama-cloud judge.

- Free-tier accessible (no subscription required)
- Different family from Gemma (Alibaba Qwen)
- Non-thinking model: emits the answer directly without consuming token budget on internal reasoning, so the judge prompt with `maxTokens: 256` runs fast
- Reliable on judge-style binary classification (3/3 control cases)

The "coder" suffix in the model name caused a brief moment of doubt — Qwen3-Coder is a code-specialised tune of Qwen3 — but binary `CORRECT | INCORRECT` classification on natural-language facts is well within its general instruction-following capability.

## Backup candidates (if Qwen ever 403s)

In rank order:

1. **`minimax-m2.5:cloud`** — MiniMax M2.5, agent-focused, slower than Qwen because thinking
2. **`glm-4.7:cloud`** — Zhipu GLM, general LLM, slower (thinking)
3. **`nemotron-3-super:cloud`** — NVIDIA Nemotron, slower (thinking)

To swap, set the env var or CLI flag:

```bash
JUDGE_MODEL=minimax-m2.5:cloud pnpm bench:locomo --limit 1
# or
pnpm bench:locomo --limit 1 --judge-model minimax-m2.5:cloud
```

## Configuration in code

The defaults live in `packages/benchmarks/src/core/llm/pick.ts`:

```ts
const DEFAULT_OLLAMA_ANSWERER = "gemma4:31b-cloud";
const DEFAULT_OLLAMA_JUDGE = "qwen3-coder-next:cloud";
```

The judge prompt is in `packages/benchmarks/src/core/llm/judge.ts`. `maxTokens` is set to 256 (not 4 or 8) so thinking-family models still emit a final verdict even after their internal CoT.

## What changed in 0.1.0

- Default judge moved from `gemma4:31b-cloud` → `qwen3-coder-next:cloud` to fix the self-favouring bias when answerer was also `gemma4:31b-cloud`
- `maxTokens` for the judge bumped from 4 → 256 to support thinking-family judges as drop-in replacements
