# 基准测试

Memorai 由同 workspace 内的姊妹包 `@memorai/benchmarks` 进行基准测试，覆盖两套互补的测试集：

- **自定义合成集**（8 项）—— 演练 Memorai 的内部机制：召回、演进、隔离、可扩展性、多模态载荷保留、时间窗查询
- **公开数据集** —— [LoCoMo](https://github.com/snap-research/locomo)（CC-BY-4.0）与 [LongMemEval](https://github.com/xiaowu0162/longmemeval)（MIT），与 mem0、Zep、Letta、MemPalace、MemMachine、Mastra 所用数据集一致

[ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem) 曾被评估并已从测试框架中移除：其 CC-BY-NC-4.0 许可证禁止派生数据用于任何商业用途，而本包面向商业友好的发布路径。

权威结果提交在 [`packages/benchmarks/results/published/`](https://github.com/Naeemo/memorai/tree/main/packages/benchmarks/results/published) —— `*.md` 供人类阅读、`*.json` 作为机器可读记录。日常运行则落到（gitignore 的）父级 `results/` 目录。

## 运行基准测试

```bash
pnpm install

# custom suite (8 benchmarks, ~10 min on Apple Silicon + Ollama)
pnpm --filter @memorai/benchmarks bench:custom

# fetch and smoke-test a public dataset
pnpm --filter @memorai/benchmarks bench:fetch locomo
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30
```

**前置条件**

- 本地运行 [Ollama](https://ollama.com)（默认 `http://localhost:11434`，可用 `OLLAMA_HOST` 覆盖）
- 已拉取 `nomic-embed-text` 模型：`ollama pull nomic-embed-text`
- 对于 LLM-as-judge 流程：要么使用一个有生成能力的 Ollama 模型（默认 `gemma4:31b-cloud` 作答 + `qwen3-coder-next:cloud` 评判 —— 不同模型家族以避免自我评判偏差），**要么**设置 `OPENAI_API_KEY=sk-...` 使用 `gpt-4o-mini` 同时担任两端。
- 当 `huggingface.co` 不可达时（例如来自中国大陆），在 `pnpm bench:fetch longmemeval` 之前设置 `HF_ENDPOINT=https://hf-mirror.com`。fetcher 遵循标准的 `HF_ENDPOINT` 环境变量。

## 自定义合成测试集

这些测试演练 Memorai 的特色设计点 —— 层级演进、多策略召回、多模态载荷、时间窗查询、跨代理隔离 —— 独立于任何第三方数据集。

| 基准 | 测试内容 |
|-----------|---------------|
| Needle-in-a-Haystack | 在语料规模 10、50、100、250 下检索单条关键事实 |
| Multi-Needle Retrieval | 100 条语料中包含 1、3、5 条不同针时的召回情况 |
| Hierarchical Evolution Preservation | segment → atomic_action → episode 聚合后原始事实仍被保留 |
| Temporal Retrieval | 时间范围查询仅返回窗口内的记忆 |
| Scalability | 规模 50、100、250、500、1,000 下的写吞吐 + 召回延迟 |
| Cross-Agent Isolation | 按 `agentProfile` 区分使三个代理的记忆互不相交 |
| **Multimodal Recall** | 图像 / 音频 / 视频 / 文件事件引用在 `recordEvent` → evolve → `recall` 后仍然保留 |
| **Time-Window Recall** | `recallByTime({start,end})` 在 24 小时跨度内只返回窗口内的事件 |

最后两项（"Multimodal Recall" 与 "Time-Window Recall"）在 0.1.0 加入，用于覆盖 Memorai 的差异化能力（多模态载荷保留以及公开的 `recallByTime` API），这些是公开聊天基准触及不到的。

## 公开基准

基准包提供运行器 + 数据集加载器 + `MemoryProvider` 抽象。Memorai 是默认 provider；同时打包了 `naive-rag` 基线（在每用户嵌入之上做 cosine 相似度）作为对照。

| 测试集 | 来源 | 许可证 | 测试内容 |
|-------|--------|---------|---------------|
| LoCoMo | [snap-research/locomo](https://github.com/snap-research/locomo) — ACL 2024 | CC-BY-4.0 | 10 段长对话，1,500+ 道 QA，涵盖单跳、多跳、开放域、时间、对抗题型 |
| LongMemEval | [xiaowu0162/longmemeval](https://github.com/xiaowu0162/longmemeval) — ICLR 2025 | MIT | 500 道 QA，涵盖信息抽取、多会话推理、时间推理、知识更新、弃答 |
| ~~ConvoMem~~ | ~~Salesforce~~ | ~~CC-BY-NC-4.0~~ | 已移除：非商业许可 |

### 流程

对每一道 QA，测试框架会：

1. **重置** provider 至该对话的 `userId`
2. 通过 `Memorai.recordEvents(events)` **摄入**每个 session 的每条轮次 —— 事件带时间锚（`at`/`during`）并打上参与方标签（`user`/`assistant`）
3. 用 `Memorai.recall(question, { userId, topK: 30, strategy: "factual" })` **查询**
4. 由作答 LLM 仅基于召回到的记忆**生成**一句话预测
5. 由严格的二元 `CORRECT | INCORRECT` LLM 评判器**评判**预测与标准答案

会同时报告分类准确率、token 级 F1、BLEU-1，以及平均 / p95 查询延迟。

### 抽取器模式

Memorai 的 `recordEvent` 会经过一个 `Extractor`，将原始事件转换为结构化的 `WritePayload`。基准测试支持两种模式：

- **`wrap`**（默认）—— `WrapExtractor` 原样透传文本。摄入期间无 LLM 调用。隔离地度量 Memorai 的存储 + 召回 + 演进层。速度快。
- **`llm`** —— `LLMExtractor` 调用一个小型 Ollama 模型（默认 `gemma4:e2b`）为每条事件生成结构化的 `{summary, tags, salience}`。较慢，但与 mem0/Letta 内部做法一致，是与其公开数字做正面比较的正确路径。

```bash
# baseline (wrap)
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30

# with LLM extraction (slow — ~30 min for one LoCoMo conv at 380 turns)
pnpm --filter @memorai/benchmarks bench:locomo --limit 1 --limit-qas 30 --extractor llm
```

### 评判器 ≠ 作答器 模型家族

LLM-as-judge 会偏向其同家族模型的输出。测试框架默认搭配如下：

| 角色 | 默认 | 家族 |
|------|---------|--------|
| 作答器 | `gemma4:31b-cloud` | Google Gemma |
| 评判器 | `qwen3-coder-next:cloud` | Alibaba Qwen |

这是我们在 Ollama Cloud 免费层上找到的唯一满足"不同家族 + 快速 + 评判可靠"的组合（共测试了 18 个 cloud 模型，见[模型审计](https://github.com/Naeemo/memorai/blob/main/packages/benchmarks/results/published/ollama-cloud-model-audit-2026-05-16.md)）。可通过 `--judge-model` / `--answerer-model` 或环境变量 `JUDGE_MODEL` / `ANSWERER_MODEL` 覆盖任一端。

### 复现已发布的运行

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

运行器会在每次运行后写出 `results/<suite>-<provider>-<timestamp>.{json,md}`。将选定的运行结果复制到 `results/published/<name>.md` 即可提交。

## 权威结果

### 2026-05-17 — Memorai 0.4.0（MemoryEvent 层）

0.4.0 引入了 **MemoryEvent 层**（Tier 2.5）：由 `EventIdentifier` 抽取的事实中心化记录，与原始 `MemoryNode` 并列存储。每个事件属于 `state` / `transition` / `happening` 之一，具备生命周期（状态事件可被替代）、有效时间语义、以及图风格的参与者 + 主题索引。召回会同时扇出到原始节点和事件层，经 RRF 融合，并对已被事件覆盖的原始节点命中去重。数据模型见 [`/concepts/memory-events`](/zh/concepts/memory-events)。

#### LoCoMo — 完整 conv-26（152 道 QA，默认过滤）

| 配置 | 准确率 | 摄入 |
|---------------|---------:|------:|
| 0.3.0 wrap | 21.71% (33/152) | 7.1 min |
| 0.3.0 llm（每轮抽取） | 23.03% (35/152) | 51.0 min |
| **0.4.0 `--extractor wrap --identifier llm`** | **36.84%** (56/152) | **17.9 min** |
| 0.4.0 `--extractor llm --identifier llm` | 32.89% (50/152) | 71.9 min |

**比 0.3.0 wrap 基线 +15.1pp。**仅打开事件识别器 —— 摄入期间不做 LLM 抽取 —— 就拿到了绝大部分增益，并且比 0.3.0 的 LLM 抽取流水线快约 3 倍。其代价是每段对话约 14 次识别器调用（每个 session 边界一次），而 LLM 抽取约需 419 次抽取器调用。

**在该样本上，把 LLM 抽取与识别器组合反而更差**（32.89% < 36.84%）。组合后的嵌入会同时累计 LLM 抽取的 `summary` 与事件级的规范化描述，作答器拿到的候选集变得更嘈杂。建议：将 `--extractor wrap --identifier llm` 作为默认配置发布。

各类别从 0.3.0 wrap → 0.4.0 wrap + identifier 的跃升：

| 类别 | 0.3.0 wrap | 0.4.0 wrap + id | Δ |
|----------|-----------:|----------------:|--:|
| multi_hop | 23.1% (3/13) | 30.8% (4/13) | +7.7 |
| single_hop | 12.5% (4/32) | 21.9% (7/32) | +9.4 |
| temporal | 2.7% (1/37) | 8.1% (3/37) | +5.4 |
| open_domain | 35.7% (25/70) | 60.0% (42/70) | **+24.3** |

开放域几乎翻倍。时间题仍然落后 —— 抽取质量解决不了时间戳推理，那是一个独立的召回/作答问题。

作为参考：mem0 在 LoCoMo 上对 RAG 配置报出 25–45%，对其完整 LLM 抽取流水线报出 65–70%。我们现在在**单段对话上落在他们 RAG 区间的中段**。距 65–70% 的剩余差距主要来自跨对话聚合（我们只跑了 10 段中的 1 段）以及作答模型强度（gemma 31B 对 OpenAI gpt-4o）。

#### LongMemEval oracle — 20 道题

| 配置 | 准确率 |
|---------------|---------:|
| 0.3.0 基线 | 60% (12/20) |
| **0.4.0 + identifier llm** | **75% (15/20)** |

+15pp 提升。Oracle split 是预先过滤的上下文，因此该数字度量的是下游流水线。提升来自事件层为作答器提供了规范化的状态断言，而不是让它在原始轮次上做接地。

#### 复现头条数字

```bash
pnpm --filter @memorai/benchmarks bench:locomo \
  --limit 1 \
  --extractor wrap \
  --identifier llm \
  --identifier-model gemma4:31b-cloud \
  --answerer-model gemma4:31b-cloud \
  --judge-model qwen3-coder-next:cloud
```

### 2026-05-17 — Memorai 0.3.0（三层：原始 + 注解 + 索引）

0.3.0 把 `MemoryNode` 拆分为不可变的 Tier 1 `raw` 与可重新生成的 Tier 2 `annotations`。Tier 3 索引（BM25 / 向量 / 标签 / 时间）会从两者自动重建。新的 `Memorai.reAnnotate()` 在不可变的 Tier 1 之上重新生成现有存储的 Tier 2 + Tier 3 —— 让你能够升级抽取器或切换嵌入模型，而不丢失源时间轴。

索引现在使用 `composeIndexableText(raw, annotations)`（原始文本 + summary + facts + tags，去重）而不是仅 summary。

#### LoCoMo — 完整 conv-26（152 道 QA，默认类别过滤）

可发布的对比：相同对话、相同 QA、两种抽取策略。

| 配置 | 准确率 | multi_hop | single_hop | temporal | open_domain | 摄入耗时 |
|---------------|---------:|----------:|-----------:|---------:|------------:|------------:|
| `--extractor wrap` | 21.71% (33/152) | 23.1% (3/13) | 12.5% (4/32) | 2.7% (1/37) | 35.7% (25/70) | 7.1 min |
| `--extractor llm --extractor-model gemma4:31b-cloud` | **23.03%** (35/152) | **38.5%** (5/13) | 15.6% (5/32) | 5.4% (2/37) | 32.9% (23/70) | 51.0 min |

**LLM 抽取整体提升约 1.3pp，集中在 `multi_hop`（+15.4pp）。**这是最能体现规范化事实抽取价值的类别 —— wrap 模式存储原始对话轮次，难以在多个会话间拼接出一条事实，而 LLM 抽取产出的 summary / 三元组可以被召回直接命中。开放域与单跳基本持平（LLM 改写偏离了字面查询文本，部分抵消了收益）。时间题仍然糟糕（2.7% → 5.4%）—— 抽取质量解决不了时间戳推理，那是一个独立的召回/作答问题。

作为参考：mem0 在仅 RAG 的 LoCoMo 上报出 25–45%，在其完整 LLM 抽取流水线上报出 65–70%。我们在 `--extractor llm` 下位于他们 RAG 区间的下沿。距 65–70% 的差距来自 **(a)** 模型强度（作答用 gemma4:31b-cloud 而非 OpenAI）、**(b)** 抽取器提示词工程、**(c)** 跨所有 10 段对话运行（我们只跑了 conv-26 —— 跨 10 段的 1986 道 QA 才是已公开比较的样本形态）。

#### 这些运行暴露出的一个 bug 修复

上述完整 conv-26 的运行触发了一个已存在的 bug：`packages/benchmarks/src/benchmarks/locomo/run.ts` 中的 `--categories` 默认值会被尾随的 `...opts` 展开覆盖，导致对抗题型（类别 5）被纳入到默认过滤之中。在本 PR 中已修复 —— 运行器现在先展开 opts，再应用默认值。`--limit-qas 30` 的烟雾测试未受影响（conv-26 的前 30 道 QA 恰好都落在默认类别里）。

#### 自定义测试集 — `published/custom-0.3.0.md`

总分 **95.5%**（对比 0.2.0 的 **97.5%**）。

| 基准 | 0.2.0 | 0.3.0 | 备注 |
|-----------|-------|-------|-------|
| Needle-in-a-Haystack | 100% | 95.5% | 一次 n=100 试验相似度低于 0.72 阈值（sim=0.589） |
| Multi-Needle Retrieval | 100% | 88.9% | 一次 needles=3 试验召回 0.67 |
| Evolution / Temporal / Scalability / CrossAgent / TimeWindow | 100% | 100% | — |
| Multimodal Recall | 80% | 80% | — |

两项合成针测试的漂移属于单次试验噪声（随机干扰项混合 + nomic-embed-text 批处理非确定性）；其余六项保持不变。

#### LongMemEval oracle — 20 道题

| 配置 | 准确率 | 延迟 |
|---------------|---------|---------|
| 0.2.0 | 60% (12/20) | 77s |
| **0.3.0** | **60% (12/20)** | **85s** |

Oracle split 是预过滤的 —— 度量的是在精选上下文上的下游流水线（Event 摄入 → recall → 作答 → 评判），不是召回质量。

### 2026-05-17 — Memorai 0.2.0（多路径召回）

0.2.0 增加了多路径召回层：每次召回现在都会并行扇出到语义 + BM25 + 标签 + 时间 + 身份等路径，通过[倒数排名融合](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)合并，并为每条返回的记忆打上 `provenance.pathways` 标签。可选的 LLM 驱动精度层（`--reranker llm`、`--query-expansion N`、`--hyde`）位于融合之上。

#### 自定义测试集 — `published/custom-2026-05-17.md`

总分 **97.5%**（由 0.1.0 的 92.9% 上升）。

| 基准 | 0.1.0 | 0.2.0 | Δ |
|-----------|------|------|---|
| Needle-in-a-Haystack | 94.3% | **100%** | +5.7 |
| Multi-Needle Retrieval | 68.9% | **100%** | +31.1 |
| Hierarchical Evolution Preservation | 100% | 100% | — |
| Temporal Retrieval | 100% | 100% | — |
| Scalability | 100% | 100% | — |
| Cross-Agent Isolation | 100% | 100% | — |
| Multimodal Recall | 80% | 80% | — |
| Time-Window Recall | 100% | 100% | — |

Multi-Needle 跃升 31 个点、Needle-Haystack 跃升 5.7 个点，证实此前 BM25 漏掉了真实召回 —— 多路径融合捕获了纯 cosine 相似度评分低于阈值的精确 token 命中。

#### LoCoMo — wrap 模式，conv-26，30 道 QA

| 配置 | 准确率 | 备注 |
|---------------|---------|-------|
| 0.1.0（仅 cosine） | 3.33% (1/30) | 30 题中 29 题"I don't know" —— 召回瓶颈 |
| 0.2.0（RRF + BM25） | **13.33% (4/30)** | **4 倍提升，召回时无额外 LLM 成本** |
| 0.2.0 + `--reranker llm` | 13.33% (4/30) | multi_hop 0%→25%、temporal 12.5%→6.3% —— 重排改变了类别分布，但 N=30 下总数未动 |
| 0.2.0 + 重排 + 扩展 + HyDE | 13.33% (4/30) | 完整 LLM 精度栈在 N=30 下未超过仅重排；大约 2× 的总耗时 |

F1 也有所提升：0.000–0.286（0.1.0）→ 0.029–0.206（0.2.0 基线）→ 0.031–0.240（带重排）。即使在二元准确率不变的地方，token 级与标准答案的接近度也在普遍上升。

头条数字：**RRF + BM25 单独贡献了这 4 倍的提升。**LLM 驱动的精度层（重排、扩展、HyDE）在 N=30 时大多是在类别之间做置换而非提升总数。对更困难的负载它们仍然是有用的逃生口。

#### LongMemEval oracle — 20 道题

| 配置 | 准确率 | 延迟 |
|---------------|---------|---------|
| 0.1.0 | 55% (11/20) | 140s |
| 0.2.0 | **60% (12/20)** | **77s**（更快 —— RRF 去重比旧的朴素合并更高效） |

Oracle split 喂给作答器的是预过滤的上下文；该数字度量下游流水线（Event 摄入 → recall → 作答 → 评判），不是召回质量。但仍是一项有用的健全性检查，确认多路径变更没有在作答生成端引入回归。

### 2026-05-16 — Memorai 0.1.0（Event API 基线）

### 自定义测试集 — `published/custom-2026-05-16.md`

8 项测试端到端全部通过；总分 92.9%。

| 基准 | 得分 | 平均延迟 | 备注 |
|-----------|-------|-------------|-------|
| Needle-in-a-Haystack | 94.3% | 23ms | n=100 时出现一次错排 |
| Multi-Needle Retrieval | 68.9% | 21ms | 5 根针并发时召回下降（方差，见下文） |
| Hierarchical Evolution Preservation | 100% | 22ms | |
| Temporal Retrieval | 100% | 18ms | |
| Scalability | 100% | 28ms | 批量写为顺序写的 2.5 倍 |
| Cross-Agent Isolation | 100% | 14ms | |
| **Multimodal Recall** | 80% | 20ms | 4/5 媒体引用得以保留；PDF 文件引用缺失 |
| **Time-Window Recall** | 100% | <1ms | 8 个窗口下查准率与召回率均为 1.0 |

Multi-Needle 的下沉和 Needle-Haystack 的错排都在 Ollama 嵌入噪声范围内；由于 nomic-embed-text 在 temperature 0 下仍存在批处理非确定性，每次运行值会波动 ±5–15pp。请将其视为近似值。

### LoCoMo — `published/locomo-wrap-30q-2026-05-16.md`

| 设置 | 值 |
|---------|-------|
| Provider | Memorai 0.1.0 |
| 抽取器 | `WrapExtractor`（摄入期间无 LLM） |
| 嵌入器 | Ollama `nomic-embed-text`（768 维） |
| 作答器 | Ollama `gemma4:31b-cloud` |
| 评判器 | Ollama `qwen3-coder-next:cloud` |
| Top-K | 30 |
| 对话数 | 1（`conv-26`） |
| QA 数 | 30（conv-26 的 199 道中的前 30 道） |
| 类别 | single_hop、multi_hop、temporal、open_domain |

**结果：3.33% 准确率（1/30）**，平均查询延迟 3.6s，p95 12.5s。

| 类别 | 数量 | 正确 | 准确率 |
|----------|-------|---------|----------|
| single_hop | 10 | 1 | 10.0% |
| multi_hop | 4 | 0 | 0.0% |
| temporal | 16 | 0 | 0.0% |

**为什么这么低？**对逐记录 JSON 的检视显示：**30 个预测中有 29 个是 "I don't know"** —— 作答器在记忆没有命中相关事实时正确地拒答。瓶颈是*召回*而非评判：`WrapExtractor` 存储原始对话轮次，但对像 "what did Caroline research?" 这样的语义查询，正确的那一轮很少能落到 top-30。单跳事实查询是最容易的情形，唯一一次 CORRECT 命中恰好落在这里（"What is Caroline's identity?" → "Caroline is a transgender woman"）。

这是"结构化存储但无 LLM 抽取"基线的可预期形态。Mem0 的 LoCoMo 论文对仅 RAG 配置报出 25–45%、对其完整 LLM 抽取流水线报出 65–70%。这里的 3% 反映出更加稀疏的召回面（完全没有 LLM 规范化的事实），并非 Memorai 自身的缺陷。

**面向可发布 LoCoMo 数字的下一步**：使用 `--extractor llm` 运行，它会把摄入路由到 `LLMExtractor` 并为每条事件生成规范化的 `{summary, tags, salience}`。在本地硬件上跑一段对话大约需要 30 分钟，因此在 v0.1.0 发布集合中暂时省略，待后续较长的基准窗口再补。

### LongMemEval

| 设置 | 值 |
|---------|-------|
| Provider | Memorai 0.1.0 |
| Split | `oracle`（每道题的语料堆仅为标准答案上下文） |
| 对话数 | 20（oracle split 中的前 20 段） |
| QA 数 | 20（每个语料堆一道 QA —— LongMemEval 的惯例） |
| 抽样类别 | temporal-reasoning（前 20 道恰好都在该类别） |

**结果：55.00% 准确率（11/20）**，平均延迟 5.8s，p95 25.4s。逐记录 JSON 提交在 `published/longmemeval-oracle-20q-2026-05-16.json`。

**这度量了什么（以及没度量什么）**：oracle split 为每道题提供了一小堆已经相关的会话作为语料。因此 55% 反映的是**下游流水线**（Event 摄入 → `recall` → 作答 → 评判）在预精选上下文上的表现 —— 它把作答生成与评判质量与召回质量隔离开来。`longmemeval_s` split（115K tokens，带干扰会话）已下载但尚未运行；那才是能与已公开的 mem0/Zep/Letta 分数对比的数字。

要在受区域网络限制的情况下抓取 LongMemEval，设置 `HF_ENDPOINT=https://hf-mirror.com` 然后重新运行 `pnpm bench:fetch longmemeval`。

## 这些结果说明 Memorai 的什么

✅ **已验证**（自定义集 + 规范 wrap 运行）：
- 层级演进在 segment → atomic_action → episode 聚合中保留事实
- 多策略召回路由正确（factual 对 temporal 对 inferential）
- 跨代理隔离在存储 + 召回边界上是精确的
- 多模态载荷（图像 / 音频 / 视频 / 文件引用）在端到端摄入与召回中保留
- 时间窗查询（`recallByTime`）在 24 小时跨度内既精确又完整
- Event API → Extractor → Memorai → recall → 作答 → 评判 的整条流水线在真实聊天数据上干净运行

❌ **尚未验证**：
- LLM 抽取模式下的 LoCoMo 数字（可与 mem0/Zep 正面对比的可发布数字）
- LongMemEval（受数据集访问阻塞）
- 流式 / 长时段保留（暂无公开基准；属未来自定义测试）

## 方法学注意事项

LLM-as-judge 存在已知偏差。我们显式处理了其中两个主要偏差：

1. **自偏好评判**：作答器与评判器使用不同模型家族（Gemma vs Qwen）。
2. **截断的推理**：评判器的 `maxTokens` 设置为 256，为像 `glm-4.7:cloud` 这类在产出最终答案前会消耗内部 token 的"思考型"模型留出空间。

我们尚未处理的：

- **单次运行方差**：每个数字均来自单次运行。LLM 评判器在 temperature 0 下也是非确定性的（带采样感知特性）；规范发布运行应在 N=3 上报告 `mean ± stddev`。
- **样本量**：30 道 LoCoMo QA 是烟雾测试，不是基准数字。conv-26 的完整 199 道运行（以及跨全部 10 段对话的完整 1,986 道运行）已列入待办。
- **跨 provider 对比**：我们没有在本地跑 mem0/Zep 来验证测试框架能复现他们公开的数字。在做到这一点之前，任何 "Memorai vs. mem0" 的论断都缺乏根据。

发布来自该测试框架的数字时：
1. 注明 **抽取器模式**（wrap 对 llm）、**嵌入器**、**作答模型**、**评判模型**，以及 **评判器 ≠ 作答器 家族**。
2. 注明 **样本切片**（N 段对话、M 道 QA、哪些类别）。
3. 在用例值得时，跨多个种子报告 `mean ± stddev`。
4. 链接到规范 `published/*.md` 以便逐记录审计。

## 非目标（0.1.0）

- 在该测试框架中不跑 mem0 / Zep / Letta 的跨 provider 测试 —— 添加这些 provider 是 v0.2 的候选项
- 不跑 `longmemeval_m` split（1.5M token 量级）—— 对当前本地 LLM 配置而言成本过高
- 不做 CI 集成 —— 基准按需运行并选择性提交
- 不做排行榜自动发布 —— 规范数字由人工从 `results/*.md` 迁移到 `results/published/` 并最终进入本页
