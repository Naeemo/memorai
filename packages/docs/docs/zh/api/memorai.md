# `Memorai`

主要入口。一个实例将存储、嵌入、抽取、事件识别、演进、召回与重排串联到单个对象中。

## 构造

```typescript
class Memorai {
  constructor(config: MemoraiConfig);
}

interface MemoraiConfig {
  // Required
  storage: StorageAdapter;
  embedding: EmbeddingService;

  // Pluggable layers — all optional
  llm?: LLMService;                     // enables LLM extractor + event identifier
  extractor?: Extractor;                // override the auto-picked extractor
  identifier?: EventIdentifier;         // override the auto-picked identifier
  events?: EventStore;                  // override the in-memory event store
  reranker?: RerankerService;           // optional cross-encoder rerank pass
  compression?: CompressionService;     // optional media compression

  // Behaviour
  evolution?: Partial<EvolutionConfig>;
  agentProfile?: AgentMemoryProfile;
  defaultActor?: string;                // fallback when Event.actor is omitted
  defaultUserId?: string;                // fallback when Event.userId is omitted
  namespace?: string;                    // multi-tenant prefix
}
```

### 自动装配

如果你不提供下列字段，Memorai 会选取合理的默认值：

| 字段 | 省略时的默认值 |
|---|---|
| `extractor` | 设置 `llm` 时使用 `LLMExtractor`，否则使用 `LightExtractor` |
| `identifier` | 设置 `llm` 时使用 `LLMEventIdentifier`，否则**不启用**（不启用事件层） |
| `events` | `InMemoryEventStore` |
| `evolution.mode` | `"auto"` |
| `agentProfile` | 默认的 reasoning 角色配置 |

因此 **0.4.0 的标志性配置就是 `{ storage, embedding, llm }`** —— 这会同时启用 LLM 抽取与 LLM 事件识别。

## 公共 API —— 事件 API

主要的读写接口。事件形态的写入，自然语言形态的读取。

### `recordEvent`

```typescript
recordEvent(event: Event): RecordHandle;
```

记录单个事件。立即返回 `RecordHandle` —— 抽取在后台运行。`await handle.nodes` 可阻塞直到抽取完成，或者在低延迟热路径上即发即忘。

```typescript
interface Event {
  // —— time anchor (one required) ——
  at?: number | Date;
  during?: { start: number | Date; end: number | Date };

  // —— participants ——
  actor: string;
  target?: string;
  participants?: string[];

  // —— payload ——
  content: EventContent;

  // —— optional metadata ——
  userId?: string;
  context?: string;
  tags?: string[];
  salienceHint?: number;
  id?: string;
}

type EventContent =
  | { kind: 'message'; text: string }
  | { kind: 'speech'; text: string; audio?: AudioBuffer | string }
  | { kind: 'image'; image: ImageData | string; caption?: string }
  | { kind: 'audio'; audio: AudioBuffer | string; transcript?: string }
  | { kind: 'video'; video: string; frames?: ImageData[]; transcript?: string }
  | { kind: 'file'; mime: string; ref: string; text?: string }
  | { kind: 'observation'; text: string }
  | { kind: 'custom'; text: string; data?: Record<string, unknown> };

interface RecordHandle {
  readonly eventIds: readonly string[];
  readonly nodes: Promise<MemoryNode[]>;
  done(): boolean;
  cancel(): void;
}
```

### `recordEvents`

```typescript
recordEvents(events: Event[]): RecordHandle;
```

以单个批次记录多个事件。事件按数组顺序处理。

### `recall`

```typescript
recall(question: string, opts?: RecallOptions): Promise<RecallResult>;

recallByActor(actor: string, opts?: RecallOptions): Promise<RecallResult>;
recallByRelationship(a: string, b: string, opts?: RecallOptions): Promise<RecallResult>;
recallByTime(range: { start: number; end: number }, opts?: RecallOptions): Promise<RecallResult>;
recallByTag(tags: string[], opts?: RecallOptions): Promise<RecallResult>;
```

在原始节点和 MemoryEvents 之上进行自然语言召回。

```typescript
interface RecallOptions {
  topK?: number;                        // default 10
  timeRange?: { start: number; end: number };
  actor?: string;
  target?: string;
  userId?: string;
  modality?: Modality[];
  level?: MemoryLevel;
  strategy?: RetrievalStrategy;
  traversalOrder?: TraversalOrder;

  // Event layer
  includeEvents?: boolean;              // default true when identifier configured
  excludeInvalidatedEvents?: boolean;   // default true

  // LLM-precision layers (require MemoraiConfig.llm)
  queryExpansion?: number;              // generate N paraphrases, fuse
  hyde?: boolean;                       // hypothetical-answer embedding

  overrideQuery?: Partial<RetrievalQuery>;
}

interface RecallResult {
  memories: RecalledMemory[];
  confidence: number;
  totalScanned: number;
}

interface RecalledMemory {
  id: string;
  at: number;
  during?: { start: number; end: number };
  userId?: string;
  actor?: string;
  target?: string;
  summary: string;
  description?: string;
  tags: string[];
  salienceScore: number;
  evidence?: MediaPayload;
  score: number;
  level: MemoryLevel;

  /** Set when this hit came from the MemoryEvent (Tier 2.5) layer. */
  eventKind?: 'state' | 'transition' | 'happening';
  /** For event-derived hits, the raw nodes the event was identified from. */
  sourceNodeIds?: readonly string[];

  provenance?: {
    pathways: string[];                 // e.g. ["semantic", "event:bm25"]
    fusedScore: number;
    pathwayScores?: Record<string, number>;
  };
}
```

