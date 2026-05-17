# Memorai Architecture

> **Version:** 0.4.0
> **Date:** 2026-05-17
> **Based on:** StreamingClaw StreamingMemory (arXiv:2603.22120v2) + mem0/Letta lessons + production benchmark feedback
> **Goal:** A runtime-agnostic, multimodal **event-based** memory layer for AI agents — an "efficient memory that never forgets".

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
7. **Event-shaped input**: The public API accepts raw events anchored in time (who, when, to whom, what) — Memorai's pipeline does extraction, structuring, indexing, and recall internally. Users never hand-craft a structured `MemoryNode`.

### 1.3 Three-Layer API Design

Memorai exposes three interface layers, ordered by abstraction:

```
┌──────────────────────────────────────────────────────────────────┐
│  Event API (Public — what users call)                            │
│  recordEvent({ at, actor, target?, content, ... })                │
│  recall(question, { actor?, timeRange?, ... })                    │
│  - Time-anchored                                                  │
│  - Actor / target relationships                                   │
│  - Multimodal content (text, image, audio, video, file)           │
└──────────────────────────────────────────────────────────────────┘
                              │
              extraction pipeline (LLM + heuristics)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Memory API (Internal — implementation surface)                  │
│  write(WritePayload) / writeBatch / evolve / retrieve             │
│  - Structured MemoryNode { summary, tags, salience, modality }    │
│  - Hierarchical evolution (segment → atomic_action → episode)     │
│  - Multi-strategy retrieval (factual / temporal / inferential …)  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Storage API (Pluggable)                                          │
│  StorageAdapter / EmbeddingService / CompressionService           │
│  - MemoryAdapter / SQLiteAdapter / IndexedDBAdapter / …           │
└──────────────────────────────────────────────────────────────────┘
```

**Why three layers**: Earlier versions of Memorai exposed `write(WritePayload)` directly to callers, forcing them to produce `{ summary, tags, salienceScore, modality }` themselves. That bled internal extraction concerns into every integration. The Event API restores the natural shape callers actually have ("Alice sent Bob a message at 14:32"), and Memorai owns the conversion to structured memory. The internal Memory API is preserved as a power-user / library-author escape hatch.

### 1.4 Three-Tier Storage Philosophy (the core principle)

Every memory in Memorai is organized in three tiers, **bottom-up**. This mirrors how humans build understanding from experience — you remember what you saw and heard first, then interpret it over time, and only later derive abstract structures from those interpretations.

```
┌──────────────────────────────────────────────────────────────────┐
│  Tier 3: Indexes (computed, re-buildable)                         │
│    - Embedding vectors                                            │
│    - BM25 inverted indexes                                        │
│    - Knowledge-triple graphs                                      │
│    - Tag / actor / target / userId reverse indexes                │
│    - Any future indexable form                                    │
│  Re-buildable from Tier 1+2 at any time.                          │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ derived (queryable shape)
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Tier 2: Annotations (evolving, can be re-extracted)              │
│    - LLM-extracted canonical fact form                            │
│    - Multiple paraphrased fact variants                           │
│    - Tags / entities / topics                                     │
│    - Salience score                                               │
│    - Knowledge triples (subject, predicate, object)               │
│    - Sentiment, topics, embeddings, …                             │
│    - Open extension: any future annotation type                   │
│  Re-extractable from Tier 1 when a better extractor appears.      │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ derived (interpretation)
                              │
┌──────────────────────────────────────────────────────────────────┐
│  Tier 1: Raw timeline (immutable, append-only, canonical truth)   │
│    - Original Event payload, byte-for-byte                        │
│    - Time anchor (timestamp + optional duration)                  │
│    - Actor / target / userId (relational anchors)                 │
│    - Multimodal references (image / audio / video / file)         │
│  Never modified. Never overwritten by an extractor. Forever.      │
└──────────────────────────────────────────────────────────────────┘
```

**Three invariants**:

