import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: path.resolve(__dirname, "src/background.ts"),
        content: path.resolve(__dirname, "src/content.ts"),
        popup: path.resolve(__dirname, "src/popup.html"),
        search: path.resolve(__dirname, "src/search.html"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background" || chunk.name === "content") {
            return "[name].js";
          }
          return "[name]/[name].js";
        },
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name].[ext]",
      },
      external: ["@xenova/transformers", "usearch", "hnswlib-node", "hnswlib-wasm"],
    },
  },
  resolve: {
    alias: {
      "memorai": path.resolve(__dirname, "../../packages/memorai/src/index.ts"),
    },
  },
});
