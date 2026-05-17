# 示例

围绕最常见的 Memorai 用法，提供简短、聚焦的示例。每个示例都可复制粘贴，并假设你已完成[快速开始](/zh/guide/getting-started)。

## 示例：状态事件与替代

跟踪用户偏好，让新陈述自动替代旧陈述。

```typescript
const memory = new Memorai({
  storage: new MemoryAdapter(),
  embedding,
  llm,  // required for LLMEventIdentifier
});

// Day 1: Alice tells us she's vegetarian
memory.recordEvent({
  at: day1,
  actor: 'alice',
  userId: 'alice',
  content: { kind: 'message', text: "I'm vegetarian" },
});
await memory.evolve();

// Day 60: she changes her mind
memory.recordEvent({
  at: day60,
  actor: 'alice',
  userId: 'alice',
  content: { kind: 'message', text: "I started eating fish again" },
});
await memory.evolve();

// Default recall returns only the *current* belief
const result = await memory.recall("what does alice eat?", { userId: 'alice' });
console.log(result.memories[0].summary);
// → "Alice started eating fish again"

// Replay history (include superseded states)
const audit = await memory.recall("what does alice eat?", {
  userId: 'alice',
  excludeInvalidatedEvents: false,
});
console.log(audit.memories.map((m) => m.summary));
// → ["Alice started eating fish again", "Alice is vegetarian"]
```

::: tip 替代的工作原理
当 EventIdentifier 产生带有 `supersedes: [oldEventId]` 的新 `state` 事件时，Memorai 会把旧事件的 `invalidatedAt` 设为新事件的 `occurredAt`。旧记录仍在存储中 —— `recall` 只是默认把它过滤掉。
:::

## 示例：时间窗召回

"用户上周提到过什么？"

```typescript
const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
const result = await memory.recall("anything important", {
  timeRange: { start: oneWeekAgo, end: Date.now() },
  topK: 20,
});
```

节点层和事件层的召回都尊重 `timeRange`。`occurredAt` 落在窗口之外的状态事件会从事件路径中被剔除，无论它们是否仍然有效。

如果你只想要窗口内的全部内容 —— 不做语义排序 —— 使用 `recallByTime`：

```typescript
const today = await memory.recallByTime({
  start: startOfDay,
  end: Date.now(),
}, { topK: 100, traversalOrder: 'forward' });
```

## 示例：在整段历史上升级抽取器

当更好的 LLM 上线时，刷新每条已有记忆的 Tier 2 注解 —— 同时不丢失原始时间轴：

```typescript
import { LLMExtractor } from 'memorai';

// Drop in a stronger LLM
const newExtractor = new LLMExtractor({ llm: newGPT5 });

const result = await memory.reAnnotate({
  extractor: newExtractor,
  filter: (node) => node.level === 'segment',  // only refresh raw segments
  onProgress: (done, total) => console.log(`${done}/${total}`),
});

console.log(`Re-annotated ${result.reannotated}, ${result.errors.length} errors`);
```

这会重新生成 `node.annotations.summary` / `facts` / `tags` / `triples`，并重建嵌入。原始的 `node.raw` 始终不会被改动。

设置 `skipEmbedding: true` 可以在仅注解文本变更时保留现有嵌入。

## 示例：带角色策略的跨代理记忆

两个代理共享同一存储，但以不同的视角看待：

