# Memory Events

A **MemoryEvent** is a semantic unit identified from the raw timeline. It's the layer that lets recall return *what the agent currently believes* rather than *every raw turn that mentioned something*.

Where a raw `MemoryNode` records "this turn was said at time T", a `MemoryEvent` says one of:

- **`state`** — an assertion that persists over time. _"Alice prefers tea over coffee."_ Can be **superseded** by a newer state assertion.
- **`transition`** — a change from one state to another. _"Alice developed a nut allergy after eating peanuts."_ The transition itself is anchored in time; the new state it produces can be its own event.
- **`happening`** — a discrete occurrence anchored in time. _"There's an urgent meeting Wednesday evening that Bob must attend."_

Multiple raw nodes can contribute to one event; one raw node can support several.

## Shape

```typescript
interface MemoryEvent {
  id: string;
  kind: 'state' | 'transition' | 'happening';

  /** Natural-language description — the canonical "what happened" sentence. */
  description: string;

  /** Entities involved (canonical lowercase names). */
  participants: string[];

  /** Tags / topics / categories. */
  topics: string[];

  /** When this event occurred, or when this state became true. */
  occurredAt: number;

  /** For state events: when this assertion was invalidated by a newer one. */
  invalidatedAt?: number;

  /** IDs of MemoryEvents this one supersedes. */
  supersedes?: string[];

  /** IDs of raw MemoryNodes this event was identified from. */
  sourceNodeIds: string[];

  userId?: string;
  actor?: string;
  embedding?: number[];
  confidence?: number;
  identifierVersion?: string;

  meta: {
    identifiedAt: number;
    lastAccessed?: number;
    accessCount: number;
  };
}
```

## How events get identified

The `EventIdentifier` interface inspects a batch of recent raw nodes plus any related existing MemoryEvents (so it can detect supersedes), and returns a list of `IdentifiedEvent` records:

```typescript
interface EventIdentifier {
  readonly version: string;
  identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]>;
}
```

Memorai ships [`LLMEventIdentifier`](/api/event-identifier), which wires up to `MemoraiConfig.llm` and uses a structured prompt that distinguishes the three kinds. You can supply your own — see the [Custom EventIdentifier recipe](/guide/examples#recipe-custom-eventidentifier).

### When identification runs

Two prerequisites must both hold for events to be identified:

1. `MemoraiConfig.llm` is set (or you passed an explicit `MemoraiConfig.identifier`)
2. `evolve()` is called (either manually, or via the auto-trigger config)

The simplest way to set both is just pass `llm` — Memorai auto-wires `LLMEventIdentifier`:

```typescript
const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding,
  llm: yourLLMService,  // ← auto-wires LLMExtractor AND LLMEventIdentifier
});

memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I just started eating fish again' },
});

await memory.evolve();   // runs HME + event identification

const events = await memory.listEvents({ excludeInvalidated: true });
// → [{ kind: 'transition', description: 'User started eating fish again', ... }]
```

Identification is **idempotent**: nodes are marked with `meta.identifiedAt` after processing, so subsequent `evolve()` calls won't re-feed the same input to the LLM.

## Supersede and invalidation

When the EventIdentifier returns a new `state` event with `supersedes: [oldEventId]`, Memorai:

1. Sets the old event's `invalidatedAt` to the new event's `occurredAt`.
2. Persists both records.
3. By default, hides the old one from recall.

The old record stays in storage — Memorai never deletes facts. You can replay history:

```typescript
// "What does the agent currently believe?" (default)
await memory.listEvents({ excludeInvalidated: true });

// "What did the agent believe at time T?"
await memory.listEvents({ validAt: someTimestamp });

// Full audit trail including superseded states
await memory.listEvents();
```

The same filters apply to `recall()` via `RecallOptions.excludeInvalidatedEvents` and `RecallOptions.timeRange`.

::: tip Supersede is authorized per-user
Memorai's identifier only sees events with matching `userId` for supersede context. Even if an identifier returns a supersedes target from another user (defense in depth), the link is silently dropped — Alice's identifier cannot invalidate Bob's events.
:::

## How recall uses events

`Memorai.recall(question, opts)` runs **two retrieval surfaces in parallel** when an `EventIdentifier` is configured:

1. **Node-level**: the multi-pathway retrieval (semantic / BM25 / tag / temporal / identity) over raw `MemoryNode`s.
2. **Event-level**: semantic + BM25 over `MemoryEvent.description`, filtered by `validAt` so superseded states drop out.

Both pathways feed into outer Reciprocal Rank Fusion. Each returned `RecalledMemory` carries provenance — pathways starting with `event:` came from the event layer:

```typescript
const result = await memory.recall('what does the user eat?');
for (const m of result.memories) {
  console.log(m.eventKind, m.summary, m.provenance?.pathways);
  // → "transition" "User started eating fish again" ["event:semantic", "event:bm25"]
}
```

If an event's `sourceNodeIds` overlap with raw-node hits, the raw hits are deduped — the event description is canonical, so we don't double-count.

### Options

```typescript
// Disable the event pathway entirely (only node-level recall)
await memory.recall('...', { includeEvents: false });

// Include superseded state events (replay history)
await memory.recall('...', { excludeInvalidatedEvents: false });

// Scope to a time window — applies to both pathways
await memory.recall('...', { timeRange: { start, end } });
```

## Why this matters

Without an event layer:

- _"Alice is vegetarian"_ and _"Alice is now eating fish"_ live as two raw turns with timestamps. Recall returns both. The agent has to reconcile the conflict at runtime.
- Single-hop fact queries like _"what does Alice eat?"_ have to hit the right raw turn — but the relevant signal is diluted across surrounding context.

With an event layer:

- The two raw turns become two MemoryEvents; the second supersedes the first. Recall returns only the current state by default.
- Single-hop queries hit the canonical fact directly. The answerer gets a clean, current view of what the agent believes.

On the public LoCoMo benchmark, enabling the MemoryEvent layer alone (on top of wrap-mode storage) lifts accuracy by **+15.1 percentage points** and runs ~3× faster than the prior LLM-extraction pipeline. See [Benchmarks](/guide/benchmarks).

## Where to go next

- [Examples → State events and supersede](/guide/examples#recipe-state-events-and-supersede) — runnable supersede flow
- [Examples → Custom EventIdentifier](/guide/examples#recipe-custom-eventidentifier) — plug in your own identifier
- [API → Event Identifier](/api/event-identifier) — the `EventIdentifier` interface in detail
- [API → Event Store](/api/event-store) — the `EventStore` interface for persistent event backends