1. **Tier 1 is append-only.** Once written, raw events are immutable. No extractor, no evolution step, no upgrade ever mutates them. This is the "永不忘记" promise — even when the rest of the system changes, what was actually observed stays intact.

2. **Tier 2 is regenerable.** Annotations are *one interpretation* of the raw event — useful, but not authoritative. When a better LLM, a smarter prompt, or a different extraction technique appears, Memorai can re-run extraction over the existing Tier 1 and replace Tier 2. This is what `Memorai.reAnnotate()` does.

3. **Tier 3 is disposable.** Indexes are computed artifacts. They can be dropped and rebuilt at any time from Tier 1+2. Different storage backends maintain different index shapes; the canonical state lives below.

**Three consequences that other memory libraries can't match**:

- **"Upgrade the model, re-index everything for free."** Mem0/Zep destructively summarize at ingest time — they keep only Tier 2. When their extraction quality improves, old memories don't benefit. Memorai re-runs extraction over Tier 1 and the entire history is upgraded.
- **"Multiple interpretations coexist."** The same raw event can carry a factual summary AND a narrative form AND a sentiment annotation AND a triple set, indexed in parallel. Recall pathways pick whichever interpretation matches the question.
- **"Provenance traces back to the source."** Every recalled memory cites its raw form. Users see both "the system thinks you said X" (annotation) and "the original was Y" (raw). Trust is grounded in the verifiable bottom layer.

**Mapping to the type system** (see §3 and §4 for the full schemas):

| Tier | Concrete fields |
|------|-----------------|
| 1 | `MemoryNode.raw: { content, text?, media? }`, `timestamp`, `duration`, `actor`, `target`, `userId`, `meta.sourceAgent`, `meta.participants`, `meta.eventId` |
| 2 | `MemoryNode.annotations: { summary?, facts?, description?, tags, salienceScore, modality, embedding?, triples? }`, `annotatedAt?`, `annotationVersion?` |
| 3 | Storage-adapter-internal: BM25 inverted index, embedding vector store, userId/actor/target maps, knowledge graph store |

Extractors write Tier 1 + Tier 2 in a single `WritePayload`. The `WrapExtractor` writes only Tier 1 (no annotation). The `LightExtractor` adds heuristic Tier 2. The `LLMExtractor` adds LLM-grade Tier 2 + (optionally) triples. The Tier 3 indexes are maintained automatically by `StorageAdapter.put()`.

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
    level: 'segment' | 'atomic_action' | 'episode';
    parentId?: string;           // For atomic_action → episode linking
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
  level?: 'segment' | 'atomic_action' | 'episode';
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
  episodeTimeWindowMs: number;        // Max span for an episode (default: 300000)
  
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
  level?: 'segment' | 'atomic_action' | 'episode';
  
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

### 4.6 Extraction Pipeline (Event → MemoryNode)

The Extraction Pipeline is what turns a raw `Event` from the public API into one or more structured `MemoryNode`s, then into hierarchical memory through `EvolutionEngine`.

```typescript
interface Extractor {
  // Convert a raw event into one or more memory writes.
  extract(event: Event, ctx: ExtractContext): Promise<WritePayload[]>;
}

interface ExtractContext {
  // The events immediately preceding this one in the same actor/target
  // window — supplied for coreference and topic continuity.
  recent: MemoryNode[];
  // Embedder, LLM, and clock available to the extractor.
  embedding: EmbeddingService;
  llm?: LLMService;
  now: () => number;
}
```

**Pipeline stages**, applied in order to every incoming event:

1. **Normalize.** Resolve `at` (point) vs. `during` (range) → canonical `timestamp` + `duration`. Resolve `actor` / `target` to stable string IDs. Coerce `content` to `MemoryPayloadInput` shape.
2. **Transcribe.** If `content` is non-text (image / audio / video / file), produce a textual `summary` and `description`:
   - Image → caption (vision model) + OCR if text present
   - Audio → speech-to-text transcript
   - Video → key-frame captions + audio transcript, joined by timeline
   - File → MIME-based handler (PDF / docx → text; binary → metadata only)
