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
