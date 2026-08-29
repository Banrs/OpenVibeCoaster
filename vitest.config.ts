import { defineConfig } from "vitest/config";

import path from "path";
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@openvibecoaster/core": path.resolve(
        import.meta.dirname,
        "packages/core/src/index.ts",
      ),
      "@openvibecoaster/generator": path.resolve(
        import.meta.dirname,
        "packages/generator/src/index.ts",
      ),
      "@openvibecoaster/simulator": path.resolve(
        import.meta.dirname,
        "packages/simulator/src/index.ts",
      ),
    },
  },
  optimizeDeps: {
    exclude: [
      "@openvibecoaster/core",
      "@openvibecoaster/generator",
      "@openvibecoaster/simulator",
    ],
  },
  test: {
    testTimeout: 20000,
    include:
      mode === "bench"
        ? ["packages/generator/src/bench.test.ts"]
        : ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: mode === "bench" ? [] : ["packages/generator/src/bench.test.ts"],
    server: {
      deps: {
        inline: [/@openvibecoaster/],
      },
    },
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: ["**/*.test.ts", "**/dist/**"],
    },
  },
}));
