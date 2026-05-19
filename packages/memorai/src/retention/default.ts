import type { MemoryNode } from "../types.js";
import type { RetentionContext, RetentionPolicy } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DefaultRetentionPolicyOptions {
  /** Below this retention score → evict. Default 0.3. */
  threshold?: number;
  /**
   * Minimum age before a node is eligible for eviction. Default 24h.
   * Fresh memories aren't dropped before the agent has used them.
   */
  minAgeMs?: number;
  /** Recency exponential-decay half-life. Default 14 days. */
  recencyHalfLifeMs?: number;
  /**
   * Access count that maps to full retention credit. Default 50 —
   * accessed 50+ times → full access weight; logarithmic curve below.
   */
  accessSaturation?: number;
  /** Component weights. Must sum to 1 (caller's responsibility). */
  weights?: {
    salience?: number;
    recency?: number;
    access?: number;
  };
}

/**
 * Default retention policy:
 *
 *     retention = 0.5·salience + 0.3·recency + 0.2·access
 *
 *   - salience  → `node.annotations.salienceScore` (already in [0, 1])
 *   - recency   → `exp(-ageMs / halfLife)` — full credit at age 0, half at
 *                 14 days, ≈0 past two months
 *   - access    → `log(1+accessCount) / log(1+saturation)` — diminishing
 *                 returns, full credit at 50 accesses
 *
 * Evict when `retention < threshold` AND `ageMs > minAgeMs`. The age floor
 * prevents fresh writes from being dropped before they've had a chance to
 * accrue access frequency.
 */
export class DefaultRetentionPolicy implements RetentionPolicy {
  private readonly threshold: number;
  private readonly minAgeMs: number;
  private readonly recencyHalfLifeMs: number;
  private readonly accessSaturation: number;
  private readonly w: { salience: number; recency: number; access: number };

  constructor(opts: DefaultRetentionPolicyOptions = {}) {
    this.threshold = opts.threshold ?? 0.3;
    this.minAgeMs = opts.minAgeMs ?? DAY_MS;
    this.recencyHalfLifeMs = opts.recencyHalfLifeMs ?? 14 * DAY_MS;
    this.accessSaturation = opts.accessSaturation ?? 50;
    this.w = {
      salience: opts.weights?.salience ?? 0.5,
      recency: opts.weights?.recency ?? 0.3,
      access: opts.weights?.access ?? 0.2,
    };
  }

  score(node: MemoryNode, ctx: RetentionContext): number {
    const ageMs = Math.max(0, ctx.now - node.timestamp);
    const recency = Math.exp(-(ageMs / this.recencyHalfLifeMs) * Math.LN2);
    const accessRaw = Math.log1p(node.meta.accessCount ?? 0);
    const accessMax = Math.log1p(this.accessSaturation);
    const access = accessMax > 0 ? Math.min(1, accessRaw / accessMax) : 0;
    const salience = clamp01(node.annotations.salienceScore);
    return clamp01(this.w.salience * salience + this.w.recency * recency + this.w.access * access);
  }

  shouldEvict(node: MemoryNode, ctx: RetentionContext): boolean {
    const ageMs = ctx.now - node.timestamp;
    if (ageMs < this.minAgeMs) return false;
    return this.score(node, ctx) < this.threshold;
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
