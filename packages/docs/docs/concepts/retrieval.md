# Retrieval

Memorai retrieval is **command-driven**, **concurrent**, and **temporal-aware**. The agent doesn't just say "search"; it says _how_ to search, and the engine decides traversal depth and stop criteria on top of that hint.

## Strategies

Three complementary strategies, taken directly from StreamingClaw's design:

| Strategy | When to use | Mechanism |
|---|---|---|
| **Command-driven** | The agent has retrieval intent | Agent passes `query + strategy hints` (depth, stop criteria). Memory engine decides traversal depth and when to stop. |
| **High-concurrency** | Large memory corpus | Candidate matching, re-ranking, and evidence extraction all run in parallel. Avoids serial error accumulation. |
| **Self-directed temporal traversal** | Time-sensitive queries | Engine autonomously picks traversal order: forward (causal), reverse (recent-first), salience-first (important-first). |

## Query shape

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
  level?: 'segment' | 'atomic_action' | 'episode';

  // Limits
  maxCandidates?: number;
  topK?: number;
}
```

The four `strategy` values are not just labels — they steer the engine:

- **`factual`** — match concrete facts; favour high-confidence embeddings, narrow traversal.
- **`temporal`** — emphasise the time axis; honour `timeRange` and `traversalOrder` strictly.
- **`inferential`** — broader recall; pull in related atomic actions, not just direct matches.
- **`exploratory`** — widest fan-out; useful for "what happened around X?" questions.

## Result shape

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

`traversalStats` is your window into _how_ the engine answered the query — useful for tuning thresholds and debugging "why didn't it find X?".

## Concurrent pipeline

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

The candidate set is built from multiple sources at once. The re-rankers also run in parallel. This avoids the serial-error problem where each stage's mistakes compound the next stage's.

## Example

The internal `retrieve()` surface returns raw `MemoryNode`s:

```typescript
const result = await memory.retrieve({
  text: 'What was I working on in the editor?',
  strategy: 'factual',
  traversalOrder: 'reverse',
  topK: 5,
});

console.log(result.nodes.map((n) => n.annotations.summary ?? n.raw.text ?? ''));
// → ['User opened the code editor and started typing', ...]
console.log(result.traversalStats);
// → { scanned: 412, matched: 18, pruned: 7, timeMs: 23 }
```

Application code should prefer the public `recall()` API, which wraps the same engine, fuses multiple variant queries, and returns flattened `RecalledMemory` objects with `provenance`:

```typescript
const result = await memory.recall('What was I working on in the editor?', {
  topK: 5,
  traversalOrder: 'reverse',
});
for (const m of result.memories) {
  console.log(m.summary, m.provenance?.pathways);
}
```
