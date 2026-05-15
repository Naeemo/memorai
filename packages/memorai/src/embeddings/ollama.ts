import type { EmbeddingService } from "../types.js";

/**
 * Ollama local embedding service.
 * Uses Ollama's /api/embeddings endpoint.
 * Default model: 'nomic-embed-text' (768-dim).
 */
export class OllamaEmbeddingService implements EmbeddingService {
  readonly dimension: number;

  constructor(
    private readonly opts: {
      baseURL?: string;
      model?: string;
      dimension?: number;
      batchSize?: number;
    } = {},
  ) {
    this.dimension = opts.dimension ?? 768;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(
      `${this.opts.baseURL ?? "http://localhost:11434"}/api/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model ?? "nomic-embed-text",
          prompt: text,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embedding failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama does not have a native batch embeddings endpoint, so we parallelize
    const batchSize = this.opts.batchSize ?? 8;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const embeddings = await Promise.all(chunk.map((t) => this.embed(t)));
      results.push(...embeddings);
    }
    return results;
  }
}
