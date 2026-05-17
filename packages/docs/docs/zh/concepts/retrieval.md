# 召回

Memorai 的 `recall()` 是一条**扇出 + 融合**流水线。它并行运行多条召回路径 —— 语义、BM25、标签、时间、身份,并在 MemoryEvent 层启用时加入事件级路径 —— 然后将它们合并为已排序的结果。

每个返回的记忆都带有 `provenance.pathways`,精确告诉你哪些路径让它浮现。这既是审计轨迹,也是结果出人意料时的调试工具。

## 流水线

```
question ──► embed ──┬─► semantic vector search  (节点级)         ┐
                     ├─► BM25 sparse retrieval                     │
                     ├─► tag / topic match                         │
                     ├─► temporal window filter                    ├──► 内层 RRF
                     └─► identity (userId/actor/target)            ┘  每个变体
                                                                     │
   变体 (HyDE / queryExpansion) ──────────────────────────────────► 外层 RRF
                                                                     │
   事件存储 ─┬─► semantic over MemoryEvent.embedding ─┐              │
            └─► BM25 over MemoryEvent.description    ─┴─► event RRF
                                                                     ▼
                                            外层融合 (RRF + 去重)
                                                  │
                                            (可选 reranker)
                                                  │
                                                  ▼
                                          RecallResult.memories
```

当设置了 `MemoraiConfig.reranker` 时,最后一次跨编码器(cross-encoder)细化会精化 top-N 候选以提升精度。

## 策略

四种策略调整节点级引擎如何构建候选以及如何提升结果。

| 策略 | 作用 |
|---|---|
| `factual` | 匹配具体事实;偏好高置信嵌入命中,窄遍历。默认。 |
| `temporal` | 强调时间轴;严格遵守 `timeRange` 和 `traversalOrder`。提升 episode 级节点。 |
| `inferential` | 召回更宽;拉入与匹配片段相关的原子动作和情节。 |
| `exploratory` | 最宽的扇出;适合"X 附近发生了什么?"这类问题。 |

## 召回选项

```typescript
interface RecallOptions {
  topK?: number;                        // default 10
  timeRange?: { start: number; end: number };
  actor?: string;
  target?: string;
  userId?: string;
  modality?: Modality[];
  level?: MemoryLevel;                  // restrict node-level pathway
  strategy?: RetrievalStrategy;
  traversalOrder?: TraversalOrder;

  // Event layer
  includeEvents?: boolean;              // default true when identifier is configured
  excludeInvalidatedEvents?: boolean;   // default true — hide superseded states

  // LLM-precision layers (require MemoraiConfig.llm)
  queryExpansion?: number;              // generate N paraphrases, fuse
  hyde?: boolean;                       // hypothetical-answer embedding pathway
}
```

## 返回什么

```typescript
interface RecalledMemory {
  id: string;
  at: number;
  during?: { start: number; end: number };
  userId?: string;
  actor?: string;
  target?: string;
  summary: string;                      // what the agent should read
  description?: string;
  tags: string[];
  salienceScore: number;
  evidence?: MediaPayload;
  score: number;                        // RRF-fused score
  level: 'segment' | 'atomic_action' | 'episode';

  // Tier 2.5 marker — set when this hit came from the MemoryEvent layer
  eventKind?: 'state' | 'transition' | 'happening';
  sourceNodeIds?: readonly string[];

  provenance?: {
    pathways: string[];                 // ["semantic", "bm25", "event:semantic", ...]
    fusedScore: number;
    pathwayScores?: Record<string, number>;
  };
}
```

依据 `eventKind` 分支,以不同方式渲染事件来源的命中。检查 `provenance.pathways` 来调试"为什么这条被返回?"。

## 一个具体示例

```typescript
const result = await memory.recall("what does the user eat?", {
  topK: 5,
  timeRange: { start: lastMonth, end: Date.now() },
});

for (const m of result.memories) {
  if (m.eventKind === 'state') {
    console.log(`[STATE] ${m.summary}  (paths: ${m.provenance?.pathways.join(',')})`);
  } else if (m.eventKind) {
    console.log(`[${m.eventKind.toUpperCase()}] ${m.summary}`);
  } else {
    console.log(`[raw ${m.level}] ${m.summary}`);
  }
}

// → [STATE] User started eating fish again  (paths: event:semantic,event:bm25)
//   [raw segment] Said over dinner: "tried sushi for the first time"  (paths: semantic)
```

状态事件排名更高,因为事件级路径和节点级路径都让它浮现 —— 其原始源片段已从节点级结果中被去重,因为事件已将同一信息正典化。

## 去重行为

当一个事件以 `sourceNodeIds: [A, B]` 浮现时,任何针对 `A` 或 `B` 的原始节点命中都会从最终结果中丢弃。事件的正典描述更适合呈现给回答者;冗余的原始片段只会浪费一个 `topK` 名额。

如需覆盖以查看两者：

```typescript
await memory.recall('...', { includeEvents: false });   // node-level only
```

## 何时使用哪个面

| 问题 | 使用 |
|---|---|
| "用户偏好/相信什么?" | 默认召回 —— 事件层占优 |
| "用户昨天下午 3 点说了什么?" | `recallByTime` + `level: 'segment'` |
| "带我走一遍这次会话发生的一切" | `recallByTime` 配合 `traversalOrder: 'forward'` |
| "用户的饮食随时间发生了什么变化?" | 默认召回,配合 `excludeInvalidatedEvents: false` 查看历史 |
| "查找此特定事件 id 的证据" | `memory.get(id)` |

## 下一步阅读

- [Memory Events](/zh/concepts/memory-events) —— 事件级召回与取代的完整细节
- [`Memorai.recall` API](/zh/api/memorai#recall) —— 所有选项、所有返回字段
- [`RetrievalEngine` API](/zh/api/retrieval-engine) —— 内部节点级引擎(进阶)
