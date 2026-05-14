import { EvolutionEngine } from "./evolution.js";
import { RetrievalEngine } from "./retrieval.js";
import { generateId } from "./utils.js";
import type {
  AgentMemoryProfile,
  CompressionService,
  ListOptions,
  MediaPayload,
  MemoraiConfig,
  MemoryNode,
  RetrievalQuery,
  RetrievalResult,
  WriteOptions,
  WritePayload,
} from "./types.js";

const DEFAULT_AGENT_PROFILE: AgentMemoryProfile = {
  agentId: "default",
  role: "reasoning",
  writePolicy: {
    levels: ["segment", "atomic_action", "event"],
    modalities: ["text", "vision", "audio", "multimodal"],
    salienceBoost: 1,
  },
  readPolicy: {
    defaultLevel: "event",
    defaultTraversal: "reverse",
    timeHorizonMs: 86400000,
  },
};

/**
 * Memorai — the core memory engine.
 *
 * Features:
 * - Write / read multimodal memory nodes
 * - Hierarchical Memory Evolution (HME): segment → atomic_action → event
 * - Pluggable storage, embeddings, retrieval
 * - Cross-agent memory profiles
 * - Background periodic evolution (optional)
 */
export class Memorai {
  private readonly retrieval: RetrievalEngine;
  private readonly evolution: EvolutionEngine;
  private readonly agentProfile: AgentMemoryProfile;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly config: MemoraiConfig) {
    this.retrieval = new RetrievalEngine(config.storage);
    this.evolution = new EvolutionEngine(config.storage, config.evolution);
    this.agentProfile = config.agentProfile ?? DEFAULT_AGENT_PROFILE;

    // Start background evolution loop if configured
    const interval = config.evolution?.autoEvolveIntervalMs;
    if (interval && interval > 0) {
      this.startEvolutionLoop(interval);
    }
  }

  private startEvolutionLoop(intervalMs: number): void {
    const run = () => {
      this.evolution
        .evolve()
        .catch((error: unknown) => {
          console.error("[Memorai] Background evolution failed:", error);
        })
        .finally(() => {
          if (this.timer !== undefined) {
            this.timer = setTimeout(run, intervalMs);
          }
        });
    };
    this.timer = setTimeout(run, intervalMs);
  }

  // ─── Write ───

  /**
   * Store a new memory segment.
   *
   * Internally triggers Level-1 evolution: the segment is either merged
   * into an existing atomic action or promoted to a new atomic action.
   */
  async write(payload: WritePayload, opts: WriteOptions = {}): Promise<MemoryNode> {
    const id = generateId();
    const now = Date.now();
    const profile = this.agentProfile;

    // Validate write policy
    const allowedLevels = profile.writePolicy.levels;
    if (!allowedLevels.includes("segment")) {
      throw new Error(
        `Writing segments not allowed by write policy for agent '${profile.agentId}'`,
      );
    }
    for (const m of payload.payload.modality) {
      if (!profile.writePolicy.modalities.includes(m)) {
        throw new Error(
          `Modality '${m}' not allowed by write policy for agent '${profile.agentId}'`,
        );
      }
    }

    // Generate embedding if needed
    let embedding = payload.payload.embedding;
    if (!opts.skipEmbedding && !embedding && payload.payload.summary) {
      embedding = await this.config.embedding.embed(payload.payload.summary);
    }

    // Apply salience boost
    const boostedSalience = payload.payload.salienceScore * profile.writePolicy.salienceBoost;

    // Compress media if configured
    let media: MediaPayload | undefined = payload.payload.media;
    if (media && this.config.compression) {
      media = await this.compressMedia(media, this.config.compression);
    }

    const segment: MemoryNode = {
      id,
      timestamp: payload.timestamp ?? now,
      duration: payload.duration ?? 0,
      payload: {
        ...payload.payload,
        embedding,
        salienceScore: boostedSalience,
        media,
      },
      hierarchy: {
        level: "segment",
        parentId: payload.hierarchy?.parentId,
        childrenIds: payload.hierarchy?.childrenIds,
        mergedFrom: payload.hierarchy?.mergedFrom,
      },
      meta: {
        sourceAgent: payload.meta?.sourceAgent ?? profile.agentId,
        agentRole: payload.meta?.agentRole ?? profile.role,
        writeContext: payload.meta?.writeContext,
        lastAccessed: now,
        accessCount: 0,
      },
    };

    await this.config.storage.put(segment);

    // Level-1 HME: segment → atomic_action
    await this.evolution.processSegment(segment);

    return segment;
  }

  /**
   * Batch write multiple memory segments.
   */
  async writeBatch(payloads: WritePayload[]): Promise<MemoryNode[]> {
    const nodes: MemoryNode[] = [];
    for (const payload of payloads) {
      nodes.push(await this.write(payload));
    }
    return nodes;
  }

  // ─── Read ───

  /**
   * Retrieve memories matching a query.
   * Defaults to the agent's read policy if not overridden.
   */
  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const mergedQuery: RetrievalQuery = {
      ...query,
      level: query.level ?? this.agentProfile.readPolicy.defaultLevel,
      traversalOrder: query.traversalOrder ?? this.agentProfile.readPolicy.defaultTraversal,
      agentRole: query.agentRole ?? this.agentProfile.role,
    };

    if (mergedQuery.text && !mergedQuery.embedding) {
      mergedQuery.embedding = await this.config.embedding.embed(mergedQuery.text);
    }

    const result = await this.retrieval.retrieve(mergedQuery);

    for (const node of result.nodes) {
      node.meta.lastAccessed = Date.now();
      node.meta.accessCount += 1;
      await this.config.storage.put(node);
    }

    return result;
  }

  /**
   * Get a specific memory node by ID.
   */
  async get(id: string): Promise<MemoryNode | null> {
    const node = await this.config.storage.get(id);
    if (node) {
      node.meta.lastAccessed = Date.now();
      node.meta.accessCount += 1;
      await this.config.storage.put(node);
    }
    return node;
  }

  /**
   * List memories with filtering and pagination.
   */
  async list(opts?: ListOptions): Promise<MemoryNode[]> {
    const { agentRole, limit, offset, ...queryOpts } = opts ?? {};
    let nodes = await this.config.storage.listAll(queryOpts);

    if (agentRole) {
      nodes = nodes.filter((n) => n.meta.agentRole === agentRole);
    }

    // Apply pagination after client-side filtering
    if (limit !== undefined || offset !== undefined) {
      const start = offset ?? 0;
      const end = limit !== undefined ? start + limit : nodes.length;
      nodes = nodes.slice(start, end);
    }

    return nodes;
  }

  // ─── Evolution ───

  /**
   * Manually trigger Level-2 memory evolution (atomic_action → event).
   *
   * This is also run automatically in the background when
   * `autoEvolveIntervalMs` is configured.
   */
  evolve(): Promise<void> {
    return this.evolution.evolve();
  }

  // ─── Management ───

  /**
   * Delete a memory node.
   * If cascade=true, also delete all children recursively.
   */
  async delete(id: string, cascade = false): Promise<void> {
    const children = await this.config.storage.getChildren(id);

    if (cascade) {
      for (const child of children) {
        await this.delete(child.id, true);
      }
    } else {
      // Detach surviving children so they don't reference a deleted parent
      for (const child of children) {
        child.hierarchy.parentId = undefined;
        await this.config.storage.put(child);
      }
    }

    // Remove this node from its parent's childrenIds before deleting
    const node = await this.config.storage.get(id);
    if (node?.hierarchy.parentId) {
      const parent = await this.config.storage.get(node.hierarchy.parentId);
      if (parent?.hierarchy.childrenIds) {
        parent.hierarchy.childrenIds = parent.hierarchy.childrenIds.filter((cid) => cid !== id);
        await this.config.storage.put(parent);
      }
    }

    await this.config.storage.delete(id);
  }

  /**
   * Update a memory node's metadata.
   */
  async update(
    id: string,
    patch: Partial<{
      payload: Partial<MemoryNode["payload"]>;
      hierarchy: Partial<MemoryNode["hierarchy"]>;
      meta: Partial<MemoryNode["meta"]>;
    }>,
  ): Promise<MemoryNode> {
    const node = await this.config.storage.get(id);
    if (!node) throw new Error(`Memory node not found: ${id}`);

    if (patch.payload) {
      node.payload = { ...node.payload, ...patch.payload };
    }
    if (patch.hierarchy) {
      node.hierarchy = { ...node.hierarchy, ...patch.hierarchy };
    }
    if (patch.meta) {
      node.meta = { ...node.meta, ...patch.meta };
    }

    await this.config.storage.put(node);
    return node;
  }

  // ─── Helpers ───

  private async compressMedia(
    media: MediaPayload,
    compression: CompressionService,
  ): Promise<MediaPayload> {
    const compressed: MediaPayload = {};

    if (media.frames) {
      const refs: string[] = [];
      for (const frame of media.frames) {
        if (typeof frame === "string") {
          refs.push(frame);
        } else {
          const imageData =
            typeof ImageData !== "undefined" && frame instanceof ImageData
              ? frame
              : (frame as unknown as ImageData);
          const img = await compression.compressImage(imageData);
          refs.push(img.ref);
        }
      }
      compressed.frames = refs;
    }

    if (media.audio) {
      if (typeof media.audio === "string") {
        compressed.audio = media.audio;
      } else {
        const audio = await compression.compressAudio(media.audio);
        compressed.audio = audio.ref;
      }
    }

    if (media.video) {
      compressed.video = media.video;
    }

    return compressed;
  }

  /**
   * Close all resources (storage, background timers, etc.).
   */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.config.storage.close();
  }
}

// Re-export everything from submodules for convenience
export * from "./types.js";
export * from "./utils.js";
export { IndexedDBAdapter, MemoryAdapter } from "./storage/index.js";
export { OllamaEmbeddingService, OpenAIEmbeddingService } from "./embeddings/index.js";
export { EvolutionEngine } from "./evolution.js";
export { RetrievalEngine } from "./retrieval.js";
export {
  BrowserImageCompressor,
  PassthroughCompressor,
  type CompressionService,
} from "./compression.js";
export { SQLiteAdapter, type SQLiteDatabase, type SQLiteStatement } from "./storage/index.js";
