# Memorai Architecture

> **Version:** 1.0-draft  
> **Date:** 2026-05-14  
> **Based on:** StreamingClaw StreamingMemory (arXiv:2603.22120v2, Section 4)  
> **Goal:** A runtime-agnostic, multimodal streaming memory layer for AI agents — Browser, Node.js, Bun, Deno.

---

## 1. Design Goals & Core Principles

Memorai started as a browser-local memory layer for AI agents. After studying **StreamingClaw's StreamingMemory** design, we're evolving it into a **full-fledged multimodal streaming memory system** that can power any agent — from browser extensions to embodied robots.

### 1.1 What We Learn from StreamingClaw

StreamingClaw's StreamingMemory solves three critical problems that traditional memory systems fail at:

| Problem | Traditional Approach | StreamingMemory Approach |
|---|---|---|
| **Information loss** | Store only text summaries | **Multimodal memory nodes** — preserve vision, audio, embedding, text together |
| **Inefficiency** | Dump all memory into context | **Hierarchical evolution** — compress & structure, retrieve only what's needed |
| **Rigid memory** | Flat, isolated entries | **Hierarchical + evolvable** — segments → atomic actions → events, with add/update/delete |

### 1.2 Memorai's Core Principles

1. **Multimodal-first**: Memory is not just text. A memory node can hold video frames, audio clips, embedding vectors, structured metadata, and text — all together, aligned by timestamp.
2. **Hierarchical evolution**: Short-term memories (fine-grained, recent) automatically evolve into long-term memories (abstract, structured) through online induction and merging.
3. **Efficient retrieval**: Command-driven, concurrent, with self-directed temporal traversal (forward / reverse / salience-first).
4. **Runtime-agnostic**: Same code runs in Browser (IndexedDB), Node.js (SQLite/LevelDB), Bun, Deno. Storage is fully abstracted.
5. **Cross-agent unified**: Standardized storage/retrieval interfaces, with differentiated memory management per agent role.
6. **Streaming-native**: Designed for continuous, real-time input — not batch processing of offline files.

---

## 2. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Agent (User Code)                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Reasoning  │  │  Planning   │  │  Proactive  │  │      Tools          │  │
│  │   Agent     │  │   Agent     │  │   Agent     │  │   (Video Cut, etc.)│  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                │                    │            │
│         └────────────────┴────────────────┴────────────────────┘            │
│                                       │                                     │
│                              ┌────────▼────────┐                          │
│                              │  Memorai Core   │                          │
│                              │  (Memory Engine)  │                          │
│                              └────────┬────────┘                          │
│                                       │                                     │
│         ┌─────────────────────────────┼─────────────────────────────┐       │
│         │                             │                             │       │
│  ┌──────▼──────┐  ┌─────────▼─────────┐  ┌─────────▼─────────┐    │       │
│  │  Storage    │  │  Evolution        │  │  Retrieval      │    │       │
│  │  Adapter    │  │  Engine           │  │  Engine         │    │       │
│  │  (Pluggable)│  │  (HME)            │  │  (Concurrent)   │    │       │
│  └─────────────┘  └───────────────────┘  └─────────────────┘    │       │
│                                                                  │       │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐   │       │
│  │  Embedding   │  │  Compression     │  │  Temporal Index  │   │       │
│  │  Service     │  │  (Multimodal)    │  │  (Salience, etc.)│   │       │
│  │  (Pluggable) │  │                  │  │                  │   │       │
│  └──────────────┘  └──────────────────┘  └──────────────────┘   │       │
│                                                                  │       │
└──────────────────────────────────────────────────────────────────┴───────┘
                                    │
                         ┌──────────▼──────────┐
                         │   Storage Backends    │
                         │  ┌───────────────┐   │
                         │  │  IndexedDB    │   │  ← Browser
                         │  │  LevelDB      │   │  ← Node.js / Bun
                         │  │  SQLite       │   │  ← Node.js / Bun / Deno
                         │  │  In-Memory    │   │  ← Testing / Edge
                         │  │  (Custom...)  │   │  ← User-defined
                         │  └───────────────┘   │
                         └─────────────────────┘
