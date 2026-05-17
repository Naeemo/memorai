# Hierarchical Memory Evolution

**Hierarchical Memory Evolution (HME)** is the temporal-clustering mechanism that aggregates raw streaming segments into coarser units for locality-aware retrieval. Memorai's HME has three levels:

```
Raw Segments ──► Atomic Actions ──► Episodes
   (fine)         (merged)           (abstract)
   │              │                  │
   │              │                  └─ Scene-similarity aggregation
   │              └─ Compatibility-score merging
   └─ Continuous incoming stream
```

::: tip Episodes ≠ MemoryEvents
Episodes are **temporal clusters** of related raw segments — they group what happened nearby in time and topic. They are NOT the semantic-event records the [EventIdentifier](/concepts/memory-events) produces. MemoryEvents are state assertions, transitions, and happenings extracted from the raw timeline; they live in their own storage layer alongside the HME hierarchy.
:::

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

  // Step 3: Check episode aggregation
  tryAggregateToEpisode(atomicAction)

  return atomicAction
```

## Level 2: Atomic Action → Episode

This runs **periodically** (background loop) or on demand (`memory.evolve()`):

1. Walk a temporally contiguous sequence of atomic actions.
2. Compute a **scene-similarity score**: are they about the same objects / scene?
3. If the merging condition is satisfied → update the existing episode.
4. Otherwise → create a new episode node.
5. Update parent–child links in the hierarchy.

## Why this matters

- **Temporal queryability.** Each episode preserves the atomic-action chain with explicit temporal order — you can replay an episode, not just summarise it.
- **Redundancy compression.** Repetitive segments merge upwards instead of bloating storage.
- **Locality-aware retrieval.** Episodes are stable, retrievable memory chunks for "what happened in this stretch of time" queries.

## Configuration

```typescript
interface EvolutionConfig {
  // Segment → Atomic Action thresholds
  semanticMergeThreshold: number;     // Cosine similarity (default: 0.85)
  temporalGapThresholdMs: number;     // Max gap to merge (default: 30000)

  // Atomic Action → Episode thresholds
  sceneSimilarityThreshold: number;   // Scene consistency (default: 0.80)
  episodeTimeWindowMs: number;        // Max span for an episode (default: 300000)

  // Trigger conditions
  stmMaxSize: number;                 // Max STM nodes before forced evolution
  mode: "auto" | "manual";
  autoTriggers: {
    onWriteCount?: number;
    onIdleMs?: number;
    onStmFull?: boolean;
    onClose?: boolean;
    intervalMs?: number;              // Background loop period (off by default)
  };
}
```

Pass any subset to `new Memorai({ evolution: { ... } })`; unspecified fields fall back to the defaults above.

## Triggering evolution manually

```typescript
// Force a Level-2 pass right now
await memory.evolve();
```

In `mode: "auto"` (default), evolution fires on its own. Manual `evolve()` is for tests, batch ingestion, or shutting down cleanly before exit.

## How HME relates to MemoryEvents

The HME hierarchy is about **temporal locality** — clustering nearby raw segments into coarser units so retrieval can fetch "what happened in the morning" as a coherent block rather than 50 segments. The MemoryEvent layer is about **semantic content** — extracting state assertions, transitions, and happenings that the agent should remember, with their own lifecycle.

Both run over the same raw timeline (Tier 1). The HME output goes into the MemoryNode hierarchy with `level: "atomic_action" | "episode"`; the EventIdentifier output goes into a separate `MemoryEvent` table indexable by participant, topic, and valid time. Recall fuses results from both.
