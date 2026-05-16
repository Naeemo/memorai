// Core type definitions for Memorai
// Based on StreamingClaw StreamingMemory architecture + Event API extensions

// ─────────────────────────────────────────────────────────────
// Memory Node — the fundamental unit of memory
// ─────────────────────────────────────────────────────────────

export type MemoryLevel = "segment" | "atomic_action" | "event";
export type Modality = "text" | "vision" | "audio" | "multimodal";

export interface MediaPayload {
  frames?: Array<ImageData | { data: Uint8ClampedArray; width: number; height: number } | string>; // string = reference URL / blob key
  audio?: AudioBuffer | string; // string = reference
  video?: string; // reference to video segment (URL, blob key, path)
}

export interface MemoryPayload {
  media?: MediaPayload;
  summary: string;
  description?: string;
  embedding?: number[];
  tags: string[];
  salienceScore: number;
  modality: Modality[];
}

export interface MemoryMeta {
  /** AI agent that processed/wrote this memory (from agentProfile). */
  sourceAgent: string;
  /** Free-form agent role label. */
  agentRole: string;
  /** Free-form context attached at write time. */
  writeContext?: string;
  /** Additional event participants beyond actor/target (e.g., multi-party calls). */
  participants?: string[];
  /** Original Event.id, for back-reference and dedup. */
  eventId?: string;
  /** Wall-clock of last retrieve(). */
  lastAccessed?: number;
  /** Number of times this node has been retrieved. */
  accessCount: number;
}

export interface MemoryNode {
  id: string;
  timestamp: number; // Unix ms — when this memory ends
  duration: number; // Duration in ms
  level: MemoryLevel;
  /** Data ownership / multi-tenant scope. */
  userId?: string;
  /** Who produced the original event (person / system). */
  actor?: string;
  /** Whom the event was directed at. */
  target?: string;
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];
  payload: MemoryPayload;
  meta: MemoryMeta;
}

// ─────────────────────────────────────────────────────────────
// Write (internal API surface)
// ─────────────────────────────────────────────────────────────

/**
 * Loose write input — fields that have natural defaults are optional. The
 * internal `write()` normalizes this to a fully-populated `MemoryNode`.
 */
export interface MemoryPayloadInput {
  summary: string;
  tags?: string[]; // default []
  salienceScore?: number; // default 0.5
  modality?: Modality[]; // default ["text"]
  description?: string;
  media?: MediaPayload;
  embedding?: number[];
}

export interface WritePayload {
  timestamp?: number;
  duration?: number;
  payload: MemoryPayloadInput;
  userId?: string;
  actor?: string;
  target?: string;
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];
  meta?: Partial<MemoryMeta>;
}

export interface WriteOptions {
  skipEmbedding?: boolean; // if user already provided embedding
}

// ─────────────────────────────────────────────────────────────
// Storage Adapter
// ─────────────────────────────────────────────────────────────

export type OrderBy = "timestamp" | "salience" | "lastAccessed";
export type Order = "asc" | "desc";

export interface QueryOpts {
  limit?: number;
  offset?: number;
  orderBy?: OrderBy;
  order?: Order;
  level?: MemoryLevel;
}

export interface StorageAdapter {
  put: (node: MemoryNode) => Promise<void>;
  get: (id: string) => Promise<MemoryNode | null>;
  delete: (id: string) => Promise<void>;
  batchPut: (nodes: MemoryNode[]) => Promise<void>;
  queryByTimeRange: (start: number, end: number, opts?: QueryOpts) => Promise<MemoryNode[]>;
  queryByTags: (tags: string[], opts?: QueryOpts) => Promise<MemoryNode[]>;
  queryBySalience: (minScore: number, opts?: QueryOpts) => Promise<MemoryNode[]>;
  queryByUserId: (userId: string, opts?: QueryOpts) => Promise<MemoryNode[]>;
  queryByActor: (actor: string, opts?: QueryOpts) => Promise<MemoryNode[]>;
  queryByTarget: (target: string, opts?: QueryOpts) => Promise<MemoryNode[]>;
  getChildren: (parentId: string) => Promise<MemoryNode[]>;
  getParent: (childId: string) => Promise<MemoryNode | null>;
  listAll: (opts?: QueryOpts) => Promise<MemoryNode[]>;
  close: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Embedding Service
// ─────────────────────────────────────────────────────────────

export interface EmbeddingService {
  embed: (text: string) => Promise<number[]>;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  dimension: number;
}

// ─────────────────────────────────────────────────────────────
// LLM Service (used by LLMExtractor + salience scoring)
// ─────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
}

