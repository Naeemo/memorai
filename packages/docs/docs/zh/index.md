---
layout: home

hero:
  name: Memorai
  text: Streaming memory for AI agents
  tagline: 三层存储。多路径召回。可相互替代的语义事件。运行时无关 —— 浏览器、Node.js、Bun、Deno。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 为什么选择 Memorai
      link: /zh/guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/Naeemo/memorai

features:
  - icon: 🗂️
    title: 三层存储
    details: Tier 1 原始事件（不可变时间轴）。Tier 2 派生注解（可通过 reAnnotate 重新生成）。Tier 3 索引。升级模型时，过去的记录始终保留。
  - icon: 🧩
    title: 语义事件层
    details: LLM 识别器将原始对话轮次转换为带替代生命周期的 state / transition / happening 事件。召回返回的是代理当前所相信的内容，而不是每一条原始话语。
  - icon: 🔀
    title: 多路径召回
    details: 语义 + BM25 + 标签 + 时间 + 身份等路径并行扇出，并通过倒数排名融合（RRF）合并。每条结果都带有路径级出处信息。
  - icon: 🔌
    title: 全栈可插拔
    details: 存储适配器（Memory / SQLite / IndexedDB / 自定义）。嵌入器（Ollama / OpenAI / 自定义）。LLM、抽取器、识别器、重排器 —— 每一层都可替换。
  - icon: 🌐
    title: 运行时无关
    details: 一个 TypeScript 包，四种运行时。核心只依赖 Web 标准 API。
  - icon: 🤝
    title: 跨代理画像
    details: 多个代理共享一个存储，按代理粒度配置读写策略。推理代理看到的是 episode；主动型代理看到的是 segment。
---

<div style="max-width: 960px; margin: 4rem auto 0; padding: 0 1.5rem;">

## 三十秒上手

```typescript
import { Memorai, MemoryAdapter, OllamaEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
  llm: yourLLMService,  // auto-wires LLMExtractor + LLMEventIdentifier
});

// Record events from a conversation
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I just started eating fish again' },
});

await memory.evolve();  // identifies the state transition

// Recall semantic events, not raw turns
const result = await memory.recall('what does the user eat?');
console.log(result.memories[0].summary);
// → "User started eating fish again"
```

[继续阅读《快速开始》 →](/zh/guide/getting-started)

</div>
