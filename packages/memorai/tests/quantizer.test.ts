import { describe, expect, test } from "vitest";
import { PassthroughQuantizer, ScalarQuantizer } from "../src/index.js";

describe("ScalarQuantizer", () => {
  test("8-bit quantization round-trip preserves rank order", () => {
    const q = new ScalarQuantizer({ bits: 8 });
    const original = [0.5, -0.3, 0.9, -0.1];
    const quantized = q.quantize(original);
    const restored = q.dequantize(quantized);

    // Rank order should be preserved
    const originalRanks = original.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const restoredRanks = restored.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    expect(restoredRanks.map((r) => r.i)).toEqual(originalRanks.map((r) => r.i));
  });

  test("8-bit with calibration set uses per-dim min/max", () => {
    const calibration = [
      [0, 10, 100],
      [5, 0, 50],
      [10, 20, 0],
    ];
    const q = new ScalarQuantizer({ bits: 8, calibrationSet: calibration });
    const vec = [5, 10, 50];
    const quantized = q.quantize(vec);

    // All values should be within [0, 255]
    for (const v of quantized) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }

    const restored = q.dequantize(quantized);
    // Should be close to original (within quantization error)
    for (let i = 0; i < vec.length; i++) {
      expect(restored[i]).toBeCloseTo(vec[i], 0);
    }
  });

  test("batch quantize/dequantize", () => {
    const q = new ScalarQuantizer({ bits: 8 });
    const batch = [
      [1, 0, -1],
      [0.5, -0.5, 0],
    ];
    const quantized = q.quantizeBatch(batch);
    expect(quantized.length).toBe(2);
    const restored = q.dequantizeBatch(quantized);
    expect(restored.length).toBe(2);
    expect(restored[0].length).toBe(3);
  });

  test("extreme values clamp to range", () => {
    const q = new ScalarQuantizer({ bits: 8 });
    // Default range is [-1, 1]; values outside should clamp
    const quantized = q.quantize([-2, 0, 2]);
    expect(quantized[0]).toBe(0); // clamped to min
    expect(quantized[1]).toBeGreaterThan(0);
    expect(quantized[2]).toBe(255); // clamped to max
  });

  test("16-bit quantization has finer granularity", () => {
    const q8 = new ScalarQuantizer({ bits: 8 });
    const q16 = new ScalarQuantizer({ bits: 16 });
    const vec = [0.123, -0.456, 0.789];

    const r8 = q8.dequantize(q8.quantize(vec));
    const r16 = q16.dequantize(q16.quantize(vec));

    // 16-bit should be closer to original than 8-bit
    const err8 = vec.reduce((s, v, i) => s + Math.abs(v - r8[i]), 0);
    const err16 = vec.reduce((s, v, i) => s + Math.abs(v - r16[i]), 0);
    expect(err16).toBeLessThan(err8);
  });
});

describe("PassthroughQuantizer", () => {
  test("passes values through unchanged", () => {
    const q = new PassthroughQuantizer();
    const vec = [0.1, -0.2, 0.3];
    expect(q.quantize(vec)).toEqual(vec);
    expect(q.dequantize(vec)).toEqual(vec);
    expect(q.bitsPerDim).toBe(32);
  });

  test("batch passthrough", () => {
    const q = new PassthroughQuantizer();
    const batch = [
      [1, 2],
      [3, 4],
    ];
    expect(q.quantizeBatch(batch)).toEqual(batch);
    expect(q.dequantizeBatch(batch)).toEqual(batch);
  });
});
