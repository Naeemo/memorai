# Evolution Engine

`EvolutionEngine` runs Hierarchical Memory Evolution: Level-1 (segment → atomic action) on every write, and Level-2 (atomic action → event) periodically or on demand.

Most users never construct this themselves — `new Memorai({ ... })` wires it up internally. You only touch it directly when writing tests or building a custom Memorai-like façade.

## Interface

```typescript
interface EvolutionEngine {
  /** Process a new incoming segment. Triggered by Memorai.write. */
  ingest(segment: RawSegment): Promise<MemoryNode>;

  /** Triggered periodically or on threshold. */
  evolveSTMtoLTM(): Promise<void>;

  /** Configuration */
  config: EvolutionConfig;
}
```

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

Tuning advice:

- **Lower `semanticMergeThreshold`** to make atomic actions more inclusive. Useful when your embeddings are noisy or your domain is repetitive (the same person clicking similar buttons all day).
- **Lower `sceneSimilarityThreshold`** to make events broader. Useful when "the same event" spans a wider range of activity than usual.
- **Raise `autoEvolveIntervalMs`** if Level-2 evolution is expensive in your environment. The cost is that LTM is staler.
- **Lower `stmMaxSize`** to force more aggressive promotion when STM grows.

## Manual control

```typescript
// Force a Level-2 pass right now
await memory.evolve();
```

Use this when:

- Tests need deterministic state before assertions.
- A batch ingest just finished and you want events available immediately.
- The process is about to exit and you want STM flushed to LTM first.

## Algorithm in one page

Level-1 (online, per write):

```text
function ingest(segment):
  node = createSegmentNode(segment)
  candidates = stm.queryRecent(temporalWindow)

  for each candidate in candidates:
    score = compatScore(node, candidate)  // semantic + temporal
    if score > config.semanticMergeThreshold:
      merged = mergeIntoAtomicAction(candidate, node)
      storage.put(merged)
      return merged

  atomicAction = promoteToAtomicAction(node)
  storage.put(atomicAction)
  tryAggregateToEvent(atomicAction)

  return atomicAction
```

Level-2 (periodic):

```text
function evolveSTMtoLTM():
  for each contiguous chunk of atomic_actions in STM:
    if sceneSimilarity(chunk) > sceneSimilarityThreshold
       and chunk.span < eventTimeWindowMs:
      mergeOrUpdateEvent(chunk)
```

See [Concepts: Hierarchical Evolution](/concepts/evolution) for the design rationale.