```typescript
const storage = new MemoryAdapter();
const embedding = new OllamaEmbeddingService({ model: 'nomic-embed-text' });

const reasoningAgent = new Memorai({
  storage,
  embedding,
  agentProfile: {
    agentId: 'reasoner',
    role: 'reasoning',
    writePolicy: {
      levels: ['segment', 'atomic_action', 'episode'],
      modalities: ['text', 'vision'],
      salienceBoost: 1.0,
    },
    readPolicy: {
      defaultLevel: 'episode',        // sees aggregated episodes
      defaultTraversal: 'reverse',
      timeHorizonMs: 7 * 24 * 60 * 60 * 1000,  // last week
    },
  },
});

const proactiveAgent = new Memorai({
  storage,                              // SAME storage
  embedding,
  agentProfile: {
    agentId: 'trigger-bot',
    role: 'proactive',
    writePolicy: {
      levels: ['segment'],              // only stores raw triggers
      modalities: ['text'],
      salienceBoost: 1.5,               // weight triggers more
    },
    readPolicy: {
      defaultLevel: 'segment',          // sees raw segments
      defaultTraversal: 'salience',
      timeHorizonMs: 60 * 60 * 1000,   // last hour only
    },
  },
});

// Both write to the same store; each reads at its own level.
```

`write()` 会强制执行代理的 `writePolicy` —— 尝试写入不允许的层或模态会抛错。

## 示例：自定义 EventIdentifier

如果你需要领域特化的事件抽取（法律、医疗、游戏……），实现你自己的：

```typescript
import type {
  EventIdentifier,
  IdentifiedEvent,
  IdentifyContext,
} from 'memorai';

class MedicalEventIdentifier implements EventIdentifier {
  readonly version = 'medical-v1';

  async identify(ctx: IdentifyContext): Promise<IdentifiedEvent[]> {
    // ctx.nodes — recent raw segments
    // ctx.relatedEvents — existing events for supersede context
    // ctx.embedding / ctx.llm — wire up however you need

    const events: IdentifiedEvent[] = [];
    for (const node of ctx.nodes) {
      const text = node.raw.text ?? '';
      if (/diagnosed with (\w+)/i.test(text)) {
        events.push({
          kind: 'state',
          description: extractDiagnosis(text),
          participants: [node.userId ?? 'patient'],
          topics: ['diagnosis'],
          occurredAt: node.timestamp,
          sourceNodeIds: [node.id],
        });
      }
      // ...other rule-based extractions
    }
    return events;
  }
}

const memory = new Memorai({
  storage,
  embedding,
  identifier: new MedicalEventIdentifier(),
});
```

识别器可以是纯规则实现、小型本地模型、混合 LLM 调用 —— Memorai 并不关心实现细节，它只需要 `identify(ctx)` 返回事件。

## 示例：处理多模态事件

通过 `content` 形状传入非文本内容 —— 图像、音频、视频、文件：

```typescript
memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'image',
    image: screenshotImageData,   // ImageData or a reference URL/blob key
    caption: 'Screenshot of the dashboard at 3pm',
  },
});

memory.recordEvent({
  at: Date.now(),
  actor: 'system',
  content: {
    kind: 'audio',
    audio: audioBufferOrRef,
    transcript: 'Meeting recording — sales sync',
  },
});

memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'file',
    mime: 'application/pdf',
    ref: 'blob:abc-123',
    text: 'Q4 2026 financial report',
  },
});
```

如果你配置了 `CompressionService`，图像 / 音频 / 视频的引用会在存储前被压缩。否则它们会被逐字存储。

## 独立可运行示例

下列完整程序位于 `packages/memorai/examples/` 目录下：

| 文件 | 运行时 | 展示内容 |
|---|---|---|
| `browser-assistant.ts` | 浏览器 | 带屏幕截图捕获的 IndexedDB 持久化助手 |
| `node-server.ts` | Node | 包装 Memorai 的 HTTP API，使用 SQLite 持久化 |
| `cross-agent.ts` | Node | 两个代理共享一个存储，使用不同的角色策略 |
| `openclaw-agent.ts` | Node | 心跳驱动的代理，记录消息并按相关性查询 |

打开任意一个，复制你需要的部分，并适配到你的技术栈。

## 下一步去哪里

- [概念 → Memory Events](/zh/concepts/memory-events) —— state / transition / happening 事件的完整生命周期
- [概念 → 召回](/zh/concepts/retrieval) —— 每条召回路径实际做了什么
- [API → Memorai](/zh/api/memorai) —— 每个公开方法、每个选项
