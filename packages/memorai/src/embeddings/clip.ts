import type { EmbeddingService } from "../types.js";

/**
 * CLIP-based cross-modal embedder.
 *
 * Uses `@xenova/transformers` to load a CLIP model that maps both text and
 * images into a shared embedding space. This enables text-to-image retrieval
 * (query with "a red car" and find images whose CLIP embeddings are closest)
 * and image-to-text retrieval (find text passages that describe a given image).
 *
 * `@xenova/transformers` is an optional peer dependency — install separately:
 *   `npm install @xenova/transformers`
 *
 * Usage:
 * ```ts
 * const clip = await CLIPEmbedder.create("Xenova/clip-vit-base-patch32");
 *
 * // Text embedding
 * const textVec = await clip.embed("a photo of a cat");
 *
 * // Image embedding (URL, path, or ImageData)
 * const imageVec = await clip.embedImage("https://example.com/cat.jpg");
 *
 * // Cosine similarity between text and image
 * const sim = cosineSimilarity(textVec, imageVec); // ~0.9 for matching pairs
 * ```
 */
export class CLIPEmbedder implements EmbeddingService {
  private textPipeline: unknown;
  private imagePipeline: unknown;
  private readonly modelName: string;

  private constructor(
    opts: {
      modelName: string;
      textPipeline: unknown;
      imagePipeline: unknown;
    },
  ) {
    this.modelName = opts.modelName;
    this.textPipeline = opts.textPipeline;
    this.imagePipeline = opts.imagePipeline;
  }

  /**
   * Factory that loads the CLIP model and returns a ready-to-use embedder.
   * This is an async constructor because model loading is asynchronous.
   */
  static async create(modelName = "Xenova/clip-vit-base-patch32"): Promise<CLIPEmbedder> {
    let mod: {
      pipeline?: unknown;
    };
    try {
      // @ts-ignore — optional peer dep, resolved at runtime
      mod = (await import(/* @vite-ignore */ "@xenova/transformers")) as {
        pipeline?: unknown;
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CLIPEmbedder: failed to load @xenova/transformers — ${reason}. ` +
          `Install it with: npm install @xenova/transformers`,
      );
    }

    if (typeof mod.pipeline !== "function") {
      throw new Error("CLIPEmbedder: @xenova/transformers.pipeline is not a function");
    }
    const pipelineFn = mod.pipeline as (
      task: string,
      model: string,
    ) => Promise<(input: unknown, opts?: unknown) => Promise<unknown>>;

    const [textPipeline, imagePipeline] = await Promise.all([
      pipelineFn("feature-extraction", modelName),
      pipelineFn("image-feature-extraction", modelName),
    ]);

    return new CLIPEmbedder({ modelName, textPipeline, imagePipeline });
  }

  /** Embed a text string into the CLIP latent space. */
  async embed(text: string): Promise<number[]> {
    const out = (await (this.textPipeline as (input: unknown, opts?: unknown) => Promise<unknown>)(
      text,
      { pooling: "mean", normalize: true },
    )) as { data: number[] };
    // The pipeline returns an object with a `data` Float32Array.
    return Array.from(out.data);
  }

  /** Embed a batch of texts. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  /**
   * Embed an image into the CLIP latent space.
   *
   * Accepts:
   *   - A URL string (http:// or https://)
   *   - A local file path string
   *   - A browser `ImageData` object
   *   - A `Blob` or `File`
   */
  async embedImage(image: string | ImageData | Blob): Promise<number[]> {
    const out = (await (this.imagePipeline as (input: unknown, opts?: unknown) => Promise<unknown>)(
      image,
      { pooling: "mean", normalize: true },
    )) as { data: number[] };
    return Array.from(out.data);
  }

  /** Dimensionality of the CLIP embedding (e.g. 512 for base, 768 for large). */
  get dimension(): number {
    // clip-vit-base-patch32 → 512, clip-vit-large-patch14 → 768
    return this.modelName.includes("large") ? 768 : 512;
  }
}