export interface LLMService {
  /** Single-turn completion. Required. */
  complete: (prompt: string, opts?: LLMCompletionOptions) => Promise<string>;
  /** Multi-turn chat. Optional — falls back to `complete` joining messages. */
  chat?: (messages: LLMMessage[], opts?: LLMCompletionOptions) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────
// Evolution
// ─────────────────────────────────────────────────────────────

export interface AutoEvolveTriggers {
  /** Fire `evolve()` every N writes since the last evolve. Default 100. */
  onWriteCount?: number;
  /** Fire `evolve()` after N ms of write-idle. Default 5000. */
  onIdleMs?: number;
  /** Fire `evolve()` when stmMaxSize is reached. Default true. */
  onStmFull?: boolean;
  /** Fire one last `evolve()` from close(). Default true. */
  onClose?: boolean;
  /** Background interval (ms). Off by default — explicit opt-in. */
  intervalMs?: number;
}

export interface EvolutionConfig {
  semanticMergeThreshold: number; // default: 0.85
  temporalGapThresholdMs: number; // default: 30000
  sceneSimilarityThreshold: number; // default: 0.80
  eventTimeWindowMs: number; // default: 300000
  stmMaxSize: number; // default: 1000
  /** "auto" runs triggers; "manual" requires explicit `evolve()` calls. */
  mode: "auto" | "manual";
  autoTriggers: AutoEvolveTriggers;
}

// ─────────────────────────────────────────────────────────────
// Retrieval (internal — wrapped by recall())
// ─────────────────────────────────────────────────────────────

export type RetrievalStrategy = "factual" | "temporal" | "inferential" | "exploratory";

export type TraversalOrder = "forward" | "reverse" | "salience";

export interface RetrievalQuery {
  text?: string;
  embedding?: number[];
  strategy: RetrievalStrategy;
  earlyStop?: boolean;
  timeRange?: { start: number; end: number };
  traversalOrder?: TraversalOrder;
  agentRole?: string;
  userId?: string;
  actor?: string;
  target?: string;
  level?: MemoryLevel;
  maxCandidates?: number;
  topK?: number;
}

export interface TraversalStats {
  scanned: number;
  matched: number;
  pruned: number;
  timeMs: number;
}

export interface RetrievalResult {
  nodes: MemoryNode[];
  confidence: number;
  traversalStats: TraversalStats;
}

// ─────────────────────────────────────────────────────────────
// Cross-Agent
// ─────────────────────────────────────────────────────────────

export interface WritePolicy {
  levels: MemoryLevel[];
  modalities: Modality[];
  salienceBoost: number;
}

export interface ReadPolicy {
  defaultLevel: MemoryLevel;
  defaultTraversal: TraversalOrder;
  timeHorizonMs: number;
}

export interface AgentMemoryProfile {
  agentId: string;
  /** Free-form role label — "reasoning" / "proactive" / app-specific. */
  role: string;
  writePolicy: WritePolicy;
  readPolicy: ReadPolicy;
}

// ─────────────────────────────────────────────────────────────
// Event API (public)
// ─────────────────────────────────────────────────────────────

export type EventContent =
  | { kind: "message"; text: string }
  | { kind: "speech"; text: string; audio?: AudioBuffer | string }
  | { kind: "image"; image: ImageData | string; caption?: string }
  | { kind: "audio"; audio: AudioBuffer | string; transcript?: string }
  | { kind: "video"; video: string; frames?: ImageData[]; transcript?: string }
  | { kind: "file"; mime: string; ref: string; text?: string }
  | { kind: "observation"; text: string }
  | { kind: "custom"; text: string; data?: Record<string, unknown> };

export interface Event {
  // —— time anchor (one required) ——
  at?: number | Date;
  during?: { start: number | Date; end: number | Date };

  // —— participants ——
  actor: string;
  target?: string;
  participants?: string[];

  // —— payload ——
  content: EventContent;

