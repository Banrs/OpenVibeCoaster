import { expect, it } from "vitest";
import { generateCoaster } from "./index";
import {
  generateCoasterForBenchmark,
  type GenerationBenchmarkEvent,
} from "./pipeline";

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

const timedGeneration = (
  measuredIntent: Parameters<typeof generateCoaster>[0],
  options: Parameters<typeof generateCoaster>[1] = {},
): {
  readonly result: ReturnType<typeof generateCoaster>;
  readonly timings: Readonly<
    Record<
      "searchMs" | "solvingMs" | "compilationMs" | "validationMs" | "totalMs",
      number
    >
  >;
} => {
  const starts = new Map<string, number>();
  const timings = {
    searchMs: 0,
    solvingMs: 0,
    compilationMs: 0,
    validationMs: 0,
    totalMs: 0,
  };
  const observer = (event: GenerationBenchmarkEvent): void => {
    const [stage, boundary] = event.split(":") as [
      "search" | "solving" | "compilation" | "validation" | "total",
      "start" | "end",
    ];
    if (boundary === "start") {
      starts.set(stage, now());
      return;
    }
    const start = starts.get(stage);
    if (start === undefined)
      throw new Error(`Missing benchmark stage ${stage}`);
    timings[`${stage}Ms`] += now() - start;
  };
  const result = generateCoasterForBenchmark(measuredIntent, options, observer);
  return { result, timings };
};

it("runs the deterministic generation benchmark", () => {
  const wallStart = now();
  for (const seed of [0xffffffff, 0x12345678, 0x87654321])
    generateCoaster({ ...intent, seed });
  const measured = Array.from({ length: 50 }, (_, seed) =>
    timedGeneration({ ...intent, seed }, { samples: 32 }),
  );
  const results = measured.map(({ result }) => result);
  const nonzeroLmMeasured = timedGeneration(
    {
      ...intent,
      seed: 17,
      constraints: [
        {
          id: "bounded-work",
          kind: "min-height",
          target: -1000,
          hard: true,
        },
      ],
    },
    { samples: 32 },
  );
  const rejectionMeasured = timedGeneration(
    {
      ...intent,
      seed: 19,
      targets: [{ id: "reject", kind: "end-z", target: 999, hard: true }],
    },
    { samples: 8 },
  );
  const relaxationMeasured = timedGeneration({
    ...directedIntent,
    seed: 23,
    targets: [{ id: "relax", kind: "end-z", target: 999, hard: true }],
  });
  const nonzeroLm = nonzeroLmMeasured.result;
  const rejection = rejectionMeasured.result;
  const relaxation = relaxationMeasured.result;
  const representative = [
    ...measured.map(({ result, timings }, seed) => ({
      name: `full-auto-${seed}`,
      seed,
      result,
      totalMs: timings.totalMs,
    })),
    {
      name: "rejection",
      seed: 19,
      result: rejection,
      totalMs: rejectionMeasured.timings.totalMs,
    },
    {
      name: "nonzero-lm",
      seed: 17,
      result: nonzeroLm,
      totalMs: nonzeroLmMeasured.timings.totalMs,
    },
    {
      name: "relaxation",
      seed: 23,
      result: relaxation,
      totalMs: relaxationMeasured.timings.totalMs,
    },
  ];
  const misses = representative
    .filter(({ totalMs }) => totalMs > 1000)
    .map(({ name, totalMs }) => ({
      name,
      totalMs,
    }));
  const totals = measured.map(({ timings }) => timings.totalMs);
  const p95Ms = percentile(totals, 0.95);
  const stage = (
    name: keyof (typeof measured)[number]["timings"],
  ): { readonly p50Ms: number; readonly p95Ms: number } => {
    const values = measured.map(({ timings }) => timings[name]);
    return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
  };
  const summary = {
    warmupSeeds: 3,
    seeds: results.length,
    representative: representative.map(({ name, seed, result, totalMs }) => ({
      name,
      seed,
      feasible: result.feasible,
      candidatesTested: result.candidatesTested,
      candidateLmIterations: result.candidateLmIterations,
      candidateLmWork: result.candidateLmWork,
      relaxationLmIterations: result.relaxationLmIterations,
      relaxationLmWork: result.relaxationLmWork,
      totalLmWork: result.lmIterations,
      totalMs,
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
        totalMs: rejectionMeasured.timings.totalMs,
        rejected: !rejection.feasible,
      },
      nonzeroLm: {
        candidatesTested: nonzeroLm.candidatesTested,
        lmIterations: nonzeroLm.lmIterations,
        candidateLmWork: nonzeroLm.candidateLmWork,
        relaxationLmWork: nonzeroLm.relaxationLmWork,
        totalMs: nonzeroLmMeasured.timings.totalMs,
      },
      relaxation: {
        candidatesTested: relaxation.candidatesTested,
        lmIterations: relaxation.lmIterations,
        candidateLmWork: relaxation.candidateLmWork,
        relaxationLmWork: relaxation.relaxationLmWork,
        totalMs: relaxationMeasured.timings.totalMs,
        rerun: relaxation.relaxationEvidence.some((item) => item.rerun),
      },
    },
    p50Ms: percentile(totals, 0.5),
    p95Ms,
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
      met: p95Ms <= 1000,
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
      result.candidateLmIterations.every((value) => value > 0 && value <= 32),
    ),
  ).toBe(true);
  expect(
    results.every(
      (result) =>
        Math.abs(
          (result.elements[3]!.parameters as { readonly bank: number }).bank,
        ) >
          Math.PI / 2 &&
        Math.abs(
          (result.elements[6]!.parameters as { readonly roll: number }).roll,
        ) ===
          Math.PI * 2 &&
        (result.elements[7]!.parameters as { readonly height: number }).height >
          0,
    ),
  ).toBe(true);
  expect(summary.feasible).toBe(true);
  expect(summary.measuredCases.rejection.rejected).toBe(true);
  expect(summary.measuredCases.rejection.candidatesTested).toBe(48);
  expect(summary.measuredCases.nonzeroLm.lmIterations).toBeGreaterThan(0);
  expect(summary.measuredCases.relaxation.rerun).toBe(true);
}, 240000);
