import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    include:
      mode === "bench"
        ? ["packages/generator/src/bench.test.ts"]
        : ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: mode === "bench" ? [] : ["packages/generator/src/bench.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: ["**/*.test.ts", "**/dist/**"],
    },
  },
}));
