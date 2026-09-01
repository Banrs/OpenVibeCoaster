import { describe, expect, it } from "vitest";
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

const polynomialValue = (coefficients: readonly number[], u: number): number =>
  coefficients.reduce(
    (value, coefficient, power) => value + coefficient * u ** power,
    0,
  );

const flagshipGeometry = (
  result: ReturnType<typeof generateCoaster>,
): {
  readonly length: number;
  readonly maxBank: number;
  readonly accumulatedRoll: number;
  readonly stallRise: number;
  readonly lmWork: number;
} => {
  const overbankSpans = result.solvedSpans.filter((span) =>
    span.id.startsWith("overbankedTurn-003"),
  );
  const rollSpans = result.solvedSpans.filter((span) =>
    span.id.startsWith("zeroGRoll-006"),
  );
  const stallSpans = result.solvedSpans.filter((span) =>
    span.id.startsWith("stall-007"),
  );
  const firstRoll = rollSpans[0]?.rollCoefficients;
  if (!firstRoll || overbankSpans.length === 0 || stallSpans.length === 0)
    throw new Error("Missing canonical flagship coefficient spans");
  const bankValues = overbankSpans.flatMap((span) => {
    const bank = span.rollCoefficients;
    if (!bank) throw new Error(`Missing roll coefficients for ${span.id}`);
    return Array.from({ length: 257 }, (_, index) =>
      Math.abs(polynomialValue(bank, index / 256)),
    );
  });
  const stallHeights = stallSpans.flatMap((span) => {
    const height = span.positionCoefficients?.[1];
    if (!height) throw new Error(`Missing height coefficients for ${span.id}`);
    return Array.from({ length: 257 }, (_, index) =>
      polynomialValue(height, index / 256),
    );
  });
  return {
    length: result.track.totalLength,
    maxBank: Math.max(...bankValues),
    accumulatedRoll: rollSpans.reduce((total, span) => {
      const bank = span.rollCoefficients;
      if (!bank) throw new Error(`Missing roll coefficients for ${span.id}`);
      return total + polynomialValue(bank, 1) - polynomialValue(bank, 0);
    }, 0),
    stallRise: Math.max(...stallHeights) - Math.min(...stallHeights),
    lmWork: result.candidateLmWork,
  };
};

const timedGeneration = (
  measuredIntent: Parameters<typeof generateCoaster>[0],
  options: Parameters<typeof generateCoaster>[1] = {},
): {
  readonly result: ReturnType<typeof generateCoaster>;
  readonly timings: Readonly<
    Record<
      | "candidateSearchInclusiveMs"
      | "solvingMs"
      | "compilationMs"
      | "validationMs"
      | "totalMs",
      number
    >
  >;
} => {
  const starts = new Map<string, number>();
  const startCounts = new Map<string, number>();
  const endCounts = new Map<string, number>();
  const timings = {
    candidateSearchInclusiveMs: 0,
    solvingMs: 0,
    compilationMs: 0,
    validationMs: 0,
    totalMs: 0,
  };
  const observer = (event: GenerationBenchmarkEvent): void => {
    // Honest design: pipeline emits single `search:start/end` which is the
    // inclusive candidate-search interval. Bench treats it as
    // `candidateSearchInclusive` (inclusive nests solving+validation).
    // Do not derive an exclusive overhead; timer nesting makes that misleading.
    const separator = event.lastIndexOf(":");
    const stage = event.slice(0, separator);
    const boundary = event.slice(separator + 1) as "start" | "end";
    const mapped = stage === "search" ? "candidateSearchInclusive" : stage;
    if (
      mapped !== "candidateSearchInclusive" &&
      mapped !== "solving" &&
      mapped !== "compilation" &&
      mapped !== "validation" &&
      mapped !== "total"
    ) {
      return;
    }
    const key = `${mapped}Ms` as keyof typeof timings;
    if (boundary === "start") {
      startCounts.set(mapped, (startCounts.get(mapped) ?? 0) + 1);
      starts.set(mapped, now());
      return;
    }
    endCounts.set(mapped, (endCounts.get(mapped) ?? 0) + 1);
    const start = starts.get(mapped);
    if (start === undefined)
      throw new Error(`Missing benchmark stage ${mapped}`);
    timings[key] += now() - start;
  };
  const result = generateCoasterForBenchmark(measuredIntent, options, observer);
  const requiredStages = [
    "candidateSearchInclusive",
    "solving",
    "validation",
    "compilation",
    "total",
  ] as const;
  const oneShotStages = new Set<string>([
    "candidateSearchInclusive",
    "compilation",
    "total",
  ]);
  for (const stage of requiredStages) {
    const startsForStage = startCounts.get(stage) ?? 0;
    const endsForStage = endCounts.get(stage) ?? 0;
    if (startsForStage === 0) {
      throw new Error(
        `Missing benchmark stage ${stage}: no start event (required)`,
      );
    }
    if (endsForStage !== startsForStage) {
      throw new Error(
        `Mismatched benchmark stage ${stage}: start count ${startsForStage} != end count ${endsForStage}`,
      );
    }
    if (oneShotStages.has(stage) && startsForStage !== 1) {
      throw new Error(
        `Invalid duplicate benchmark stage ${stage}: expected exactly one start/end, got ${startsForStage}`,
      );
    }
  }
  return { result, timings };
};

