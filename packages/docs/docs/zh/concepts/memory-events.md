# Memory Events

**MemoryEvent** 是从原始时间轴中识别出的语义单元。它让召回能够返回*代理当前所相信的内容*,而非*所有提及该内容的原始轮次*。

原始的 `MemoryNode` 记录的是"这一轮在时间 T 被说过",而 `MemoryEvent` 则表达以下三种之一：

- **`state`** —— 一个随时间持续存在的断言。_"Alice 偏好茶胜于咖啡。"_ 可被一个更新的状态断言**取代**。
- **`transition`** —— 从一个状态到另一个状态的变化。_"Alice 在吃花生后产生了坚果过敏。"_ 状态变化本身锚定在时间上;它所产生的新状态可以成为它自己的事件。
- **`happening`** —— 锚定在时间上的离散发生事件。_"周三晚上有一个紧急会议,Bob 必须参加。"_

多个原始节点可以贡献于一个事件;一个原始节点也可以支撑多个事件。

## 形状

```typescript
interface MemoryEvent {
  id: string;
  kind: 'state' | 'transition' | 'happening';

  /** Natural-language description — the canonical "what happened" sentence. */
  description: string;

  /** Entities involved (canonical lowercase names). */
  participants: string[];

  /** Tags / topics / categories. */
  topics: string[];

  /** When this event occurred, or when this state became true. */
  occurredAt: number;

  /** For state events: when this assertion was invalidated by a newer one. */
  invalidatedAt?: number;

  /** IDs of MemoryEvents this one supersedes. */
  supersedes?: string[];

  /** IDs of raw MemoryNodes this event was identified from. */
  sourceNodeIds: string[];

  userId?: string;
  actor?: string;
  embedding?: number[];
  confidence?: number;
  identifierVersion?: string;

  meta: {
    identifiedAt: number;
    lastAccessed?: number;
    accessCount: number;
  };
}
```

## 事件是如何被识别的

`EventIdentifier` 接口检查一批近期的原始节点以及任何相关的已有 MemoryEvents(以便侦测取代关系),并返回一个 `IdentifiedEvent` 记录列表：

```typescript
interface EventIdentifier {
  readonly version: string;
  identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]>;
}
```

Memorai 提供 [`LLMEventIdentifier`](/zh/api/event-identifier),它接入 `MemoraiConfig.llm` 并使用一个区分三种类型的结构化提示词。你也可以提供自定义实现 —— 参见[自定义 EventIdentifier 配方](/zh/guide/examples#recipe-custom-eventidentifier)。

### 识别在何时运行

事件被识别需同时满足两个前提：

1. 已设置 `MemoraiConfig.llm`(或你已显式传入 `MemoraiConfig.identifier`)
2. 调用了 `evolve()`(手动调用,或通过自动触发配置)

最简单的方式是直接传入 `llm` —— Memorai 会自动接入 `LLMEventIdentifier`：

```typescript
const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding,
  llm: yourLLMService,  // ← auto-wires LLMExtractor AND LLMEventIdentifier
});

memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: { kind: 'message', text: 'I just started eating fish again' },
});

await memory.evolve();   // runs HME + event identification

const events = await memory.listEvents({ excludeInvalidated: true });
// → [{ kind: 'transition', description: 'User started eating fish again', ... }]
```

识别是**幂等的**：节点在处理后会被标记 `meta.identifiedAt`,因此后续的 `evolve()` 调用不会把相同的输入再次喂给 LLM。

## 取代与失效

当 EventIdentifier 返回一个带有 `supersedes: [oldEventId]` 的新 `state` 事件时,Memorai 会：

1. 把旧事件的 `invalidatedAt` 设置为新事件的 `occurredAt`。
2. 持久化两条记录。
3. 默认情况下,将旧事件从召回中隐藏。

旧记录仍保留在存储中 —— Memorai 永不删除事实。你可以回放历史：

```typescript
// "What does the agent currently believe?" (default)
await memory.listEvents({ excludeInvalidated: true });

// "What did the agent believe at time T?"
await memory.listEvents({ validAt: someTimestamp });

// Full audit trail including superseded states
await memory.listEvents();
```

同样的过滤器也适用于 `recall()`,通过 `RecallOptions.excludeInvalidatedEvents` 和 `RecallOptions.timeRange`。

::: tip 取代是按用户授权的
Memorai 的识别器在取代上下文中只能看到 `userId` 匹配的事件。即使识别器返回了来自另一用户的取代目标(纵深防御),该链接也会被静默丢弃 —— Alice 的识别器无法使 Bob 的事件失效。
:::

## 召回如何使用事件

当配置了 `EventIdentifier` 时,`Memorai.recall(question, opts)` **并行运行两个召回面**：

1. **节点级**：在原始 `MemoryNode` 上运行多路径召回(语义 / BM25 / 标签 / 时间 / 身份)。
2. **事件级**：在 `MemoryEvent.description` 上运行语义 + BM25,以 `validAt` 过滤,使被取代的状态被剔除。

两条路径都进入外层 Reciprocal Rank Fusion(倒数排名融合)。每个返回的 `RecalledMemory` 都携带来源 —— 以 `event:` 开头的路径来自事件层：

```typescript
const result = await memory.recall('what does the user eat?');
for (const m of result.memories) {
  console.log(m.eventKind, m.summary, m.provenance?.pathways);
  // → "transition" "User started eating fish again" ["event:semantic", "event:bm25"]
}
```

如果某个事件的 `sourceNodeIds` 与原始节点命中重叠,原始命中会被去重 —— 事件描述是正典,因此不会重复计数。

### 选项

```typescript
// Disable the event pathway entirely (only node-level recall)
await memory.recall('...', { includeEvents: false });

// Include superseded state events (replay history)
await memory.recall('...', { excludeInvalidatedEvents: false });

// Scope to a time window — applies to both pathways
await memory.recall('...', { timeRange: { start, end } });
```

## 为什么这很重要

没有事件层时：

- _"Alice 是素食者"_ 和 _"Alice 现在吃鱼了"_ 作为两个带时间戳的原始轮次共存。召回返回二者。代理必须在运行时解决冲突。
- 像 _"Alice 吃什么?"_ 这类单跳事实查询必须命中正确的原始轮次 —— 但相关信号被周围上下文稀释了。

有事件层时：

- 两个原始轮次成为两个 MemoryEvents;后者取代前者。召回默认只返回当前状态。
- 单跳查询直接命中正典事实。回答者获得对代理所信内容的干净、当前的视图。

在公开的 LoCoMo 基准测试中,仅启用 MemoryEvent 层(在 wrap 模式存储之上),准确率提升 **+15.1 个百分点**,且比之前的 LLM 抽取流水线快约 3 倍。参见[基准测试](/zh/guide/benchmarks)。

## 下一步阅读

- [示例 → 状态事件与取代](/zh/guide/examples#recipe-state-events-and-supersede) —— 可运行的取代流程
- [示例 → 自定义 EventIdentifier](/zh/guide/examples#recipe-custom-eventidentifier) —— 接入你自己的识别器
- [API → Event Identifier](/zh/api/event-identifier) —— `EventIdentifier` 接口详解
- [API → Event Store](/zh/api/event-store) —— 持久化事件后端的 `EventStore` 接口
