import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  base: "./",
  resolve: {
    alias: {
      "@openvibecoaster/core": path.resolve(
        import.meta.dirname,
        "../../packages/core/src/index.ts",
      ),
      "@openvibecoaster/generator": path.resolve(
        import.meta.dirname,
        "../../packages/generator/src/index.ts",
      ),
      "@openvibecoaster/simulator": path.resolve(
        import.meta.dirname,
        "../../packages/simulator/src/index.ts",
      ),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
