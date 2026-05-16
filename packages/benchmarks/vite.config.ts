import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
  },
  fmt: {
    ignorePatterns: ["datasets", "results"],
  },
});
