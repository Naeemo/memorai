# Embedding Service

The `EmbeddingService` interface lets Memorai stay model-agnostic. Bring whatever embedding model you like — hosted, local, transformers.js, ONNX — as long as it implements three things.

## Interface

```typescript
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedMultimodal?(payload: MultimodalPayload): Promise<number[]>;
  dimension: number;
}
```

- `embed(text)` — required. Returns a fixed-dimension vector.
- `embedMultimodal(payload)` — optional. If implemented, Memorai will use it for nodes with non-text modalities.
- `dimension` — required. The vector dimension. Must be stable across calls and must match what your storage adapter expects.

## Built-in services

Import from `memorai/embeddings`:

```typescript
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings';
```

### `OpenAIEmbeddingService`

Hosted, high-quality embeddings via the OpenAI API.

```typescript
const embedding = new OpenAIEmbeddingService({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // optional, sensible default
});
```

### `OllamaEmbeddingService`

Local models served by Ollama. Great for offline or private deployments.

```typescript
const embedding = new OllamaEmbeddingService({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});
```

## Custom embeddings

The minimum useful implementation looks like this:

```typescript
import type { EmbeddingService } from 'memorai';

class TransformersEmbeddingService implements EmbeddingService {
  readonly dimension = 384;

  async embed(text: string): Promise<number[]> {
    // ...load model, run inference, return vector
  }
}
```

Tips:

- **Cache where it makes sense.** `embed()` is called once per write and once per text-only query — small cache hits add up.
- **Batch when possible.** If your model exposes a batch API, override `writeBatch` in your custom wrapper to take advantage. Memorai doesn't batch automatically, but writing one method that batches under the hood is fine.
- **Match `dimension` exactly.** Switching models mid-database means existing embeddings can't be compared to new ones cleanly. Reset storage or run a migration.
- **Stay synchronous-ish.** `embed` is `async`, but try to keep the latency under a few hundred ms per call. Retrieval blocks on it.
