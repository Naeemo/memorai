import type { Memorai, Event } from "memorai";

/**
 * Check whether an event has already been imported.
 * Uses the deterministic `chatgpt-msg:{id}` event id for lookup.
 */
export async function eventExists(mem: Memorai, event: Event): Promise<boolean> {
  if (!event.id) return false;

  try {
    const result = await mem.recall(event.id, { topK: 1, level: "segment" });
    return result.memories.some((m) => m.id === event.id);
  } catch {
    return false;
  }
}
