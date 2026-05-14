# Getting Started

## Installation

```bash
pnpm add memorai
# or
npm install memorai
```

Memorai has no required peer dependencies. Storage backends and embedding services are pluggable — you bring the ones you need.

## Hello, memory

The simplest possible setup uses the in-memory storage adapter (great for tests) and an OpenAI embedding service:

```typescript
import { Memorai, MemoryAdapter, OpenAIEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OpenAIEmbeddingService({ apiKey: 'sk-...' }),
});

// Write a memory
const node = await memory.write({
  payload: {
    summary: 'User opened VS Code and started editing architecture.md',
    tags: ['coding', 'vscode'],
    salienceScore: 0.9,
    modality: ['text'],
  },
});

// Retrieve
const result = await memory.retrieve({
  strategy: 'factual',
  text: 'What was the user working on?',
  topK: 5,
});

console.log(result.nodes.map((n) => n.payload.summary));
```

## Browser quick start

In the browser, pair the IndexedDB adapter with a transformers.js-style local embedding service, or call out to a hosted model:

```typescript
import { Memorai, IndexedDBAdapter, OpenAIEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'my-agent-memory' }),
  embedding: new OpenAIEmbeddingService({ apiKey: '...' }),
  evolution: {
    semanticMergeThreshold: 0.85,
    stmMaxSize: 1000,
  },
});
```

## Server / Node.js quick start

On the server, use the SQLite adapter for durable, queryable storage:

```typescript
import { Memorai, SQLiteAdapter, OllamaEmbeddingService } from 'memorai';
import Database from 'better-sqlite3';

const memory = new Memorai({
  storage: new SQLiteAdapter(new Database('./memory.db')),
  embedding: new OllamaEmbeddingService({ baseUrl: 'http://localhost:11434' }),
});
```

## Configuration

`new Memorai(config)` accepts the following:

```typescript
interface MemoraiConfig {
  storage: StorageAdapter;             // required
  embedding: EmbeddingService;         // required
  compression?: CompressionService;    // optional multimodal compression
  evolution?: Partial<EvolutionConfig>;// thresholds & background loop
  agentProfile?: AgentMemoryProfile;   // cross-agent read/write policy
  namespace?: string;                  // multi-tenant prefix
}
```

See the [API Reference](/api/memorai) for the full shape of every option.

## Next steps

- [Examples](/guide/examples) — full programs you can clone and run.
- [Concepts: Overview](/concepts/overview) — how the moving parts fit together.
- [Cross-Agent Memory](/concepts/cross-agent) — multiple agents sharing one store.