3. **Salience scoring.** Heuristic + (optional) LLM rating. Heuristic considers: presence of named entities, declarative facts (`X is Y`), updates that contradict prior memory, explicit emphasis tokens, length. Score in `[0, 1]`.
4. **Tagging.** Extract entities (people, places, things, dates), topics, and explicit hashtags. Always include `actor` and `target` (if present) as tags so they remain queryable via `queryByTags`.
5. **Embedding.** Compute `embedding` from `summary` (and `description` if present) via the injected `EmbeddingService`. Cached by content hash so identical content doesn't re-embed.
6. **Relationship inference.** If `target` is present, attach a `{ kind: "interaction", from: actor, to: target }` triple to `meta`. Used for `queryByRelationship`.
7. **Splitting.** Long content (e.g., a 30-minute video transcript) may be split into multiple `WritePayload`s along sentence/scene boundaries; the originals are linked via shared `event_id` in `meta`.
8. **Write.** Pass the resulting `WritePayload[]` to `Memorai.writeBatch()`. The internal `EvolutionEngine` takes over from there (segment → atomic_action → episode).

**Extractor implementations** (provided + pluggable):

| Implementation | Cost | Quality | When to use |
|---|---|---|---|
| `WrapExtractor` | $0 | Low | Text-only events; benchmarking storage layer in isolation |
| `LightExtractor` | Embeddings + heuristics | Medium | Production text agents; no LLM available |
| `LLMExtractor` | LLM per event | High | Match mem0/Letta-class quality; default for production |
| `MultimodalExtractor` | LLM + vision model | High | Image/audio/video events |
| User-defined | — | — | Domain-specific extraction logic |

The extractor is injected at `Memorai` construction. Switching extractors is the primary lever for the cost/quality tradeoff.

---

## 5. Cross-Agent Unified Memory

Different agents have different memory needs, but they share the same storage and retrieval infrastructure.

```typescript
interface AgentMemoryProfile {
  agentId: string;
  role: 'reasoning' | 'proactive' | 'custom';
  
  // What this agent stores
  writePolicy: {
    levels: ('segment' | 'atomic_action' | 'episode')[];
    modalities: ('text' | 'vision' | 'audio' | 'multimodal')[];
    salienceBoost: number;        // Agent-specific salience weight
  };
  
  // What this agent retrieves
  readPolicy: {
    defaultLevel: 'segment' | 'atomic_action' | 'episode';
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

The public API is **event-shaped**. Users hand Memorai raw events; Memorai owns extraction, structuring, evolution, and recall. The structured `MemoryNode` / `WritePayload` types remain reachable for advanced users but are no longer the recommended integration surface.

### 6.1 Event API — the primary entry point

```typescript
interface Event {
  // —— time anchor (one of these is required) ——
  at?: number | Date;                     // point in time (Unix ms or Date)
  during?: { start: number | Date; end: number | Date }; // time range

  // —— participants ——
  actor: string;                          // who produced the event
  target?: string;                        // to whom (optional — observations have no target)
  participants?: string[];                // additional involved parties (multi-party calls, etc.)

  // —— payload ——
  content: EventContent;                  // discriminated by `kind`

  // —— optional metadata ——
  context?: string;                       // free-form, attached to MemoryNode.meta.writeContext
  tags?: string[];                        // user-supplied tags merged with extracted ones
  salienceHint?: number;                  // 0–1, user-supplied override for salience scorer
  id?: string;                            // dedupe key — same id = idempotent re-record
}

type EventContent =
  | { kind: "message"; text: string }                                        // SMS / chat / email
  | { kind: "speech"; text: string; audio?: AudioBuffer | string }            // transcribed speech
  | { kind: "image"; image: ImageData | string; caption?: string }            // photo / screenshot
  | { kind: "audio"; audio: AudioBuffer | string; transcript?: string }
  | { kind: "video"; video: string; frames?: ImageData[]; transcript?: string }
  | { kind: "file"; mime: string; ref: string; text?: string }                // document / attachment
  | { kind: "observation"; text: string }                                    // narration / introspection
  | { kind: "custom"; text: string; data?: Record<string, unknown> };

