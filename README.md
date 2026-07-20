# Memorai

> Memory for AI agents - built to remember, recall, and reflect.

**Browser • Node.js • Bun • Deno**

Memorai is a portable reimplementation of [StreamingClaw's StreamingMemory](https://jackyu6.github.io/StreamingClaw-Page/) architecture, bringing hierarchical multimodal memory evolution to the TypeScript ecosystem.

---

## Features

- **Multimodal Memory Nodes** - Store text, images, audio, and video references together with embeddings and metadata
- **Hierarchical Memory Evolution (HME)** - Raw segments → Atomic actions → Events, with automatic online merging
- **Pluggable Storage** - IndexedDB (Browser), in-memory (testing), or bring your own adapter
- **Pluggable Embeddings** - OpenAI, Ollama, or any custom embedding service
- **Runtime Agnostic** - Same code runs anywhere JavaScript runs
- **Cross-Agent Memory Profiles** - Different agents with different read/write policies share unified storage

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

// Record an event
await memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'observation',
    text: 'User opened VS Code and started editing architecture.md',
  },
}).nodes

// Recall with automatic temporal resolution
const result = await memory.recall('What was the user working on?', { topK: 5 })

console.log(result.memories.map((m) => m.summary))
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

**Bundle size:** the full `memorai` entry is ~56 KB gzipped. Use subpath imports to keep bundles smaller:

- `memorai/storage` — ~8.5 KB gzip
- `memorai/graph` — ~6.5 KB gzip
- `memorai/vector` — ~5.9 KB gzip
- `memorai/embeddings` — ~1.9 KB gzip

---

## Architecture

See [docs/design/ARCHITECTURE.md](docs/design/ARCHITECTURE.md) for the full design document.

**Roadmap status:**
- ✅ Phase 1: Core Foundation (storage adapters, CRUD, embeddings)
- ✅ Phase 2: Hierarchical Memory Evolution (segment → atomic_action → event)
- ✅ Phase 3: Advanced Retrieval (strategies, temporal traversal, early-stop)
- ✅ Phase 4: Multimodal Compression (image/audio/video interfaces)
- ✅ Phase 5: Cross-Agent Ecosystem (examples, OpenClaw integration, real SQLite)

---

## Benchmarks

Memorai is evaluated against both **public datasets** (comparable across libraries) and **internal synthetic tests** (validates specific capabilities in controlled settings).

### Public Datasets

| Benchmark | Score | What it tests | Notes |
|---|---|---|---|
| LoCoMo conv-26 | 33.55% | Multi-turn conversational memory over 26 turns | Primary target for improvement. See [docs/design/OPTIMIZATION-PLAN.md](docs/design/OPTIMIZATION-PLAN.md) for roadmap. |
| LongMemEval | 92% | Event-level recall + query expansion | Competitive (Zep: 64–71%, Mem0: 49%) |

### Internal Synthetic Tests

These are controlled-environment tests with pre-defined conditions. **Not comparable to public benchmarks.**

| Benchmark | Score | What it tests | Test conditions |
|---|---|---|---|
| Needle-in-a-Haystack | 100% | Retrieve a specific fact from 250 distractor memories | Controlled vocabulary, single-hop |
| Multi-Needle Retrieval | 100% | Recall 5 hidden facts simultaneously from 100 memories | Controlled vocabulary, no temporal ambiguity |
| Hierarchical Evolution Preservation | 100% | Information retrievability after STM→LTM compression | 2-level hierarchy, pre-defined segments |
| Temporal Retrieval | 100% | Time-range filtered queries over 24h of activity | Fixed time window, no relative expressions |
| Scalability | 100% | Write/read latency at 1,000 memory corpus | Sequential ingestion, single user |
| Cross-Agent Isolation | 100% | Memory boundary enforcement between agent profiles | Two fixed profiles, no overlap |

**Latest run:** 2026-07-18
**Models:** `nomic-embed-text` (embeddings) · `gemma4:31b-cloud` (LLM judge)
**Batch write speedup:** 2.3× over sequential ingestion.

**Recent changes:** `recall()` now resolves temporal expressions (`"yesterday"`, `"last week"`, etc.) automatically. Disable with `defaultResolveTime: false` in config or `resolveTime: false` per call.

Run benchmarks yourself:

```bash
cd packages/memorai
pnpm add -D tsx  # one-time
pnpm exec tsx benchmarks/index.ts
```

## License

MIT © [Naeemo](https://github.com/Naeemo)
