// Utility functions for Memorai

/**
 * Cosine similarity between two vectors.
 * Returns 0.0 if either vector is empty or zero-magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const [i, element] of a.entries()) {
    dot += element * b[i];
    magA += element * element;
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generate a unique ID using crypto.randomUUID when available,
 * otherwise a timestamp + random fallback.
 */
export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute compatibility score between two memory nodes.
 * Combines semantic similarity (embedding cosine) and temporal continuity.
 *
 * Score = α * cosine(embA, embB) + β * temporalFactor
 *
 * temporalFactor = 1 - (gap / maxGap), capped at 0
 */
export function compatibilityScore(
  a: { annotations: { embedding?: number[] } },
  b: { annotations: { embedding?: number[] } },
  timeGapMs: number,
  opts: {
    semanticWeight?: number;
    temporalWeight?: number;
    maxTemporalGapMs?: number;
  } = {},
): number {
  const { semanticWeight = 0.7, temporalWeight = 0.3, maxTemporalGapMs = 30000 } = opts;

  let semanticScore = 0;
  if (a.annotations.embedding && b.annotations.embedding) {
    semanticScore = cosineSimilarity(a.annotations.embedding, b.annotations.embedding);
  }

  const temporalFactor = Math.max(0, 1 - timeGapMs / maxTemporalGapMs);

  return semanticWeight * semanticScore + temporalWeight * temporalFactor;
}