class Memorai {
  // —— Recording events ——
  /**
   * Record a single event. Returns a RecordHandle immediately — extraction
   * runs in the background. Await `handle.nodes` to block until extraction
   * completes, or fire-and-forget for low-latency hot paths.
   */
  recordEvent(event: Event): RecordHandle;

  /** Record many events efficiently. Returns one handle covering all of them. */
  recordEvents(events: Event[]): RecordHandle;
}

interface RecordHandle {
  /** Event IDs assigned synchronously (one per Event, dedupe-keyed if `Event.id` provided). */
  readonly eventIds: readonly string[];
  /** Resolves once extraction + write completes. Rejects on extraction failure. */
  readonly nodes: Promise<MemoryNode[]>;
  /** True once `nodes` has resolved. Useful for non-blocking status checks. */
  readonly done: () => boolean;
  /** Cancel pending extraction (no-op if already complete). */
  readonly cancel: () => void;
}
```

**Examples**:

```typescript
// "Alice sent Bob a message at 14:32"
const handle = memory.recordEvent({
  at: Date.now(),
  actor: "alice",
  target: "bob",
  content: { kind: "message", text: "Are you free for lunch?" },
});
// fire-and-forget — hot path doesn't wait on LLM extraction
// (or `await handle.nodes` to block until written)

// "Carol shared a 5-minute video"
memory.recordEvent({
  during: { start: t0, end: t0 + 5 * 60_000 },
  actor: "carol",
  content: { kind: "video", video: "blob:abc-123", transcript: "..." },
});

// "User observed the dashboard alert"
memory.recordEvent({
  at: Date.now(),
  actor: "user",
  content: { kind: "observation", text: "Dashboard turned red — error rate climbed past 5%" },
  salienceHint: 0.9,
});
```

### 6.2 Recall API — the primary read path

```typescript
class Memorai {
  /** Natural-language recall. Returns the most relevant memories. */
  recall(question: string, opts?: RecallOptions): Promise<RecallResult>;

  /** Structured recall: by actor, by relationship, by time window. */
  recallByActor(actor: string, opts?: RecallOptions): Promise<RecallResult>;
  recallByRelationship(a: string, b: string, opts?: RecallOptions): Promise<RecallResult>;
  recallByTime(range: { start: number; end: number }, opts?: RecallOptions): Promise<RecallResult>;
  recallByTag(tags: string[], opts?: RecallOptions): Promise<RecallResult>;
}

interface RecallOptions {
  topK?: number;                          // default 10
  timeRange?: { start: number; end: number };
  actor?: string;                         // filter to events involving this actor
  target?: string;
  modality?: ("text" | "image" | "audio" | "video")[];
  level?: "segment" | "atomic_action" | "episode";
  strategy?: "factual" | "temporal" | "inferential" | "exploratory";
  // Power user: override the underlying RetrievalQuery for full control
  overrideQuery?: Partial<RetrievalQuery>;
}

interface RecallResult {
  memories: RecalledMemory[];             // ranked, top-K
  confidence: number;
  totalScanned: number;
}