describe("generation benchmark observer – inclusive search", () => {
  it("emits exactly one search interval per generation (candidateSearchInclusive not doubled)", () => {
    const events: GenerationBenchmarkEvent[] = [];
    generateCoasterForBenchmark({ ...intent, seed: 1 }, { samples: 32 }, (e) =>
      events.push(e),
    );
    expect(events.filter((e) => e === "search:start").length).toBe(1);
    expect(events.filter((e) => e === "search:end").length).toBe(1);
    // Pipeline must not emit the duplicated candidateSearchInclusive alias that caused double-count.
    expect(
      events.filter((e) => (e as string) === "candidateSearchInclusive:start")
        .length,
    ).toBe(0);
    expect(
      events.filter((e) => (e as string) === "candidateSearchInclusive:end")
        .length,
    ).toBe(0);
    // Nesting contract: solving and validation are nested inside search (appear after search:start and before search:end).
    const searchStart = events.indexOf("search:start");
    const searchEnd = events.indexOf("search:end");
    expect(searchStart).toBeGreaterThanOrEqual(0);
    expect(searchEnd).toBeGreaterThan(searchStart);
    for (const nested of [
      "solving:start",
      "solving:end",
      "validation:start",
      "validation:end",
    ] as const) {
      for (const occurrence of events
        .map((e, i) => (e === nested ? i : -1))
        .filter((i) => i >= 0)) {
        expect(occurrence).toBeGreaterThan(searchStart);
        expect(occurrence).toBeLessThan(searchEnd);
      }
    }
  });
});

it("runs the deterministic generation benchmark", () => {
  const wallStart = now();
  for (const seed of [0xffffffff, 0x12345678, 0x87654321])
    generateCoaster({ ...intent, seed });
  const measured = Array.from({ length: 50 }, (_, seed) =>
    timedGeneration({ ...intent, seed }, { samples: 32 }),
  );
  const results = measured.map(({ result }) => result);
  const flagshipMetrics = results.map(flagshipGeometry);
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
    flagshipGeometry: flagshipMetrics,
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
      candidateSearchInclusive: stage("candidateSearchInclusiveMs"),
      solving: stage("solvingMs"),
      compilation: stage("compilationMs"),
      validation: stage("validationMs"),
      total: stage("totalMs"),
      // Nesting note: candidateSearchInclusive (search) nests solving + validation.
      // Do not sum candidateSearchInclusive with its nested stages as independent additive contributions.
      // total = candidateSearchInclusive + compilation (+ negligible dispatch).
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
    flagshipMetrics.every(
      (metrics, index) =>
        metrics.length >= 1600 &&
        metrics.length <= 2200 &&
        metrics.maxBank > Math.PI / 2 &&
        Math.abs(Math.abs(metrics.accumulatedRoll) - Math.PI * 2) < 1e-10 &&
        metrics.stallRise > 10 &&
        metrics.lmWork > 0 &&
        metrics.lmWork <= results[index]!.candidatesTested * 32,
    ),
  ).toBe(true);
  expect(summary.feasible).toBe(true);
  expect(summary.measuredCases.rejection.rejected).toBe(true);
  expect(summary.measuredCases.rejection.candidatesTested).toBe(48);
  expect(summary.measuredCases.nonzeroLm.lmIterations).toBeGreaterThan(0);
  expect(summary.measuredCases.relaxation.rerun).toBe(true);
}, 240000);
