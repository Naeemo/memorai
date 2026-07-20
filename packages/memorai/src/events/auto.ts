import type { EventStore } from "../types.js";
import type { VectorIndex } from "../vector/types.js";
import { IndexedDBEventStore } from "./indexeddb-store.js";
import { InMemoryEventStore } from "./store.js";

/**
 * Pick the best default `EventStore` for the current runtime.
 *
 * - Browser: `IndexedDBEventStore` persists MemoryEvents across sessions.
 * - Node.js / Bun / Deno / tests: `InMemoryEventStore` is kept because a
 *   SQLite backend requires an explicit database file/handle that callers
 *   should opt into via `MemoraiConfig.events`.
 */
export function createDefaultEventStore(opts: {
  vectorIndex?: VectorIndex;
  namespace?: string;
} = {}): EventStore {
  if (typeof indexedDB !== "undefined") {
    return new IndexedDBEventStore({
      dbName: "memorai-events",
      vectorIndex: opts.vectorIndex,
    });
  }
  return new InMemoryEventStore({
    vectorIndex: opts.vectorIndex,
    namespace: opts.namespace,
  });
}
