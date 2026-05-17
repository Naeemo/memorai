# Subpath Exports

Memorai ships a small set of entry points. The main barrel (`memorai`) re-exports everything for convenience; the subpaths exist so bundlers can tree-shake what you don't use.

```typescript
// Core library + the most common surface
import { Memorai } from 'memorai';

// Storage adapters (also re-exported from the main barrel)
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage';

// Embedding services (also re-exported from the main barrel)
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings';
```

## What lives where

### `memorai` (main barrel)

Everything you need for typical use:

- **Engine**: `Memorai` class.
- **Types**: `MemoryNode`, `MemoryEvent`, `Event`, `EventContent`, `RecallOptions`, `RecallResult`, `RecalledMemory`, `WritePayload`, `RetrievalQuery`, `StorageAdapter`, `EventStore`, `EventIdentifier`, `Extractor`, `LLMService`, `EmbeddingService`, `RerankerService`, `CompressionService`, and the rest.
- **Storage adapters**: `MemoryAdapter`, `IndexedDBAdapter`, `SQLiteAdapter` (re-exported from `memorai/storage`).
- **Event layer**: `InMemoryEventStore`, `LLMEventIdentifier`.
- **Extractors**: `WrapExtractor`, `LightExtractor`, `LLMExtractor`.
- **Embedding services**: `OllamaEmbeddingService`, `OpenAIEmbeddingService` (re-exported from `memorai/embeddings`).
- **Internals (useful for custom implementations)**: `BM25Index`, `LLMReranker`, `EvolutionEngine`, `RetrievalEngine`, `BrowserImageCompressor`, `PassthroughCompressor`.
- **Utilities**: `cosineSimilarity`, `generateId`.

### `memorai/storage`

Storage adapters and types only — useful when you want minimal imports in a tree-shaken build:

- `MemoryAdapter`
- `IndexedDBAdapter`
- `SQLiteAdapter`

### `memorai/embeddings`

Embedding services only:

- `OllamaEmbeddingService`
- `OpenAIEmbeddingService`

Both implement `EmbeddingService`, which you can also implement yourself for custom models.

## Tree-shaking tips

- Prefer named imports over namespace imports. `import * as Memorai from 'memorai'` defeats tree-shaking.
- Browser bundles don't need to import `SQLiteAdapter`; Node bundles don't need `IndexedDBAdapter`. Import only what you use from the appropriate subpath.
- The package is pure ESM (`"type": "module"`). It bundles cleanly under Vite, esbuild, Rollup, Webpack 5+, and the Node ESM loader.

## TypeScript types

All subpaths ship `.d.ts`. The main barrel additionally re-exports the type vocabulary (`MemoryEvent`, `RecalledMemory`, `EventStore`, etc.) so you can type your own provider implementations:

```typescript
import type { EventStore, MemoryEvent, EventQueryOpts } from 'memorai';

class MyEventStore implements EventStore {
  // ...
}
```
