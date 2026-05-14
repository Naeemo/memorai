# Cross-Agent Memory

Different agents have different memory needs, but they should share the same storage and retrieval infrastructure. Memorai expresses this with **agent memory profiles**: per-agent read/write policies on top of one shared store.

## The `AgentMemoryProfile` shape

```typescript
interface AgentMemoryProfile {
  agentId: string;
  role: 'reasoning' | 'proactive' | 'custom';

  // What this agent stores
  writePolicy: {
    levels: ('segment' | 'atomic_action' | 'event')[];
    modalities: ('text' | 'vision' | 'audio' | 'multimodal')[];
    salienceBoost: number;          // Agent-specific salience weight
  };

  // What this agent retrieves
  readPolicy: {
    defaultLevel: 'segment' | 'atomic_action' | 'event';
    defaultTraversal: 'forward' | 'reverse' | 'salience';
    timeHorizonMs: number;          // How far back this agent typically looks
  };
}
```

The profile is passed when constructing the `Memorai` instance:

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
      defaultLevel: 'event',
      defaultTraversal: 'reverse',
      timeHorizonMs: 86_400_000,    // 24 hours
    },
  },
});
```

## Built-in profiles

| Agent role | Write focus | Read focus |
|---|---|---|
| **Reasoning** | Global semantic evolution, cross-temporal events | Events + atomic actions, forward traversal |
| **Proactive** | Key action triggers, state changes | Recent segments, reverse traversal, high salience |
| **Custom** | User-defined | User-defined |

Reasoning agents write up high (events live longer); proactive agents stay near the present (segments expire fast).

## Sharing storage across agents

Each agent gets its own `Memorai` instance, but they can point at the **same** `StorageAdapter`. The adapter is the unified store; the policies are the lenses:

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
    writePolicy: { levels: ['segment', 'atomic_action', 'event'], modalities: ['text', 'vision'], salienceBoost: 1 },
    readPolicy: { defaultLevel: 'event', defaultTraversal: 'forward', timeHorizonMs: 86_400_000 },
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

Now both agents read from the same memory, but each scopes its queries by default. Either agent can override the default in a per-call basis by passing explicit `level`, `traversalOrder`, or `agentRole`.

## Why per-agent policies, not per-call defaults?

Per-call defaults are tedious and easy to get wrong. A reasoning agent that occasionally forgets to filter by `level: 'event'` ends up flooded with raw segments. By encoding the policy in the profile, the default behaviour matches the agent's role, and explicit overrides become rare exceptions rather than constant boilerplate.
