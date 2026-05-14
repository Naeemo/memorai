# `Memorai`

The main entry point. Wires storage, embedding, evolution, and retrieval into one object and exposes a small write / read / manage API.

## Construction

```typescript
class Memorai {
  constructor(config: MemoraiConfig);
}

interface MemoraiConfig {
  storage: StorageAdapter;             // required
  embedding: EmbeddingService;         // required
  compression?: CompressionService;    // optional multimodal compression
  evolution?: Partial<EvolutionConfig>;// thresholds & background loop
  agentProfile?: AgentMemoryProfile;   // cross-agent read/write policy
  namespace?: string;                  // multi-tenant prefix
}
```

When `evolution.autoEvolveIntervalMs` is set to a positive number, the instance starts a background loop that triggers Level-2 evolution on a cadence. Call `close()` to stop it.

## Methods

### Write

```typescript
/** Store a new memory segment. Returns the created MemoryNode. */
write(payload: WritePayload, opts?: WriteOptions): Promise<MemoryNode>;

/** Batch write multiple segments. */
writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]>;
```

Every `write` also runs a Level-1 evolution pass synchronously — the returned node is the freshly created segment, while the merge/promotion happens in the background storage state.

### Read

```typescript
/** Retrieve memories matching a query. */
retrieve(query: RetrievalQuery): Promise<RetrievalResult>;

/** Get a specific node by ID. */
get(id: string): Promise<MemoryNode | null>;

/** List memories with filtering. */
list(opts?: ListOptions): Promise<MemoryNode[]>;
```

`retrieve` and `get` both bump `meta.lastAccessed` and `meta.accessCount` on the touched nodes. This is what makes LRU eviction and salience recalculation possible later.

### Evolution

```typescript
/** Manually trigger Level-2 HME (atomic_action → event). */
evolve(): Promise<void>;
```

Normally auto-triggered if `autoEvolveIntervalMs` is configured. Manual `evolve()` is for tests and clean shutdowns.

### Management

```typescript
/** Delete a memory node (and optionally its children). */
delete(id: string, cascade?: boolean): Promise<void>;

/** Update a memory node's metadata. */
update(id: string, patch: Partial<MemoryNode>): Promise<MemoryNode>;

/** Close all resources. */
close(): Promise<void>;
```

`delete` cleans up parent–child links: when `cascade` is `false` (the default), surviving children are detached from the deleted parent so they don't reference a dead node. When `cascade` is `true`, children are deleted recursively.

`close` clears the background evolution timer and closes the storage adapter — call it on process exit / page unload.

## Full example

```typescript
import { Memorai } from 'memorai';
import { IndexedDBAdapter } from 'memorai/storage';
import { OpenAIEmbeddingService } from 'memorai/embeddings';

const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'my-agent-memory' }),
  embedding: new OpenAIEmbeddingService({ apiKey: process.env.OPENAI_API_KEY! }),
  evolution: {
    semanticMergeThreshold: 0.85,
    stmMaxSize: 1000,
    autoEvolveIntervalMs: 60_000,
  },
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
      timeHorizonMs: 86_400_000,
    },
  },
});

const node = await memory.write({
  timestamp: Date.now(),
  payload: {
    summary: 'User opened the code editor and started typing',
    media: { frames: [screenshot] },
    tags: ['coding', 'vscode', 'architecture'],
    salienceScore: 0.9,
    modality: ['vision', 'text'],
  },
});

const result = await memory.retrieve({
  text: 'What was I working on in the editor?',
  strategy: 'factual',
  traversalOrder: 'reverse',
  topK: 5,
});
```
