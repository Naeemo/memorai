# `Memorai`

The main entry point. Wires storage, embedding, extraction, evolution, and retrieval into one object.

## Construction

```typescript
class Memorai {
  constructor(config: MemoraiConfig);
}

interface MemoraiConfig {
  storage: StorageAdapter;             // required
  embedding: EmbeddingService;         // required
  compression?: CompressionService;    // optional multimodal compression
  llm?: LLMService;                    // enables LLMExtractor + HyDE + query expansion + LLMReranker
  extractor?: Extractor;               // override the default extractor pick
  reranker?: RerankerService;          // optional cross-encoder pass over fused results
  evolution?: Partial<EvolutionConfig>;// thresholds & auto-trigger config
  agentProfile?: AgentMemoryProfile;   // cross-agent read/write policy
  defaultActor?: string;
  defaultUserId?: string;
  namespace?: string;                  // multi-tenant prefix
}
```

When `evolution.autoTriggers.intervalMs` is set to a positive number, a background loop fires Level-2 evolution on a cadence. Call `close()` to stop it.

The extractor is selected automatically: if `extractor` is passed, it's used as-is; else if `llm` is configured, the `LLMExtractor` is wired; otherwise the heuristic `LightExtractor` runs.

## Public API — Event API

The primary read/write surface. Event-shaped writes and natural-language reads.

### `recordEvent` / `recordEvents`

```typescript
recordEvent(event: Event): RecordHandle;
recordEvents(events: Event[]): RecordHandle;

interface Event {
  at?: number | Date;                  // point-in-time anchor
  during?: { start: number | Date; end: number | Date };
  actor: string;
  target?: string;
  participants?: string[];
  content: EventContent;
  userId?: string;
  context?: string;
  tags?: string[];
  salienceHint?: number;
  id?: string;
}

interface RecordHandle {
  readonly eventIds: readonly string[];
  readonly nodes: Promise<MemoryNode[]>;
  done(): boolean;
  cancel(): void;
}
```

`recordEvent` returns a handle immediately — the actual extraction runs in the background. Await `handle.nodes` to block until extraction completes, or fire-and-forget for low-latency hot paths.

### `recall`

```typescript
recall(question: string, opts?: RecallOptions): Promise<RecallResult>;

recallByActor(actor: string, opts?: RecallOptions): Promise<RecallResult>;
recallByRelationship(a: string, b: string, opts?: RecallOptions): Promise<RecallResult>;
recallByTime(range: { start: number; end: number }, opts?: RecallOptions): Promise<RecallResult>;
recallByTag(tags: string[], opts?: RecallOptions): Promise<RecallResult>;

interface RecallOptions {
  topK?: number;
  timeRange?: { start: number; end: number };
  actor?: string;
  target?: string;
  userId?: string;
  modality?: Modality[];
  level?: MemoryLevel;
  strategy?: RetrievalStrategy;
  traversalOrder?: TraversalOrder;
  queryExpansion?: number;             // requires config.llm
  hyde?: boolean;                       // requires config.llm
  overrideQuery?: Partial<RetrievalQuery>;
}
```

`recall` performs the full multi-pathway pipeline: semantic + BM25 + tag + temporal + identity, fused via Reciprocal Rank Fusion. When `queryExpansion` or `hyde` are set (and a LLM is configured), the question is expanded into variant queries before retrieval and the results are fused again across variants. Each surfacing pathway is recorded in `RecalledMemory.provenance.pathways`.

When `config.reranker` is set, a final cross-encoder pass refines the top-N candidates for precision.

### `reAnnotate`

```typescript
reAnnotate(opts?: ReAnnotateOptions): Promise<ReAnnotateResult>;

interface ReAnnotateOptions {
  extractor?: Extractor;                          // use this instead of the configured one
  filter?: (node: MemoryNode) => boolean;         // scope to a subset
  skipEmbedding?: boolean;                        // keep existing embeddings
  onProgress?: (done: number, total: number) => void;
}

interface ReAnnotateResult {
  reannotated: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
}
```

The three-tier signature feature: regenerate Tier 2 annotations + Tier 3 indexes across the existing store from the immutable Tier 1 raw events. Use it to upgrade the extractor, switch embedding models, or backfill new annotation kinds — without touching the timeline.

```typescript
// Upgrade everything to a newer LLM extractor.
await memory.reAnnotate({ extractor: new LLMExtractor({ llm: gpt5 }) });

// Only refresh segments tagged "important".
await memory.reAnnotate({
  filter: (n) => n.level === "segment" && n.annotations.tags.includes("important"),
});
```

## Internal API — structured write

Used by extractors, tests, and benchmark harnesses. Application code should use `recordEvent` instead.

```typescript
/** @internal */ write(payload: WritePayload, opts?: WriteOptions): Promise<MemoryNode>;
/** @internal */ writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]>;
/** @internal */ retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
```

## Management

```typescript
get(id: string): Promise<MemoryNode | null>;
list(opts?: ListOptions): Promise<MemoryNode[]>;
delete(id: string, cascade?: boolean): Promise<void>;
update(id: string, patch: NodePatch): Promise<MemoryNode>;
evolve(): Promise<void>;
close(): Promise<void>;
```

`update` lets you patch annotations / metadata / linkage. Tier 1 `raw` is intentionally **not** patchable through this surface — use `reAnnotate()` to regenerate Tier 2 from raw instead.

`close` clears background timers and closes the storage adapter — call it on process exit / page unload.

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
    autoTriggers: { intervalMs: 60_000 },
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
      defaultLevel: 'episode',
      defaultTraversal: 'reverse',
      timeHorizonMs: 86_400_000,
    },
  },
});

memory.recordEvent({
  at: Date.now(),
  actor: 'user',
  content: {
    kind: 'image',
    image: screenshot,
    caption: 'User opened the code editor and started typing',
  },
  tags: ['coding', 'vscode', 'architecture'],
  salienceHint: 0.9,
});

const result = await memory.recall('What was I working on in the editor?', {
  topK: 5,
  traversalOrder: 'reverse',
});

for (const m of result.memories) {
  console.log(m.summary, m.provenance?.pathways);
}
```
