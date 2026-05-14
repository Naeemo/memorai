# Hierarchical Memory Evolution

**Hierarchical Memory Evolution (HME)** is the core mechanism that transforms raw streaming inputs into structured long-term knowledge. Memorai follows StreamingClaw's three-level hierarchy:

```
Raw Segments ──► Atomic Actions ──► Events
   (fine)         (merged)          (abstract)
   │              │                 │
   │              │                 └─ Scene-similarity aggregation
   │              └─ Compatibility-score merging
   └─ Continuous incoming stream
```

## Level 1: Segment → Atomic Action

This runs **online**, on every write. For each new segment:

1. Retrieve neighboring memory nodes from STM.
2. Compute a **compatibility score**: semantic similarity (embedding cosine) combined with temporal continuity (time gap).
3. If the score exceeds the threshold → merge into the existing atomic action.
4. Otherwise → create a new atomic-action node.

In pseudocode:

```text
function ingest(segment):
  node = createSegmentNode(segment)

  // Step 1: Try to merge into an existing atomic action
  candidates = stm.queryRecent(temporalWindow)
  for each candidate in candidates:
    score = compatScore(node, candidate)  // semantic + temporal
    if score > config.semanticMergeThreshold:
      merged = mergeIntoAtomicAction(candidate, node)
      storage.put(merged)
      return merged

  // Step 2: Create a new atomic action
  atomicAction = promoteToAtomicAction(node)
  storage.put(atomicAction)

  // Step 3: Check event aggregation
  tryAggregateToEvent(atomicAction)

  return atomicAction
```

## Level 2: Atomic Action → Event

This runs **periodically** (background loop) or on demand (`memory.evolve()`):

1. Walk a temporally contiguous sequence of atomic actions.
2. Compute a **scene-similarity score**: are they about the same objects / scene?
3. If the merging condition is satisfied → update the existing event.
4. Otherwise → create a new event node.
5. Update parent–child links in the hierarchy.

## Why this matters

- **Temporal queryability.** Each event preserves the atomic-action chain with explicit temporal order — you can replay an event, not just summarise it.
- **Redundancy compression.** Repetitive segments merge upwards instead of bloating storage.
- **Structured long-term storage.** Events are stable, retrievable memory chunks — the abstract index your agent searches over.

## Configuration

```typescript
interface EvolutionConfig {
  // Segment → Atomic Action thresholds
  semanticMergeThreshold: number;     // Cosine similarity (default: 0.85)
  temporalGapThresholdMs: number;     // Max gap to merge (default: 30000)

  // Atomic Action → Event thresholds
  sceneSimilarityThreshold: number;    // Scene consistency (default: 0.80)
  eventTimeWindowMs: number;           // Max span for an event (default: 300000)

  // Trigger conditions
  autoEvolveIntervalMs: number;       // Background evolution (default: 60000)
  stmMaxSize: number;                 // Max STM nodes before forced evolution
}
```

Pass any subset to `new Memorai({ evolution: { ... } })`; unspecified fields fall back to the defaults above.

## Triggering evolution manually

```typescript
// Force a Level-2 pass right now
await memory.evolve();
```

You generally don't need to. The background loop (`autoEvolveIntervalMs`) handles it on a cadence. Manual `evolve()` is for tests, batch ingestion, or shutting down cleanly before exit.