interface RecalledMemory {
  id: string;
  at: number;                             // primary timestamp
  during?: { start: number; end: number };
  actor: string;
  target?: string;
  summary: string;                        // canonical textual form
  evidence?: { kind: "image" | "audio" | "video" | "file"; ref: string }[];
  score: number;                          // 0–1 relevance
  level: "segment" | "atomic_action" | "episode";
}
```

The Recall API is intentionally narrow on the surface but pipes through the full `RetrievalEngine` underneath. The `overrideQuery` escape hatch lets benchmarks and power users access the multi-strategy retrieval API directly.

### 6.3 Internal Memory API

These methods are **internal**. They live on `Memorai` for library authors, extractor implementations, and benchmark harnesses that need to bypass extraction. They are documented but not the recommended integration path.

```typescript
class Memorai {
  // ─── Internal: structured write ───
  /** @internal Store a pre-extracted memory segment. Used by extractors and tests. */
  write(payload: WritePayload, opts?: WriteOptions): Promise<MemoryNode>;
  /** @internal Batch version. */
  writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]>;

  // ─── Internal: low-level read ───
  /** @internal Direct retrieval engine access. Most callers should use recall(). */
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  /** @internal Direct storage access. */
  get(id: string): Promise<MemoryNode | null>;
  list(opts?: ListOptions): Promise<MemoryNode[]>;

  // ─── Internal: evolution ───
  /** @internal Force HME aggregation. Normally auto-triggered. */
  evolve(): Promise<void>;

  // ─── Management ───
  delete(id: string, cascade?: boolean): Promise<void>;
  update(id: string, patch: NodePatch): Promise<MemoryNode>;
  close(): Promise<void>;
}
```

### 6.4 Configuration

```typescript
interface MemoraiConfig {
  // Storage
  storage: StorageAdapter;

  // Services (all pluggable)
  embedding: EmbeddingService;
  compression?: CompressionService;
  extractor?: Extractor;                  // default: LightExtractor (if no LLM) or LLMExtractor (if LLM provided)
  llm?: LLMService;                       // used by LLMExtractor and salience scoring

  // Evolution — auto-triggered by default
  evolution?: Partial<EvolutionConfig>;

  // Cross-agent
  agentProfile?: AgentMemoryProfile;

  // Default participants
  defaultActor?: string;                  // used if Event.actor is omitted
  namespace?: string;
}
```

### 6.5 Usage Example

```typescript
import { Memorai, LLMExtractor } from "memorai";
import { SQLiteAdapter } from "memorai/storage";
import { OpenAIEmbeddingService } from "memorai/embeddings";

const memory = new Memorai({
  storage: new SQLiteAdapter(db),
  embedding: new OpenAIEmbeddingService({ apiKey }),
  extractor: new LLMExtractor({ llm: openaiChat, model: "gpt-4o-mini" }),
  defaultActor: "user",
});

// Record conversations
memory.recordEvent({
  at: Date.now(),
  actor: "user",
  target: "assistant",
  content: { kind: "message", text: "Remind me to call Bob tomorrow about the migration" },
});

memory.recordEvent({
  at: Date.now(),
  actor: "assistant",
  target: "user",
  content: { kind: "message", text: "Got it. I'll surface a reminder tomorrow morning." },
});

// Later: recall
const result = await memory.recall("what did the user ask me to remind them about?", {
  actor: "user",
  topK: 5,
});

for (const m of result.memories) {
  console.log(`[${new Date(m.at).toISOString()}] ${m.actor}→${m.target}: ${m.summary}`);
}
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
                                            (public API)
┌─────────────┐     ┌──────────────┐     ┌──────────────────────┐
│  Caller     │────►│  Event       │────►│   Extraction         │
│  (agent /   │     │  recordEvent │     │   (transcribe → tag  │
│   user code)│     │  recordEvents│     │    → salience → emb) │
└─────────────┘     └──────────────┘     └──────────┬───────────┘
                                                     │ WritePayload[]
                                                     ▼
                              (internal Memory API)
                    ┌─────────────────┐     ┌────────────────┐
                    │  Memorai.write  │────►│ STM: Segments  │
                    │   (structured)  │     │ (fine-grained) │
                    └─────────────────┘     └────────┬───────┘
                                                      │
                                                      ▼
                                            ┌────────────────┐
                                            │   HME L1:      │
                                            │  Segment →     │
                                            │  Atomic Action │
                                            └────────┬───────┘
                                                      │
                                                      ▼ (auto-trigger)
                                            ┌────────────────┐
                                            │   HME L2:      │
                                            │  Atomic →      │
                                            │  Event         │
                                            └────────┬───────┘
                                                      │
                                                      ▼
                                            ┌────────────────┐
                                            │ LTM: Events    │
                                            │ (abstract)     │
                                            └────────┬───────┘
                                                      │
                                                      ▼
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Agent      │◄────│  Recall      │◄────│   Retrieval        │
│  Query      │     │  (public API)│     │   (concurrent,     │
└─────────────┘     └──────────────┘     │    multi-strategy) │
                                          └────────────────────┘
