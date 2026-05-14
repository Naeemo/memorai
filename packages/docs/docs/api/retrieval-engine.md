# Retrieval Engine

`RetrievalEngine` runs the concurrent retrieval pipeline. As with the evolution engine, you don't normally construct one yourself — `Memorai.retrieve(...)` delegates to it. This page documents the contract for completeness.

## Interface

```typescript
interface RetrievalEngine {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}
```

## Query

```typescript
interface RetrievalQuery {
  // Core query
  text?: string;                    // Natural language query
  embedding?: number[];             // Pre-computed embedding (optional)

  // Strategy hints (command-driven)
  strategy: 'factual' | 'temporal' | 'inferential' | 'exploratory';
  maxDepth?: number;                // Max traversal depth
  earlyStop?: boolean;              // Stop when confidence threshold met

  // Temporal constraints
  timeRange?: { start: number; end: number };
  traversalOrder?: 'forward' | 'reverse' | 'salience';

  // Agent context
  agentRole?: string;               // Filter by agent role
  level?: 'segment' | 'atomic_action' | 'event';

  // Limits
  maxCandidates?: number;
  topK?: number;
}
```

When the query has `text` but no `embedding`, `Memorai.retrieve` calls the configured embedding service to fill it in before handing off to the engine. Direct callers must provide one or the other.

## Result

```typescript
interface RetrievalResult {
  nodes: MemoryNode[];
  confidence: number;               // Aggregate relevance score
  traversalStats: {
    scanned: number;
    matched: number;
    pruned: number;
    timeMs: number;
  };
}
```

`confidence` is an aggregate, not a per-node score. Use it to decide whether to retry with a broader strategy or fall back to a different memory store.

`traversalStats` reports how the engine got to those nodes:

- `scanned` — total candidates pulled from storage indexes.
- `matched` — candidates that survived re-ranking.
- `pruned` — candidates dropped by early-stop or strategy filters.
- `timeMs` — wall-clock time inside `retrieve`.

## Pipeline

```
1. Parse query → determine strategy → set stop criteria
2. Build candidate set (parallel):
   ├─ Semantic search (embedding cosine)
   ├─ Tag / keyword index lookup
   ├─ Temporal index scan (if timeRange specified)
   └─ Salience-ranked pre-filter
3. Concurrent re-ranking:
   ├─ Cross-encoder scoring (if available)
   ├─ Temporal relevance scoring
   └─ Agent-role relevance scoring
4. Evidence extraction → assemble result nodes
5. Early-stop check → return or continue
```

See [Concepts: Retrieval](/concepts/retrieval) for the rationale behind the parallel candidate set and the four strategies.
