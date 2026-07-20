import type { Memorai, Event } from "memorai";
import { fetchAllConversations, fetchConversationDetail } from "./api.js";
import { mapConversationToEvents } from "./mapper.js";
import { eventExists } from "./dedup.js";
import type { ImportOptions, ImportProgress } from "./types.js";

/** How many events to write before yielding to the service worker event loop. */
const WRITE_BATCH_SIZE = 10;

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Orchestrates the full ChatGPT → Memorai import.
 *
 * For each conversation: fetch detail → map to events → dedupe → record.
 * Progress is reported via the optional `onProgress` callback.
 */
export async function runImport(
  mem: Memorai,
  token: string,
  opts: ImportOptions = {},
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportProgress> {
  const progress: ImportProgress = {
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    isRunning: true,
  };

  const notify = () => onProgress?.({ ...progress });

  try {
    const conversations = await fetchAllConversations(token, {
      maxConversations: opts.maxConversations,
      signal: opts.signal,
    });

    progress.total = conversations.length;
    notify();

    for (const conv of conversations) {
      if (opts.signal?.aborted) break;

      try {
        const detail = await fetchConversationDetail(token, conv.id, opts.signal);
        const events = mapConversationToEvents(detail, conv, { since: opts.since });

        // Process events in small batches so the service worker stays responsive.
        for (let i = 0; i < events.length; i += WRITE_BATCH_SIZE) {
          if (opts.signal?.aborted) break;

          const batch = events.slice(i, i + WRITE_BATCH_SIZE);
          for (const event of batch) {
            if (await eventExists(mem, event)) {
              progress.skipped++;
              continue;
            }
            await mem.recordEvent(event).nodes;
          }

          // Yield between batches to avoid blocking the event loop.
          if (i + WRITE_BATCH_SIZE < events.length) {
            await yieldToEventLoop();
          }
        }

        progress.completed++;
      } catch (err) {
        progress.failed++;
        console.error(`[Memorai Importer] conversation ${conv.id} failed:`, err);
      }

      notify();
    }

    progress.isRunning = false;
    notify();
    return progress;
  } catch (err) {
    progress.isRunning = false;
    progress.error = err instanceof Error ? err.message : String(err);
    notify();
    throw err;
  }
}
