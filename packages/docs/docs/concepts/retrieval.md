# Retrieval

Memorai's `recall()` is a **fan-out + fuse** pipeline. It runs multiple retrieval pathways in parallel — semantic, BM25, tag, temporal, identity, plus event-level paths when the MemoryEvent layer is enabled — and merges them into a ranked result.

Every returned memory carries `provenance.pathways` telling you exactly which routes surfaced it. That's both an audit trail and a debugging tool when results surprise you.

## The pipeline

```
question ──► embed ──┬─► semantic vector search  (node-level)  ┐
                     ├─► BM25 sparse retrieval                  │
                     ├─► tag / topic match                      │
                     ├─► temporal window filter                 ├──► inner RRF
                     └─► identity (userId/actor/target)         ┘  per variant
                                                                     │
   variants (HyDE / queryExpansion) ───────────────────────────────► outer RRF
                                                                     │
   event store ─┬─► semantic over MemoryEvent.embedding ─┐           │
                └─► BM25 over MemoryEvent.description   ─┴─► event RRF
                                                                     ▼
                                            outer fuse (RRF + dedup)
                                                  │
                                            (optional reranker)
                                                  │
                                                  ▼
                                          RecallResult.memories
```

When `MemoraiConfig.reranker` is set, a final cross-encoder pass refines the top-N candidates for precision.

## Strategies

The four strategies adjust how the node-level engine builds candidates and how it boosts results.

| Strategy | What it does |
|---|---|
| `factual` | Match concrete facts; favour high-confidence embedding hits, narrow traversal. Default. |
| `temporal` | Emphasise the time axis; honour `timeRange` and `traversalOrder` strictly. Boosts episode-level nodes. |
| `inferential` | Broader recall; pull in atomic actions and episodes related to the matched segments. |
| `exploratory` | Widest fan-out; useful for "what happened around X?" questions. |

## Recall options

```typescript
interface RecallOptions {
  topK?: number;                        // default 10
  timeRange?: { start: number; end: number };
  actor?: string;
  target?: string;
  userId?: string;
  modality?: Modality[];
  level?: MemoryLevel;                  // restrict node-level pathway
  strategy?: RetrievalStrategy;
  traversalOrder?: TraversalOrder;

  // Event layer
  includeEvents?: boolean;              // default true when identifier is configured
  excludeInvalidatedEvents?: boolean;   // default true — hide superseded states

  // LLM-precision layers (require MemoraiConfig.llm)
  queryExpansion?: number;              // generate N paraphrases, fuse
  hyde?: boolean;                       // hypothetical-answer embedding pathway
}
```

## What you get back

```typescript
interface RecalledMemory {
  id: string;
  at: number;
  during?: { start: number; end: number };
  userId?: string;
  actor?: string;
  target?: string;
  summary: string;                      // what the agent should read
  description?: string;
  tags: string[];
  salienceScore: number;
  evidence?: MediaPayload;
  score: number;                        // RRF-fused score
  level: 'segment' | 'atomic_action' | 'episode';

  // Tier 2.5 marker — set when this hit came from the MemoryEvent layer
  eventKind?: 'state' | 'transition' | 'happening';
  sourceNodeIds?: readonly string[];

  provenance?: {
    pathways: string[];                 // ["semantic", "bm25", "event:semantic", ...]
    fusedScore: number;
    pathwayScores?: Record<string, number>;
  };
}
```

Branch on `eventKind` to render event-derived hits differently. Inspect `provenance.pathways` to debug "why was this returned?".

## Worked example

```typescript
const result = await memory.recall("what does the user eat?", {
  topK: 5,
  timeRange: { start: lastMonth, end: Date.now() },
});

for (const m of result.memories) {
  if (m.eventKind === 'state') {
    console.log(`[STATE] ${m.summary}  (paths: ${m.provenance?.pathways.join(',')})`);
  } else if (m.eventKind) {
    console.log(`[${m.eventKind.toUpperCase()}] ${m.summary}`);
  } else {
    console.log(`[raw ${m.level}] ${m.summary}`);
  }
}

// → [STATE] User started eating fish again  (paths: event:semantic,event:bm25)
//   [raw segment] Said over dinner: "tried sushi for the first time"  (paths: semantic)
```

The state event ranks higher because the event-level pathways and node-level pathways both surfaced it — its raw source segment got deduped from the node-level results since the event canonicalises the same information.

## Dedup behaviour

When an event surfaces with `sourceNodeIds: [A, B]`, any raw-node hits for `A` or `B` are dropped from the final result. The event's canonical description is the better thing to show the answerer; the redundant raw segments would just waste a `topK` slot.

To override and see both:

```typescript
await memory.recall('...', { includeEvents: false });   // node-level only
```

## When to use which surface

| Question | Use |
|---|---|
| "What does the user prefer/believe?" | Default recall — event layer wins |
| "What did the user say at 3pm yesterday?" | `recallByTime` + `level: 'segment'` |
| "Walk me through everything that happened in this session" | `recallByTime` with `traversalOrder: 'forward'` |
| "What changed in the user's diet over time?" | Default recall with `excludeInvalidatedEvents: false` to see the history |
| "Find evidence of this specific event id" | `memory.get(id)` |

## Where to go next

- [Memory Events](/concepts/memory-events) — full detail on event-level recall and supersede
- [`Memorai.recall` API](/api/memorai#recall) — every option, every return field
- [`RetrievalEngine` API](/api/retrieval-engine) — the internal node-level engine (advanced)
