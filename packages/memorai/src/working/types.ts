// Working memory — fast, typed scratchpad for short-lived agent state.
//
// Distinct from the LTM (MemoryNode + MemoryEvent stack) Memorai already
// manages: working memory is not extracted, not embedded, not evolved.
// Agents use it for the kind of state they need *right now* — current task,
// pending tool calls, in-flight beliefs — that's irrelevant the moment the
// task ends.
//
// Optional TTL on every entry. Aged entries can be enumerated for promotion
// into LTM ("should I remember this?") via a self-reflection pass.

export interface WorkingMemoryEntry<T = unknown> {
  key: string;
  value: T;
  /** Unix ms when the entry was created. */
  createdAt: number;
  /** Unix ms when the entry was last updated. */
  updatedAt: number;
  /**
   * Unix ms when the entry should expire. Undefined = persistent until
   * explicitly deleted or `clear()` is called.
   */
  expiresAt?: number;
}

export interface SetOptions {
  /** Time-to-live in milliseconds. Omit for no expiry. */
  ttlMs?: number;
}

/**
 * Pluggable working-memory backend.
 *
 * Implementations are free to be in-memory (the default), persistent across
 * agent restarts (SQLite/IndexedDB), or distributed (Redis). The interface
 * stays narrow — Memorai never assumes anything beyond key/value lookup
 * with optional expiry.
 *
 * Get/set are JSON-serializable values; deep clone is the caller's
 * responsibility if needed.
 */
export interface WorkingMemory {
  set<T>(key: string, value: T, opts?: SetOptions): Promise<void>;
  get<T = unknown>(key: string): Promise<T | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  /** Snapshot of all live (non-expired) entries keyed by their key. */
  snapshot(): Promise<Record<string, unknown>>;
  /**
   * Entries that have been around longer than `minAgeMs`. Useful for
   * implementing a "should this be promoted to LTM?" reflection pass —
   * working memory that's been around a while is more likely to deserve
   * persistence.
   */
  agedEntries(minAgeMs: number): Promise<WorkingMemoryEntry[]>;
  size(): Promise<number>;
}
