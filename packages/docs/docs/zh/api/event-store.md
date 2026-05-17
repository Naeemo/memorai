# `EventStore`

[`MemoryEvent`](/zh/concepts/memory-events) 记录（Tier 2.5）的持久化存储。与持有原始 `MemoryNode` 的 [`StorageAdapter`](/zh/api/storage) 互相独立。

## 接口

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

## 内置：`InMemoryEventStore`

随包提供，并且当 `MemoraiConfig.events` 省略时作为默认。

```typescript
import { InMemoryEventStore } from 'memorai';
```

适用于单进程代理、测试和基准。索引策略：

- `participants` / `topics` / `kind` → 倒排映射（O(1) 过滤）
- `description` → BM25 稀疏召回
- `embedding` → 线性扫描余弦（在约 10⁵ 个事件以内表现良好）

对于更大的存储，请实现一个针对向量数据库或持久化存储的自定义适配器。

## 有效性语义

- `invalidatedAt` 未设置 → "仍被认为为真"
- `validAt = T` 过滤 → 保留 `invalidatedAt > T` 或 `invalidatedAt` 未设置的事件
- `excludeInvalidated = true` → 无论 `validAt` 为何，丢弃任何 `invalidatedAt` 已设置的事件

这让你能够提出三个截然不同的问题：

```typescript
// What does the agent believe right now?
await store.listEvents({ excludeInvalidated: true });

// What did the agent believe at a specific point in time?
await store.listEvents({ validAt: someTimestamp });

// Full audit trail — what has the agent ever believed?
await store.listEvents();
```

## 自定义 EventStore

实现该接口可以用任何后端来支撑事件层 —— Postgres、Redis、向量数据库或远程服务：

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

在热摄入路径上，Memorai 除了识别期间的 `putEvent` 之外，绝不会调用事件存储，因此远程存储是可行的 —— 但 `queryEventsByEmbedding` / `queryEventsByText` 会在每次 `recall()` 时被调用，所以建议将其与代理共置以获得低延迟。

## 提示

- **小心地镜像 userId 范围。** Memorai 假定事件存储遵守 `EventQueryOpts.userId`。忽略该参数的自定义存储可能泄露跨租户数据。
- **`validAt` 对召回正确性而言是必需的。** 召回会传入 `validAt = timeRange.end ?? Date.now()`，以便被替代的状态被过滤掉。你的存储必须按它过滤。
- **`putEvent` 也用于更新。** 当一个事件被替代时，Memorai 会以设置了 `invalidatedAt` 的方式重新写入旧事件。你的实现应将 `putEvent(existing)` 视为 upsert。
