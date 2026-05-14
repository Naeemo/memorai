# Memorai

> Runtime-agnostic, multimodal streaming memory for AI agents.

**Browser • Node.js • Bun • Deno**

Memorai is a portable reimplementation of [StreamingClaw's StreamingMemory](https://jackyu6.github.io/StreamingClaw-Page/) architecture, bringing hierarchical multimodal memory evolution to the TypeScript ecosystem.

---

## Features

- **Multimodal Memory Nodes** — Store text, images, audio, and video references together with embeddings and metadata
- **Hierarchical Memory Evolution (HME)** — Raw segments → Atomic actions → Events, with automatic online merging
- **Pluggable Storage** — IndexedDB (Browser), in-memory (testing), or bring your own adapter
- **Pluggable Embeddings** — OpenAI, Ollama, or any custom embedding service
- **Runtime Agnostic** — Same code runs anywhere JavaScript runs
- **Cross-Agent Memory Profiles** — Different agents with different read/write policies share unified storage

---

## Quick Start

```bash
npm install memorai
```

```typescript
import { Memorai, MemoryAdapter, OpenAIEmbeddingService } from 'memorai'

const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OpenAIEmbeddingService({ apiKey: 'sk-...' }),
})

// Write a memory
const node = await memory.write({
  payload: {
    summary: 'User opened VS Code and started editing architecture.md',
    tags: ['coding', 'vscode'],
    salienceScore: 0.9,
    modality: ['text'],
  },
})

// Retrieve
const result = await memory.retrieve({
  strategy: 'factual',
  text: 'What was the user working on?',
  topK: 5,
})

console.log(result.nodes.map((n) => n.payload.summary))
```

---

## Examples

See `examples/` for complete use cases:

| Example | Runtime | What it shows |
|---|---|---|
| [`browser-assistant.ts`](examples/browser-assistant.ts) | Browser | Browser AI assistant with page visit / click / input memory |
| [`node-server.ts`](examples/node-server.ts) | Node.js | HTTP API server backed by SQLite + background evolution |
| [`cross-agent.ts`](examples/cross-agent.ts) | Any | Two agents (Reasoning + Proactive) sharing the same storage |
| [`openclaw-agent.ts`](examples/openclaw-agent.ts) | Browser / Node | OpenClaw agent integration with heartbeat hooks |

---

## Subpath Exports

```typescript
// Core library
import { Memorai } from 'memorai'

// Storage adapters
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage'

// Embedding services
import { OpenAIEmbeddingService, OllamaEmbeddingService } from 'memorai/embeddings'
```

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

**Roadmap status:**
- ✅ Phase 1: Core Foundation (storage adapters, CRUD, embeddings)
- ✅ Phase 2: Hierarchical Memory Evolution (segment → atomic_action → event)
- ✅ Phase 3: Advanced Retrieval (strategies, temporal traversal, early-stop)
- ✅ Phase 4: Multimodal Compression (image/audio/video interfaces)
- ✅ Phase 5: Cross-Agent Ecosystem (examples, OpenClaw integration, real SQLite)

---

## License

MIT © [Naeemo](https://github.com/Naeemo)
