# 跨代理记忆

不同的代理有不同的记忆需求,但它们应共享同一套存储与召回基础设施。Memorai 通过**代理记忆画像(agent memory profiles)**来表达这一点：在一个共享存储之上为每个代理设置读/写策略。

## `AgentMemoryProfile` 形状

```typescript
interface AgentMemoryProfile {
  agentId: string;
  /** Free-form role label — "reasoning" / "proactive" / app-specific. */
  role: string;

  // What this agent stores
  writePolicy: {
    levels: ('segment' | 'atomic_action' | 'episode')[];
    modalities: ('text' | 'vision' | 'audio' | 'multimodal')[];
    salienceBoost: number;          // Agent-specific salience weight
  };

  // What this agent retrieves
  readPolicy: {
    defaultLevel: 'segment' | 'atomic_action' | 'episode';
    defaultTraversal: 'forward' | 'reverse' | 'salience';
    timeHorizonMs: number;          // How far back this agent typically looks
  };
}
```

`writePolicy` 在 `write()` 时**强制执行** —— 尝试以不允许的级别写入节点,或写入允许列表之外的模态,都会抛错。可借此防止"主动触发"代理意外写入丰富的 `episode` 级摘要,或防止视觉盲代理存储 `vision` 模态节点。

画像在构造 `Memorai` 实例时传入：

```typescript
const memory = new Memorai({
  storage,
  embedding,
  agentProfile: {
    agentId: 'browser-assistant',
    role: 'reasoning',
    writePolicy: {
      levels: ['segment', 'atomic_action'],
      modalities: ['text', 'vision'],
      salienceBoost: 1.0,
    },
    readPolicy: {
      defaultLevel: 'episode',
      defaultTraversal: 'reverse',
      timeHorizonMs: 86_400_000,    // 24 hours
    },
  },
});
```

## 内置画像

| 代理角色 | 写入侧重 | 读取侧重 |
|---|---|---|
| **Reasoning** | 全局语义演进、跨时间情节 | 情节 + 原子动作,正向遍历 |
| **Proactive** | 关键动作触发、状态变化 | 近期片段,反向遍历,高 salience |
| **Custom** | 用户自定义 | 用户自定义 |

推理代理写得更高层(情节生命更长);主动代理停留在当下附近(片段过期更快)。

## 跨代理共享存储

每个代理都有自己的 `Memorai` 实例,但它们可以指向**同一个** `StorageAdapter`。适配器是统一存储;策略是透镜：

```typescript
import { Memorai, IndexedDBAdapter, OpenAIEmbeddingService } from 'memorai';

const storage = new IndexedDBAdapter({ dbName: 'shared-agent-memory' });
const embedding = new OpenAIEmbeddingService({ apiKey });

const reasoning = new Memorai({
  storage,
  embedding,
  agentProfile: {
    agentId: 'reasoning-1',
    role: 'reasoning',
    writePolicy: { levels: ['segment', 'atomic_action', 'episode'], modalities: ['text', 'vision'], salienceBoost: 1 },
    readPolicy: { defaultLevel: 'episode', defaultTraversal: 'forward', timeHorizonMs: 86_400_000 },
  },
});

const proactive = new Memorai({
  storage,
  embedding,
  agentProfile: {
    agentId: 'proactive-1',
    role: 'proactive',
    writePolicy: { levels: ['segment'], modalities: ['text'], salienceBoost: 1.2 },
    readPolicy: { defaultLevel: 'segment', defaultTraversal: 'reverse', timeHorizonMs: 60_000 },
  },
});
```

现在两个代理从同一份记忆读取,但各自的查询默认以自身范围为限。任一代理都可以通过在调用时显式传入 `level`、`traversalOrder` 或 `agentRole` 来覆盖默认值。

## 为什么是每代理策略,而非每次调用的默认值?

每次调用的默认值繁琐且容易出错。偶尔忘记按 `level: 'episode'` 过滤的推理代理,会被原始片段淹没。把策略编码到画像中,默认行为就与代理角色匹配,显式覆盖就变成罕见例外,而非持续不断的样板代码。