```

---

## 3. Core Concepts

### 3.1 Memory Node (`MemoryNode`)

The fundamental unit of memory. Inspired by StreamingClaw's definition:

```typescript
interface MemoryNode {
  id: string;                    // Unique identifier
  timestamp: number;           // Unix timestamp (ms) — when this memory ends
  duration: number;              // Duration in ms (for temporal segments)
  
  // --- Multimodal payload ---
  payload: {
    // Raw / compressed multimodal data (optional, stored by reference)
    media?: {
      frames?: ImageData[];      // Compressed video frames / screenshots
      audio?: AudioBufferRef;     // Audio clip reference
      video?: VideoSegmentRef;    // Video segment reference
    };
    
    // Semantic representations
    summary: string;             // Textual summary (required) — "what happened"
    description?: string;        // Detailed description — "how it happened"
    embedding?: number[];        // Vector embedding of the semantic content
    
    // Structured metadata for retrieval & evolution
    tags: string[];              // Extracted tags/entities
    salienceScore: number;       // 0.0 - 1.0, importance at write time
    modality: ('text' | 'vision' | 'audio' | 'multimodal')[];
  };
  
  // --- Hierarchical linking ---
  hierarchy: {
    level: 'segment' | 'atomic_action' | 'event';
    parentId?: string;           // For atomic_action → event linking
    childrenIds?: string[];      // For event → atomic_actions
    mergedFrom?: string[];       // IDs of nodes merged into this one
  };
  
  // --- Cross-agent metadata ---
  meta: {
    sourceAgent: string;         // Which agent created this memory
    agentRole: string;           // Role: 'reasoning' | 'proactive' | 'custom'
    writeContext?: string;       // Context at write time (for traceability)
    lastAccessed?: number;       // Timestamp of last read (for LRU eviction)
    accessCount: number;         // For salience recalculation
  };
}
```

**Key insight from StreamingClaw**: Do NOT force-convert visual information to text. Store the original media reference (or compressed version) alongside text embeddings. This prevents semantic misalignment and information loss.

### 3.2 Memory Layers

Two distinct storage tiers with different characteristics:

| | **Short-Term Memory (STM)** | **Long-Term Memory (LTM)** |
|---|---|---|
| **Content** | Compressed frames, atomic actions, fine-grained | Events, abstract summaries, structured |
| **Granularity** | High — per-segment / per-action | Low — aggregated events |
| **Recency** | Recent (configurable, e.g., last 5 min) | Historical |
| **Storage** | Fast access, in-memory or fast backend | Persistent, compressed |
| **Evolution** | Source material for HME | Result of HME |
| **Retrieval** | Direct lookup, reverse temporal | Indexed, semantic search, salience-ranked |

### 3.3 Hierarchical Memory Evolution (HME)

The core mechanism that transforms raw streaming inputs into structured long-term knowledge. StreamingClaw's three-level hierarchy:

```
Raw Segments ──► Atomic Actions ──► Events
   (fine)         (merged)          (abstract)
   │              │                 │
   │              │                 └─ Scene-similarity aggregation
   │              └─ Compatibility-score merging
   └─ Continuous incoming stream
```

**Level 1: Segment → Atomic Action**

For each new video/segment input:
1. Retrieve neighboring memory nodes from STM
2. Compute **compatibility score**: combines semantic similarity (embedding cosine) + temporal continuity (time gap)
3. If score > threshold → merge into existing atomic action
4. If score ≤ threshold → create new atomic-action node

**Level 2: Atomic Action → Event**

For a temporally contiguous sequence of atomic actions:
1. Compute **scene-similarity score**: are they about the same objects/scene?
2. If merging condition satisfied → update existing event
3. Otherwise → create new event node
4. Update parent-child links in hierarchy

**Benefits**:
- **Temporal queryability**: Each event preserves the atomic-action chain with explicit temporal order
- **Redundancy compression**: Repetitive segments merge up
- **Structured long-term storage**: Events are stable memory chunks

### 3.4 Retrieval Strategies

Three complementary strategies, directly from StreamingClaw's design:

| Strategy | When to Use | Mechanism |
|---|---|---|
| **Command-driven** | Agent specifies retrieval intent | Agent passes `query + strategy hints` (depth, stop criteria). Memory engine decides traversal depth and when to stop. |
| **High-concurrency** | Large memory corpus | Candidate matching, re-ranking, evidence extraction all run in parallel. Avoids serial error accumulation. |
| **Self-directed temporal traversal** | Time-sensitive queries | Engine autonomously picks traversal order: forward (causal), reverse (recent-first), salience-first (important-first). |

---

## 4. Module Design

### 4.1 Storage Adapter (`StorageAdapter`)

**Interface** — the only runtime-specific dependency:

```typescript
interface StorageAdapter {
  // Node CRUD
  put(node: MemoryNode): Promise<void>;
  get(id: string): Promise<MemoryNode | null>;
  delete(id: string): Promise<void>;
  
