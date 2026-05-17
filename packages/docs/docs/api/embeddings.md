# Embedding Service

The `EmbeddingService` interface lets Memorai stay model-agnostic. Bring whatever embedding model you like — hosted, local, transformers.js, ONNX — as long as it implements two things.

## Interface

```typescript
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  dimension: number;
}
```

- `embed(text)` — required. Returns a fixed-dimension vector.
- `embedBatch(texts)` — optional. If implemented, `Memorai.writeBatch()` uses it to embed many nodes in a single round-trip.
- `dimension` — required. The vector dimension. Must be stable across calls and must match what your storage adapter expects.

Memorai embeds the **composed indexable text** of each node (Tier 1 `raw.text` + Tier 2 `annotations.summary` + `facts`). This means upgrading the extractor and calling `reAnnotate()` naturally refreshes embeddings to reflect the new annotations.

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

  // Optional — speeds up Memorai.writeBatch().
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

Tips:

- **Cache where it makes sense.** `embed()` is called once per write and once per text-only query — small cache hits add up.
- **Implement `embedBatch` if your model supports it.** Memorai's `writeBatch()` and the bulk `reAnnotate()` path both honour it for a meaningful speedup.
- **Match `dimension` exactly.** Switching models mid-database means existing embeddings can't be compared to new ones cleanly. Run `memory.reAnnotate()` (without `skipEmbedding`) to recompute everything after a model swap.
- **Stay synchronous-ish.** `embed` is `async`, but try to keep the latency under a few hundred ms per call. Retrieval blocks on it.