```

Two phases run continuously:
- **Ingest** (top half): events arrive, extraction produces `WritePayload`s, internal `write` deposits them as segments, HME promotes them upward in the background.
- **Recall** (bottom): `recall(question, opts?)` queries across all levels with the configured retrieval strategy, returning a ranked, attributed result set.

The two halves are decoupled — recall does not wait on evolution, and evolution does not block recall.

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
- [x] SQLite adapter (Node.js / Bun / Deno)
- [x] MemoryNode schema + CRUD operations
- [x] Basic embedding service interface + OpenAI/Ollama implementations
- [x] Simple retrieval (embedding cosine similarity)

### Phase 2: Hierarchical Evolution ✅
- [x] Segment → Atomic Action merging (online, on every write)
- [x] Atomic Action → Event aggregation (manual + background loop)
- [x] Background evolution loop (`autoEvolveIntervalMs`)
- [x] Configurable thresholds (`semanticMergeThreshold`, `sceneSimilarityThreshold`, etc.)

### Phase 3: Advanced Retrieval ✅
- [x] Command-driven retrieval with strategy hints
- [x] Concurrent retrieval pipeline
- [x] Self-directed temporal traversal (forward/reverse/salience)
- [x] Early-stop mechanism

### Phase 4: Multimodal & Compression
- [x] Media payload type support (image references)
- [x] Compression service interface
- [ ] Cross-modal embeddings
- [ ] Image / audio / video extractors

### Phase 5: Cross-Agent & Ecosystem
- [x] Agent memory profiles (read/write policies)
- [ ] Cross-agent unified memory (shared storage + differentiated retrieval)
- [ ] Integration examples (OpenClaw-compatible)
- [x] Documentation & tutorials (VitePress)
- [x] Benchmark harness against public datasets (LoCoMo / LongMemEval / ConvoMem)

### Phase 6: Event API + Extraction Pipeline ✅ (shipped in 0.1.0)

The first five phases produced the internal Memory API. Phase 6 wrapped it with the event-shaped public surface described in Sections 1.3, 4.6, 6.1, and 6.2.

**6.1 — Flatten internal types** ✅
- [x] Lift `level` / `parentId` / `childrenIds` / `mergedFrom` from `MemoryNode.hierarchy` to top-level
- [x] Update all storage adapters (indexes use flat fields)
- [x] Update tests, examples, benchmarks package

**6.2 — Auto-evolve triggers** ✅
- [x] `EvolutionConfig.mode: "auto" | "manual"` with default `"auto"`
- [x] `autoTriggers`: `onWriteCount` / `onIdleMs` / `onStmFull` / `onClose` / optional `intervalMs`
- [x] Mutex so concurrent `evolve()` coalesces into one in-flight call

**6.3 — userId first-class** ✅
- [x] `MemoryNode.userId?`, `MemoryNode.actor?`, `MemoryNode.target?` at top level
- [x] `StorageAdapter.queryByUserId` / `queryByActor` / `queryByTarget` + indexes in all 3 adapters
- [x] Evolution respects userId boundaries — no cross-actor merging (L1 + L2)

**6.4 — Event API surface** ✅
- [x] `recordEvent(event)` / `recordEvents(events)` returning `RecordHandle`
- [x] `Event` + discriminated `EventContent` types (message / speech / image / audio / video / file / observation / custom)
- [x] `recall(question, opts?)` + structured `recallByActor` / `recallByRelationship` / `recallByTime` / `recallByTag`
- [x] `defaultActor` / `defaultUserId` in config

**6.5 — Extraction pipeline** ✅
- [x] `Extractor` interface + `ExtractContext` + `LLMService` interface
- [x] `WrapExtractor` (text passthrough — no LLM)
- [x] `LightExtractor` (embeddings + heuristic salience + entity tagging)
- [x] `LLMExtractor` (LLM summary + tags + salience; gracefully falls back to Light on parse failure)
- [ ] `MultimodalExtractor` (image/audio/video → text) — deferred; multimodal events currently pass through via WrapExtractor with raw media refs preserved

**6.6 — Internal API cleanup** ✅
- [x] Mark `write` / `writeBatch` / `retrieve` / `evolve` as `@internal` in JSDoc
- [x] Documented escape hatches for benchmarks and extractors
- [x] Pre-1.0 breaking changes consolidated into 0.1.0 (no migration guide — wipe and reingest)

**6.7 — Benchmarks rewire** ✅
- [x] `packages/benchmarks/src/providers/memorai.ts` switched to single Memorai + `recordEvent` + `recall`
- [x] Dropped the `Map<userId, Memorai>` instance-per-user workaround
- [x] Custom suite passes; LoCoMo smoke pipeline runs end-to-end

---

## 11. Open Questions

### Resolved (decisions captured)

- **Q6 / `recordEvent` is async via `RecordHandle`** — returns a handle synchronously with `eventIds`; extraction runs in the background. Callers can `await handle.nodes` to block, fire-and-forget for hot paths, or call `handle.cancel()` to abort pending extraction.
- **Q11 / Cost transparency is out of scope for the API** — token spend stays at the LLM client layer. Memorai does not return `cost` fields. Users who need observability wrap their `LLMService` themselves.

### Original (pre-Event-API)

1. **Embedding dimension & model choice**: Do we standardize on a default embedding dimension (e.g., 768, 1024, 1536)? Should the storage adapter handle dynamic dimensions?
2. **Media storage size limits**: Browser IndexedDB has size quotas. Should we implement automatic pruning/eviction based on LRU + salience?
3. **Real-time evolution cost**: HME on every write could be expensive. Should we batch evolution (buffer writes, evolve periodically)?
4. **Compression trade-offs**: Video compression is CPU-intensive. Should compression be offloaded to a Web Worker / worker thread?
5. **Cross-tab synchronization**: In browser, should memory sync across tabs via BroadcastChannel + SharedWorker?

### New (raised by Phase 6 Event API)

6. **Should `recordEvent` return memory IDs synchronously or wait on extraction?** LLM extraction can take seconds. Option A: return a `RecordHandle` that resolves to nodes when extraction completes; caller can `await` or fire-and-forget. Option B: always await — simple but blocks. Option C: dual API — sync `queueEvent` returning a handle, async `recordEvent` returning nodes.
7. **Multi-actor relationships**: Currently `meta.sourceAgent` is a single string. Should we generalize to `actor` + `target` + `participants`? How does this interact with `agentProfile`?
8. **Idempotency**: `Event.id` lets callers dedupe. What's the storage cost of dedupe tracking? Time-bounded (e.g., last 24h) or permanent?
9. **Recall ranking across mixed levels**: When `recall()` returns segments, atomic_actions, and events together, how should they be ranked? The current `RetrievalEngine` boosts levels per-strategy, but a "smart default" merging segment+event for the same fact is desirable.
10. **Extractor isolation**: An LLM extractor can hallucinate a salience score or invent tags. Should extractor output be sandboxed/validated against a schema before reaching storage?
11. **Cost transparency**: Event API hides token spend behind extraction. Should `recordEvent` emit a `cost` field (tokens, $ estimate) so callers know what they're spending?
12. **Re-extraction on extractor upgrade**: If the user swaps `LightExtractor` for `LLMExtractor`, should historical memories be re-extracted? Stored events vs. stored extractions — should both be persisted?

---

*This architecture is a living document. As we implement, we'll refine and update.*
