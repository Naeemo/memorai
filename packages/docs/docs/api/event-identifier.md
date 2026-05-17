# `EventIdentifier`

Turns batches of raw `MemoryNode`s into [`MemoryEvent`](/concepts/memory-events) records — the Tier 2.5 semantic layer. Pluggable: bring your own logic, or use the bundled LLM-based default.

## Interface

```typescript
interface EventIdentifier {
  /** Free-form version string persisted on every produced event. */
  readonly version: string;

  /** Identify semantic events from a batch of raw nodes. */
  identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]>;
}

interface IdentifyContext {
  /** Raw nodes that are candidates for identification (a recent batch). */
  nodes: MemoryNode[];

  /**
   * Existing MemoryEvents scoped to the batch's userIds — given to your
   * implementation so it can decide INSERT vs SUPERSEDE on state events.
   */
  relatedEvents: MemoryEvent[];

  embedding: EmbeddingService;
  llm?: LLMService;
  now(): number;
  signal?: AbortSignal;
}

interface IdentifiedEvent {
  kind: 'state' | 'transition' | 'happening';
  description: string;
  participants: string[];
  topics: string[];
  occurredAt: number;
  sourceNodeIds: string[];

  /** Only for state events that update an older state. */
  supersedes?: string[];
  confidence?: number;
}
```

## Built-in: `LLMEventIdentifier`

LLM-powered. Constructed automatically when `MemoraiConfig.llm` is set.

```typescript
import { LLMEventIdentifier } from 'memorai';

const memory = new Memorai({
  storage,
  embedding,
  llm: yourLLM,  // ← auto-wires LLMEventIdentifier
});
```

Or construct explicitly:

```typescript
const identifier = new LLMEventIdentifier({
  llm: yourLLM,
  systemPrompt: customPrompt,         // override the default
  temperature: 0,
  maxInputChars: 16000,                // per-call input budget
  onError: (stage, err, ctx) => {       // custom error logging
    console.warn(`[identifier] ${stage}:`, err, ctx);
  },
});

const memory = new Memorai({ storage, embedding, identifier });
```

### Prompt design

`LLMEventIdentifier` sends the LLM a prompt with three sections:

1. **System prompt** explaining the three event kinds (`state`, `transition`, `happening`) and supersede rules.
2. **EXISTING RELATED EVENTS** — a JSON list of existing events the new batch might supersede (scoped to the batch's `userId`).
3. **RAW NODES TO ANALYZE** — JSON of raw nodes with id, timestamp, text, actor, target.

The LLM returns a JSON array of `IdentifiedEvent`s. The default prompt handles common code-fence wrapping (` ```json ... ``` `) and prose-embedded arrays.

### Error handling

`LLMEventIdentifier` is non-throwing by contract — failures inside the LLM call or JSON parsing return `[]` instead of throwing. By default they're logged via `console.error`; supply `opts.onError` to redirect or silence.

## Custom EventIdentifier

Use cases for a custom identifier:

- Domain-specific extraction (legal, medical, gaming, manufacturing)
- Pure rule-based identification (no LLM, deterministic)
- Hybrid (LLM + rule post-processing)
- Cheap local-model identification followed by validation

```typescript
import type {
  EventIdentifier,
  IdentifiedEvent,
  IdentifyContext,
} from 'memorai';

class RuleBasedIdentifier implements EventIdentifier {
  readonly version = 'rules-v1';

  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    const out: IdentifiedEvent[] = [];
    for (const node of ctx.nodes) {
      const text = node.raw.text ?? '';

      // Example: extract date-bound meetings
      const meetingMatch = text.match(/meeting on (\w+ \d+)/i);
      if (meetingMatch) {
        out.push({
          kind: 'happening',
          description: `Meeting on ${meetingMatch[1]}`,
          participants: [node.actor ?? 'unknown'],
          topics: ['meeting', 'calendar'],
          occurredAt: node.timestamp,
          sourceNodeIds: [node.id],
        });
      }

      // Example: detect state changes ("I'm now ...")
      const stateMatch = text.match(/I'm now (.+)/i);
      if (stateMatch) {
        const description = `User is now ${stateMatch[1]}`;
        const supersedes = ctx.relatedEvents
          .filter((e) => e.kind === 'state' && e.description.startsWith('User is'))
          .map((e) => e.id);
        out.push({
          kind: 'state',
          description,
          participants: [node.userId ?? 'user'],
          topics: ['user-state'],
          occurredAt: node.timestamp,
          sourceNodeIds: [node.id],
          supersedes: supersedes.length > 0 ? supersedes : undefined,
        });
      }
    }
    return out;
  }
}
```

## Contract & invariants

- **`sourceNodeIds` must reference ids in `ctx.nodes`.** Memorai drops events that reference unknown ids; this protects against hallucinated references.
- **Memorai scopes `relatedEvents` per-userId.** Your identifier only ever sees events with matching `userId` from the batch. Cross-tenant supersedes are silently rejected at persist time even if you try.
- **Idempotence.** After `identifyBatch`, Memorai stamps `node.meta.identifiedAt` so the same raw nodes won't be re-fed to your identifier on subsequent `evolve()` calls. Returning `[]` is a valid output and still marks nodes as processed.
- **Tier 1 is untouched.** Your identifier is read-only on raw nodes.

## Tips

- **Keep batches small** (default 30 nodes). Larger batches risk LLM input-budget overflow and confusing supersede signals across distant turns.
- **Output canonical descriptions.** The event's `description` is what `recall` returns as the `summary` field — write it in agent-readable prose.
- **Use the three kinds correctly.**
  - `state` is for assertions ("User prefers ...") that future events may supersede.
  - `transition` is for moments of change ("User started ...") — typically not superseded.
  - `happening` is for time-anchored occurrences ("Meeting at ...") — also typically not superseded.
- **For supersedes, lower bar wins.** It's safer to over-supersede than to leave contradictory state events live. Memorai keeps the audit trail anyway.

## See also

- [`MemoryEvent` concept](/concepts/memory-events) — full lifecycle including supersede
- [Examples → Custom EventIdentifier](/guide/examples#recipe-custom-eventidentifier)
- [`EventStore`](/api/event-store) — where the produced events get persisted
