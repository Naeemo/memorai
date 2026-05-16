import { cosineSimilarity, generateId } from "./utils.js";
import type { EvolutionConfig, MemoryNode, StorageAdapter } from "./types.js";

const DEFAULT_CONFIG: EvolutionConfig = {
  semanticMergeThreshold: 0.85,
  temporalGapThresholdMs: 30000,
  sceneSimilarityThreshold: 0.8,
  eventTimeWindowMs: 300000,
  stmMaxSize: 1000,
  mode: "auto",
  autoTriggers: {
    onWriteCount: 100,
    onIdleMs: 5000,
    onStmFull: true,
    onClose: true,
  },
};

/**
 * Hierarchical Memory Evolution (HME) Engine.
 *
 * StreamingClaw-inspired two-level evolution:
 *
 *   Segment ──► Atomic Action ──► Event
 *     (raw)        (merged)        (abstract)
 *
 * Level 1 (online, on every segment write):
 *   A newly-created segment is merged into an existing atomic action if
 *   semantic + temporal compatibility exceeds the threshold AND both belong
 *   to the same userId.  Otherwise a new atomic action wraps the segment.
 *
 * Level 2 (auto-triggered or manual evolve()):
 *   Atomic actions are aggregated into events based on scene similarity,
 *   again with userId boundaries respected.
 */
export class EvolutionEngine {
  private readonly config: EvolutionConfig;

