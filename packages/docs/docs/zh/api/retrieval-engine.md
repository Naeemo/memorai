# `RetrievalEngine`

`RetrievalEngine` 在原始 `MemoryNode` 之上运行多通路并发召回流水线。你通常不会直接构造它 —— `Memorai.recall(...)` 会在内部调用它，然后将其结果与事件级召回（参见 [Memory Events](/zh/concepts/memory-events)）融合。

::: warning `Memorai.retrieve` 是 `@internal`
对于应用代码，请使用 [`Memorai.recall`](/zh/api/memorai#recall) —— 它包装了 `retrieve`，扇出变体查询（HyDE、查询扩展），与事件级层融合结果，并可选地重排。本页记录的 `retrieve` 接口是底层引擎视图。
:::

## 类结构

```typescript
class RetrievalEngine {
  constructor(storage: StorageAdapter);
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}
```

## 查询

```typescript
interface RetrievalQuery {
  text?: string;                    // Natural language query
  embedding?: number[];             // Pre-computed embedding

  strategy: 'factual' | 'temporal' | 'inferential' | 'exploratory';
  earlyStop?: boolean;              // Stop when confidence threshold met

  timeRange?: { start: number; end: number };
  traversalOrder?: 'forward' | 'reverse' | 'salience';

  agentRole?: string;               // Filter by agent role
  userId?: string;
  actor?: string;
  target?: string;
  level?: 'segment' | 'atomic_action' | 'episode';

  maxCandidates?: number;
  topK?: number;
}
```

当查询有 `text` 但没有 `embedding` 时，`Memorai.retrieve` 会调用配置的嵌入服务来填充，然后再交给引擎。

### 策略

| 策略 | 行为 |
|---|---|
| `factual` | 匹配具体事实；偏向高置信度嵌入，缩窄遍历。 |
| `temporal` | 强调时间轴；严格遵守 `timeRange` 和 `traversalOrder`。 |
| `inferential` | 更广召回；引入相关的 atomic_action，不只是直接匹配。 |
| `exploratory` | 最大扇出；用于"X 周围发生了什么"之类的问题。 |

## 结果

```typescript
interface RetrievalResult {
  nodes: MemoryNode[];
  confidence: number;
  traversalStats: {
    scanned: number;
    matched: number;
    pruned: number;
    timeMs: number;
  };
}
```

- `confidence` 是 ∈ [0, 1] 的聚合值。用它判断是否需要使用更广策略重试或降级。
- `traversalStats` 是你了解引擎*如何*到达结果的窗口：总扫描量、重排后保留量、被早停 / 策略过滤丢弃的量、墙钟时间。

## 流水线

```
1. Parse query → determine strategy → set stop criteria
2. Build candidate set in parallel:
   ├─ Semantic search (embedding cosine over Tier 3 vector index)
   ├─ BM25 sparse retrieval
   ├─ Tag / topic index lookup
   ├─ Temporal index scan (if timeRange specified)
   └─ Identity lookup (userId / actor / target)
3. Reciprocal Rank Fusion across pathways
4. Strategy-specific boosts (e.g. recency for "temporal", child-count for "inferential")
5. Early-stop check → return or continue
```

融合后的结果就是 `Memorai.recall` 接下来与事件级召回（参见 [Memory Events](/zh/concepts/memory-events#how-recall-uses-events)）做外层合并的输入。每个存活的节点都附带隐藏的 `_score` / `_pathways` / `_pathwayScores` 注释，会被解包为 `RecalledMemory.provenance`。

## 参见

- [`Memorai.recall`](/zh/api/memorai#recall) —— 大多数调用方想要的公共读取接口
- [概念：召回](/zh/concepts/retrieval) —— 四种策略与多通路设计的设计理由
- [Memory Events](/zh/concepts/memory-events#how-recall-uses-events) —— 事件级召回如何与本引擎组合
