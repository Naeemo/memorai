# 嵌入服务

`EmbeddingService` 接口让 Memorai 与模型解耦。你可以使用任意嵌入模型 —— 托管的、本地的、transformers.js、ONNX —— 只要它实现两件事。

## 接口

```typescript
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  dimension: number;
}
```

- `embed(text)` —— 必需。返回固定维度的向量。
- `embedBatch(texts)` —— 可选。如果实现，`Memorai.writeBatch()` 会用它在单次往返中嵌入多个节点。
- `dimension` —— 必需。向量维度。必须跨调用稳定，并与你的存储适配器预期一致。

Memorai 嵌入每个节点的**组合后可索引文本**（Tier 1 `raw.text` + Tier 2 `annotations.summary` + `facts`）。这意味着升级抽取器并调用 `reAnnotate()` 会自然地刷新嵌入以反映新的注释。

## 内置服务

从 `memorai/embeddings` 导入：

```typescript
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings';
```

### `OpenAIEmbeddingService`

通过 OpenAI API 提供托管、高质量的嵌入。

```typescript
const embedding = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // optional, sensible default
});
```

### `OllamaEmbeddingService`

由 Ollama 提供的本地模型。适用于离线或私有部署。

```typescript
const embedding = new OllamaEmbeddingService({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});
```

## 自定义嵌入

最小可用实现如下：

```typescript
import type { EmbeddingService } from 'memorai';

class TransformersEmbeddingService implements EmbeddingService {
  readonly dimension = 384;

  async embed(text: string): Promise<number[]> {
    // ...load model, run inference, return vector
  }

  // Optional — speeds up Memorai.writeBatch().
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

提示：

- **在有意义的地方缓存。** 每次写入和每次纯文本查询都会调用一次 `embed()` —— 小的缓存命中积少成多。
- **如果模型支持，就实现 `embedBatch`。** Memorai 的 `writeBatch()` 以及批量 `reAnnotate()` 路径都会遵循它以获得显著加速。
- **`dimension` 必须严格匹配。** 在数据库中途切换模型意味着现有嵌入无法与新嵌入干净比较。模型替换后请运行 `memory.reAnnotate()`（不带 `skipEmbedding`）以重新计算所有内容。
- **保持准同步。** `embed` 是 `async`，但请尽量把每次调用的延迟控制在几百毫秒以内。召回会阻塞在它上面。
