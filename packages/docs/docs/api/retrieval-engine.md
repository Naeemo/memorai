# `RetrievalEngine`

`RetrievalEngine` runs the multi-pathway concurrent retrieval pipeline over raw `MemoryNode`s. You don't normally construct it — `Memorai.recall(...)` invokes it under the hood, then fuses its results with the event-level retrieval (see [Memory Events](/concepts/memory-events)).

::: warning `Memorai.retrieve` is `@internal`
For application code, use [`Memorai.recall`](/api/memorai#recall) — it wraps `retrieve`, fans out variant queries (HyDE, query expansion), fuses results with the event-level layer, and optionally reranks. The `retrieve` surface documented here is the low-level engine view.
:::

## Class shape

```typescript
class RetrievalEngine {
  constructor(storage: StorageAdapter);
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}
```

## Query

```typescript
interface RetrievalQuery {
  text?: string;                    // Natural language query
  embedding?: number[];             // Pre-computed embedding

  strategy: 'factual' | 'temporal' | 'inferential' | 'exploratory';
  earlyStop?: boolean;              // Stop when confidence threshold met

  timeRange?: { start: number; end: number };
  traversalOrder?: 'forward' | 'reverse' | 'salience';

  agentRole?: string;               // Filter by agent role
  userId?: string;
  actor?: string;
  target?: string;
  level?: 'segment' | 'atomic_action' | 'episode';

  maxCandidates?: number;
  topK?: number;
}
```

When the query has `text` but no `embedding`, `Memorai.retrieve` calls the configured embedding service to fill it in before handing off to the engine.

### Strategies

| Strategy | Behavior |
|---|---|
| `factual` | Match concrete facts; favor high-confidence embeddings, narrow traversal. |
| `temporal` | Emphasise the time axis; honour `timeRange` and `traversalOrder` strictly. |
| `inferential` | Broader recall; pull in related atomic actions, not just direct matches. |
| `exploratory` | Widest fan-out; for "what happened around X" questions. |

## Result

```typescript
interface RetrievalResult {
  nodes: MemoryNode[];
  confidence: number;
  traversalStats: {
    scanned: number;
    matched: number;
    pruned: number;
    timeMs: number;
  };
}
```

- `confidence` is an aggregate ∈ [0, 1]. Use it to decide whether to retry with a broader strategy or fall back.
- `traversalStats` is your window into *how* the engine got there: total scanned, kept after re-rank, dropped by early-stop / strategy filters, wall-clock.

## Pipeline

```
1. Parse query → determine strategy → set stop criteria
2. Build candidate set in parallel:
   ├─ Semantic search (embedding cosine over Tier 3 vector index)
   ├─ BM25 sparse retrieval
   ├─ Tag / topic index lookup
   ├─ Temporal index scan (if timeRange specified)
   └─ Identity lookup (userId / actor / target)
3. Reciprocal Rank Fusion across pathways
4. Strategy-specific boosts (e.g. recency for "temporal", child-count for "inferential")
5. Early-stop check → return or continue
```

The fused result is what `Memorai.recall` then outer-merges with the event-level retrieval (see [Memory Events](/concepts/memory-events#how-recall-uses-events)). Each surviving node carries hidden `_score` / `_pathways` / `_pathwayScores` annotations that get unwrapped into `RecalledMemory.provenance`.

## See also

- [`Memorai.recall`](/api/memorai#recall) — the public read surface most callers want
- [Concepts: Retrieval](/concepts/retrieval) — design rationale for the four strategies and the multi-pathway design
- [Memory Events](/concepts/memory-events#how-recall-uses-events) — how event-level retrieval composes with this engine
