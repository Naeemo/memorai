# 子路径导出

Memorai 提供一小组入口。主导出（`memorai`）出于便利重新导出全部内容；子路径的存在则是为了让打包器可以对未使用部分进行 tree-shake。

```typescript
// Core library + the most common surface
import { Memorai } from 'memorai';

// Storage adapters (also re-exported from the main barrel)
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage';

// Embedding services (also re-exported from the main barrel)
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings';
```

## 各路径下都有什么

### `memorai`（主导出）

满足典型用例所需的一切：

- **引擎**：`Memorai` 类。
- **类型**：`MemoryNode`、`MemoryEvent`、`Event`、`EventContent`、`RecallOptions`、`RecallResult`、`RecalledMemory`、`WritePayload`、`RetrievalQuery`、`StorageAdapter`、`EventStore`、`EventIdentifier`、`Extractor`、`LLMService`、`EmbeddingService`、`RerankerService`、`CompressionService` 等。
- **存储适配器**：`MemoryAdapter`、`IndexedDBAdapter`、`SQLiteAdapter`（同时从 `memorai/storage` 重新导出）。
- **事件层**：`InMemoryEventStore`、`LLMEventIdentifier`。
- **抽取器**：`WrapExtractor`、`LightExtractor`、`LLMExtractor`。
- **嵌入服务**：`OllamaEmbeddingService`、`OpenAIEmbeddingService`（同时从 `memorai/embeddings` 重新导出）。
- **内部组件（对自定义实现有用）**：`BM25Index`、`LLMReranker`、`EvolutionEngine`、`RetrievalEngine`、`BrowserImageCompressor`、`PassthroughCompressor`。
- **工具函数**：`cosineSimilarity`、`generateId`。

### `memorai/storage`

仅包含存储适配器及其类型 —— 当你希望在一个 tree-shake 后的构建中减少引入时很有用：

- `MemoryAdapter`
- `IndexedDBAdapter`
- `SQLiteAdapter`

### `memorai/embeddings`

仅包含嵌入服务：

- `OllamaEmbeddingService`
- `OpenAIEmbeddingService`

两者都实现了 `EmbeddingService`，你也可以为自定义模型自行实现该接口。

## Tree-shaking 提示

- 优先使用具名导入，而不是命名空间导入。`import * as Memorai from 'memorai'` 会破坏 tree-shaking。
- 浏览器打包不需要引入 `SQLiteAdapter`；Node 打包不需要 `IndexedDBAdapter`。从对应的子路径只引入你实际使用的内容。
- 该包是纯 ESM（`"type": "module"`）。它可以在 Vite、esbuild、Rollup、Webpack 5+ 以及 Node ESM 加载器下干净地打包。

## TypeScript 类型

所有子路径都提供 `.d.ts`。主导出额外重新导出了类型词汇表（`MemoryEvent`、`RecalledMemory`、`EventStore` 等），便于你为自定义实现标注类型：

```typescript
import type { EventStore, MemoryEvent, EventQueryOpts } from 'memorai';

class MyEventStore implements EventStore {
  // ...
}
```