  constructor(
    private readonly storage: StorageAdapter,
    partialConfig?: Partial<EvolutionConfig>,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...partialConfig,
      autoTriggers: {
        ...DEFAULT_CONFIG.autoTriggers,
        ...(partialConfig?.autoTriggers ?? {}),
      },
    };
  }

  /**
   * Level 1 — process a raw segment right after it has been persisted.
   *
   * Mutates the segment's `parentId` and may create / update an
   * atomic-action node in storage.  All changes are written via `batchPut`.
   */
  async processSegment(segment: MemoryNode): Promise<void> {
    const merged = await this.tryMergeIntoAtomicAction(segment);
    if (merged) {
      return;
    }

    // No compatible atomic action → create a new one
    await this.createAtomicAction(segment);
  }

  /**
   * Level 2 — aggregate atomic actions into events. Scans recent atomic
   * actions and groups scene-similar, temporally-contiguous ones into events.
   * Aggregation respects userId boundaries — a Bob atomic_action will not be
   * folded into an Alice event.
   */
  async evolve(): Promise<void> {
    const all = await this.storage.listAll({ level: "atomic_action" });

    // Update existing events whose children have changed
    const withParent = all.filter((aa) => aa.parentId);
    for (const aa of withParent) {
      const event = await this.storage.get(aa.parentId!);
      if (!event) continue;
      if (!sameUser(event, aa)) continue; // safety net
      await this.updateEventWithChild(event, aa);
    }

    // Aggregate orphaned atomic actions into new or existing events
    const orphaned = all.filter((aa) => !aa.parentId);
    for (const aa of orphaned) {
      await this.tryAggregateToEvent(aa);
    }
  }

  // ─── Level 1 internals ───

  private async tryMergeIntoAtomicAction(segment: MemoryNode): Promise<boolean> {
    const candidates = await this.storage.queryByTimeRange(
      segment.timestamp - this.config.temporalGapThresholdMs,
      segment.timestamp,
      { level: "atomic_action", orderBy: "timestamp", order: "desc" },
    );

    let bestMatch: MemoryNode | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!sameUser(candidate, segment)) continue;
      if (!candidate.payload.embedding || !segment.payload.embedding) continue;

      const timeGap = Math.abs(segment.timestamp - candidate.timestamp);
      const semanticScore = cosineSimilarity(
        segment.payload.embedding,
        candidate.payload.embedding,
      );
      const temporalFactor = Math.max(0, 1 - timeGap / this.config.temporalGapThresholdMs);
      const compat = 0.7 * semanticScore + 0.3 * temporalFactor;

      if (compat > bestScore) {
        bestScore = compat;
        bestMatch = candidate;
      }
    }

    if (bestMatch && bestScore >= this.config.semanticMergeThreshold) {
      await this.mergeSegmentIntoAtomicAction(bestMatch, segment);
      return true;
    }

    return false;
  }

  private async mergeSegmentIntoAtomicAction(
    atomicAction: MemoryNode,
    segment: MemoryNode,
  ): Promise<void> {
    const oldPayload = atomicAction.payload;
    atomicAction.payload = {
      ...oldPayload,
      summary: `${oldPayload.summary}; ${segment.payload.summary}`,
      description: segment.payload.description
        ? oldPayload.description
          ? `${oldPayload.description}; ${segment.payload.description}`
          : segment.payload.description
        : oldPayload.description,
      embedding:
        oldPayload.embedding && segment.payload.embedding
          ? weightedAvg(
              oldPayload.embedding,
              segment.payload.embedding,
              atomicAction.duration,
              segment.duration,
            )
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...segment.payload.tags])],
      modality: [...new Set([...oldPayload.modality, ...segment.payload.modality])],
      salienceScore: Math.max(oldPayload.salienceScore, segment.payload.salienceScore),
    };

    const children = atomicAction.childrenIds ?? [];
    atomicAction.childrenIds = [...children, segment.id];
    atomicAction.duration = (atomicAction.duration || 0) + (segment.duration || 0);
    atomicAction.timestamp = Math.max(atomicAction.timestamp, segment.timestamp);

    // Multi-actor / multi-target: keep the first one set; payload.tags carries the rest.
    if (!atomicAction.actor && segment.actor) atomicAction.actor = segment.actor;
    if (!atomicAction.target && segment.target) atomicAction.target = segment.target;

    segment.parentId = atomicAction.id;

    await this.storage.batchPut([atomicAction, segment]);
  }

  private async createAtomicAction(segment: MemoryNode): Promise<void> {
    const atomicAction: MemoryNode = {
      id: generateId(),
      timestamp: segment.timestamp,
      duration: segment.duration,
      level: "atomic_action",
      childrenIds: [segment.id],
      userId: segment.userId,
      actor: segment.actor,
      target: segment.target,
      payload: { ...segment.payload },
      meta: { ...segment.meta, lastAccessed: Date.now() },
    };

    segment.parentId = atomicAction.id;
    await this.storage.batchPut([atomicAction, segment]);
  }

  // ─── Level 2 internals ───

  private async tryAggregateToEvent(atomicAction: MemoryNode): Promise<void> {
    const candidates = await this.storage.queryByTimeRange(
      atomicAction.timestamp - this.config.eventTimeWindowMs,
      atomicAction.timestamp,
      { level: "event", orderBy: "timestamp", order: "desc" },
    );

    let bestMatch: MemoryNode | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      if (!sameUser(candidate, atomicAction)) continue;
      if (!candidate.payload.embedding || !atomicAction.payload.embedding) continue;

      const score = cosineSimilarity(atomicAction.payload.embedding, candidate.payload.embedding);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestMatch && bestScore >= this.config.sceneSimilarityThreshold) {
      await this.mergeAtomicActionIntoEvent(bestMatch, atomicAction);
    } else {
      await this.createEvent(atomicAction);
    }
  }

  private async mergeAtomicActionIntoEvent(
    event: MemoryNode,
    atomicAction: MemoryNode,
  ): Promise<void> {
    const oldPayload = event.payload;
    event.payload = {
      ...oldPayload,
      summary: `${oldPayload.summary}; ${atomicAction.payload.summary}`,
      description: atomicAction.payload.description
        ? oldPayload.description
          ? `${oldPayload.description}; ${atomicAction.payload.description}`
          : atomicAction.payload.description
        : oldPayload.description,
      embedding:
        oldPayload.embedding && atomicAction.payload.embedding
          ? weightedAvg(
              oldPayload.embedding,
              atomicAction.payload.embedding,
              event.duration,
              atomicAction.duration,
            )
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...atomicAction.payload.tags])],
      modality: [...new Set([...oldPayload.modality, ...atomicAction.payload.modality])],
      salienceScore: Math.max(oldPayload.salienceScore, atomicAction.payload.salienceScore),
    };

    const children = event.childrenIds ?? [];
    event.childrenIds = [...children, atomicAction.id];
    event.duration = (event.duration || 0) + (atomicAction.duration || 0);
    event.timestamp = Math.max(event.timestamp, atomicAction.timestamp);

    if (!event.actor && atomicAction.actor) event.actor = atomicAction.actor;
    if (!event.target && atomicAction.target) event.target = atomicAction.target;

    atomicAction.parentId = event.id;
    await this.storage.batchPut([event, atomicAction]);
  }

  private async createEvent(atomicAction: MemoryNode): Promise<void> {
    const event: MemoryNode = {
      id: generateId(),
      timestamp: atomicAction.timestamp,
      duration: atomicAction.duration,
      level: "event",
      childrenIds: [atomicAction.id],
      userId: atomicAction.userId,
      actor: atomicAction.actor,
      target: atomicAction.target,
      payload: { ...atomicAction.payload },
      meta: { ...atomicAction.meta, lastAccessed: Date.now() },
    };

    atomicAction.parentId = event.id;
    await this.storage.batchPut([event, atomicAction]);
  }

  private async updateEventWithChild(event: MemoryNode, atomicAction: MemoryNode): Promise<void> {
    const children = event.childrenIds ?? [];
    if (children.includes(atomicAction.id)) return;

    event.childrenIds = [...children, atomicAction.id];
    event.timestamp = Math.max(event.timestamp, atomicAction.timestamp);
    const oldDuration = event.duration || 0;
    event.duration = oldDuration + (atomicAction.duration || 0);

    const oldPayload = event.payload;
    event.payload = {
      ...oldPayload,
      summary: `${oldPayload.summary}; ${atomicAction.payload.summary}`,
      description: atomicAction.payload.description
        ? oldPayload.description
          ? `${oldPayload.description}; ${atomicAction.payload.description}`
          : atomicAction.payload.description
        : oldPayload.description,
      embedding:
        oldPayload.embedding && atomicAction.payload.embedding
          ? weightedAvg(
              oldPayload.embedding,
              atomicAction.payload.embedding,
              oldDuration,
              atomicAction.duration,
            )
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...atomicAction.payload.tags])],
      modality: [...new Set([...oldPayload.modality, ...atomicAction.payload.modality])],
      salienceScore: Math.max(oldPayload.salienceScore, atomicAction.payload.salienceScore),
    };

    await this.storage.put(event);
  }
}

function sameUser(a: MemoryNode, b: MemoryNode): boolean {
  return (a.userId ?? "") === (b.userId ?? "");
}

function weightedAvg(
  a: number[],
  b: number[],
  wa: number,
  wb: number,
): number[] {
  const w1 = Math.max(wa, 1);
  const w2 = Math.max(wb, 1);
  const total = w1 + w2;
  return a.map((v, i) => (v * w1 + b[i] * w2) / total);
}
