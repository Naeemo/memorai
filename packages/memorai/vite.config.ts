import { defineConfig } from "vite-plus";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
  },
  optimizeDeps: {
    exclude: ["hnswlib-wasm", "hnswlib-node", "usearch"],
  },
  resolve: {
    alias: {
      "hnswlib-wasm": path.resolve(__dirname, "node_modules/hnswlib-wasm/dist/hnswlib.js"),
    },
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
      "eval/index": "src/eval/index.ts",
    },
    dts: true,
    platform: "neutral",
    sourcemap: true,
    clean: true,
  },
  fmt: {
    ignorePatterns: ["dist", "dist-cjs"],
  },
});
