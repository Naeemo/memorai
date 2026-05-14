# Storage Adapter

The `StorageAdapter` is the only runtime-specific dependency in Memorai. Anything that can store key-value records and respond to a few queries can implement it.

## Interface

```typescript
interface StorageAdapter {
  // Node CRUD
  put(node: MemoryNode): Promise<void>;
  get(id: string): Promise<MemoryNode | null>;
  delete(id: string): Promise<void>;

  // Batch operations (for HME efficiency)
  batchPut(nodes: MemoryNode[]): Promise<void>;

  // Range queries (temporal)
  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]>;

  // Tag / salience index queries
  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]>;
  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]>;

  // Hierarchy traversal
  getChildren(parentId: string): Promise<MemoryNode[]>;
  getParent(childId: string): Promise<MemoryNode | null>;

  // Lifecycle
  close(): Promise<void>;
}

interface QueryOpts {
  limit?: number;
  offset?: number;
  orderBy?: 'timestamp' | 'salience' | 'lastAccessed';
  order?: 'asc' | 'desc';
  level?: 'segment' | 'atomic_action' | 'event';
}
```

## Built-in adapters

| Adapter | Runtime | Backend | Best for |
|---|---|---|---|
| `IndexedDBAdapter` | Browser | IndexedDB | Browser extensions, web apps |
| `LevelDBAdapter` | Node.js, Bun | LevelDB / RocksDB | Server-side, high throughput |
| `SQLiteAdapter` | Node.js, Bun, Deno | SQLite | Structured queries, embedded |
| `MemoryAdapter` | Any | In-memory `Map` | Testing, ephemeral |

Import them from `memorai/storage`:

```typescript
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage';
```

### `MemoryAdapter`

Pure in-process Map. Nothing persists across reloads. Ideal for tests and short-lived sessions.

```typescript
const storage = new MemoryAdapter();
```

### `IndexedDBAdapter`

Browser-only. Uses IndexedDB under the hood; data persists across reloads and tabs.

```typescript
const storage = new IndexedDBAdapter({ dbName: 'my-agent-memory' });
```

### `SQLiteAdapter`

Server-side. Takes any `better-sqlite3`-compatible database handle, so you can use `better-sqlite3` on Node.js or `bun:sqlite` on Bun.

```typescript
import Database from 'better-sqlite3';
const storage = new SQLiteAdapter(new Database('./memory.db'));
```

## Writing your own adapter

Implement the interface and pass the instance to `new Memorai({ storage })`. Tips:

- **Indexes pay off.** `queryByTags`, `queryBySalience`, and `queryByTimeRange` are hot paths during retrieval. If your backend supports indexes (SQL `CREATE INDEX`, IndexedDB object stores, etc.), use them.
- **Batch puts must be atomic-ish.** HME calls `batchPut` to commit merge results. Partial failures here leave the hierarchy inconsistent.
- **Hierarchy queries need a parent index.** `getChildren` is called every time a node is deleted with `cascade: true`.
- **`close()` should be idempotent.** Memorai calls it once during `memory.close()`; nothing else should crash if it's called twice.

A Redis or PostgreSQL adapter is left as an exercise — both fit the interface naturally.
