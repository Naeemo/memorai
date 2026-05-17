# `StorageAdapter`

`StorageAdapter` 是运行时相关的依赖，承载 Memorai 的 Tier 1 原始 `MemoryNode` 和 Tier 3 索引。任何能够存储键值记录并响应少量查询的后端都可以实现该接口。

Tier 2.5 的 `MemoryEvent` 层请参见 [`EventStore`](/zh/api/event-store) —— 那是一个独立的接口。

## 接口

```typescript
interface StorageAdapter {
  // Node CRUD
  put(node: MemoryNode): Promise<void>;
  get(id: string): Promise<MemoryNode | null>;
  delete(id: string): Promise<void>;
  batchPut(nodes: MemoryNode[]): Promise<void>;

  // Range queries
  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]>;
  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]>;
  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]>;
  queryByUserId(userId: string, opts?: QueryOpts): Promise<MemoryNode[]>;
  queryByActor(actor: string, opts?: QueryOpts): Promise<MemoryNode[]>;
  queryByTarget(target: string, opts?: QueryOpts): Promise<MemoryNode[]>;

  /**
   * Sparse keyword retrieval. Adapters implement this with BM25 (or an
   * equivalent best-effort) and return up to `limit` nodes ranked by
   * relevance. Returns [] if `text` produces no tokens.
   */
  queryByText(text: string, opts?: QueryOpts & { limit?: number }): Promise<MemoryNode[]>;

  // Hierarchy traversal
  getChildren(parentId: string): Promise<MemoryNode[]>;
  getParent(childId: string): Promise<MemoryNode | null>;

  // Iteration
  listAll(opts?: QueryOpts): Promise<MemoryNode[]>;

  // Lifecycle
  close(): Promise<void>;
}

interface QueryOpts {
  limit?: number;
  offset?: number;
  orderBy?: 'timestamp' | 'salience' | 'lastAccessed';
  order?: 'asc' | 'desc';
  level?: 'segment' | 'atomic_action' | 'episode';
}
```

## 内置适配器

| 适配器 | 运行时 | 后端 | 适用场景 |
|---|---|---|---|
| `MemoryAdapter` | 任何 | 进程内 `Map` + BM25 索引 | 测试、临时会话、基准 |
| `IndexedDBAdapter` | 浏览器 | IndexedDB | 浏览器扩展、Web 应用 |
| `SQLiteAdapter` | Node / Bun（Deno 受限） | 通过兼容 `better-sqlite3` 句柄的 SQLite | 服务端持久化 |

从顶层桶或 `memorai/storage` 中导入它们：

```typescript
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai';
// or
import { MemoryAdapter, IndexedDBAdapter, SQLiteAdapter } from 'memorai/storage';
```

### `MemoryAdapter`

纯进程内实现。不持久化任何数据。非常适合测试、短生命周期会话以及基准框架。

```typescript
const storage = new MemoryAdapter();
```

### `IndexedDBAdapter`

仅浏览器可用。跨刷新和标签页持久化。Schema 迁移会自动处理（截至 0.4.0 数据库版本为 4 —— 迁移自早期版本的 `event` → `episode` level 重命名）。

```typescript
const storage = new IndexedDBAdapter({ dbName: 'my-agent-memory' });
```

### `SQLiteAdapter`

服务端。接受任意与 `better-sqlite3` 兼容的数据库句柄。

```typescript
import Database from 'better-sqlite3';
const storage = new SQLiteAdapter(new Database('./memory.db'));
```

兼容的运行时：

| 运行时 | DB |
|---|---|
| Node.js | `better-sqlite3` |
| Bun | `bun:sqlite`（带一个小型 shim） |
| Deno | 受限 —— `better-sqlite3` 无法运行。请使用 `MemoryAdapter` 或针对 Deno SQLite 的自定义适配器。 |

## 编写你自己的适配器

实现该接口，并将实例传给 `new Memorai({ storage })`。如果你没有原生 FTS 方案，可复用 `memorai` 中的 `BM25Index`。

```typescript
import type { StorageAdapter, MemoryNode, QueryOpts } from 'memorai';
import { BM25Index } from 'memorai';

class RedisAdapter implements StorageAdapter {
  private bm25 = new BM25Index();

  constructor(private readonly redis: RedisClient) {}

  async put(node: MemoryNode): Promise<void> {
    await this.redis.set(`node:${node.id}`, JSON.stringify(node));
    // ... maintain side indexes for tags, timestamp ranges, etc.
    this.bm25.put(node.id, this.indexableText(node));
  }

  // ...other methods
}
```

### 提示

- **为热路径建立索引。** `queryByTimeRange`、`queryByTags`、`queryByEmbedding`（通过 BM25 或向量搜索）、`queryByUserId` 都会在召回期间被调用。原生索引带来的收益显著。
- **`batchPut` 应当尽量原子。** HME 调用 `batchPut` 来提交合并结果。此处的部分失败会让层级关系陷入不一致。
- **层级查询需要父索引。** 每次以 `cascade: true` 删除节点时都会调用 `getChildren(parentId)`。
- **`close()` 应当幂等。** Memorai 会在 `memory.close()` 期间调用一次；即便被重复调用也不应崩溃。
- **延迟加载 BM25。** `MemoryAdapter` 和 `IndexedDBAdapter` 都会在首次查询时从持久化节点惰性加载 BM25 状态。如果你的后端持久化节点但不持久化 BM25 状态，请遵循同样做法。

Redis 或 PostgreSQL 适配器留作练习 —— 两者都很自然地契合该接口，欢迎现有社区贡献。
