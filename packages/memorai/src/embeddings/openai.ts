import type { EmbeddingService } from '../types.js'

/**
 * OpenAI API embedding service.
 * Uses the `text-embedding-3-small` model by default.
 * Requires an OpenAI API key.
 */
export class OpenAIEmbeddingService implements EmbeddingService {
  readonly dimension = 1536 // text-embedding-3-small

  constructor(
    private readonly opts: {
      apiKey: string
      baseURL?: string
      model?: string
      dimension?: number
    },
  ) {
    if (opts.dimension) {
      ;(this as { dimension: number }).dimension = opts.dimension
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(
      `${this.opts.baseURL ?? 'https://api.openai.com/v1'}/embeddings`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.opts.model ?? 'text-embedding-3-small',
          input: text,
          dimensions: this.dimension,
        }),
      },
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI embedding failed: ${response.status} ${error}`)
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>
    }
    return data.data[0].embedding
  }
}