  // Batch operations (for HME efficiency)
  batchPut(nodes: MemoryNode[]): Promise<void>;
  
  // Range queries (temporal)
  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]>;
  
  // Tag / salience index queries
  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]>;
  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]>;
  
  // Hierarchy traversal
  getChildren(parentId: string): Promise<MemoryNode[]>;
  getParent(childId: string): Promise<MemoryNode | null>;
  
  // Lifecycle
  close(): Promise<void>;
}

interface QueryOpts {
  limit?: number;
  offset?: number;
  orderBy?: 'timestamp' | 'salience' | 'lastAccessed';
  order?: 'asc' | 'desc';
  level?: 'segment' | 'atomic_action' | 'event';
}
```

**Built-in Adapters**:

| Adapter | Runtime | Backend | Best For |
|---|---|---|---|
| `IndexedDBAdapter` | Browser | IndexedDB | Browser extensions, web apps |
| `LevelDBAdapter` | Node.js, Bun | LevelDB / RocksDB | Server-side, high throughput |
| `SQLiteAdapter` | Node.js, Bun, Deno | SQLite | Structured queries, embedded |
| `MemoryAdapter` | Any | In-memory Map | Testing, ephemeral |

Users can implement custom adapters (e.g., Redis, PostgreSQL, S3).

### 4.2 Hierarchical Memory Evolution Engine (`EvolutionEngine`)

```typescript
interface EvolutionEngine {
  // Process a new incoming segment
  ingest(segment: RawSegment): Promise<MemoryNode>;
  
  // Triggered periodically or on threshold
  evolveSTMtoLTM(): Promise<void>;
  
  // Configuration
  config: EvolutionConfig;
}

interface EvolutionConfig {
  // Segment → Atomic Action thresholds
  semanticMergeThreshold: number;    // Cosine similarity (default: 0.85)
  temporalGapThresholdMs: number;    // Max gap to merge (default: 30000)
  
  // Atomic Action → Event thresholds
  sceneSimilarityThreshold: number;   // Scene consistency (default: 0.80)
  eventTimeWindowMs: number;          // Max span for an event (default: 300000)
  
  // Trigger conditions
  autoEvolveIntervalMs: number;     // Background evolution (default: 60000)
  stmMaxSize: number;               // Max STM nodes before forced evolution
}
```

**Evolution Algorithm** (simplified):

```
function ingest(segment):
  node = createSegmentNode(segment)
  
  // Step 1: Try merge into atomic action
  candidates = stm.queryRecent(temporalWindow)
  for each candidate in candidates:
    score = compatScore(node, candidate)  // semantic + temporal
    if score > config.semanticMergeThreshold:
      merged = mergeIntoAtomicAction(candidate, node)
      storage.put(merged)
      return merged
  
  // Step 2: Create new atomic action
  atomicAction = promoteToAtomicAction(node)
  storage.put(atomicAction)
  
  // Step 3: Check event aggregation
  tryAggregateToEvent(atomicAction)
  
  return atomicAction
```

### 4.3 Retrieval Engine (`RetrievalEngine`)

```typescript
interface RetrievalEngine {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}

interface RetrievalQuery {
  // Core query
  text?: string;                    // Natural language query
  embedding?: number[];             // Pre-computed embedding (optional)
  
  // Strategy hints (command-driven)
  strategy: 'factual' | 'temporal' | 'inferential' | 'exploratory';
  maxDepth?: number;                // Max traversal depth
  earlyStop?: boolean;              // Stop when confidence threshold met
  
