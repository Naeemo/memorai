# MemoryEvents

A **MemoryEvent** is a semantic unit identified from the raw timeline — the layer that lets recall return *what the agent currently knows* instead of just *which raw turns mentioned something*.

Where the raw `MemoryNode` is "this turn was said at time T", a `MemoryEvent` is one of:

- **`state`** — an assertion that persists. _"Alice prefers tea over coffee."_ Can be **superseded** by a newer state.
- **`transition`** — a change from one state to another, optionally with a trigger. _"Alice developed a nut allergy after eating peanuts."_ The transition itself is anchored in time; the resulting state can be its own event.
- **`happening`** — a discrete occurrence anchored in time. _"There's an urgent meeting Wednesday evening that Bob must attend."_

Multiple raw nodes can identify one event; one raw node can contribute to several events.

## The `MemoryEvent` shape

```typescript
interface MemoryEvent {
  id: string;
  kind: 'state' | 'transition' | 'happening';

  /** Natural-language description — the canonical "what happened" sentence. */
  description: string;

  /** Entities involved (canonical lowercase). */
  participants: string[];

  /** Tags / topics. */
  topics: string[];

  /** When this event occurred or this state became true. */
  occurredAt: number;

  /** For state events: when this assertion was invalidated by a newer one. */
  invalidatedAt?: number;

  /** IDs of MemoryEvents this one supersedes. */
  supersedes?: string[];

  /** IDs of raw MemoryNodes this event was identified from. */
  sourceNodeIds: string[];

  userId?: string;
  actor?: string;

  /** Embedding over description + participants + topics. */
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

## How they get identified

The `EventIdentifier` interface looks at a batch of recent raw `MemoryNode`s plus any related existing `MemoryEvent`s (for supersede context), and produces a list of `IdentifiedEvent` records:

```typescript
interface EventIdentifier {
  readonly version: string;
  identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]>;
}
```

The default ships in the package as `LLMEventIdentifier`, which wires up to `MemoraiConfig.llm`. It sends the raw turns + related events to the LLM with a prompt that distinguishes the three kinds and asks for structured JSON output.

Identification runs as part of `Memorai.evolve()` (or by calling `memory.identifyRecent()` directly). Nodes are marked `meta.identifiedAt` after processing so subsequent evolve passes don't re-ask the LLM on the same input.

```typescript
const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding: new OpenAIEmbeddingService({ apiKey: '...' }),
  llm: yourLLMService, // enables both LLMExtractor AND LLMEventIdentifier
});

// ingest raw events
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I just started eating fish again' },
});

await memory.evolve();        // runs HME + event identification
const events = await memory.listEvents({ excludeInvalidated: true });
// → [{ kind: 'transition', description: 'User started eating fish again', ... }]
```

## Supersede & invalidation

State events can replace each other. When the `EventIdentifier` returns a new state event with `supersedesIds: [oldId]`, Memorai marks the old event's `invalidatedAt` to the new event's `occurredAt`. The old record is preserved (Tier 1 remains immutable; the event store keeps the audit trail) but recall by default filters it out.

```typescript
// "Currently believed" — invalidated states excluded
await memory.listEvents({ excludeInvalidated: true });

// "What did the agent believe at time T" — replay history
await memory.listEvents({ validAt: someTimestamp });

// Full audit trail including superseded states
await memory.listEvents();
```

## How recall uses events

`Memorai.recall(question, opts)` runs **two retrieval surfaces in parallel** when an `EventIdentifier` is configured:

1. **Node-level**: the existing multi-pathway retrieval (semantic / BM25 / tag / temporal / identity) over raw `MemoryNode`s.
2. **Event-level**: semantic + BM25 over `MemoryEvent`s, filtered by `validAt` (so superseded states drop out).

Both pathways feed into outer Reciprocal Rank Fusion. Each returned `RecalledMemory` carries provenance — pathways starting with `event:` came from the event layer:

```typescript
const result = await memory.recall('what does the user eat?');
for (const m of result.memories) {
  console.log(m.summary, m.provenance?.pathways);
  // → "User started eating fish again", ["event:semantic", "event:bm25"]
}
```

Set `opts.includeEvents = false` to skip the event pathway. Set `opts.excludeInvalidatedEvents = false` to include superseded states (useful for "show me everything Alice has ever said about diet").

## Why this matters

Without an event layer:
- _"Alice is vegetarian"_ and _"Alice now eats fish"_ live as two raw turns with timestamps. Recall returns both. The agent has to figure out the conflict.
- Single-hop fact queries like _"what does Alice eat?"_ have to hit the right raw turn — which has the answer diluted across context, with weak semantic signal vs distractors.

With an event layer:
- The two raw turns become two MemoryEvents, the second supersedes the first. Recall returns _only_ the current state by default.
- Single-hop queries hit the canonical fact directly. Stronger signal, less work for the answerer.

This is what `mem0` / `Zep` are doing under the hood. The difference in Memorai's three-tier model is that the raw timeline (Tier 1) stays intact — you can call `Memorai.reAnnotate()` or rerun event identification with a better extractor across the whole history without losing the source.

## Custom EventIdentifier

Implement the `EventIdentifier` interface to plug in your own logic — a domain-specific prompt, a non-LLM rule-based identifier, or a hybrid:

```typescript
import type { EventIdentifier, IdentifiedEvent, IdentifyContext } from 'memorai';

class MyDomainIdentifier implements EventIdentifier {
  readonly version = 'my-domain-v1';
  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    // ...inspect ctx.nodes, return events.
  }
}

const memory = new Memorai({
  // ...
  identifier: new MyDomainIdentifier(),
});
```
