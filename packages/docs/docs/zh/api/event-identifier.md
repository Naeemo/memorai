# `EventIdentifier`

将一批原始 `MemoryNode` 转换为 [`MemoryEvent`](/zh/concepts/memory-events) 记录 —— 即 Tier 2.5 的语义层。可插拔：携带你自己的逻辑，或使用内置的基于 LLM 的默认实现。

## 接口

```typescript
interface EventIdentifier {
  /** Free-form version string persisted on every produced event. */
  readonly version: string;

  /** Identify semantic events from a batch of raw nodes. */
  identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]>;
}

interface IdentifyContext {
  /** Raw nodes that are candidates for identification (a recent batch). */
  nodes: MemoryNode[];

  /**
   * Existing MemoryEvents scoped to the batch's userIds — given to your
   * implementation so it can decide INSERT vs SUPERSEDE on state events.
   */
  relatedEvents: MemoryEvent[];

  embedding: EmbeddingService;
  llm?: LLMService;
  now(): number;
  signal?: AbortSignal;
}

interface IdentifiedEvent {
  kind: 'state' | 'transition' | 'happening';
  description: string;
  participants: string[];
  topics: string[];
  occurredAt: number;
  sourceNodeIds: string[];

  /** Only for state events that update an older state. */
  supersedes?: string[];
  confidence?: number;
}
```

## 内置：`LLMEventIdentifier`

LLM 驱动。当设置 `MemoraiConfig.llm` 时自动构造。

```typescript
import { LLMEventIdentifier } from 'memorai';

const memory = new Memorai({
  storage,
  embedding,
  llm: yourLLM,  // ← auto-wires LLMEventIdentifier
});
```

或显式构造：

```typescript
const identifier = new LLMEventIdentifier({
  llm: yourLLM,
  systemPrompt: customPrompt,         // override the default
  temperature: 0,
  maxInputChars: 16000,                // per-call input budget
  onError: (stage, err, ctx) => {       // custom error logging
    console.warn(`[identifier] ${stage}:`, err, ctx);
  },
});

const memory = new Memorai({ storage, embedding, identifier });
```

### 提示设计

`LLMEventIdentifier` 向 LLM 发送一个包含三部分的提示：

1. **System prompt** 解释三种事件类型（`state`、`transition`、`happening`）以及替代规则。
2. **EXISTING RELATED EVENTS** —— 一个 JSON 列表，列出新批次可能替代的现有事件（按批次的 `userId` 限定范围）。
3. **RAW NODES TO ANALYZE** —— 原始节点的 JSON，含 id、时间戳、文本、actor、target。

LLM 返回一个 `IdentifiedEvent` 的 JSON 数组。默认提示能处理常见的代码围栏包裹（` ```json ... ``` `）以及嵌入散文中的数组。

### 错误处理

`LLMEventIdentifier` 按契约不抛出 —— LLM 调用或 JSON 解析中的失败会返回 `[]` 而非抛出。默认通过 `console.error` 记录；提供 `opts.onError` 可重定向或抑制。

## 自定义 EventIdentifier

自定义识别器的用例：

- 领域专属抽取（法律、医疗、游戏、制造）
- 纯规则式识别（无 LLM，确定性）
- 混合（LLM + 规则后处理）
- 廉价本地模型识别 + 校验

```typescript
import type {
  EventIdentifier,
  IdentifiedEvent,
  IdentifyContext,
} from 'memorai';

class RuleBasedIdentifier implements EventIdentifier {
  readonly version = 'rules-v1';

  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    const out: IdentifiedEvent[] = [];
    for (const node of ctx.nodes) {
      const text = node.raw.text ?? '';

      // Example: extract date-bound meetings
      const meetingMatch = text.match(/meeting on (\w+ \d+)/i);
      if (meetingMatch) {
        out.push({
          kind: 'happening',
          description: `Meeting on ${meetingMatch[1]}`,
          participants: [node.actor ?? 'unknown'],
          topics: ['meeting', 'calendar'],
          occurredAt: node.timestamp,
          sourceNodeIds: [node.id],
        });
      }

      // Example: detect state changes ("I'm now ...")
      const stateMatch = text.match(/I'm now (.+)/i);
      if (stateMatch) {
        const description = `User is now ${stateMatch[1]}`;
        const supersedes = ctx.relatedEvents
          .filter((e) => e.kind === 'state' && e.description.startsWith('User is'))
          .map((e) => e.id);
        out.push({
          kind: 'state',
          description,
          participants: [node.userId ?? 'user'],
          topics: ['user-state'],
          occurredAt: node.timestamp,
          sourceNodeIds: [node.id],
          supersedes: supersedes.length > 0 ? supersedes : undefined,
        });
      }
    }
    return out;
  }
}
```

## 契约与不变量

- **`sourceNodeIds` 必须引用 `ctx.nodes` 中的 id。** Memorai 会丢弃引用未知 id 的事件；这能防御幻觉式引用。
- **Memorai 按 userId 限定 `relatedEvents` 范围。** 你的识别器只会看到与批次中 `userId` 匹配的事件。即使你尝试，跨租户的替代关系在持久化时也会被静默拒绝。
- **幂等性。** `identifyBatch` 之后，Memorai 会在 `node.meta.identifiedAt` 上打戳，使后续 `evolve()` 调用不会再次把相同原始节点喂给你的识别器。返回 `[]` 是有效输出，仍然会将节点标记为已处理。
- **Tier 1 不会被触碰。** 你的识别器对原始节点只读。

## 提示

- **保持批次较小**（默认 30 节点）。更大的批次有 LLM 输入预算溢出的风险，并且会让跨远轮次的替代信号变得混乱。
- **输出规范化描述。** 事件的 `description` 就是 `recall` 作为 `summary` 字段返回的内容 —— 请用代理可读的散文撰写。
- **正确使用这三种类型。**
  - `state` 用于断言（"User prefers ..."），未来事件可能会替代它。
  - `transition` 用于变化时刻（"User started ..."）—— 通常不会被替代。
  - `happening` 用于时间锚定的发生（"Meeting at ..."）—— 通常也不会被替代。
- **对于替代，宁可降低门槛。** 过度替代比让矛盾的状态事件继续存在更安全。Memorai 反正会保留审计轨迹。

## 参见

- [`MemoryEvent` 概念](/zh/concepts/memory-events) —— 包括替代在内的完整生命周期
- [示例 → 自定义 EventIdentifier](/zh/guide/examples#recipe-custom-eventidentifier)
- [`EventStore`](/zh/api/event-store) —— 产生的事件最终持久化的去处
