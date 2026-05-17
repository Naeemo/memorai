# Memory Nodes

A **memory node** is the fundamental unit of memory in Memorai. Every recorded event produces one; every retrieval returns a set of them. The shape is intentionally tiered so the canonical truth survives even when the layers above it evolve.

## Three tiers of storage

Memorai separates *what was observed* from *how we currently understand it*:

- **Tier 1 — `raw`**: the original event content. Append-only. Never modified by extractors, evolution, or upgrades. This is the canonical timeline.
- **Tier 2 — `annotations`**: derived summaries, tags, embeddings, knowledge triples. Re-extractable from Tier 1 via [`reAnnotate()`](/api/memorai#reannotate).
- **Tier 2.5 — `MemoryEvent`s**: semantic state / transition / happening records identified from raw nodes. Lifecycle-managed (state events can be superseded). See [Memory Events](/concepts/memory-events) — they live in a separate store from `MemoryNode`s.
- **Tier 3 — indexes**: BM25, vector, tag, time, participant indexes maintained internally by storage adapters. Disposable; rebuildable from Tiers 1 + 2 + 2.5 at any time.

## The `MemoryNode` shape

```typescript
interface MemoryNode {
  id: string;                    // Unique identifier
  timestamp: number;             // Unix ms — when this memory ends
  duration: number;              // Duration in ms (0 for point-in-time)
  level: 'segment' | 'atomic_action' | 'episode';

  userId?: string;               // Multi-tenant scope
  actor?: string;                // Who produced the event
  target?: string;               // Whom the event was directed at
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];

  // Tier 1 — immutable raw record
  raw: {
    content: EventContent;       // Preserved verbatim from recordEvent
    text?: string;               // Flat text projection for indexing
    media?: MediaPayload;        // Multimodal references (frames, audio, video)
  };

  // Tier 2 — derived annotations
  annotations: {
    summary?: string;            // Canonical fact form
    facts?: string[];            // Paraphrased forms — improves recall coverage
    description?: string;
    tags: string[];
    salienceScore: number;       // 0.0–1.0
    modality: ('text' | 'vision' | 'audio' | 'multimodal')[];
    embedding?: number[];
    triples?: KnowledgeTriple[]; // Subject/predicate/object — graph pathway
    extensions?: Record<string, unknown>; // Open extension surface
  };
  annotatedAt?: number;          // Unix ms when annotations were produced
  annotationVersion?: string;    // Free-form version string of the extractor

  meta: {
    sourceAgent: string;
    agentRole: string;
    writeContext?: string;
    participants?: string[];
    eventId?: string;            // Back-reference to the originating Event
    lastAccessed?: number;
    accessCount: number;
    identifiedAt?: number;       // Set after EventIdentifier processes this node
  };
}
```

::: tip Key insight
Do **not** force-convert visual information to text. Store the original media reference in `raw.media` alongside the text projection in `raw.text` and the semantic embedding in `annotations.embedding`. This prevents semantic misalignment and information loss, and lets you regenerate `annotations` with a better extractor later without losing the original.
:::

## Why three tiers

A single-layer "summarize at ingest" approach (the mem0/Zep model) bakes the extractor's understanding into the stored record. When you upgrade the model, every old memory is stuck at the old quality. Memorai keeps the raw event verbatim, so:

- Upgrading the extractor regenerates Tier 2 across the entire history — no data lost.
- Multiple interpretations can coexist (e.g., a per-extractor `annotationVersion` per node).
- Provenance traces back to the original source, not just a derived summary.

## Memory hierarchy (levels)

Within each tier, nodes are organised by aggregation level:

| | **Segment** | **Atomic Action** | **Episode** |
|---|---|---|---|
| **Granularity** | Highest — one per `recordEvent` | Merged from semantically + temporally close segments | Aggregated cluster of atomic actions |
| **Lifecycle** | Created by `write` | Created/updated by Level-1 evolution (per write) | Created/updated by Level-2 evolution (per `evolve()`) |
| **Use case** | Raw recall, supersede provenance | Locality-aware retrieval | "What happened around X" queries |

The boundary between levels is hierarchical, not physical. All three levels live in the same storage adapter; queries can target a specific level via `RecallOptions.level`.

::: tip Episodes are not MemoryEvents
The HME `episode` level is a *temporal cluster* of raw segments. It is **not** the same as a [`MemoryEvent`](/concepts/memory-events), which is a *semantic* record (state / transition / happening). Both run over the same raw timeline; they answer different questions.
:::

## A worked example

A browser assistant records one event per significant page action:

```typescript
const handle = memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'image',
    image: screenshot,
    caption: 'User opened VS Code and started editing architecture.md',
  },
  tags: ['coding', 'vscode', 'architecture'],
  salienceHint: 0.9,
});

const nodes = await handle.nodes;
console.log(nodes[0].raw.content);          // Tier 1 — original event
console.log(nodes[0].annotations.summary);  // Tier 2 — derived summary
```

What comes back is a fully populated `MemoryNode`. Behind the scenes, Memorai ran the configured extractor to produce `annotations`, persisted both tiers, and kicked off a Level-1 evolution pass — see [Hierarchical Evolution](/concepts/evolution).
