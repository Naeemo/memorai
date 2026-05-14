# Subpath Exports

Memorai ships a small set of subpath entry points so you can tree-shake what you don't use:

```typescript
// Core library
import { Memorai } from 'memorai';

// Storage adapters
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage';

// Embedding services
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings';
```

## What's exported where

### `memorai`

The main entry point. Exports the `Memorai` class, all shared types (`MemoryNode`, `WritePayload`, `RetrievalQuery`, etc.), and the high-level engines. The barrel also re-exports adapters and embedding services for convenience, so you can import everything from one path if you prefer.

### `memorai/storage`

Storage adapters and the `StorageAdapter` interface:

- `MemoryAdapter` — in-process Map, intended for tests and short-lived sessions.
- `IndexedDBAdapter` — browser persistent storage.
- `SQLiteAdapter` — Node.js / Bun / Deno; takes any `better-sqlite3`-compatible database handle.

### `memorai/embeddings`

Pluggable embedding services:

- `OpenAIEmbeddingService` — hosted OpenAI API.
- `OllamaEmbeddingService` — local models via Ollama.

Both implement the `EmbeddingService` interface, which you can also implement yourself for custom models.

## Tree-shaking

Because each entry point only pulls in the modules you import, code that runs in the browser doesn't pay for the SQLite adapter, and code that runs on the server doesn't pay for IndexedDB shims. ESM `import` chains are the most reliable way to keep bundles small — avoid wildcard re-exports in your own code when you can.