  // —— optional metadata ——
  userId?: string;
  context?: string;
  tags?: string[];
  salienceHint?: number;
  id?: string;
}

export interface RecordHandle {
  readonly eventIds: readonly string[];
  readonly nodes: Promise<MemoryNode[]>;
  done(): boolean;
  cancel(): void;
}

// ─────────────────────────────────────────────────────────────
// Extraction Pipeline
// ─────────────────────────────────────────────────────────────

export interface ExtractContext {
  /** Recent memories from the same actor/target window — for coreference. */
  recent: MemoryNode[];
  embedding: EmbeddingService;
  llm?: LLMService;
  now(): number;
  signal?: AbortSignal;
}

export interface Extractor {
  /** Convert a raw event into one or more memory writes. */
  extract: (event: Event, ctx: ExtractContext) => Promise<WritePayload[]>;
}

// ─────────────────────────────────────────────────────────────
// Recall API (public)
// ─────────────────────────────────────────────────────────────

export interface RecallOptions {
  topK?: number;
  timeRange?: { start: number; end: number };
  actor?: string;
  target?: string;
  userId?: string;
  modality?: Modality[];
  level?: MemoryLevel;
  strategy?: RetrievalStrategy;
  traversalOrder?: TraversalOrder;
  /** Power user escape hatch — overrides go straight to RetrievalQuery. */
  overrideQuery?: Partial<RetrievalQuery>;
}

export interface RecalledMemory {
  id: string;
  at: number;
  during?: { start: number; end: number };
  userId?: string;
  actor?: string;
  target?: string;
  summary: string;
  description?: string;
  tags: string[];
  salienceScore: number;
  evidence?: MediaPayload;
  score: number;
  level: MemoryLevel;
}

export interface RecallResult {
  memories: RecalledMemory[];
  confidence: number;
  totalScanned: number;
}

// ─────────────────────────────────────────────────────────────
// Patch (used by Memorai.update)
// ─────────────────────────────────────────────────────────────

export interface NodePatch {
  payload?: Partial<MemoryPayload>;
  meta?: Partial<MemoryMeta>;
  userId?: string;
  actor?: string;
  target?: string;
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];
}

// ─────────────────────────────────────────────────────────────
// Main Config
// ─────────────────────────────────────────────────────────────

export interface MemoraiConfig {
  storage: StorageAdapter;
  embedding: EmbeddingService;
  compression?: CompressionService;
  llm?: LLMService;
  extractor?: Extractor;
  evolution?: Partial<EvolutionConfig>;
  agentProfile?: AgentMemoryProfile;
  /** Default actor when Event.actor is omitted. */
  defaultActor?: string;
  /** Default userId when Event.userId is omitted. */
  defaultUserId?: string;
  /** Logical namespace (multi-tenant separation). */
  namespace?: string;
}

export interface ListOptions extends QueryOpts {
  agentRole?: string;
}

// ─────────────────────────────────────────────────────────────
// Compression
// ─────────────────────────────────────────────────────────────

export interface VideoCompressConfig {
  maxWidth?: number;
  maxHeight?: number;
  fps?: number;
  quality?: number; // 0.0 - 1.0
  format?: "webp" | "jpeg" | "mp4";
}

export interface AudioCompressConfig {
  sampleRate?: number;
  channels?: number;
  bitrate?: number; // kbps
  format?: "mp3" | "ogg" | "wav";
}

export interface ImageCompressConfig {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.0 - 1.0
  format?: "webp" | "jpeg" | "png";
}

export interface CompressedVideo {
  ref: string; // URL / path / blob key
  width: number;
  height: number;
  durationMs: number;
  format: string;
  sizeBytes: number;
}

export interface CompressedAudio {
  ref: string;
  durationMs: number;
  sampleRate: number;
  format: string;
  sizeBytes: number;
}

export interface CompressedImage {
  ref: string;
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
}

export interface CompressionService {
  compressVideo: (frames: ImageData[], config?: VideoCompressConfig) => Promise<CompressedVideo>;

  compressAudio: (buffer: AudioBuffer, config?: AudioCompressConfig) => Promise<CompressedAudio>;

  compressImage: (image: ImageData, config?: ImageCompressConfig) => Promise<CompressedImage>;
}
