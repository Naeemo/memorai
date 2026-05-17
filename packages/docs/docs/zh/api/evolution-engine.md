# `EvolutionEngine`

`EvolutionEngine` 运行分层记忆演进（Hierarchical Memory Evolution）：在每次写入时执行 Level-1（segment → atomic_action），并周期性或按需执行 Level-2（atomic_action → episode）。

大多数用户不需要直接构造它 —— `new Memorai({ ... })` 会在内部装配它。只有在编写测试或构建自定义的类 Memorai 外观时才会用到。

::: tip Episodes 与 MemoryEvents
HME 的 `episode` 层是相关原始 segment 的**时间聚类** —— 一种局部性感知的聚合。它与 [`MemoryEvent`](/zh/concepts/memory-events) **不同**，后者是语义记录（state / transition / happening）。两者运行于相同的原始时间线之上；它们回答不同的问题。
:::

## 类结构

```typescript
class EvolutionEngine {
  constructor(storage: StorageAdapter, partialConfig?: Partial<EvolutionConfig>);

  /** Called by Memorai.write after each segment is persisted. */
  processSegment(segment: MemoryNode): Promise<void>;

  /** Trigger Level-2 (atomic_action → episode) — called by Memorai.evolve(). */
  evolve(): Promise<void>;
}
```

## 配置

```typescript
interface EvolutionConfig {
  // Segment → Atomic Action thresholds
  semanticMergeThreshold: number;     // Cosine similarity (default: 0.85)
  temporalGapThresholdMs: number;     // Max gap to merge (default: 30000)

  // Atomic Action → Episode thresholds
  sceneSimilarityThreshold: number;   // Scene consistency (default: 0.80)
  episodeTimeWindowMs: number;        // Max span for an episode (default: 300000)

  // STM size + auto-evolve mode
  stmMaxSize: number;                 // Max STM nodes before forced evolution
  mode: 'auto' | 'manual';            // default: 'auto'
  autoTriggers: {
    onWriteCount?: number;            // every N writes (default 100)
    onIdleMs?: number;                 // after N ms idle (default 5000)
    onStmFull?: boolean;               // when stmMaxSize reached (default true)
    onClose?: boolean;                 // one last evolve from close() (default true)
    intervalMs?: number;               // background loop period (off by default)
  };
}
```

### 调优建议

- **降低 `semanticMergeThreshold`** 可以让 atomic_action 更具包容性。当你的嵌入嘈杂或领域重复度高时很有用。
- **降低 `sceneSimilarityThreshold`** 可让 episode 更宽。当"同一个 episode"覆盖比常规更宽的活动范围时很有用。
- **设置 `autoTriggers.intervalMs > 0`** 启用后台演进循环。默认关闭，以使测试和基准保持确定性。
- **`mode: "manual"`** 禁用所有自动触发器 —— 在你希望以显式 `evolve()` 作为边界的测试和基准中很有用。
- **降低 `stmMaxSize`** 可在 STM 增长时强制更激进的提升。

## 手动控制

```typescript
// Force a Level-2 pass right now
await memory.evolve();
```

在以下场景使用：

- 测试需要在断言前获得确定状态。
- 一次批量摄入刚结束，你希望 episodes（以及识别出的 MemoryEvents）立即可用。
- 进程即将退出，你希望 STM 被刷写。

当配置了 `EventIdentifier` 时，`evolve()` 也会运行事件识别 —— 参见 [Memory Events](/zh/concepts/memory-events)。

## 算法概要

Level-1（在线，每次写入）：

```
function processSegment(segment):
  candidates = queryByTimeRange(now - temporalGap, now, level='atomic_action')

  best = argmax(candidates, compatScore(segment, c))
  if best.score >= semanticMergeThreshold:
    mergeIntoAtomicAction(best, segment)
    return

  createAtomicAction(segment)
```

Level-2（手动 / 调度）：

```
function evolve():
  all = listAll(level='atomic_action')

  for each atomicAction in all:
    if atomicAction.parentId:
      // Already in an episode; refresh aggregation
      updateEpisodeWithChild(parent, atomicAction)
    else:
      // Try to attach to an existing episode by scene similarity
      tryAggregateToEpisode(atomicAction)
```

`compatScore` 结合余弦语义相似度与时间连续性：

```
compatScore = 0.7 * cosine(emb_a, emb_b) + 0.3 * max(0, 1 - timeGap / temporalGapThresholdMs)
```

设计理由参见 [分层演进](/zh/concepts/evolution)。
