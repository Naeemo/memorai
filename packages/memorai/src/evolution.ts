import { cosineSimilarity, generateId } from './utils.js'
import type { EvolutionConfig, MemoryNode, StorageAdapter } from './types.js'

const DEFAULT_CONFIG: EvolutionConfig = {
  semanticMergeThreshold: 0.85,
  temporalGapThresholdMs: 30000,
  sceneSimilarityThreshold: 0.8,
  eventTimeWindowMs: 300000,
  autoEvolveIntervalMs: 60000,
  stmMaxSize: 1000,
}

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
 *   semantic + temporal compatibility exceeds the threshold.
 *   Otherwise a new atomic action is created that wraps the segment.
 *
 * Level 2 (periodic or manual evolve()):
 *   Atomic actions are aggregated into events based on scene similarity.
 *   Events that already exist are updated when new atomic actions belong.
 */
export class EvolutionEngine {
  private readonly config: EvolutionConfig

  constructor(
    private readonly storage: StorageAdapter,
    partialConfig?: Partial<EvolutionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...partialConfig }
  }

  /**
   * Level 1 — process a raw segment right after it has been persisted.
   *
   * Mutates the segment's `hierarchy.parentId` and may create / update an
   * atomic-action node in storage.  All changes are written via `batchPut`.
   */
  async processSegment(segment: MemoryNode): Promise<void> {
    const merged = await this.tryMergeIntoAtomicAction(segment)
    if (merged) {
      return
    }

    // No compatible atomic action → create a new one
    await this.createAtomicAction(segment)
  }

  /**
   * Level 2 — aggregate atomic actions into events.
   *
   * Scans recent atomic actions and groups scene-similar, temporally
   * contiguous ones into events.  Existing events are updated when new
   * children arrive.
   */
  async evolve(): Promise<void> {
    const all = await this.storage.listAll({ level: 'atomic_action' })

    // Update existing events whose children have changed
    const withParent = all.filter((aa) => aa.hierarchy.parentId)
    for (const aa of withParent) {
      const event = await this.storage.get(aa.hierarchy.parentId!)
      if (!event) continue
      await this.updateEventWithChild(event, aa)
    }

    // Aggregate orphaned atomic actions into new or existing events
    const orphaned = all.filter((aa) => !aa.hierarchy.parentId)
    for (const aa of orphaned) {
      await this.tryAggregateToEvent(aa)
    }
  }

  // ─── Level 1 internals ───

  private async tryMergeIntoAtomicAction(
    segment: MemoryNode,
  ): Promise<boolean> {
    // Find recent atomic actions within the temporal gap threshold
    const candidates = await this.storage.queryByTimeRange(
      segment.timestamp - this.config.temporalGapThresholdMs,
      segment.timestamp,
      { level: 'atomic_action', orderBy: 'timestamp', order: 'desc' },
    )

    let bestMatch: MemoryNode | null = null
    let bestScore = 0

    for (const candidate of candidates) {
      if (!candidate.payload.embedding || !segment.payload.embedding) continue

      const timeGap = Math.abs(segment.timestamp - candidate.timestamp)
      const semanticScore = cosineSimilarity(
        segment.payload.embedding,
        candidate.payload.embedding,
      )
      const temporalFactor = Math.max(
        0,
        1 - timeGap / this.config.temporalGapThresholdMs,
      )
      const compat = 0.7 * semanticScore + 0.3 * temporalFactor

      if (compat > bestScore) {
        bestScore = compat
        bestMatch = candidate
      }
    }

    if (bestMatch && bestScore >= this.config.semanticMergeThreshold) {
      await this.mergeSegmentIntoAtomicAction(bestMatch, segment)
      return true
    }

    return false
  }

  private async mergeSegmentIntoAtomicAction(
    atomicAction: MemoryNode,
    segment: MemoryNode,
  ): Promise<void> {
    // Build a new payload object so we don't mutate shared references
    const oldPayload = atomicAction.payload
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
          ? (() => {
              const w1 = Math.max(atomicAction.duration, 1)
              const w2 = Math.max(segment.duration, 1)
              const total = w1 + w2
              return oldPayload.embedding.map(
                (v, i) => (v * w1 + segment.payload.embedding![i] * w2) / total,
              )
            })()
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...segment.payload.tags])],
      modality: [
        ...new Set([...oldPayload.modality, ...segment.payload.modality]),
      ],
      salienceScore: Math.max(
        oldPayload.salienceScore,
        segment.payload.salienceScore,
      ),
    }

    // Hierarchy: add segment as child
    const children = atomicAction.hierarchy.childrenIds ?? []
    atomicAction.hierarchy.childrenIds = [...children, segment.id]

    // Temporal bounds
    atomicAction.duration =
      (atomicAction.duration || 0) + (segment.duration || 0)
    atomicAction.timestamp = Math.max(atomicAction.timestamp, segment.timestamp)

    // Link segment upward
    segment.hierarchy.parentId = atomicAction.id

    await this.storage.batchPut([atomicAction, segment])
  }

  private async createAtomicAction(segment: MemoryNode): Promise<void> {
    const atomicAction: MemoryNode = {
      id: generateId(),
      timestamp: segment.timestamp,
      duration: segment.duration,
      payload: { ...segment.payload },
      hierarchy: {
        level: 'atomic_action',
        parentId: undefined,
        childrenIds: [segment.id],
        mergedFrom: undefined,
      },
      meta: { ...segment.meta, lastAccessed: Date.now() },
    }

    segment.hierarchy.parentId = atomicAction.id
    await this.storage.batchPut([atomicAction, segment])
  }

  // ─── Level 2 internals ───

  private async tryAggregateToEvent(atomicAction: MemoryNode): Promise<void> {
    const candidates = await this.storage.queryByTimeRange(
      atomicAction.timestamp - this.config.eventTimeWindowMs,
      atomicAction.timestamp,
      { level: 'event', orderBy: 'timestamp', order: 'desc' },
    )

    let bestMatch: MemoryNode | null = null
    let bestScore = 0

    for (const candidate of candidates) {
      if (!candidate.payload.embedding || !atomicAction.payload.embedding)
        continue

      const score = cosineSimilarity(
        atomicAction.payload.embedding,
        candidate.payload.embedding,
      )

      if (score > bestScore) {
        bestScore = score
        bestMatch = candidate
      }
    }

    if (bestMatch && bestScore >= this.config.sceneSimilarityThreshold) {
      await this.mergeAtomicActionIntoEvent(bestMatch, atomicAction)
    } else {
      await this.createEvent(atomicAction)
    }
  }

  private async mergeAtomicActionIntoEvent(
    event: MemoryNode,
    atomicAction: MemoryNode,
  ): Promise<void> {
    const oldPayload = event.payload
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
          ? (() => {
              const w1 = Math.max(event.duration, 1)
              const w2 = Math.max(atomicAction.duration, 1)
              const total = w1 + w2
              return oldPayload.embedding.map(
                (v, i) =>
                  (v * w1 + atomicAction.payload.embedding![i] * w2) / total,
              )
            })()
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...atomicAction.payload.tags])],
      modality: [
        ...new Set([...oldPayload.modality, ...atomicAction.payload.modality]),
      ],
      salienceScore: Math.max(
        oldPayload.salienceScore,
        atomicAction.payload.salienceScore,
      ),
    }

    const children = event.hierarchy.childrenIds ?? []
    event.hierarchy.childrenIds = [...children, atomicAction.id]
    event.duration = (event.duration || 0) + (atomicAction.duration || 0)
    event.timestamp = Math.max(event.timestamp, atomicAction.timestamp)

    atomicAction.hierarchy.parentId = event.id
    await this.storage.batchPut([event, atomicAction])
  }

  private async createEvent(atomicAction: MemoryNode): Promise<void> {
    const event: MemoryNode = {
      id: generateId(),
      timestamp: atomicAction.timestamp,
      duration: atomicAction.duration,
      payload: { ...atomicAction.payload },
      hierarchy: {
        level: 'event',
        parentId: undefined,
        childrenIds: [atomicAction.id],
        mergedFrom: undefined,
      },
      meta: { ...atomicAction.meta, lastAccessed: Date.now() },
    }

    atomicAction.hierarchy.parentId = event.id
    await this.storage.batchPut([event, atomicAction])
  }

  private async updateEventWithChild(
    event: MemoryNode,
    atomicAction: MemoryNode,
  ): Promise<void> {
    const children = event.hierarchy.childrenIds ?? []
    if (children.includes(atomicAction.id)) return

    event.hierarchy.childrenIds = [...children, atomicAction.id]
    event.timestamp = Math.max(event.timestamp, atomicAction.timestamp)
    const oldDuration = event.duration || 0
    event.duration = oldDuration + (atomicAction.duration || 0)

    // Merge payload so the event stays semantically representative
    const oldPayload = event.payload
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
          ? (() => {
              const w1 = Math.max(oldDuration, 1)
              const w2 = Math.max(atomicAction.duration, 1)
              const total = w1 + w2
              return oldPayload.embedding.map(
                (v, i) =>
                  (v * w1 + atomicAction.payload.embedding![i] * w2) / total,
              )
            })()
          : oldPayload.embedding,
      tags: [...new Set([...oldPayload.tags, ...atomicAction.payload.tags])],
      modality: [
        ...new Set([...oldPayload.modality, ...atomicAction.payload.modality]),
      ],
      salienceScore: Math.max(
        oldPayload.salienceScore,
        atomicAction.payload.salienceScore,
      ),
    }

    await this.storage.put(event)
  }
}
