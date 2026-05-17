# 分层记忆演进

**分层记忆演进(Hierarchical Memory Evolution,HME)**是将原始流式片段聚合为更粗粒度单元的时间聚类机制,以支持局部性感知的召回。Memorai 的 HME 有三个级别：

```
原始片段 ──► 原子动作 ──► 情节
 (细)        (合并)      (抽象)
 │           │           │
 │           │           └─ 基于场景相似度的聚合
 │           └─ 基于兼容性得分的合并
 └─ 持续传入的流
```

::: tip 情节 ≠ MemoryEvents
情节是相关原始片段的**时间簇** —— 它们将时间和话题上相邻发生的内容分组。它们**不是** [EventIdentifier](/zh/concepts/memory-events) 产生的语义事件记录。MemoryEvents 是从原始时间轴中抽取的状态断言、状态变化和发生事件;它们与 HME 层级并行,存在于自己的存储层中。
:::

## Level 1：片段 → 原子动作

此过程**在线**运行,每次写入都会触发。对每个新片段：

1. 从 STM 中检索相邻的记忆节点。
2. 计算**兼容性得分**：语义相似度(嵌入余弦)结合时间连续性(时间间隔)。
3. 如果得分超过阈值 → 合并进现有的原子动作。
4. 否则 → 创建一个新的原子动作节点。

伪代码：

```text
function ingest(segment):
  node = createSegmentNode(segment)

  // Step 1: Try to merge into an existing atomic action
  candidates = stm.queryRecent(temporalWindow)
  for each candidate in candidates:
    score = compatScore(node, candidate)  // semantic + temporal
    if score > config.semanticMergeThreshold:
      merged = mergeIntoAtomicAction(candidate, node)
      storage.put(merged)
      return merged

  // Step 2: Create a new atomic action
  atomicAction = promoteToAtomicAction(node)
  storage.put(atomicAction)

  // Step 3: Check episode aggregation
  tryAggregateToEpisode(atomicAction)

  return atomicAction
```

## Level 2：原子动作 → 情节

此过程**周期性**运行(后台循环)或按需运行(`memory.evolve()`)：

1. 遍历一段时间连续的原子动作序列。
2. 计算**场景相似度得分**：它们是否涉及同一对象/场景?
3. 如果满足合并条件 → 更新现有情节。
4. 否则 → 创建一个新的情节节点。
5. 更新层级中的父-子链接。

## 为什么这很重要

- **时间可查询性。**每个情节保留原子动作链的显式时间顺序 —— 你可以回放一个情节,而不仅是总结它。
- **冗余压缩。**重复片段向上合并,而非堆积在存储中。
- **局部性感知的召回。**情节是稳定的、可召回的记忆块,适合"这段时间内发生了什么"类查询。

## 配置

```typescript
interface EvolutionConfig {
  // Segment → Atomic Action thresholds
  semanticMergeThreshold: number;     // Cosine similarity (default: 0.85)
  temporalGapThresholdMs: number;     // Max gap to merge (default: 30000)

  // Atomic Action → Episode thresholds
  sceneSimilarityThreshold: number;   // Scene consistency (default: 0.80)
  episodeTimeWindowMs: number;        // Max span for an episode (default: 300000)

  // Trigger conditions
  stmMaxSize: number;                 // Max STM nodes before forced evolution
  mode: "auto" | "manual";
  autoTriggers: {
    onWriteCount?: number;
    onIdleMs?: number;
    onStmFull?: boolean;
    onClose?: boolean;
    intervalMs?: number;              // Background loop period (off by default)
  };
}
```

将任意子集传入 `new Memorai({ evolution: { ... } })`;未指定的字段会回退到上述默认值。

## 手动触发演进

```typescript
// Force a Level-2 pass right now
await memory.evolve();
```

在 `mode: "auto"`(默认)下,演进会自动触发。手动 `evolve()` 适用于测试、批量摄入,或在退出前干净地关闭。

## HME 与 MemoryEvents 的关系

HME 层级关心的是**时间局部性** —— 把时间相邻的原始片段聚合成更粗的单元,使召回能把"上午发生了什么"作为一个连贯的块抓取出来,而不是 50 个片段。MemoryEvent 层关心的是**语义内容** —— 抽取代理应当记住的状态断言、状态变化和发生事件,并赋予它们自身的生命周期。

两者都运行在同一原始时间轴(Tier 1)之上。HME 的输出进入 MemoryNode 层级,带有 `level: "atomic_action" | "episode"`;EventIdentifier 的输出进入一个独立的 `MemoryEvent` 表,可按参与者、话题和有效时间索引。召回融合两者的结果。
