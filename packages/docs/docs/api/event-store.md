# `EventStore`

Persistent storage for [`MemoryEvent`](/concepts/memory-events) records (Tier 2.5). Separate from [`StorageAdapter`](/api/storage), which holds raw `MemoryNode`s.

## Interface

```typescript
interface EventStore {
  putEvent(event: MemoryEvent): Promise<void>;
  getEvent(id: string): Promise<MemoryEvent | null>;
  deleteEvent(id: string): Promise<void>;
  batchPutEvents(events: MemoryEvent[]): Promise<void>;

  queryEventsByEmbedding(
    embedding: number[],
    opts?: EventQueryOpts & { topK?: number },
  ): Promise<MemoryEvent[]>;

  queryEventsByText(
    text: string,
    opts?: EventQueryOpts & { topK?: number },
  ): Promise<MemoryEvent[]>;

  queryEventsByParticipant(
    participant: string,
    opts?: EventQueryOpts,
  ): Promise<MemoryEvent[]>;

  queryEventsByTopic(topic: string, opts?: EventQueryOpts): Promise<MemoryEvent[]>;

  queryEventsByTimeRange(
    start: number,
    end: number,
    opts?: EventQueryOpts,
  ): Promise<MemoryEvent[]>;

  listEvents(opts?: EventQueryOpts): Promise<MemoryEvent[]>;

  closeEventStore(): Promise<void>;
}

interface EventQueryOpts {
  limit?: number;
  offset?: number;
  orderBy?: 'occurredAt' | 'lastAccessed' | 'confidence';
  order?: 'asc' | 'desc';
  userId?: string;
  kind?: 'state' | 'transition' | 'happening';
  /** Return events still believed valid at this timestamp. */
  validAt?: number;
  /** Drop events with invalidatedAt set. */
  excludeInvalidated?: boolean;
}
```

## Built-in: `InMemoryEventStore`

Ships with the package and is the default when `MemoraiConfig.events` is omitted.

```typescript
import { InMemoryEventStore } from 'memorai';
```

Suitable for single-process agents, tests, and benchmarks. Indexing strategy:

- `participants` / `topics` / `kind` → inverted maps (O(1) filter)
- `description` → BM25 sparse retrieval
- `embedding` → linear-scan cosine (fine up to ~10⁵ events)

For larger stores, implement a custom adapter against a vector DB or persistent store.

## Validity semantics

- `invalidatedAt` undefined → "still believed true"
- `validAt = T` filter → keep events where `invalidatedAt > T` or `invalidatedAt` undefined
- `excludeInvalidated = true` → drop anything with `invalidatedAt` set, regardless of `validAt`

This lets you ask three distinct questions:

```typescript
// What does the agent believe right now?
await store.listEvents({ excludeInvalidated: true });

// What did the agent believe at a specific point in time?
await store.listEvents({ validAt: someTimestamp });

// Full audit trail — what has the agent ever believed?
await store.listEvents();
```

## Custom EventStore

Implement the interface to back the event layer with anything — Postgres, Redis, a vector DB, or a remote service:

```typescript
import type { EventStore, MemoryEvent, EventQueryOpts } from 'memorai';

class PostgresEventStore implements EventStore {
  constructor(private readonly db: Pool) {}

  async putEvent(event: MemoryEvent): Promise<void> {
    await this.db.query(
      'INSERT INTO memory_events (id, kind, description, ...) VALUES (...) ON CONFLICT (id) DO UPDATE SET ...',
      [event.id, event.kind, event.description, /* ... */],
    );
  }

  // ...other methods
}

const memory = new Memorai({
  storage,
  embedding,
  events: new PostgresEventStore(pgPool),
});
```

Memorai never calls into the event store on the hot ingest path beyond `putEvent` during identification, so a remote store is fine — but `queryEventsByEmbedding` / `queryEventsByText` are called per `recall()`, so colocating them with low latency to the agent is recommended.

## Tips

- **Mirror the userId scoping carefully.** Memorai assumes the event store honors `EventQueryOpts.userId`. A custom store that ignores it could leak cross-tenant data.
- **`validAt` is mandatory for recall correctness.** Recall passes `validAt = timeRange.end ?? Date.now()` so superseded states stay out. Your store must filter by it.
- **`putEvent` is also used for updates.** When an event is superseded, Memorai re-puts the old event with `invalidatedAt` set. Your implementation should treat `putEvent(existing)` as an upsert.
