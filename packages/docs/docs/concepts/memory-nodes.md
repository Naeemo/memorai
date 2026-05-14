# Memory Nodes

A **memory node** is the fundamental unit of memory in Memorai. Every write produces one; every retrieval returns a set of them. The shape is intentionally rich so we don't have to convert every modality through a text bottleneck.

## The `MemoryNode` shape

```typescript
interface MemoryNode {
  id: string;                    // Unique identifier
  timestamp: number;             // Unix timestamp (ms) — when this memory ends
  duration: number;              // Duration in ms (for temporal segments)

  // --- Multimodal payload ---
  payload: {
    // Raw / compressed multimodal data (optional, stored by reference)
    media?: {
      frames?: ImageData[];       // Compressed video frames / screenshots
      audio?: AudioBufferRef;     // Audio clip reference
      video?: VideoSegmentRef;    // Video segment reference
    };

    // Semantic representations
    summary: string;              // Textual summary (required) — "what happened"
    description?: string;         // Detailed description — "how it happened"
    embedding?: number[];         // Vector embedding of the semantic content

    // Structured metadata for retrieval & evolution
    tags: string[];               // Extracted tags / entities
    salienceScore: number;        // 0.0–1.0, importance at write time
    modality: ('text' | 'vision' | 'audio' | 'multimodal')[];
  };

  // --- Hierarchical linking ---
  hierarchy: {
    level: 'segment' | 'atomic_action' | 'event';
    parentId?: string;            // For atomic_action → event linking
    childrenIds?: string[];       // For event → atomic_actions
    mergedFrom?: string[];        // IDs of nodes merged into this one
  };

  // --- Cross-agent metadata ---
  meta: {
    sourceAgent: string;          // Which agent created this memory
    agentRole: string;            // Role: 'reasoning' | 'proactive' | 'custom'
    writeContext?: string;        // Context at write time (for traceability)
    lastAccessed?: number;        // Timestamp of last read (for LRU eviction)
    accessCount: number;          // For salience recalculation
  };
}
```

::: tip Key insight
Do **not** force-convert visual information to text. Store the original media reference (or a compressed version) alongside text embeddings. This prevents semantic misalignment and information loss.
:::

## Memory layers

Nodes live in one of two tiers, distinguished by their hierarchy level and by their use:

|                   | **Short-Term Memory (STM)**                  | **Long-Term Memory (LTM)**             |
|-------------------|----------------------------------------------|----------------------------------------|
| **Content**       | Compressed frames, atomic actions, fine-grained | Events, abstract summaries, structured |
| **Granularity**   | High — per-segment / per-action               | Low — aggregated events                |
| **Recency**       | Recent (configurable, e.g., last 5 min)       | Historical                             |
| **Storage**       | Fast access, in-memory or fast backend         | Persistent, compressed                 |
| **Evolution**     | Source material for HME                        | Result of HME                          |
| **Retrieval**     | Direct lookup, reverse temporal                | Indexed, semantic search, salience-ranked |

The boundary between STM and LTM is not a physical separation — it's a hierarchical one. Segments and recent atomic actions function as STM; events function as LTM. The storage adapter holds both.

## A worked example

A browser assistant writes one node per significant page action:

```typescript
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
```

What comes back is a fully populated `MemoryNode`. Behind the scenes, Memorai also kicked off a Level-1 evolution pass — see [Hierarchical Evolution](/concepts/evolution).
