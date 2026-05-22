/**
 * Embedding quantization — reduce memory footprint of vector indexes.
 *
 * Full f32 embeddings at 1536 dims × 1M nodes = 6GB. Scalar quantization
 * to i8 cuts this to ~1.5GB with minimal recall loss (<2pp). Product
 * quantization (PQ) goes further for very large corpora.
 *
 * The quantizer is transparent to VectorIndex implementations: callers
 * quantize before upsert and dequantize after query.
 */

export interface EmbeddingQuantizer {
  /** Quantize a single embedding. */
  quantize(embedding: number[]): number[];
  /** Quantize a batch. */
  quantizeBatch(embeddings: number[][]): number[][];
  /** Dequantize back to f32. */
  dequantize(quantized: number[]): number[];
  /** Dequantize a batch. */
  dequantizeBatch(quantized: number[][]): number[][];
  /** Bits per dimension after quantization. */
  bitsPerDim: number;
}

export interface ScalarQuantizerOptions {
  /**
   * Target bit width. 8 = i8 (most common), 16 = f16.
   * Default 8.
   */
  bits?: 8 | 16;
  /**
   * Calibration embeddings used to compute per-dimension min/max.
   * If omitted, a default symmetric range [-1, 1] is used.
   */
  calibrationSet?: number[][];
}

/**
 * Scalar quantizer: maps each dimension independently to an integer
 * range using per-dimension min/max from a calibration set.
 *
 * For 8-bit:
 *   quantized[i] = round((embedding[i] - min[i]) / (max[i] - min[i]) * 255)
 *
 * Returns quantized values as numbers (0-255 for i8). For storage
 * efficiency, callers can cast to Uint8Array.
 *
 * If no calibration set is provided, uses symmetric range [-1, 1]
 * which is appropriate for cosine-normalized embeddings.
 */
export class ScalarQuantizer implements EmbeddingQuantizer {
  readonly bitsPerDim: number;
  private readonly levels: number;
  private readonly min: Float32Array;
  private readonly max: Float32Array;
  private readonly range: Float32Array;

  constructor(opts: ScalarQuantizerOptions = {}) {
    const bits = opts.bits ?? 8;
    this.bitsPerDim = bits;
    this.levels = bits === 16 ? 65535 : 255;

    if (opts.calibrationSet && opts.calibrationSet.length > 0) {
      const dim = opts.calibrationSet[0].length;
      this.min = new Float32Array(dim);
      this.max = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        let minVal = Infinity;
        let maxVal = -Infinity;
        for (const vec of opts.calibrationSet) {
          if (d < vec.length) {
            minVal = Math.min(minVal, vec[d]);
            maxVal = Math.max(maxVal, vec[d]);
          }
        }
        // Add small epsilon to avoid division by zero
        const eps = 1e-8;
        this.min[d] = minVal;
        this.max[d] = maxVal + eps;
      }
    } else {
      // Default symmetric range for normalized embeddings
      this.min = new Float32Array([-1]);
      this.max = new Float32Array([1.0000001]); // +eps
    }
    this.range = new Float32Array(this.max.length);
    for (let i = 0; i < this.max.length; i++) {
      this.range[i] = this.max[i] - this.min[i];
    }
  }

  quantize(embedding: number[]): number[] {
    const out = new Array(embedding.length);
    const usePerDim = this.min.length > 1;
    for (let i = 0; i < embedding.length; i++) {
      const idx = usePerDim ? i : 0;
      const normalized = (embedding[i] - this.min[idx]) / this.range[idx];
      out[i] = Math.max(0, Math.min(this.levels, Math.round(normalized * this.levels)));
    }
    return out;
  }

  quantizeBatch(embeddings: number[][]): number[][] {
    return embeddings.map((e) => this.quantize(e));
  }

  dequantize(quantized: number[]): number[] {
    const out = new Array(quantized.length);
    const usePerDim = this.min.length > 1;
    for (let i = 0; i < quantized.length; i++) {
      const idx = usePerDim ? i : 0;
      out[i] = (quantized[i] / this.levels) * this.range[idx] + this.min[idx];
    }
    return out;
  }

  dequantizeBatch(quantized: number[][]): number[][] {
    return quantized.map((q) => this.dequantize(q));
  }
}

/**
 * No-op quantizer: passes f32 through unchanged.
 * Useful when quantization is opt-in but the pipeline expects
 * a Quantizer interface everywhere.
 */
export class PassthroughQuantizer implements EmbeddingQuantizer {
  readonly bitsPerDim = 32;

  quantize(embedding: number[]): number[] {
    return embedding;
  }
  quantizeBatch(embeddings: number[][]): number[][] {
    return embeddings;
  }
  dequantize(quantized: number[]): number[] {
    return quantized;
  }
  dequantizeBatch(quantized: number[][]): number[][] {
    return quantized;
  }
}