`recall` 的执行步骤：

1. **节点级通路**：在原始 `MemoryNode` 之上执行语义召回 + BM25 + 标签 + 时间 + 身份扇出，通过 RRF 融合。
2. **事件级通路**（当配置了识别器时）：在 `MemoryEvent` 之上执行语义召回 + BM25，并按 `validAt` 与 `userId` 过滤。
3. **外层融合**：两个层面通过 RRF 融合；如果原始节点命中的 ID 出现在已浮现事件的 `sourceNodeIds` 中，则去重。
4. 设置了 `MemoraiConfig.reranker` 时，进行**可选的重排**。

## MemoryEvent 管理

### `identifyRecent`

```typescript
identifyRecent(opts?: { batchSize?: number; maxBatches?: number }): Promise<MemoryEvent[]>;
```

手动触发对尚未被识别的 segment 节点的事件识别。通常由 `evolve()` 调用；如果你希望显式控制识别调度，可以使用它。

幂等 —— 已设置 `meta.identifiedAt` 的节点会被跳过。

### `getEvent`

```typescript
getEvent(id: string): Promise<MemoryEvent | null>;
```

根据 id 取回单个 MemoryEvent。

### `listEvents`

```typescript
listEvents(opts?: {
  userId?: string;
  kind?: 'state' | 'transition' | 'happening';
  validAt?: number;
  excludeInvalidated?: boolean;
  limit?: number;
  offset?: number;
}): Promise<MemoryEvent[]>;
```

带过滤地列出 MemoryEvents。底层查询语义请参考 [`EventStore`](/zh/api/event-store)。

## 管理

### `reAnnotate`

```typescript
reAnnotate(opts?: {
  extractor?: Extractor;
  filter?: (node: MemoryNode) => boolean;
  skipEmbedding?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{
  reannotated: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}>;
```

基于不可变的 Tier 1 原始事件，重新生成整个存储中的 Tier 2 注释和 Tier 3 索引。在升级抽取器或切换嵌入模型后使用。参见 [示例 → 升级抽取器](/zh/guide/examples#recipe-upgrade-the-extractor-across-history)。

### `evolve`

```typescript
evolve(): Promise<void>;
```

手动触发 Level-2 分层演进（将 atomic_actions 聚类为 episodes）以及事件识别。通常会自动触发。可在测试、批量摄入或关闭前使用。

多个并发调用会被合并 —— 同一时刻只会运行一个演进。

### 读取单个节点

```typescript
get(id: string): Promise<MemoryNode | null>;
list(opts?: ListOptions): Promise<MemoryNode[]>;
```

按 id 获取特定的原始 `MemoryNode`，或带过滤地列出节点。`get` 和 `recall` 都会更新 `meta.lastAccessed` / `meta.accessCount`。

### `delete`

```typescript
delete(id: string, cascade?: boolean): Promise<void>;
```

删除一个 MemoryNode。当 `cascade=true` 时，递归删除子节点。当 `false`（默认）时，存活的子节点会与被删除的父节点解除关联。

### `update`

```typescript
update(id: string, patch: NodePatch): Promise<MemoryNode>;
```

修补节点的注释、元数据或链接。**Tier 1 的 `raw` 是故意不可修补的** —— 使用 `reAnnotate()` 从 raw 重新生成 Tier 2。

```typescript
interface NodePatch {
  annotations?: Partial<MemoryAnnotations>;
  meta?: Partial<MemoryMeta>;
  userId?: string;
  actor?: string;
  target?: string;
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];
}
```

### `close`

```typescript
close(): Promise<void>;
```

关闭所有资源 —— 存储适配器、事件存储、后台定时器。在 `evolution.mode = "auto"` 时还会刷写最后一次 `evolve()`。

## 内部 API

```typescript
/** @internal */ write(payload: WritePayload, opts?: WriteOptions): Promise<MemoryNode>;
/** @internal */ writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]>;
/** @internal */ retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
```

这些 API 由抽取器、测试和基准使用。应用代码应使用 `recordEvent` / `recall`。

## 完整示例

```typescript
import Database from 'better-sqlite3';
import {
  Memorai,
  SQLiteAdapter,
  OllamaEmbeddingService,
  type LLMService,
} from 'memorai';

const llm: LLMService = {
  complete: async (prompt, opts) => callMyLLM(prompt, opts),
};

const memory = new Memorai({
  storage: new SQLiteAdapter(new Database('./memory.db')),
  embedding: new OllamaEmbeddingService({ model: 'nomic-embed-text' }),
  llm,  // auto-wires LLMExtractor + LLMEventIdentifier
  agentProfile: {
    agentId: 'browser-assistant',
    role: 'reasoning',
    writePolicy: {
      levels: ['segment', 'atomic_action', 'episode'],
      modalities: ['text', 'vision'],
      salienceBoost: 1,
    },
    readPolicy: {
      defaultLevel: 'episode',
      defaultTraversal: 'reverse',
      timeHorizonMs: 7 * 24 * 60 * 60 * 1000,
    },
  },
});

memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'My favorite editor is VS Code' },
});

await memory.evolve();

const result = await memory.recall("what's the user's favorite editor?");
console.log(result.memories[0].summary);  // → "User prefers VS Code"
console.log(result.memories[0].eventKind); // → "state"
```