  // Temporal constraints
  timeRange?: { start: number; end: number };
  traversalOrder?: 'forward' | 'reverse' | 'salience';
  
  // Agent context
  agentRole?: string;               // Filter by agent role
  level?: 'segment' | 'atomic_action' | 'event';
  
  // Limits
  maxCandidates?: number;
  topK?: number;
}

interface RetrievalResult {
  nodes: MemoryNode[];
  confidence: number;               // Aggregate relevance score
  traversalStats: {
    scanned: number;
    matched: number;
    pruned: number;
    timeMs: number;
  };
}
```

**Concurrent Retrieval Pipeline**:

```
1. Parse query → determine strategy → set stop criteria
2. Build candidate set (parallel):
   ├─ Semantic search (embedding cosine)
   ├─ Tag/keyword index lookup
   ├─ Temporal index scan (if timeRange specified)
   └─ Salience-ranked pre-filter
3. Concurrent re-ranking:
   ├─ Cross-encoder scoring (if available)
   ├─ Temporal relevance scoring
   └─ Agent-role relevance scoring
4. Evidence extraction → assemble result nodes
5. Early-stop check → return or continue
```

### 4.4 Embedding Service (`EmbeddingService`)

Pluggable interface for generating vector embeddings. Users bring their own model.

```typescript
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedMultimodal?(payload: MultimodalPayload): Promise<number[]>;
  dimension: number;
}
```

**Built-in options**:
- `OpenAIEmbeddingService` — OpenAI API
- `OllamaEmbeddingService` — Local models via Ollama
- `TransformersEmbeddingService` — Browser/Node.js via `@xenova/transformers`
- `CustomEmbeddingService` — User-defined

### 4.5 Multimodal Compression Service (`CompressionService`)

Handles raw media compression before storage. Critical for STM storage efficiency.

```typescript
interface CompressionService {
  // Video: compress frame sequence → keyframes + delta
  compressVideo(frames: ImageData[], config: VideoCompressConfig): Promise<CompressedVideo>;
  
  // Audio: compress audio clip
  compressAudio(buffer: AudioBuffer, config: AudioCompressConfig): Promise<CompressedAudio>;
  
  // Image: compress single frame
  compressImage(image: ImageData, config: ImageCompressConfig): Promise<CompressedImage>;
}
```

Compression is **optional** — users can disable it and store raw references.

---

## 5. Cross-Agent Unified Memory

Different agents have different memory needs, but they share the same storage and retrieval infrastructure.

```typescript
interface AgentMemoryProfile {
  agentId: string;
  role: 'reasoning' | 'proactive' | 'custom';
  
  // What this agent stores
  writePolicy: {
    levels: ('segment' | 'atomic_action' | 'event')[];
    modalities: ('text' | 'vision' | 'audio' | 'multimodal')[];
    salienceBoost: number;        // Agent-specific salience weight
  };
  
  // What this agent retrieves
  readPolicy: {
    defaultLevel: 'segment' | 'atomic_action' | 'event';
    defaultTraversal: 'forward' | 'reverse' | 'salience';
    timeHorizonMs: number;        // How far back this agent typically looks
  };
}
```

**Example profiles**:

| Agent Role | Write Focus | Read Focus |
|---|---|---|
| **Reasoning** | Global semantic evolution, cross-temporal events | Events + atomic actions, forward traversal |
| **Proactive** | Key action triggers, state changes | Recent segments, reverse traversal, high salience |
| **Custom** | User-defined | User-defined |

---

## 6. Public API Design

### 6.1 Core Class: `Memorai`

```typescript
class Memorai {
  constructor(config: MemoraiConfig);
  
  // ─── Write ───
  /** Store a new memory segment. Returns the created MemoryNode. */
  write(payload: WritePayload, opts?: WriteOptions): Promise<MemoryNode>;
  
