# Memory Nodes

**记忆节点(memory node)**是 Memorai 中记忆的基本单元。每次记录事件都会产生一个;每次召回都会返回一组。其形状被刻意分层,以便上层演进时,正典的真相仍能保留。

## 三层存储

Memorai 将*实际观察到的内容*与*当前的理解方式*分离开来：

- **Tier 1 —— `raw`**：原始事件内容。仅追加。永不被抽取器、演进或升级修改。这是正典时间轴。
- **Tier 2 —— `annotations`**：派生的摘要、标签、嵌入、知识三元组。可通过 [`reAnnotate()`](/zh/api/memorai#reannotate) 从 Tier 1 重新抽取。
- **Tier 2.5 —— `MemoryEvent`s**：从原始节点中识别出的语义 state / transition / happening 记录。生命周期受管理(状态事件可被取代)。参见 [Memory Events](/zh/concepts/memory-events) —— 它们位于与 `MemoryNode` 分离的存储中。
- **Tier 3 —— 索引**：BM25、向量、标签、时间、参与者索引,由存储适配器内部维护。可丢弃;可随时从 Tier 1 + 2 + 2.5 重建。

## `MemoryNode` 形状

```typescript
interface MemoryNode {
  id: string;                    // Unique identifier
  timestamp: number;             // Unix ms — when this memory ends
  duration: number;              // Duration in ms (0 for point-in-time)
  level: 'segment' | 'atomic_action' | 'episode';

  userId?: string;               // Multi-tenant scope
  actor?: string;                // Who produced the event
  target?: string;               // Whom the event was directed at
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];

  // Tier 1 — immutable raw record
  raw: {
    content: EventContent;       // Preserved verbatim from recordEvent
    text?: string;               // Flat text projection for indexing
    media?: MediaPayload;        // Multimodal references (frames, audio, video)
  };

  // Tier 2 — derived annotations
  annotations: {
    summary?: string;            // Canonical fact form
    facts?: string[];            // Paraphrased forms — improves recall coverage
    description?: string;
    tags: string[];
    salienceScore: number;       // 0.0–1.0
    modality: ('text' | 'vision' | 'audio' | 'multimodal')[];
    embedding?: number[];
    triples?: KnowledgeTriple[]; // Subject/predicate/object — graph pathway
    extensions?: Record<string, unknown>; // Open extension surface
  };
  annotatedAt?: number;          // Unix ms when annotations were produced
  annotationVersion?: string;    // Free-form version string of the extractor

  meta: {
    sourceAgent: string;
    agentRole: string;
    writeContext?: string;
    participants?: string[];
    eventId?: string;            // Back-reference to the originating Event
    lastAccessed?: number;
    accessCount: number;
    identifiedAt?: number;       // Set after EventIdentifier processes this node
  };
}
```

::: tip 关键洞见
**不要**强行把视觉信息转换为文本。将原始媒体引用存入 `raw.media`,同时把文本投影存入 `raw.text`、把语义嵌入存入 `annotations.embedding`。这避免了语义错位与信息丢失,也让你以后能用更好的抽取器重新生成 `annotations` 而不丢失原件。
:::

## 为什么是三层

单层"摄入时摘要"的做法(mem0/Zep 模型)将抽取器的理解烙印进存储记录中。当你升级模型时,所有旧记忆都卡在旧的质量水平。Memorai 逐字保留原始事件,因此：

- 升级抽取器后可在全部历史上重新生成 Tier 2 —— 不丢失任何数据。
- 多种解释可以共存(例如,每节点上每抽取器一份 `annotationVersion`)。
- 追溯可回到原始源头,而非仅仅是派生摘要。

## 记忆层级(levels)

在每一层内,节点按聚合级别组织：

| | **Segment** | **Atomic Action** | **Episode** |
|---|---|---|---|
| **粒度** | 最细 —— 每次 `recordEvent` 一个 | 由语义 + 时间上相近的片段合并而来 | 原子动作的聚合簇 |
| **生命周期** | 由 `write` 创建 | 由 Level-1 演进创建/更新(每次写入) | 由 Level-2 演进创建/更新(每次 `evolve()`) |
| **使用场景** | 原始召回、取代溯源 | 局部性感知的召回 | "X 附近发生了什么"类查询 |

层级之间的边界是分层的,而非物理的。三个级别都位于同一个存储适配器中;查询可以通过 `RecallOptions.level` 指向特定级别。

::: tip 情节(episodes)不是 MemoryEvents
HME 的 `episode` 级别是原始片段的*时间簇*。它**不**等同于 [`MemoryEvent`](/zh/concepts/memory-events),后者是一个*语义*记录(state / transition / happening)。两者都运行在同一原始时间轴上;它们回答不同的问题。
:::

## 一个具体示例

一个浏览器助手为每个重要的页面动作记录一个事件：

```typescript
const handle = memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'image',
    image: screenshot,
    caption: 'User opened VS Code and started editing architecture.md',
  },
  tags: ['coding', 'vscode', 'architecture'],
  salienceHint: 0.9,
});

const nodes = await handle.nodes;
console.log(nodes[0].raw.content);          // Tier 1 — original event
console.log(nodes[0].annotations.summary);  // Tier 2 — derived summary
```

返回的是一个完整填充的 `MemoryNode`。在幕后,Memorai 运行了配置的抽取器以生成 `annotations`,持久化了两层,并启动了一次 Level-1 演进 —— 参见[分层演进](/zh/concepts/evolution)。
