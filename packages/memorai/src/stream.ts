import type { Event, MemoryNode } from "./types.js";
import type { Memorai } from "./index.js";

export interface StreamIngestorOptions {
  /** Maximum events to hold in the internal queue before backpressure. Default 1000. */
  maxQueueDepth?: number;
  /** Number of events to accumulate before flushing. Default 32. */
  batchSize?: number;
  /** Milliseconds between automatic flushes. Default 500. */
  flushIntervalMs?: number;
  /** Called when queue depth crosses 80% of max. */
  onBackpressure?: (depth: number, max: number) => void;
  /** Called when an event is dropped because the queue is full. */
  onDrop?: (event: Event, reason: "queue-full") => void;
  /** Called after each batch is successfully written. */
  onFlush?: (nodes: MemoryNode[]) => void;
}

export interface StreamResult {
  /** Events that were successfully written. */
  written: number;
  /** Events dropped due to backpressure. */
  dropped: number;
}

/**
 * Streaming ingest pipeline with backpressure for high-throughput agents.
 *
 * Observation-heavy agents can produce 50-500 events/sec. The default
 * `recordEvent` API fires extraction + embedding + storage per event,
 * which can't keep up at that rate. `StreamIngestor` batches events,
 * leverages `embedBatch` when available, and signals backpressure so
 * the producer can slow down or shed load.
 *
 * Usage:
 * ```ts
 * const ingestor = new StreamIngestor(memory, { maxQueueDepth: 500 });
 *
 * // Push individual events — returns false when backpressure kicks in.
 * const ok = ingestor.push(event);
 * if (!ok) { /* slow down producer *\/ }
 *
 * // Or stream from an async iterator (e.g. WebSocket, SSE).
 * const result = await ingestor.recordStream(webSocketEvents());
 *
 * // Graceful shutdown.
 * await ingestor.close();
 * ```
 */
export class StreamIngestor {
  private readonly maxQueueDepth: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly onBackpressure?: (depth: number, max: number) => void;
  private readonly onDrop?: (event: Event, reason: "queue-full") => void;
  private readonly onFlush?: (nodes: MemoryNode[]) => void;

  private queue: Event[] = [];
  private processing = false;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private _written = 0;
  private _dropped = 0;

  constructor(
    private readonly memory: Memorai,
    opts: StreamIngestorOptions = {},
  ) {
    this.maxQueueDepth = opts.maxQueueDepth ?? 1000;
    this.batchSize = opts.batchSize ?? 32;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.onBackpressure = opts.onBackpressure;
    this.onDrop = opts.onDrop;
    this.onFlush = opts.onFlush;

    this.timer = setInterval(() => this.tryFlush(), this.flushIntervalMs);
  }

  /** Current queue depth. */
  get depth(): number {
    return this.queue.length;
  }

  /** Total events written since creation. */
  get written(): number {
    return this._written;
  }

  /** Total events dropped since creation. */
  get dropped(): number {
    return this._dropped;
  }

  /**
   * Enqueue a single event. Returns `true` if the queue is healthy
   * (< 80% full), `false` if backpressure is active (>= 80% full).
   * When the queue is at 100% capacity the event is dropped and
   * `onDrop` is called.
   */
  push(event: Event): boolean {
    if (this.closed) {
      this._dropped++;
      return false;
    }

    if (this.queue.length >= this.maxQueueDepth) {
      this._dropped++;
      this.onDrop?.(event, "queue-full");
      return false;
    }

    this.queue.push(event);
    const ratio = this.queue.length / this.maxQueueDepth;

    if (ratio >= 0.8) {
      this.onBackpressure?.(this.queue.length, this.maxQueueDepth);
    }

    // Kick off a flush immediately if we've hit batch size.
    if (!this.processing && this.queue.length >= this.batchSize) {
      this.tryFlush();
    }

    return ratio < 0.8;
  }

  /**
   * Consume events from an async iterable. Automatically flushes at
   * the end. Returns counts of written vs dropped events.
   */
  async recordStream(source: AsyncIterable<Event>): Promise<StreamResult> {
    const startWritten = this._written;
    const startDropped = this._dropped;

    for await (const event of source) {
      this.push(event);
    }

    await this.flush();
    return {
      written: this._written - startWritten,
      dropped: this._dropped - startDropped,
    };
  }

  /**
   * Force-flush any queued events. Returns when the flush completes.
   * Safe to call concurrently — serializes behind the same lock.
   */
  async flush(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      // Wait for any in-flight work to finish.
      await this.inFlight;
      return;
    }
    await this.drain();
  }

  /**
   * Stop accepting new events, flush the remaining queue, and clean up
   * the background timer. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private tryFlush(): void {
    if (this.processing || this.queue.length === 0 || this.closed) return;
    this.inFlight = this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      // Drain the queue even after `closed` is set — close() should flush
      // everything that was accepted before shutdown.
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        if (batch.length === 0) break;

        try {
          const handle = this.memory.recordEvents(batch);
          const nodes = await handle.nodes;
          this._written += batch.length;
          this.onFlush?.(nodes);
        } catch (err) {
          // Batch failed — count as dropped. Don't re-queue to avoid
          // infinite retry loops; callers can inspect `dropped`.
          this._dropped += batch.length;
          // eslint-disable-next-line no-console
          console.error("[StreamIngestor] batch flush failed:", err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