  /** Batch write multiple segments. */
  writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]>;
  
  // ─── Read ───
  /** Retrieve memories matching a query. */
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  
  /** Get a specific node by ID. */
  get(id: string): Promise<MemoryNode | null>;
  
  /** List memories with filtering. */
  list(opts?: ListOptions): Promise<MemoryNode[]>;
  
  // ─── Evolution ───
  /** Manually trigger HME. Normally auto-triggered. */
  evolve(): Promise<void>;
  
  // ─── Management ───
  /** Delete a memory node (and optionally its children). */
  delete(id: string, cascade?: boolean): Promise<void>;
  
  /** Update a memory node's metadata (tags, salience, etc.). */
  update(id: string, patch: Partial<MemoryNode>): Promise<MemoryNode>;
  
  /** Close all resources. */
  close(): Promise<void>;
}
```

### 6.2 Configuration

```typescript
interface MemoraiConfig {
  // Storage
  storage: StorageAdapter;
  
  // Services (all pluggable)
  embedding: EmbeddingService;
  compression?: CompressionService;
  
  // Evolution
  evolution?: Partial<EvolutionConfig>;
  
  // Cross-agent
  agentProfile?: AgentMemoryProfile;
  
  // Global
  namespace?: string;               // Memory namespace (for multi-tenant)
}
```

### 6.3 Usage Example

```typescript
import { Memorai } from 'memorai';
import { IndexedDBAdapter } from 'memorai/adapters/browser';
import { OpenAIEmbeddingService } from 'memorai/embeddings';

// Browser usage
const memory = new Memorai({
  storage: new IndexedDBAdapter({ dbName: 'my-agent-memory' }),
  embedding: new OpenAIEmbeddingService({ apiKey: '...' }),
  evolution: {
    semanticMergeThreshold: 0.85,
    stmMaxSize: 1000,
  },
  agentProfile: {
    agentId: 'browser-assistant',
    role: 'reasoning',
    writePolicy: { levels: ['segment', 'atomic_action'], modalities: ['text', 'vision'], salienceBoost: 1.0 },
    readPolicy: { defaultLevel: 'event', defaultTraversal: 'reverse', timeHorizonMs: 86400000 },
  },
});

// Write a multimodal memory (e.g., from a video stream)
const node = await memory.write({
  timestamp: Date.now(),
  payload: {
    summary: 'User opened the code editor and started typing',
    description: 'The user switched from browser to VS Code and began editing file architecture.md',
    media: {
      frames: [screenshot],  // ImageData
    },
    tags: ['coding', 'vscode', 'architecture'],
    salienceScore: 0.9,
    modality: ['vision', 'text'],
  },
});

// Retrieve with natural language
const result = await memory.retrieve({
  text: 'What was I working on in the editor?',
  strategy: 'factual',
  traversalOrder: 'reverse',
  topK: 5,
});

console.log(result.nodes.map(n => n.payload.summary));
// → ['User opened the code editor and started typing', ...]
```

---

## 7. Runtime Compatibility Design

### 7.1 Runtime Detection

```typescript
const runtime = detectRuntime(); // 'browser' | 'node' | 'bun' | 'deno'
```

### 7.2 Conditional Exports (package.json)

```json
{
  "exports": {
    ".": {
      "browser": "./dist/browser/index.js",
      "node": "./dist/node/index.js",
      "bun": "./dist/node/index.js",
      "deno": "./dist/deno/index.js",
      "default": "./dist/index.js"
    },
    "./adapters/browser": "./dist/adapters/browser.js",
    "./adapters/node": "./dist/adapters/node.js",
    "./embeddings/openai": "./dist/embeddings/openai.js",
    "./embeddings/ollama": "./dist/embeddings/ollama.js",
    "./embeddings/transformers": "./dist/embeddings/transformers.js"
  }
}
```

### 7.3 Browser vs Node.js Differences

| Feature | Browser | Node.js / Bun / Deno |
|---|---|---|
| Default Storage | IndexedDBAdapter | LevelDBAdapter or SQLiteAdapter |
| Compression | Canvas-based image compression | Sharp / ffmpeg-wasm |
| Embeddings | `@xenova/transformers` (WebGPU) | Ollama / OpenAI API / local |
| Crypto | `crypto.subtle` | `crypto` module (polyfilled for Deno) |

### 7.4 Build Setup

Use **tsdown** (or tsup) with multiple entry points and conditional builds. No bundler-specific APIs in core code — only Web Standard APIs (`fetch`, `crypto`, `URL`, etc.).

---

## 8. Streaming Memory Lifecycle

```
┌──────────┐     ┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│  Input   │────►│   Raw Segment │────►│  STM: Segments   │────►│   HME:      │
│  Stream  │     │   (temporal)  │     │  (fine-grained)  │     │  Segment →  │
└──────────┘     └──────────────┘     └─────────────────┘     │  Atomic     │
                                                                │  Action     │
                                                                └──────┬──────┘
                                                                       │
                                                                       ▼
