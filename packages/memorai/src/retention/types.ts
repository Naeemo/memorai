// Retention policy — decides which memories to forget.
//
// Memorai promises "never forget" at Tier 1 (immutable raw). What it doesn't
// promise is unbounded storage. For lifelong agents, low-value Tier 2/3 has
// to age out — but the Tier 1 raw timeline stays intact and re-annotation
// can resurrect any node when a better extractor appears.
//
// This module defines the scoring + eviction primitives. `Memorai.forget()`
// applies them; the default policy combines salience + recency + access
// frequency into a single retention score.

import type { MemoryNode } from "../types.js";

export interface RetentionContext {
  /** Reference wall-clock in Unix ms. */
  now: number;
}

export interface RetentionPolicy {
  /**
   * Retention score in `[0, 1]`. Higher = keep, lower = candidate for
   * eviction. Implementations are free to fold in any signal: salience,
   * recency, access frequency, agent role, semantic novelty, etc.
   */
  score(node: MemoryNode, ctx: RetentionContext): number;
  /**
   * Whether this node should be evicted now. Typically `score < threshold`
   * gated by a `minAgeMs` floor — fresh memories shouldn't age out before
   * the agent has had a chance to use them.
   */
  shouldEvict(node: MemoryNode, ctx: RetentionContext): boolean;
}

export type ForgetMode = "delete" | "strip";

export interface ForgetOptions {
  /**
   * Policy to apply. Defaults to the `DefaultRetentionPolicy` if Memorai
   * was constructed without an explicit policy.
   */
  policy?: RetentionPolicy;
  /**
   * Eviction mode:
   *   - "delete" (default): full removal from storage. Tier 1 + Tier 2 + Tier 3
   *     are all dropped for the evicted node. Vector index entry removed.
   *   - "strip": keep the `MemoryNode` but clear `annotations` (Tier 2) and
   *     drop from the vector index. The raw timeline (Tier 1) stays — a
   *     future `reAnnotate()` can resurrect this node.
   */
  mode?: ForgetMode;
  /**
   * Scope to a subset of nodes. Defaults to all nodes in storage.
   */
  filter?: (node: MemoryNode) => boolean;
  /**
   * Dry-run — compute counts without actually evicting. Useful for sizing
   * a forgetting pass before committing.
   */
  dryRun?: boolean;
}

export interface ForgetResult {
  scanned: number;
  evicted: number;
  kept: number;
  /** Eviction mode that was applied (echoed for clarity in logs). */
  mode: ForgetMode;
  /** When dryRun was true, the IDs that would have been evicted. */
  wouldEvictIds?: string[];
}
