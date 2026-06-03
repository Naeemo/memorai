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
        popup: path.resolve(__dirname, "src/popup/index.html"),
        search: path.resolve(__dirname, "src/search/index.html"),
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
    },
  },
  resolve: {
    alias: {
      "memorai": path.resolve(__dirname, "../../memorai/src/index.ts"),
    },
  },
});