┌──────────┐     ┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│  Agent   │◄────│  Retrieval   │◄────│  LTM: Events    │◄────│   HME:      │
│  Query   │     │  (efficient) │     │  (abstract)     │     │  Atomic →   │
└──────────┘     └──────────────┘     └─────────────────┘     │  Event      │
                                                              └─────────────┘
```

---

## 9. Comparison: Memorai vs StreamingClaw StreamingMemory

| Aspect | StreamingClaw (Python/ML) | Memorai (TypeScript/Runtime-agnostic) |
|---|---|---|
| **Language** | Python, PyTorch, MLLM-based | TypeScript, model-agnostic |
| **Runtime** | GPU servers (embodied AI) | Browser, Node.js, Bun, Deno |
| **Storage** | In-memory + persistent backend | Pluggable adapters (IndexedDB, SQLite, etc.) |
| **Multimodal** | Native video frames, KV-cache | Media references + embeddings + text |
| **Evolution** | MLLM-powered summarization/aggregation | Pluggable evolution engine (default: embedding-based) |
| **Retrieval** | MLLM + concurrent pipeline | Embedding search + concurrent + temporal index |
| **Deployment** | Server-side embodied agents | Anywhere JS/TS runs |
| **Model dependency** | Tight (requires MLLM) | Loose (bring your own embedding model) |

**Memorai is essentially a portable, runtime-agnostic reimplementation of StreamingMemory's core ideas**, designed for the TypeScript ecosystem and broader deployment scenarios.

---

## 10. Roadmap & Phases

### Phase 1: Core Foundation ✅
- [x] Storage adapter interface + IndexedDB + Memory adapters
- [ ] SQLite adapter (Node.js / Bun / Deno)
- [x] MemoryNode schema + CRUD operations
- [x] Basic embedding service interface + OpenAI/Ollama implementations
- [x] Simple retrieval (embedding cosine similarity)

### Phase 2: Hierarchical Evolution ✅
- [x] Segment → Atomic Action merging (online, on every write)
- [x] Atomic Action → Event aggregation (manual + background loop)
- [x] Background evolution loop (`autoEvolveIntervalMs`)
- [x] Configurable thresholds (`semanticMergeThreshold`, `sceneSimilarityThreshold`, etc.)

### Phase 3: Advanced Retrieval
- [ ] Command-driven retrieval with strategy hints
- [ ] Concurrent retrieval pipeline
- [ ] Self-directed temporal traversal (forward/reverse/salience)
- [ ] Early-stop mechanism

### Phase 4: Multimodal & Compression
- [ ] Media payload support (image references)
- [ ] Compression service interface
- [ ] Cross-modal embeddings

### Phase 5: Cross-Agent & Ecosystem
- [x] Agent memory profiles (read/write policies)
- [ ] Cross-agent unified memory (shared storage + differentiated retrieval)
- [ ] Integration examples (OpenClaw-compatible)
- [ ] Documentation & tutorials

---

## 11. Open Questions

1. **Embedding dimension & model choice**: Do we standardize on a default embedding dimension (e.g., 768, 1024, 1536)? Should the storage adapter handle dynamic dimensions?
2. **Media storage size limits**: Browser IndexedDB has size quotas. Should we implement automatic pruning/eviction based on LRU + salience?
3. **Real-time evolution cost**: HME on every write could be expensive. Should we batch evolution (buffer writes, evolve periodically)?
4. **Compression trade-offs**: Video compression is CPU-intensive. Should compression be offloaded to a Web Worker / worker thread?
5. **Cross-tab synchronization**: In browser, should memory sync across tabs via BroadcastChannel + SharedWorker?

---

*This architecture is a living document. As we implement, we'll refine and update.*
