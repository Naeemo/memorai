# Runtime Compatibility & Lifecycle

Memorai targets four runtimes from one codebase: **Browser**, **Node.js**, **Bun**, and **Deno**. The core has no runtime-specific code — everything that touches the platform goes through a pluggable adapter or service.

## What changes per runtime

| Feature | Browser | Node.js | Bun | Deno |
|---|---|---|---|---|
| Default storage | [`IndexedDBAdapter`](/api/storage#indexeddbadapter) | [`SQLiteAdapter`](/api/storage#sqliteadapter) via `better-sqlite3` | [`SQLiteAdapter`](/api/storage#sqliteadapter) via `bun:sqlite` | `MemoryAdapter` or custom (no `better-sqlite3`) |
| Embeddings | `OpenAIEmbeddingService`, transformers.js, etc. | `OllamaEmbeddingService`, `OpenAIEmbeddingService` | same as Node | same as Node |
| Compression | `BrowserImageCompressor` (Canvas-based) | `PassthroughCompressor` or custom (`sharp`, `ffmpeg-wasm`) | same | same |
| Background timers | `setTimeout` / `setInterval` (works while tab is active) | `setTimeout` / `setInterval` | same | same |

Memorai's core only uses Web Standard APIs (`fetch`, `crypto`, `URL`, `Promise`, `Map`, `Set`, `ImageData` types). Bundlers re-bundle it without surprises.

## Picking a setup

```typescript
// Browser
import { Memorai, IndexedDBAdapter, OpenAIEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'agent-memory' }),
  embedding: new OpenAIEmbeddingService({ apiKey }),
});

// Node.js
import Database from 'better-sqlite3';
import { Memorai, SQLiteAdapter, OllamaEmbeddingService } from 'memorai';

const memory = new Memorai({
  storage: new SQLiteAdapter(new Database('./memory.db')),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
});
```

## Lifecycle of an event

```
┌──────────┐    recordEvent     ┌──────────┐    extract     ┌─────────────┐
│  Input   │ ─────────────────► │  Event   │ ─────────────► │ MemoryNode  │
│  stream  │                    │  (input) │                │ (level=seg) │
└──────────┘                    └──────────┘                └──────┬──────┘
                                                                   │
                                                                   ▼ processSegment (L1)
                                                            ┌─────────────┐
                                                            │ MemoryNode  │
                                                            │  atomic_    │
                                                            │  action     │
                                                            └──────┬──────┘
                                                                   │
                                                                   ▼ evolve (L2)
                                                            ┌─────────────┐
                                                            │ MemoryNode  │
                                                            │  episode    │
                                                            └──────┬──────┘
                                                                   │
                                                                   ▼ identify (Tier 2.5)
                                                            ┌─────────────┐
                                                            │ MemoryEvent │
                                                            │ state /     │
                                                            │ transition /│
                                                            │ happening   │
                                                            └─────────────┘

                          recall(question)
                          ─────────────────►
                          fan out node-level + event-level pathways
                          → RRF fusion
                          → optional rerank
                          → RecallResult.memories
```

`recordEvent` is fire-and-forget for low latency; extraction happens in the background. `evolve()` is the explicit boundary that publishes both HME episodes and identified MemoryEvents to recall.

## Clean shutdown

```typescript
// Browser
window.addEventListener('beforeunload', () => memory.close());

// Node.js
process.on('SIGINT', async () => {
  await memory.close();
  process.exit(0);
});
```

`memory.close()`:

1. Stops background evolution timers.
2. Optionally flushes a final `evolve()` when `evolution.mode = 'auto'` and `triggers.onClose !== false` (defaults to true).
3. Calls `eventStore.closeEventStore()` if you supplied one.
4. Calls `storage.close()`.

Always call it before the runtime tears down — otherwise file handles may leak and IndexedDB transactions may be aborted.

## Browser-specific notes

### Size quotas

IndexedDB has origin-level quotas (often hundreds of MB; some browsers prompt for more). Plan an eviction strategy for long-running browser agents:

- Use a `salienceScore` cutoff to prune low-importance segments.
- Rely on `meta.lastAccessed` for LRU eviction.
- Configure a `CompressionService` to shrink image / audio frames before storage.

### Lifecycle hooks

The background evolution timer pauses naturally when the tab is backgrounded (browsers throttle `setTimeout` in inactive tabs). For longer-running agents, consider scheduling `evolve()` on visibility-change instead:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') memory.evolve();
});
```

## Node / Bun / Deno notes

### Node + Bun

`SQLiteAdapter` is the recommended persistence layer. On Node use `better-sqlite3`; on Bun use `bun:sqlite` (you may need a small adapter shim to match the `SQLiteDatabase` interface — see [`api/storage`](/api/storage)).

### Deno

`better-sqlite3` doesn't run on Deno. Options:

- **In-memory only** — use `MemoryAdapter`; persist via your own write-out.
- **Custom adapter** — implement `StorageAdapter` against Deno's KV or a Deno-native SQLite library.

The rest of the package (extractors, identifier, retrieval, evolution, recall) runs unchanged on Deno.

## Conditional exports

Memorai's `package.json` exposes the core under one entry plus subpath exports for convenience (see [Subpath Exports](/guide/subpath-exports)). Bundlers and the Node loader honour these automatically.
