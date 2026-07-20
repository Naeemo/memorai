import type { RerankDoc, RerankResult, RerankerService } from "./types.js";
import { TransformersReranker, loadXenovaCrossEncoder } from "./reranker-transformers.js";

export type AutoRerankerBackend = "auto" | "transformers" | "none";

export interface AutoRerankerOptions {
  /**
   * Cross-encoder model name. Default "Xenova/ms-marco-MiniLM-L-6-v2".
   * Ignored when `backend` is "none".
   */
  model?: string;
  /**
   * Preferred backend. `"auto"` (default) uses `TransformersReranker` when
   * `@xenova/transformers` is installed; otherwise disables reranking.
   */
  backend?: AutoRerankerBackend;
}

/**
 * Reranker that auto-selects the best available local cross-encoder backend.
 *
 * Use this when you want precision reranking without manually wiring
 * `@xenova/transformers`. The first `rerank()` call attempts to load the
 * transformer pipeline; on failure it degrades to a pass-through that returns
 * the input order unchanged.
 *
 * Example:
 * ```ts
 * const memory = new Memorai({
 *   storage,
 *   embedding,
 *   reranker: new AutoReranker(), // auto-detects @xenova/transformers
 * });
 * ```
 */
export class AutoReranker implements RerankerService {
  private inner?: Promise<RerankerService>;

  constructor(private readonly opts: AutoRerankerOptions = {}) {}

  private ensure(): Promise<RerankerService> {
    if (!this.inner) {
      this.inner = this.loadBackend();
    }
    return this.inner;
  }

  async rerank(query: string, docs: RerankDoc[], topK: number): Promise<RerankResult[]> {
    const reranker = await this.ensure();
    return reranker.rerank(query, docs, topK);
  }

  /** The backend that was actually selected. Undefined until first use. */
  get backendName(): string | undefined {
    if (!this.inner) return undefined;
    // Can't inspect a promise synchronously; expose via a resolved marker.
    return this.resolvedBackend;
  }
  private resolvedBackend?: string;

  private async loadBackend(): Promise<RerankerService> {
    const backend = this.opts.backend ?? "auto";
    const model = this.opts.model ?? "Xenova/ms-marco-MiniLM-L-6-v2";

    if (backend === "none") {
      this.resolvedBackend = "none";
      return new PassThroughReranker();
    }

    try {
      const score = await loadXenovaCrossEncoder(model);
      this.resolvedBackend = "transformers";
      return new TransformersReranker({ score });
    } catch {
      this.resolvedBackend = "none";
      return new PassThroughReranker();
    }
  }
}

/** No-op reranker used when no cross-encoder backend is available. */
class PassThroughReranker implements RerankerService {
  async rerank(_query: string, _docs: RerankDoc[], _topK: number): Promise<RerankResult[]> {
    // Return empty so Memorai.applyReranker falls back to the fused list.
    return [];
  }
}
