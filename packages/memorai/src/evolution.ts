import { cosineSimilarity, generateId } from "./utils.js";
import type {
  EvolutionConfig,
  MediaPayload,
  MemoryAnnotations,
  MemoryNode,
  RawContent,
  StorageAdapter,
} from "./types.js";

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
 * Two-level evolution (Segment → Atomic Action → Event). Operates on the
 * three-tier MemoryNode shape:
 *   - Tier 1 `raw` is merged conservatively: parent.raw.text = joined child
 *     texts, parent.raw.media = union, parent.raw.content stays as the first
 *     child's content shape (a synthetic representative).
 *   - Tier 2 `annotations` is merged across children: summary / facts / tags
 *     concatenated and deduped, salience = max, embedding = weighted average.
 *
 * userId boundaries are strictly respected at both levels — a Bob node will
 * never be folded into an Alice atomic_action / event.
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
   * May merge into an existing atomic_action or create a new one.
   */
  async processSegment(segment: MemoryNode): Promise<void> {
    const merged = await this.tryMergeIntoAtomicAction(segment);
    if (merged) return;
    await this.createAtomicAction(segment);
  }

  /**
   * Level 2 — aggregate atomic actions into events. Scans recent atomic
   * actions and groups scene-similar, temporally-contiguous ones into events.
   */
  async evolve(): Promise<void> {
    const all = await this.storage.listAll({ level: "atomic_action" });

    const withParent = all.filter((aa) => aa.parentId);
    for (const aa of withParent) {
      const event = await this.storage.get(aa.parentId!);
      if (!event) continue;
      if (!sameUser(event, aa)) continue;
      await this.updateEventWithChild(event, aa);
    }

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
      if (!candidate.annotations.embedding || !segment.annotations.embedding) continue;

      const timeGap = Math.abs(segment.timestamp - candidate.timestamp);
      const semanticScore = cosineSimilarity(
        segment.annotations.embedding,
        candidate.annotations.embedding,
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
    atomicAction.raw = mergeRaw(atomicAction.raw, segment.raw);
    atomicAction.annotations = mergeAnnotations(
      atomicAction.annotations,
      segment.annotations,
      atomicAction.duration,
      segment.duration,
    );

    const children = atomicAction.childrenIds ?? [];
    atomicAction.childrenIds = [...children, segment.id];
    atomicAction.duration = (atomicAction.duration || 0) + (segment.duration || 0);
    atomicAction.timestamp = Math.max(atomicAction.timestamp, segment.timestamp);

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
      raw: { ...segment.raw },
      annotations: { ...segment.annotations },
      annotatedAt: segment.annotatedAt,
      annotationVersion: segment.annotationVersion,
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
      if (!candidate.annotations.embedding || !atomicAction.annotations.embedding) continue;

      const score = cosineSimilarity(
        atomicAction.annotations.embedding,
        candidate.annotations.embedding,
      );

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
    event.raw = mergeRaw(event.raw, atomicAction.raw);
    event.annotations = mergeAnnotations(
      event.annotations,
      atomicAction.annotations,
      event.duration,
      atomicAction.duration,
    );

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
      raw: { ...atomicAction.raw },
      annotations: { ...atomicAction.annotations },
      annotatedAt: atomicAction.annotatedAt,
      annotationVersion: atomicAction.annotationVersion,
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

    event.raw = mergeRaw(event.raw, atomicAction.raw);
    event.annotations = mergeAnnotations(
      event.annotations,
      atomicAction.annotations,
      oldDuration,
      atomicAction.duration,
    );

    await this.storage.put(event);
  }
}

// ─── Helpers ───

function sameUser(a: MemoryNode, b: MemoryNode): boolean {
  return (a.userId ?? "") === (b.userId ?? "");
}

function weightedAvg(a: number[], b: number[], wa: number, wb: number): number[] {
  const w1 = Math.max(wa, 1);
  const w2 = Math.max(wb, 1);
  const total = w1 + w2;
  return a.map((v, i) => (v * w1 + b[i] * w2) / total);
}

function mergeRaw(parent: RawContent, child: RawContent): RawContent {
  const text =
    parent.text && child.text ? `${parent.text}; ${child.text}` : (parent.text ?? child.text);
  const media = mergeMedia(parent.media, child.media);
  return {
    // The parent's content kind is preserved as the representative shape;
    // it's just a label at this level — the searchable form is `text`.
    content: parent.content,
    text,
    media,
  };
}

function mergeMedia(
  a: MediaPayload | undefined,
  b: MediaPayload | undefined,
): MediaPayload | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return {
    frames: [...(a.frames ?? []), ...(b.frames ?? [])],
    audio: a.audio ?? b.audio,
    video: a.video ?? b.video,
  };
}

function mergeAnnotations(
  parent: MemoryAnnotations,
  child: MemoryAnnotations,
  parentDuration: number,
  childDuration: number,
): MemoryAnnotations {
  const summary =
    parent.summary && child.summary
      ? `${parent.summary}; ${child.summary}`
      : (parent.summary ?? child.summary);

  const description =
    parent.description && child.description
      ? `${parent.description}; ${child.description}`
      : (parent.description ?? child.description);

  const embedding =
    parent.embedding && child.embedding
      ? weightedAvg(parent.embedding, child.embedding, parentDuration, childDuration)
      : (parent.embedding ?? child.embedding);

  const facts = mergeStringArrays(parent.facts, child.facts);
  const triples =
    parent.triples || child.triples
      ? [...(parent.triples ?? []), ...(child.triples ?? [])]
      : undefined;

  const tags = [...new Set([...parent.tags, ...child.tags])];
  const modality = [...new Set([...parent.modality, ...child.modality])];
  const salienceScore = Math.max(parent.salienceScore, child.salienceScore);

  return {
    ...parent,
    summary,
    facts,
    description,
    embedding,
    tags,
    modality,
    salienceScore,
    triples,
  };
}

function mergeStringArrays(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
