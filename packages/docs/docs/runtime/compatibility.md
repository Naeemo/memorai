# Runtime Compatibility & Lifecycle

Memorai targets four runtimes from one codebase: **Browser**, **Node.js**, **Bun**, and **Deno**. The core has no runtime-specific code — everything that touches the platform goes through a pluggable adapter or service.

## Runtime detection

```typescript
const runtime = detectRuntime(); // 'browser' | 'node' | 'bun' | 'deno'
```

You usually don't need this — you pick the right adapter and embedding service for your runtime at construction time. `detectRuntime` is exposed for tools that want to ship one bundle and choose at runtime.

## Conditional exports

Memorai's `package.json` uses conditional exports so the right entry point loads for each runtime:

```json
{
  "exports": {
    ".": {
      "browser": "./dist/browser/index.js",
      "node": "./dist/node/index.js",
      "bun": "./dist/node/index.js",
      "deno": "./dist/deno/index.js",
      "default": "./dist/index.js"
    },
    "./storage": "./dist/storage/index.js",
    "./embeddings": "./dist/embeddings/index.js"
  }
}
```

Bundlers (Vite, esbuild, Rolldown) and the Node loader honour these conditions automatically.

## What changes per runtime

| Feature | Browser | Node.js / Bun / Deno |
|---|---|---|
| Default storage | `IndexedDBAdapter` | `SQLiteAdapter` or `LevelDBAdapter` |
| Compression | Canvas-based image compression | `sharp` / `ffmpeg-wasm` |
| Embeddings | `@xenova/transformers` (WebGPU), or hosted | Ollama / OpenAI API / local |
| Crypto | `crypto.subtle` | `crypto` module (polyfilled for Deno) |

## Lifecycle

```
┌──────────┐     ┌───────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Input   │────►│  Raw Segment  │────►│  STM: Segments   │────►│   HME:      │
│  Stream  │     │  (temporal)   │     │  (fine-grained)  │     │  Segment →  │
└──────────┘     └───────────────┘     └──────────────────┘     │  Atomic     │
                                                                │  Action     │
                                                                └──────┬──────┘
                                                                       │
                                                                       ▼
┌──────────┐     ┌──────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Agent   │◄────│  Retrieval   │◄────│  LTM: Events     │◄────│   HME:      │
│  Query   │     │  (efficient) │     │  (abstract)      │     │  Atomic →   │
└──────────┘     └──────────────┘     └──────────────────┘     │  Event      │
                                                                └─────────────┘
```

The same flow runs everywhere: the only thing that changes is which adapter holds the storage state and which embedding service produces vectors.

## Clean shutdown

```typescript
window.addEventListener('beforeunload', () => memory.close());
// or in Node
process.on('SIGINT', async () => { await memory.close(); process.exit(0); });
```

`close()` does two things: stop the background evolution timer (so the process can exit), and close the underlying storage (so file handles release / IndexedDB transactions flush). Always call it before the runtime tears down.

## Build setup

The library is built with [`vite-plus`](https://github.com/Naeemo/memorai/tree/main/packages/memorai) (Vite + tooling). The core uses only Web Standard APIs (`fetch`, `crypto`, `URL`, etc.), so it can be re-bundled by any consumer toolchain without surprises.

## Browser size quotas

Browser IndexedDB has size quotas (typically tens or hundreds of MB depending on the origin). For long-running browser agents, plan an eviction strategy:

- Use a `salienceScore` cutoff to prune low-importance segments.
- Rely on `meta.lastAccessed` for LRU eviction over time.
- Compress media aggressively if your agent generates a lot of frames.
