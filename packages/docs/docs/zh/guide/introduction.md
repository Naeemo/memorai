# 简介

Memorai 是面向 AI 代理的 TypeScript 记忆库。它记录所发生的一切，识别有意义的事件，让代理在长时段内召回这些信息 —— 并且其设计保证**原始时间轴永不丢失**，即便用来解读它的模型在未来被升级。

它与运行时无关（浏览器 / Node / Bun / Deno），端到端可插拔（存储 / 嵌入 / LLM / 抽取器 / 识别器 / 重排器），并自带合理的默认配置。

## 心智模型

Memorai 为每条记忆存储三个层，每一层都有不同的生命周期：

| 层 | 承载内容 | 生命周期 |
|---|---|---|
| **Tier 1 — 原始时间轴** | 事件发生时的逐字记录：文本、图像引用、音频、视频、文件。 | 仅追加。永不重写。 |
| **Tier 2 — 注解** | 派生的摘要、标签、向量嵌入、知识三元组。 | 可重新生成 —— 调用 [`reAnnotate()`](/zh/api/memorai#reannotate) 用更好的抽取器刷新。 |
| **Tier 2.5 — MemoryEvents** | 从 Tier 1 识别出的语义事件：状态断言、状态变化、发生事件。状态事件具有替代生命周期。 | 受生命周期管理。新事件可使旧事件失效。 |
| **Tier 3 — 索引** | BM25、向量、标签、时间、参与者。 | 可丢弃。自动从 Tier 1+2 重建。 |

这种分层的关键在于：**Tier 1 是永恒的记录；其上的一切都是可演进的解读。**当出现更好的 LLM 时，你可以在整段历史上重新抽取 Tier 2。当你对什么算作"有意义的事件"改变了主意时，你可以重新识别 Tier 2.5。原始时间轴始终不受影响。

## 它解决了什么问题

大多数代理记忆库把记忆压缩成单一层：摄取时由 LLM 生成摘要，该摘要被存储，原始对话被丢弃或淹没。当模型变强时，旧记忆无法从中获益。当你发现抽取提示词不对时，你也无法回头修正。当两条信息相互矛盾时 —— 例如 _"Alice 是素食主义者"_ 与 _"Alice 现在又吃鱼了"_ —— 二者都留在存储中，召回时同时返回，代理只能自己判断当前事实。

Memorai 显式地把这些关注点分开：

- **原始事件是神圣的。**它们被逐字存储，永不修改。
- **解读是可丢弃的。**任何时候都可以重新跑抽取器。
- **语义事件有生命周期。**新的状态断言会替代旧的；召回默认会过滤掉失效事实，但需要时也可以回放历史。

## 召回的端到端流程

召回不是单一路径的搜索。Memorai 并行运行五条召回路径：

```
question ──► embed ──┬─► semantic vector search       ─┐
                     ├─► BM25 sparse retrieval         │ RRF fusion
                     ├─► tag / topic match             ├──► ranked candidates
                     ├─► temporal window filter        │
                     └─► identity (userId/actor/target)─┘
```

……当 MemoryEvent 层被启用时，还会在事件之上额外开启第六条与第七条路径：对规范化事件描述做语义检索与 BM25 检索，并按有效时间过滤 —— 被替代的状态默认会被剔除。

所有路径汇入倒数排名融合（RRF）。每条返回的记忆都带有路径级出处信息 —— 你能看到它究竟是被哪些路径召回的。

## 可插拔的层

几乎一切都可插拔。Memorai 自带默认实现，但每一层都可以替换：

| 层 | 内置 | 自定义 |
|---|---|---|
| 存储 | `MemoryAdapter`、`SQLiteAdapter`、`IndexedDBAdapter` | 实现 [`StorageAdapter`](/zh/api/storage) |
| 事件存储 | `InMemoryEventStore` | 实现 [`EventStore`](/zh/api/event-store) |
| 嵌入 | `OllamaEmbeddingService`、`OpenAIEmbeddingService` | 实现 [`EmbeddingService`](/zh/api/embeddings) |
| 抽取器 | `WrapExtractor`、`LightExtractor`、`LLMExtractor` | 实现 `Extractor` |
| 事件识别器 | `LLMEventIdentifier` | 实现 [`EventIdentifier`](/zh/api/event-identifier) |
| 重排器 | `LLMReranker` | 实现 `RerankerService` |
| 压缩 | `BrowserImageCompressor`、`PassthroughCompressor` | 实现 `CompressionService` |

## Memorai 面向谁

- **对话型代理**，需要在跨会话场景下记住用户偏好与历史。
- **流式代理**，持续摄入观测流（屏幕截图、传感器数据、消息）。
- **多代理系统**，不同角色共享同一存储但以不同粒度读取。
- **浏览器端 AI**，希望一切在客户端运行，并使用 IndexedDB 持久化。

## 下一步去哪里

| 如果你想…… | 阅读 |
|---|---|
| 跑通第一个示例 | [快速开始](/zh/guide/getting-started) |
| 查看真实示例 | [示例](/zh/guide/examples) |
| 理解架构 | [概念 → 总览](/zh/concepts/overview) |
| 自定义一个存储适配器 | [API → Storage Adapter](/zh/api/storage) |
| 看 Memorai 在公开基准上的成绩 | [基准测试](/zh/guide/benchmarks) |
