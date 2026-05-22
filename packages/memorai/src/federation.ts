import type {
  MemoryEvent,
  MemoryNode,
  MemorySlice,
  SubscribeFilter,
  SubscriptionHandle,
} from "./types.js";

/**
 * In-memory subscription registry. Memorai keeps one instance and
 * routes post-write notifications through it.
 */
export class SubscriptionRegistry {
  private subs = new Map<number, { filter: SubscribeFilter; callback: (node: MemoryNode) => void }>();
  private nextId = 0;

  subscribe(filter: SubscribeFilter, callback: (node: MemoryNode) => void): SubscriptionHandle {
    const id = this.nextId++;
    this.subs.set(id, { filter, callback });
    return {
      unsubscribe: () => {
        this.subs.delete(id);
      },
    };
  }

  notify(node: MemoryNode): void {
    for (const [, sub] of this.subs) {
      if (matchesFilter(sub.filter, node)) {
        try {
          sub.callback(node);
        } catch {
          // Subscriber errors should not break the write pipeline.
        }
      }
    }
  }

  clear(): void {
    this.subs.clear();
  }

  get size(): number {
    return this.subs.size;
  }
}

function matchesFilter(filter: SubscribeFilter, node: MemoryNode): boolean {
  if (filter.actor !== undefined && node.actor !== filter.actor) return false;
  if (filter.minSalience !== undefined && (node.annotations.salienceScore ?? 0) < filter.minSalience)
    return false;
  if (filter.tags !== undefined && filter.tags.length > 0) {
    const nodeTags = node.annotations.tags ?? [];
    const hasTag = filter.tags.some((t) => nodeTags.includes(t));
    if (!hasTag) return false;
  }
  if (filter.textContains !== undefined) {
    const text =
      node.raw.text ??
      (typeof node.raw.content === "object" && "text" in node.raw.content
        ? String(node.raw.content.text ?? "")
        : "");
    if (!text.toLowerCase().includes(filter.textContains.toLowerCase())) return false;
  }
  if (filter.predicate !== undefined && !filter.predicate(node)) return false;
  return true;
}

/**
 * Cross-instance memory federation primitive.
 *
 * Enables multi-agent / multi-device memory sharing by serializing
 * memory slices that can be exported from one Memorai instance and
 * imported into another. Each slice carries provenance metadata so
 * the importing instance knows where the memories originated.
 *
 * Usage:
 * ```ts
 * // Agent A exports a slice
 * const slice = federation.exportSlice(memory, { since: Date.now() - 86400000 });
 * // Serialize over the wire
 * const json = JSON.stringify(slice);
 * // Agent B imports it
 * const imported = federation.importSlice(JSON.parse(json));
 * await memory.mergeSlice(imported);
 * ```
 */
export class MemoryFederation {
  /**
   * Extract a serializable memory slice from a Memorai instance.
   */
  async exportSlice(opts: {
    sourceAgentId: string;
    listNodes: (opts: { since?: number; limit?: number }) => Promise<MemoryNode[]>;
    listEvents?: (opts: { since?: number; limit?: number }) => Promise<MemoryEvent[]>;
    since?: number;
    limit?: number;
  }): Promise<MemorySlice> {
    const [nodes, events] = await Promise.all([
      opts.listNodes({ since: opts.since, limit: opts.limit }),
      opts.listEvents ? opts.listEvents({ since: opts.since, limit: opts.limit }) : Promise.resolve([]),
    ]);
    return {
      sourceAgentId: opts.sourceAgentId,
      exportedAt: Date.now(),
      nodes,
      events: events.length > 0 ? events : undefined,
    };
  }

  /**
   * Prepare an imported slice for merging. Returns nodes with their
   * IDs remapped (to avoid collisions) and source provenance attached.
   */
  prepareImport(slice: MemorySlice): {
    nodes: MemoryNode[];
    events?: MemoryEvent[];
    idMap: Map<string, string>;
  } {
    const idMap = new Map<string, string>();
    const nodes: MemoryNode[] = [];

    for (const node of slice.nodes) {
      const newId = this.generateId();
      idMap.set(node.id, newId);
      nodes.push({
        ...node,
        id: newId,
        meta: {
          ...node.meta,
          sourceAgent: slice.sourceAgentId,
          importedAt: Date.now(),
        },
      });
    }

    // Rewrite parent/children references using the id map
    for (const node of nodes) {
      if (node.parentId) {
        node.parentId = idMap.get(node.parentId) ?? node.parentId;
      }
      if (node.childrenIds) {
        node.childrenIds = node.childrenIds.map((id) => idMap.get(id) ?? id);
      }
    }

    let events: MemoryEvent[] | undefined;
    if (slice.events) {
      events = slice.events.map((ev) => ({
        ...ev,
        sourceNodeIds: ev.sourceNodeIds.map((id) => idMap.get(id) ?? id),
        relatedEventIds: ev.relatedEventIds?.map((id) => idMap.get(id) ?? id),
      }));
    }

    return { nodes, events, idMap };
  }

  private generateId(): string {
    return `fed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
