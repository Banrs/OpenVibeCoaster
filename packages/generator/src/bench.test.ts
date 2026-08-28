import { expect, it } from "vitest";
import { generateCoaster } from "./index";

declare const console: { log(message: string): void };

const intent = {
  schemaVersion: 1 as const,
  generatorVersion: "generator-v1",
  seed: 0,
  mode: "full-auto" as const,
  family: "steel-sitdown-lsm-v1" as const,
  elements: [],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
};
const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ] ?? 0
  );
};

it("runs the deterministic generation benchmark", () => {
  for (const seed of [0xffffffff, 0x12345678, 0x87654321])
    generateCoaster({ ...intent, seed });
  const results = Array.from({ length: 50 }, (_, seed) =>
    generateCoaster({ ...intent, seed }, { samples: 32 }),
  );
  const stage = (
    name: keyof (typeof results)[number]["stageTimings"],
  ): { readonly p50Ms: number; readonly p95Ms: number } => {
    const values = results.map((result) => result.stageTimings[name]);
    return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
  };
  const summary = {
    warmupSeeds: 3,
    seeds: results.length,
    candidatesTested: results.map((result) => result.candidatesTested),
    lmIterations: results.map((result) => result.lmIterations),
    p50Ms: percentile(
      results.map((result) => result.stageTimings.totalMs),
      0.5,
    ),
    p95Ms: percentile(
      results.map((result) => result.stageTimings.totalMs),
      0.95,
    ),
    stages: {
      search: stage("searchMs"),
      solving: stage("solvingMs"),
      compilation: stage("compilationMs"),
      validation: stage("validationMs"),
      total: stage("totalMs"),
      browser: "not-measured-here",
      simulation: "not-measured-here",
      transfer: "not-measured-here",
      frame: "not-measured-here",
    },
    target: {
      p95Ms: 1000,
      met:
        percentile(
          results.map((result) => result.stageTimings.totalMs),
          0.95,
        ) <= 1000,
    },
    feasible: results.every((result) => result.feasible),
  };
  console.log(JSON.stringify(summary));
  console.log(
    `bench: ${summary.seeds} seeds; total p50=${summary.p50Ms.toFixed(3)}ms p95=${summary.p95Ms.toFixed(3)}ms; 1s p95 target=${summary.target.met ? "met" : "not-met"}`,
  );
  expect(summary.seeds).toBeGreaterThanOrEqual(50);
  expect(
    results.every(
      (result) => result.candidatesTested >= 1 && result.candidatesTested <= 48,
    ),
  ).toBe(true);
  expect(
    results.every(
      (result) => result.lmIterations >= 0 && result.lmIterations <= 32,
    ),
  ).toBe(true);
  expect(summary.target.met).toBe(true);
  expect(summary.feasible).toBe(true);
});
