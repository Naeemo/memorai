# 快速开始

本页将带你在大约五分钟内从零搭建一个可运行的代理记忆。我们会记录若干事件、演进记忆、并完成召回。

## 前置条件

- Node.js 18+（或对应版本的 Bun / Deno，或现代浏览器）
- 一个嵌入服务。最简单的选择：
  - 本地运行的 **Ollama** 并已拉取 `nomic-embed-text`（`ollama pull nomic-embed-text`）
  - **OpenAI** API key（`OPENAI_API_KEY`）
- *（可选但推荐）* 用于事件层的生成型 LLM —— 例如 Ollama 上的 `gemma4:31b-cloud`，或 `OPENAI_API_KEY`

## 安装

::: code-group
```bash [pnpm]
pnpm add memorai
```
```bash [npm]
npm install memorai
```
```bash [yarn]
yarn add memorai
```
```bash [bun]
bun add memorai
```
:::

Memorai 没有必需的 peer 依赖。只有当你需要 SQLite 适配器时，才需要引入 `better-sqlite3`。

## 最小示例 —— 仅原始时间轴

最简单的配置使用内存存储适配器与 Ollama 嵌入器。没有 LLM。Memorai 会逐字存储一切，并通过语义相似度 + BM25 召回：

```typescript
import { Memorai, MemoryAdapter, OllamaEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
});

// Record events — returns immediately; extraction runs in the background.
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I love sourdough bread' },
});
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: "Just baked one this morning, came out great" },
});

// Wait for background extraction to drain before recalling.
await memory.evolve();

const result = await memory.recall("what kind of bread does the user like?");
console.log(result.memories[0].summary);
// → "I love sourdough bread"
```

此时你已经拥有了**多路径召回**层：语义 + BM25 + 标签 + 时间 + 身份等路径全部通过 RRF 融合。每条返回的记忆都带有 `provenance.pathways`，告诉你它来自哪些路径。

## 推荐示例 —— 启用 MemoryEvent 层

这是我们在基准测试中**在 LoCoMo 上取得 +15pp** 的配置。在配置中加上 `llm`，Memorai 会自动接上 `LLMEventIdentifier`。在 `evolve()` 期间，原始轮次会被转换为规范化的 state / transition / happening 事件：

```typescript
import {
  Memorai,
  MemoryAdapter,
  OllamaEmbeddingService,
  type LLMService,
} from 'memorai';

// Bring your own LLM. Anything with a `complete(prompt, opts)` method works.
const llm: LLMService = {
  complete: async (prompt, opts) => {
    // ...call your LLM...
    return result;
  },
};

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
  llm,  // auto-wires LLMExtractor AND LLMEventIdentifier
});

memory.recordEvents([
  { at: Date.now(),     actor: 'user', content: { kind: 'message', text: "I'm vegetarian" } },
  { at: Date.now() + 1, actor: 'user', content: { kind: 'message', text: "Actually I started eating fish again last month" } },
]);

await memory.evolve();   // identifies the state + the transition, and supersedes the old state

const result = await memory.recall("what does the user eat?");
for (const m of result.memories) {
  console.log(m.summary, m.eventKind, m.provenance?.pathways);
}
// → "User started eating fish again" "transition" ["event:semantic", "event:bm25"]
// Note: "I'm vegetarian" is NOT returned — superseded states drop out by default.
```

如果要回放审计轨迹并包含被替代的状态：

```typescript
await memory.recall("...", { excludeInvalidatedEvents: false });
```

如果要查看代理曾经知道的每一个事件、忽略召回排序：

```typescript
const all = await memory.listEvents();
const currentlyBelieved = await memory.listEvents({ excludeInvalidated: true });
```

## 浏览器持久化示例

代码相同，但使用 `IndexedDBAdapter`，让记忆在页面刷新后依然存在：

```typescript
import { Memorai, IndexedDBAdapter, OpenAIEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'my-agent' }),
  embedding: new OpenAIEmbeddingService({ apiKey: 'sk-...' }),
  llm: yourBrowserLLM, // e.g. a fetch wrapper around your API gateway
});
```

IndexedDB 适配器会自动处理 schema 迁移，并在第一次查询时重新加载 BM25 索引。

## Node 持久化示例

在 Node 中，使用 SQLite（由你自己提供 `better-sqlite3` 实例）：

```typescript
import Database from 'better-sqlite3';
import { Memorai, SQLiteAdapter, OllamaEmbeddingService } from 'memorai';

const db = new Database('./memory.db');
const memory = new Memorai({
  storage: new SQLiteAdapter(db),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
  llm: yourLLM,
});

// ...on shutdown
process.on('SIGINT', async () => {
  await memory.close();
  db.close();
  process.exit(0);
});
```

`memory.close()` 会刷出最后一次 `evolve()`（当 `evolution.mode = "auto"`），并关闭存储适配器。

## 读取召回结果

`recall()` 返回 `RecallResult.memories: RecalledMemory[]`。每一项都会告诉你它的来源：

```typescript
interface RecalledMemory {
  id: string;
  at: number;                       // when the event/memory occurred
  summary: string;                  // what the agent should see
  tags: string[];
  score: number;                    // RRF-fused score
  level: 'segment' | 'atomic_action' | 'episode';

  // Set when the hit was identified by the EventIdentifier (Tier 2.5).
  eventKind?: 'state' | 'transition' | 'happening';
  sourceNodeIds?: readonly string[];

  provenance?: {
    pathways: string[];             // which retrieval routes surfaced it
    fusedScore: number;
    pathwayScores?: Record<string, number>;
  };
}
```

根据 `eventKind` 分支以不同方式渲染事件衍生记忆，并使用 `provenance.pathways` 来调试"为什么这条结果被返回？"。

## 下一步

| 如果你想…… | 前往 |
|---|---|
| 看更多示例（替代流程、跨代理、reAnnotate、自定义 EventIdentifier） | [示例](/zh/guide/examples) |
| 理解三层模型存在的原因 | [概念 → 总览](/zh/concepts/overview) |
| 正确配置 `MemoraiConfig` | [API → Memorai](/zh/api/memorai) |
| 接入自定义存储 | [API → Storage Adapter](/zh/api/storage) |
| 在 Bun / Deno / 浏览器上运行 | [运行时兼容性](/zh/runtime/compatibility) |
