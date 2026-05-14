// Core type definitions for Memorai
// Based on StreamingClaw StreamingMemory architecture

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

export interface HierarchyLink {
  level: MemoryLevel;
  parentId?: string;
  childrenIds?: string[];
  mergedFrom?: string[];
}

export interface MemoryMeta {
  sourceAgent: string;
  agentRole: string;
  writeContext?: string;
  lastAccessed?: number;
  accessCount: number;
}

export interface MemoryNode {
  id: string;
  timestamp: number; // Unix ms — when this memory ends
  duration: number; // Duration in ms
  payload: MemoryPayload;
  hierarchy: HierarchyLink;
  meta: MemoryMeta;
}

// ─────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────

export interface WritePayload {
  timestamp?: number;
  duration?: number;
  payload: Omit<MemoryPayload, "embedding"> & { embedding?: number[] };
  hierarchy?: Partial<HierarchyLink>;
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
  dimension: number;
}

// ─────────────────────────────────────────────────────────────
// Evolution
// ─────────────────────────────────────────────────────────────

export interface EvolutionConfig {
  semanticMergeThreshold: number; // default: 0.85
  temporalGapThresholdMs: number; // default: 30000
  sceneSimilarityThreshold: number; // default: 0.80
  eventTimeWindowMs: number; // default: 300000
  autoEvolveIntervalMs: number; // default: 60000
  stmMaxSize: number; // default: 1000
}

// ─────────────────────────────────────────────────────────────
// Retrieval
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
  role: "reasoning" | "proactive" | "custom";
  writePolicy: WritePolicy;
  readPolicy: ReadPolicy;
}

// ─────────────────────────────────────────────────────────────
// Main Config
// ─────────────────────────────────────────────────────────────

export interface MemoraiConfig {
  storage: StorageAdapter;
  embedding: EmbeddingService;
  compression?: CompressionService;
  evolution?: Partial<EvolutionConfig>;
  agentProfile?: AgentMemoryProfile;
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
