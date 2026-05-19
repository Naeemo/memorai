import type { SetOptions, WorkingMemory, WorkingMemoryEntry } from "./types.js";

/**
 * In-memory `WorkingMemory` implementation.
 *
 * Map-backed, fast, single-process. TTL is checked lazily at read time —
 * expired entries are evicted on `get` / `has` / `keys` / `snapshot`, so
 * the cost is paid by the next reader, not by a background timer.
 *
 * For multi-process or persistent scratchpads, implement the `WorkingMemory`
 * interface against your backend of choice (Redis, SQLite, IndexedDB).
 */
export class InMemoryWorkingMemory implements WorkingMemory {
  private entries = new Map<string, WorkingMemoryEntry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    const now = this.now();
    const existing = this.entries.get(key);
    const entry: WorkingMemoryEntry = {
      key,
      value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt: opts.ttlMs !== undefined ? now + opts.ttlMs : undefined,
    };
    this.entries.set(key, entry);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async has(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async keys(): Promise<string[]> {
    this.sweepExpired();
    return [...this.entries.keys()];
  }

  async snapshot(): Promise<Record<string, unknown>> {
    this.sweepExpired();
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.entries) out[k] = v.value;
    return out;
  }

  async agedEntries(minAgeMs: number): Promise<WorkingMemoryEntry[]> {
    const now = this.now();
    const out: WorkingMemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (this.isExpiredAt(entry, now)) continue;
      if (now - entry.createdAt >= minAgeMs) {
        out.push(entry);
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  async size(): Promise<number> {
    this.sweepExpired();
    return this.entries.size;
  }

  // ─── helpers ───

  private isExpired(entry: WorkingMemoryEntry): boolean {
    return this.isExpiredAt(entry, this.now());
  }

  private isExpiredAt(entry: WorkingMemoryEntry, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.isExpiredAt(entry, now)) {
        this.entries.delete(key);
      }
    }
  }
}
