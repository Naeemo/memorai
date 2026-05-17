# Introduction

Memorai is a TypeScript memory library for AI agents. It records what happens, identifies the meaningful events, lets agents recall them across long horizons — and is designed so the **original timeline is never lost**, even when the model that interprets it gets upgraded.

It's runtime-agnostic (Browser / Node / Bun / Deno), pluggable end-to-end (storage / embeddings / LLM / extractor / identifier / reranker), and ships with sensible defaults.

## The mental model

Memorai stores three layers per memory, each with a different lifecycle:

| Layer | What it holds | Lifetime |
|---|---|---|
| **Tier 1 — raw timeline** | Verbatim events as they happened: text, image refs, audio, video, files. | Append-only. Never rewritten. |
| **Tier 2 — annotations** | Derived summaries, tags, embeddings, knowledge triples. | Regenerable — call [`reAnnotate()`](/api/memorai#reannotate) to refresh with a better extractor. |
| **Tier 2.5 — MemoryEvents** | Semantic events identified from Tier 1: state assertions, transitions, happenings. State events have a supersede lifecycle. | Lifecycle-managed. New events can invalidate older ones. |
| **Tier 3 — indexes** | BM25, vector, tag, time, participant. | Disposable. Rebuilt from Tiers 1+2 automatically. |

The point of the split: **Tier 1 is the eternal record; everything above it is an interpretation that can evolve.** When a better LLM comes out, you can re-extract Tier 2 across the whole history. When you change your mind about what counts as a meaningful event, you can re-identify Tier 2.5. The raw timeline doesn't care.

## What problem this solves

Most agent memory libraries collapse memory into a single layer: at ingest time the LLM produces a summary, that summary is stored, and the raw conversation is discarded or buried. When the model improves, the old memories don't benefit. When you discover that your extraction prompt was wrong, you can't go back. When two pieces of information contradict — _"Alice is vegetarian"_ vs _"Alice is now eating fish"_ — both stay in storage and recall returns both, leaving the agent to figure out what's currently true.

Memorai separates these concerns explicitly:

- **Raw events are sacred.** They're stored verbatim and never modified.
- **Interpretations are disposable.** Re-run the extractor whenever you want.
- **Semantic events have a lifecycle.** A new state assertion supersedes the old one; recall filters out invalidated facts by default but you can replay history if you need to.

## Recall, end to end

Recall isn't a single-route search. Memorai runs five retrieval pathways in parallel:

```
question ──► embed ──┬─► semantic vector search       ─┐
                     ├─► BM25 sparse retrieval         │ RRF fusion
                     ├─► tag / topic match             ├──► ranked candidates
                     ├─► temporal window filter        │
                     └─► identity (userId/actor/target)─┘
```

…plus, when the MemoryEvent layer is enabled, a sixth and seventh path over events: semantic and BM25 over the canonical event descriptions, with valid-time filtering so superseded states drop out by default.

All paths feed into Reciprocal Rank Fusion. Each returned memory carries pathway-level provenance — you see exactly which routes surfaced it.

## What's pluggable

Almost everything. Memorai ships defaults but every layer can be swapped:

| Layer | Built-in | Bring your own |
|---|---|---|
| Storage | `MemoryAdapter`, `SQLiteAdapter`, `IndexedDBAdapter` | Implement [`StorageAdapter`](/api/storage) |
| Event store | `InMemoryEventStore` | Implement [`EventStore`](/api/event-store) |
| Embeddings | `OllamaEmbeddingService`, `OpenAIEmbeddingService` | Implement [`EmbeddingService`](/api/embeddings) |
| Extractor | `WrapExtractor`, `LightExtractor`, `LLMExtractor` | Implement `Extractor` |
| Event identifier | `LLMEventIdentifier` | Implement [`EventIdentifier`](/api/event-identifier) |
| Reranker | `LLMReranker` | Implement `RerankerService` |
| Compression | `BrowserImageCompressor`, `PassthroughCompressor` | Implement `CompressionService` |

## Who Memorai is for

- **Conversational agents** that need to remember user preferences and history across sessions.
- **Streaming agents** that ingest a continuous flow of observations (screen captures, sensor data, messages).
- **Multi-agent systems** where different roles share storage but read at different granularities.
- **Browser-side AI** where you want everything to run client-side with IndexedDB persistence.

## Where to go next

| If you want to… | Read |
|---|---|
| Run the first example | [Getting Started](/guide/getting-started) |
| See real recipes | [Examples](/guide/examples) |
| Understand the architecture | [Concepts → Overview](/concepts/overview) |
| Build a custom storage adapter | [API → Storage Adapter](/api/storage) |
| See how Memorai scores on public benchmarks | [Benchmarks](/guide/benchmarks) |
