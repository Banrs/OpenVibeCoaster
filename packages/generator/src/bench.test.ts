import { expect, it } from "vitest";
import { generateCoaster } from "./index";

declare const console: { log(message: string): void };
const now = (): number =>
  (
    globalThis as unknown as { readonly performance?: { now(): number } }
  ).performance?.now() ?? Date.now();

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
const directedIntent = {
  ...intent,
  mode: "directed" as const,
  elements: [
    {
      id: "station-000",
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    },
  ],
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
  const wallStart = now();
  for (const seed of [0xffffffff, 0x12345678, 0x87654321])
    generateCoaster({ ...intent, seed });
  const results = Array.from({ length: 50 }, (_, seed) =>
    generateCoaster({ ...intent, seed }, { samples: 32 }),
  );
  const nonzeroLm = generateCoaster(
    {
      ...intent,
      seed: 17,
      constraints: [
        { id: "bounded-work", kind: "min-height", target: -1000, hard: true },
      ],
    },
    { samples: 32 },
  );
  const rejection = generateCoaster(
    {
      ...intent,
      seed: 19,
      targets: [{ id: "reject", kind: "end-z", target: 999, hard: true }],
    },
    { samples: 8 },
  );
  const relaxation = generateCoaster({
    ...directedIntent,
    seed: 23,
    targets: [{ id: "relax", kind: "end-z", target: 999, hard: true }],
  });
  const representative = [
    ...results.map((result, seed) => ({
      name: `full-auto-${seed}`,
      seed,
      result,
    })),
    { name: "rejection", seed: 19, result: rejection },
    { name: "nonzero-lm", seed: 17, result: nonzeroLm },
    { name: "relaxation", seed: 23, result: relaxation },
  ];
  const misses = representative
    .filter(({ result }) => result.stageTimings.totalMs > 1000)
    .map(({ name, result }) => ({
      name,
      totalMs: result.stageTimings.totalMs,
    }));
  const stage = (
    name: keyof (typeof results)[number]["stageTimings"],
  ): { readonly p50Ms: number; readonly p95Ms: number } => {
    const values = results.map((result) => result.stageTimings[name]);
    return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
  };
  const summary = {
    warmupSeeds: 3,
    seeds: results.length,
    representative: representative.map(({ name, seed, result }) => ({
      name,
      seed,
      feasible: result.feasible,
      candidatesTested: result.candidatesTested,
      candidateLmIterations: result.candidateLmIterations,
      candidateLmWork: result.candidateLmWork,
      relaxationLmIterations: result.relaxationLmIterations,
      relaxationLmWork: result.relaxationLmWork,
      totalLmWork: result.lmIterations,
      totalMs: result.stageTimings.totalMs,
    })),
    candidatesTested: results.map((result) => result.candidatesTested),
    candidateLmWork: results.map((result) => result.candidateLmWork),
    relaxationLmWork: results.map((result) => result.relaxationLmWork),
    measuredCases: {
      rejection: {
        candidatesTested: rejection.candidatesTested,
        lmIterations: rejection.lmIterations,
        candidateLmWork: rejection.candidateLmWork,
        relaxationLmWork: rejection.relaxationLmWork,
        totalMs: rejection.stageTimings.totalMs,
        rejected: !rejection.feasible,
      },
      nonzeroLm: {
        candidatesTested: nonzeroLm.candidatesTested,
        lmIterations: nonzeroLm.lmIterations,
        candidateLmWork: nonzeroLm.candidateLmWork,
        relaxationLmWork: nonzeroLm.relaxationLmWork,
        totalMs: nonzeroLm.stageTimings.totalMs,
      },
      relaxation: {
        candidatesTested: relaxation.candidatesTested,
        lmIterations: relaxation.lmIterations,
        candidateLmWork: relaxation.candidateLmWork,
        relaxationLmWork: relaxation.relaxationLmWork,
        totalMs: relaxation.stageTimings.totalMs,
        rerun: relaxation.relaxationEvidence.some((item) => item.rerun),
      },
    },
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
      met: misses.length === 0,
      misses,
    },
    feasible: results.every((result) => result.feasible),
    durationMs: now() - wallStart,
  };
  console.log(JSON.stringify(summary));
  console.log(
    `bench: ${summary.seeds} seeds; total p50=${summary.p50Ms.toFixed(3)}ms p95=${summary.p95Ms.toFixed(3)}ms; duration=${summary.durationMs.toFixed(3)}ms; misses=${summary.target.misses.length}; 1s p95 target=${summary.target.met ? "met" : "not-met"}`,
  );
  expect(summary.seeds).toBeGreaterThanOrEqual(50);
  expect(
    results.every(
      (result) => result.candidatesTested >= 1 && result.candidatesTested <= 48,
    ),
  ).toBe(true);
  expect(
    results.every((result) =>
      result.candidateLmIterations.every((value) => value >= 0 && value <= 32),
    ),
  ).toBe(true);
  expect(summary.feasible).toBe(true);
  expect(summary.measuredCases.rejection.rejected).toBe(true);
  expect(summary.measuredCases.rejection.candidatesTested).toBe(48);
  expect(summary.measuredCases.nonzeroLm.lmIterations).toBeGreaterThan(0);
  expect(summary.measuredCases.relaxation.rerun).toBe(true);
}, 240000);
