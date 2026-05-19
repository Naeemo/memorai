import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
  },
  pack: {
    entry: {
      index: "src/index.ts",
      "storage/index": "src/storage/index.ts",
      "embeddings/index": "src/embeddings/index.ts",
      "vector/index": "src/vector/index.ts",
      "graph/index": "src/graph/index.ts",
      "temporal/index": "src/temporal/index.ts",
      "working/index": "src/working/index.ts",
      "retention/index": "src/retention/index.ts",
    },
    dts: true,
    platform: "neutral",
    sourcemap: true,
    clean: true,
  },
  fmt: {
    ignorePatterns: ["dist"],
  },
});
