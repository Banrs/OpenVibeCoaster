import { describe, expect, it, vi } from "vitest";
import {
  compileCoasterFile,
  createElement,
  generateCoaster,
  regenerateLocal,
  validateClearance,
} from "./index";
import {
  CompiledTrackData,
  aabbFromPoints,
  compileTrack,
  HeightfieldEnvironment,
  serializeCoasterFileV1,
  vec3,
  vec3Cross,
  vec3Normalize,
  type SolvedSpan,
} from "@openvibecoaster/core";
import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  type Vec3,
} from "@openvibecoaster/core";
import * as solver from "./solver";

const directedIntent = {
  schemaVersion: 1 as const,
  generatorVersion: "generator-v1",
  seed: 7,
  mode: "directed" as const,
  family: "steel-sitdown-lsm-v1" as const,
  elements: [
    {
      id: "station-000",
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    },
    {
      id: "stall-001",
      kind: "stall",
      type: "stall",
      parameters: { length: 32, height: 18, bank: 0 },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: ["station-000"],
};

const rigidlyRotate = (value: Vec3): Vec3 => {
  const [x, y, z] = value;
  const zAngle = 0.61;
  const xAngle = -0.47;
  const cosZ = Math.cos(zAngle);
  const sinZ = Math.sin(zAngle);
  const rotatedZ = vec3(cosZ * x - sinZ * y, sinZ * x + cosZ * y, z);
  const cosX = Math.cos(xAngle);
  const sinX = Math.sin(xAngle);
  return vec3(
    rotatedZ[0],
    cosX * rotatedZ[1] - sinX * rotatedZ[2],
    sinX * rotatedZ[1] + cosX * rotatedZ[2],
  );
};

const rigidlyTransform = (value: Vec3): Vec3 => {
  const rotated = rigidlyRotate(value);
  return vec3(rotated[0] + 31, rotated[1] - 17, rotated[2] + 23);
};

const rigidlyTransformSpan = (span: SolvedSpan): SolvedSpan => {
  const rows = span.positionCoefficients;
  if (!rows) throw new Error(`Missing position coefficients for ${span.id}`);
  const positionCoefficients = [0, 1, 2].map((component) =>
    Array.from({ length: 8 }, (_, power) => {
      const rotated = rigidlyRotate(
        vec3(rows[0]![power]!, rows[1]![power]!, rows[2]![power]!),
      );
      return (
        rotated[component]! + (power === 0 ? [31, -17, 23][component]! : 0)
      );
    }),
  );
  const transformed = {
    ...span,
    span: {
      position: (u: number) => rigidlyTransform(span.span.position(u)),
      derivative: (u: number, order = 1) =>
        rigidlyRotate(span.span.derivative(u, order)),
    },
    positionCoefficients,
    bounds: aabbFromPoints(
      Array.from({ length: 17 }, (_, index) =>
        rigidlyTransform(span.span.position(index / 16)),
      ),
    ),
  };
  return transformed;
};

const rigidlyTransformTrackVectors = (
  values: Float64Array,
  transform: (value: Vec3) => Vec3,
): Float64Array => {
  const transformed = new Float64Array(values.length);
  for (let index = 0; index < values.length / 3; index += 1) {
    const value = vec3(
      values[index * 3]!,
      values[index * 3 + 1]!,
      values[index * 3 + 2]!,
    );
    const result = transform(value);
    transformed[index * 3] = result[0];
    transformed[index * 3 + 1] = result[1];
    transformed[index * 3 + 2] = result[2];
  }
  return transformed;
};

const rigidlyTransformTrack = (
  track: ReturnType<typeof compileTrack>,
): CompiledTrackData =>
  new CompiledTrackData({
    positions: rigidlyTransformTrackVectors(track.positions, rigidlyTransform),
    tangents: rigidlyTransformTrackVectors(track.tangents, rigidlyRotate),
    normals: rigidlyTransformTrackVectors(track.normals, rigidlyRotate),
    binormals: rigidlyTransformTrackVectors(track.binormals, rigidlyRotate),
    distances: track.distances,
    curvature: track.curvature,
    curvatureVector: rigidlyTransformTrackVectors(
      track.curvatureVector,
      rigidlyRotate,
    ),
    bank: track.bank,
    bankDerivative: track.bankDerivative,
    zoneMasks: track.zoneMasks,
    zoneNames: track.zoneNames,
    elementIndices: track.elementIndices,
    elementBoundaries: track.elementBoundaries,
    parameters: track.parameters,
    totalLength: track.totalLength,
  });

describe("wave 3 deterministic generator", () => {
  it("builds the flagship semantic sequence for automatic modes", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(result.feasible, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(
      false,
    );
    expect(result.elements.map((element) => element.type)).toEqual([
      "station",
      "launch",
      "topHat",
      "overbankedTurn",
      "airtimeHill",
      "boost",
      "zeroGRoll",
      "stall",
      "brake",
      "brake",
      "station",
    ]);
    const topHat = result.elements[2];
    expect(topHat).toBeDefined();
    expect((topHat!.parameters as { readonly height: number }).height).toBe(80);
    expect(result.track.totalLength).toBeGreaterThanOrEqual(1600);
    expect(result.track.totalLength).toBeLessThanOrEqual(2200);
    expect(
      Math.abs(
        (result.elements[3]!.parameters as { readonly bank: number }).bank,
      ),
    ).toBeGreaterThan(Math.PI / 2);
    expect(
      Math.abs(
        (result.elements[6]!.parameters as { readonly roll: number }).roll,
      ),
    ).toBeCloseTo(Math.PI * 2, 12);
    expect(
      (result.elements[7]!.parameters as { readonly height: number }).height,
    ).toBeGreaterThan(0);
    const overbankSpans = result.solvedSpans.filter((span) =>
      span.id.startsWith("overbankedTurn-003"),
    );
    expect(
      Math.max(
        ...overbankSpans.flatMap((span) =>
          Array.from({ length: 33 }, (_, index) =>
            Math.abs(span.bank!.position(index / 32)),
          ),
        ),
      ),
    ).toBeGreaterThan(Math.PI / 2);
    const rollSpans = result.solvedSpans.filter((span) =>
      span.id.startsWith("zeroGRoll-006"),
    );
    expect(
      rollSpans.at(-1)!.bank!.position(1) - rollSpans[0]!.bank!.position(0),
    ).toBeCloseTo(Math.PI * 2, 10);
    const stallSpans = result.solvedSpans.filter((span) =>
      span.id.startsWith("stall-007"),
    );
    const stallHeights = stallSpans.flatMap((span) =>
      Array.from(
        { length: 33 },
        (_, index) => span.span.position(index / 32)[1],
      ),
    );
    expect(
      Math.max(...stallHeights) - Math.min(...stallHeights),
    ).toBeGreaterThan(10);
    const topHatSpans = result.file.solvedSpans.filter((span) =>
      span.id.startsWith("topHat-002#"),
    );
    expect(topHatSpans.map((span) => span.id)).toEqual([
      "topHat-002#0",
      "topHat-002#1",
    ]);
    const runtimeTopHatSpans = result.solvedSpans.filter((span) =>
      span.id.startsWith("topHat-002#"),
    );
    runtimeTopHatSpans.forEach((span, index) => {
      expect(span.span).toBeInstanceOf(SeventhOrderHermiteSpan);
      expect(span.bank).toBeInstanceOf(QuinticScalarSpan);
      expect(span.positionCoefficients).toEqual(
        topHatSpans[index]!.positionCoefficients,
      );
      expect(span.rollCoefficients).toEqual(
        topHatSpans[index]!.rollCoefficients,
      );
    });
    const loaded = compileCoasterFile(result.serializedFile);
    const sampleTopHat = (spans: typeof topHatSpans, u: number) => {
      const index = u <= 0.5 ? 0 : 1;
      const local = index === 0 ? u * 2 : u * 2 - 1;
      const span = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
        spans[index]!.positionCoefficients,
      );
      const roll = spans[index]!.rollCoefficients;
      return {
        height: span.position(local)[1],
        bank: roll.reduce(
          (sum, value, power) => sum + value * local ** power,
          0,
        ),
      };
    };
    const apex = sampleTopHat(topHatSpans, 0.5);
    const offApexHeights = Array.from(
      { length: 2001 },
      (_, index) => index / 2000,
    )
      .filter((u) => u !== 0.5)
      .map((u) => sampleTopHat(topHatSpans, u).height);
    expect(apex.height).toBeCloseTo(80, 10);
    expect(Math.max(...offApexHeights)).toBeLessThan(apex.height);
    expect(apex.bank - sampleTopHat(topHatSpans, 0).bank).toBeCloseTo(
      Math.PI,
      12,
    );
    const loadedTopHatSpans = loaded.file.solvedSpans.filter((span) =>
      span.id.startsWith("topHat-002#"),
    );
    expect(loadedTopHatSpans).toEqual(topHatSpans);
    for (const u of [0, 0.17, 0.35, 0.5, 0.65, 0.83, 1]) {
      const sample = sampleTopHat(topHatSpans, u);
      const loadedSample = sampleTopHat(loadedTopHatSpans, u);
      expect(loadedSample).toEqual(sample);
    }
    expect(compileCoasterFile(result.serializedFile).track.positions).toEqual(
      result.track.positions,
    );
    expect(loaded.track.checksum).toBe(result.track.checksum);
    expect(serializeCoasterFileV1(loaded.file)).toBe(result.serializedFile);
  });

  it("keeps the flagship force-driven geometry schema-clean", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(Object.keys(result.elements[4]!)).not.toContain("flatForceProfile");
    expect(Object.keys(result.elements[3]!)).not.toContain("smoothEnds");
    expect(result.serializedFile).not.toContain("flatForceProfile");
    expect(result.serializedFile).not.toContain("smoothEnds");
    const airtime = result.solvedSpans.filter((span) =>
      span.id.startsWith("airtimeHill-004"),
    );
    expect(airtime.length).toBeGreaterThan(0);
    const curvatureResponses = airtime.map((span) =>
      SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
        span.positionCoefficients!,
      ).derivative(0.5, 2),
    );
    expect(
      Math.max(
        ...curvatureResponses.map((response) => Math.hypot(...response)),
      ),
    ).toBeGreaterThan(1e-3);
    expect(
      airtime.some((span) =>
        span.positionCoefficients!.some((row) =>
          row.slice(2).some((coefficient) => Math.abs(coefficient) > 1e-8),
        ),
      ),
    ).toBe(true);
  });

  it("keeps candidate search bounded and byte deterministic", () => {
    const first = generateCoaster(directedIntent);
    const second = generateCoaster(directedIntent);
    expect(first.candidatesTested).toBeLessThanOrEqual(48);
    expect(first.selectedLmIterations).toBeLessThanOrEqual(32);
    expect(first.candidateLmIterations).toEqual([first.selectedLmIterations]);
    expect(first.candidateLmWork).toBe(first.selectedLmIterations);
    expect(first.relaxationLmWork).toBe(0);
    expect(first.lmIterations).toBe(
      first.candidateLmWork + first.relaxationLmWork,
    );
    expect(first.serializedFile).toBe(second.serializedFile);
    expect(first.track.checksum).toBe(second.track.checksum);
    expect(compileCoasterFile(first.file, { samples: 32 }).track.checksum).toBe(
      first.track.checksum,
    );
    expect(
      compileCoasterFile(first.serializedFile, { samples: 32 }).track.checksum,
    ).toBe(
      compileCoasterFile(second.serializedFile, { samples: 32 }).track.checksum,
    );
    expect(first.diagnostics).toEqual(second.diagnostics);
  });

  it("runs bounded LM work for full-auto candidates", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(result.lmIterations).toBeGreaterThan(0);
    expect(result.candidateLmIterations.every((value) => value > 0)).toBe(true);
    expect(result.selectedLmIterations).toBeLessThanOrEqual(32);
    expect(result.candidateLmIterations.every((value) => value <= 32)).toBe(
      true,
    );
    expect(result.candidateLmWork).toBe(
      result.candidateLmIterations.reduce((sum, value) => sum + value, 0),
    );
  });

  it("reports all candidate and relaxation LM work instead of selected-only work", () => {
    const result = generateCoaster(
      {
        ...directedIntent,
        mode: "full-auto",
        elements: [],
        targets: [
          { id: "impossible-z", kind: "end-z", target: 999, hard: true },
        ],
      },
      { samples: 8 },
    );
    expect(result.candidatesTested).toBe(48);
    expect(result.candidateLmIterations).toHaveLength(48);
    expect(result.candidateLmIterations.every((value) => value <= 32)).toBe(
      true,
    );
    expect(result.candidateLmWork).toBe(
      result.candidateLmIterations.reduce((sum, value) => sum + value, 0),
    );
    expect(result.relaxationLmIterations.length).toBeGreaterThan(0);
    expect(result.relaxationLmWork).toBe(
      result.relaxationLmIterations.reduce((sum, value) => sum + value, 0),
    );
    expect(
      result.relaxationEvidence.every(
        (evidence) => evidence.lmIterations >= 0 && evidence.lmIterations <= 32,
      ),
    ).toBe(true);
    expect(result.lmIterations).toBe(
      result.candidateLmWork + result.relaxationLmWork,
    );
    expect(result.selectedLmIterations).toBe(
      result.candidateLmIterations.at(-1),
    );
  }, 120000);

  it("compares gate roll when tangent and position agree", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [directedIntent.elements[0]!],
      gates: [
        {
          id: "rolled",
          position: [0, 0, 6] as const,
          orientation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const,
        },
      ],
    });
    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.some((item) => item.code === "GATE_POSITION"),
    ).toBe(false);
    expect(
      result.diagnostics.some((item) => item.code === "GATE_ORIENTATION"),
    ).toBe(true);
    expect(
      result.diagnostics.find((item) => item.code === "GATE_ORIENTATION")
        ?.message,
    ).toContain("tangent=0");
  });

  it("reports exact clearance locations and margins", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 100,
      heights: [0, 0, 0, 0],
    });
    const generated = generateCoaster(directedIntent, {
      environment,
      samples: 32,
    });
    const diagnostics = validateClearance(generated.solvedSpans, environment, {
      trainEnvelopeRadius: 2,
    });
    expect(
      diagnostics.every((diagnostic) => diagnostic.location?.s !== undefined),
    ).toBe(true);
    expect(
      diagnostics.every(
        (diagnostic) =>
          diagnostic.actual !== undefined && diagnostic.limit !== undefined,
      ),
    ).toBe(true);
  });

  it("regenerates only the selected neighborhood and keeps pinned spans bitwise stable", () => {
    const generated = generateCoaster(directedIntent);
    const result = regenerateLocal(generated, "stall-001", {
      pinnedElementIds: ["station-000"],
    });
    expect(result.feasible).toBe(true);
    expect(result.untouchedSpanHashes["station-000"]).toBe(
      generated.spanHashes["station-000"],
    );
  });

  it("widens a changed local solve without changing an upstream pin", () => {
    const generated = generateCoaster(directedIntent);
    const result = regenerateLocal(generated, "stall-001", {
      changes: { "stall-001": { length: 40 } },
      pinnedElementIds: ["station-000"],
    });
    expect(result.feasible).toBe(true);
    expect(result.untouchedSpanHashes["station-000"]).toBe(
      generated.spanHashes["station-000"],
    );
    expect(result.generation.spanHashes["stall-001"]).not.toBe(
      generated.spanHashes["stall-001"],
    );
  });

  it("enforces ordered gates at path locations instead of the final endpoint", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "launch-001",
          kind: "launch",
          type: "launch",
          parameters: { length: 30, targetSpeed: 25, bank: 0 },
        },
      ],
      gates: [
        { id: "gate-a", position: [0, 0, 6] as const },
        { id: "gate-b", position: [0, 0, 24] as const },
      ],
      targets: [],
      constraints: [],
    });
    expect(result.feasible).toBe(true);
    expect(result.diagnostics.filter((item) => item.code === "GATE")).toEqual(
      [],
    );
  });

  it("solves a continuous gate location between every legacy sample", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "long-line",
          kind: "station",
          type: "station",
          parameters: { length: 500, bank: 0, closed: false },
        },
      ],
      gates: [{ id: "between-samples", position: [0, 0, 250.5] as const }],
      pinnedElementIds: [],
    });

    expect(result.feasible).toBe(true);
    expect(
      result.diagnostics.some((item) =>
        item.relatedIds?.includes("between-samples"),
      ),
    ).toBe(false);
  });

  it("returns one exact fatal diagnostic for every gate without a position", () => {
    const result = generateCoaster({
      ...directedIntent,
      gates: [
        { id: "legacy-at-near", at: 1 },
        { id: "legacy-at-far", at: 999 },
      ],
    });
    const failures = result.diagnostics.filter(
      (item) => item.code === "GATE_POSITION_REQUIRED",
    );

    expect(result.feasible).toBe(false);
    expect(failures).toHaveLength(2);
    expect(failures.map((item) => item.relatedIds)).toEqual([
      ["legacy-at-near"],
      ["legacy-at-far"],
    ]);
    expect(failures.every((item) => item.severity === "fatal")).toBe(true);
  });

  it("fails zero, non-finite, and malformed gate quaternions", () => {
    const zero = generateCoaster({
      ...directedIntent,
      gates: [
        {
          id: "zero-quaternion",
          position: [0, 0, 6] as const,
          orientation: [0, 0, 0, 0] as const,
        },
      ],
    });
    expect(zero.feasible).toBe(false);
    expect(
      zero.diagnostics.some(
        (item) =>
          item.code === "GATE_ORIENTATION_INVALID" &&
          item.severity === "fatal" &&
          item.relatedIds?.[0] === "zero-quaternion",
      ),
    ).toBe(true);

    expect(() =>
      generateCoaster({
        ...directedIntent,
        gates: [
          {
            id: "nan-quaternion",
            position: [0, 0, 6] as const,
            orientation: [Number.NaN, 0, 0, 1] as const,
          },
        ],
      }),
    ).toThrow("expected finite number");
    expect(() =>
      generateCoaster({
        ...directedIntent,
        gates: [
          {
            id: "malformed-quaternion",
            position: [0, 0, 6] as const,
            orientation: [0, 0, 1] as never,
          },
        ],
      }),
    ).toThrow("expected quaternion");
  });

  it("reports exact infeasibility for a hard end-z target", () => {
    const result = generateCoaster({
      ...directedIntent,
      targets: [{ id: "finish-z", kind: "end-z", target: 999, hard: true }],
    });
    const failure = result.diagnostics.find((item) =>
      item.relatedIds?.includes("finish-z"),
    );
    expect(result.feasible).toBe(false);
    expect(failure?.message).toContain("end-z");
    expect(failure?.actual).toBeDefined();
    expect(failure?.limit).toBeDefined();
    expect(failure?.margin).toBeDefined();
    expect(result.relaxationEvidence[0]?.rerun).toBe(true);
    expect(result.relaxationEvidence[0]?.change).toContain("finish-z");
  });

  it("retains finite hard-conflict evidence and relaxes only failed IDs", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [directedIntent.elements[0]!],
      targets: [
        { id: "satisfied-x", kind: "end-x", target: 0, hard: true },
        { id: "satisfied-y", kind: "end-y", target: 0, hard: true },
        { id: "satisfied-bank", kind: "end-bank", target: 0, hard: true },
        { id: "failed-end-z", kind: "end-z", target: 999, hard: true },
      ],
      pinnedElementIds: [],
    });
    const conflict = result.diagnostics.find(
      (item) => item.code === "INFEASIBLE_HARD_CONSTRAINTS",
    );

    expect(result.feasible).toBe(false);
    expect(conflict?.relatedIds).toContain("failed-end-z");
    expect(conflict?.actual).toBeTypeOf("number");
    expect(conflict?.limit).toBeTypeOf("number");
    expect(conflict?.margin).toBeTypeOf("number");
    expect(
      [conflict?.actual, conflict?.limit, conflict?.margin].every(
        (value) => value === undefined || Number.isFinite(value),
      ),
    ).toBe(true);
    expect(result.relaxationEvidence.map((item) => item.change)).toEqual([
      "Relax hard target failed-end-z",
    ]);
    expect(conflict?.suggestedRelaxation).toBe(
      "Relax failed hard target: failed-end-z",
    );
  });

  it("caps relaxation work at three reruns even when a derived ID collides", () => {
    const base = solver.solveSemanticChain([
      createElement("station", "station-000", { length: 12 }),
    ]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain").mockReturnValue({
      ...base,
      feasible: false,
      lmIterations: 32,
      diagnostics: [
        {
          code: "INFEASIBLE_HARD_CONSTRAINTS",
          severity: "error",
          message: "Derived geometry failure for h1:height",
          relatedIds: ["h1:height"],
        },
      ],
    });
    try {
      const result = generateCoaster({
        ...directedIntent,
        elements: [directedIntent.elements[0]!],
        targets: [
          { id: "h1:height", kind: "end-z", target: 999, hard: true },
          { id: "failed-x", kind: "end-x", target: 999, hard: true },
          { id: "failed-y", kind: "end-y", target: 999, hard: true },
          { id: "failed-bank", kind: "end-bank", target: 2, hard: true },
        ],
        pinnedElementIds: [],
      });

      expect(solveSpy).toHaveBeenCalledTimes(4);
      expect(result.relaxationLmIterations).toEqual([32, 32, 32]);
      expect(result.relaxationEvidence.map((item) => item.change)).toEqual([
        "Relax hard target h1:height",
        "Relax hard target failed-x",
        "Relax hard target failed-y",
      ]);
      expect(
        result.relaxationEvidence.every((item) =>
          Object.values(item.margins).every(Number.isFinite),
        ),
      ).toBe(true);
    } finally {
      solveSpy.mockRestore();
    }
  });

  it("does not rerun a satisfied hard target that collides with a derived ID", () => {
    const base = solver.solveSemanticChain([
      createElement("station", "station-000", { length: 12 }),
    ]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain").mockReturnValue({
      ...base,
      feasible: false,
      lmIterations: 32,
      diagnostics: [
        {
          code: "INFEASIBLE_HARD_CONSTRAINTS",
          severity: "error",
          message: "Derived geometry failure for h1:height",
          relatedIds: ["h1:height"],
        },
      ],
    });
    try {
      const result = generateCoaster({
        ...directedIntent,
        elements: [directedIntent.elements[0]!],
        targets: [
          {
            id: "h1:height",
            kind: "end-z",
            target: base.endPose.position[2],
            hard: true,
          },
        ],
        pinnedElementIds: [],
      });

      expect(solveSpy).toHaveBeenCalledTimes(1);
      expect(result.relaxationLmIterations).toEqual([]);
      expect(result.relaxationEvidence).toEqual([]);
    } finally {
      solveSpy.mockRestore();
    }
  });

  it("rejects unknown hard constraints and enforces required semantics", () => {
    expect(() =>
      generateCoaster({
        ...directedIntent,
        constraints: [
          { id: "mystery", kind: "unknown-hard", value: 1, hard: true },
        ],
      }),
    ).toThrow("supported constraint kind");

    const missing = generateCoaster({
      ...directedIntent,
      elements: [directedIntent.elements[0]!],
      constraints: [
        {
          id: "need-turn",
          kind: "required-element",
          target: "overbankedTurn",
          hard: true,
        },
      ],
    });
    expect(missing.feasible).toBe(false);
    expect(
      missing.diagnostics.some((item) =>
        item.relatedIds?.includes("need-turn"),
      ),
    ).toBe(true);
  });

  it("uses actual bounded candidate and LM counts across a five-seed unit sample", () => {
    const results = Array.from({ length: 5 }, (_, seed) =>
      generateCoaster(
        { ...directedIntent, seed, mode: "full-auto", elements: [] },
        { samples: 32 },
      ),
    );
    expect(
      results.every(
        (result) =>
          result.candidatesTested >= 1 && result.candidatesTested <= 48,
      ),
    ).toBe(true);
    expect(
      results.every((result) =>
        result.candidateLmIterations.every(
          (iterations) => iterations > 0 && iterations <= 32,
        ),
      ),
    ).toBe(true);
    expect(results.slice(0, 5).map((result) => result.serializedFile)).toEqual(
      results
        .slice(0, 5)
        .map(
          (_, seed) =>
            generateCoaster(
              { ...directedIntent, seed, mode: "full-auto", elements: [] },
              { samples: 32 },
            ).serializedFile,
        ),
    );
    expect(results[0]!.serializedFile).not.toBe(results[4]!.serializedFile);
  }, 120000);

  it("enforces scalar height and clearance constraints", () => {
    const result = generateCoaster({
      ...directedIntent,
      constraints: [
        { id: "too-low", kind: "min-height", target: 1, hard: true },
        { id: "too-high", kind: "max-height", target: -1, hard: true },
      ],
    });
    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.some((item) => item.relatedIds?.includes("too-low")),
    ).toBe(true);
    expect(
      result.diagnostics.some((item) => item.relatedIds?.includes("too-high")),
    ).toBe(true);
  });

  it("searches all bounded candidates before returning an infeasible full-auto result", () => {
    const result = generateCoaster(
      {
        ...directedIntent,
        mode: "full-auto",
        elements: [],
        targets: [
          { id: "impossible-z", kind: "end-z", target: 999, hard: true },
        ],
      },
      { samples: 8 },
    );
    expect(result.feasible).toBe(false);
    expect(result.candidatesTested).toBe(48);
    expect(result.candidateLmIterations).toHaveLength(48);
    expect(result.candidateLmIterations.every((value) => value <= 32)).toBe(
      true,
    );
  }, 120000);

  it("uses positive signed distance as free terrain space", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 0, 0, 0],
    });
    expect(environment.sampleSolid(vec3(0.5, 1, 0.5))).toBeGreaterThan(0);
  });

  it("detects a polynomial self-intersection within one span", () => {
    const circle = {
      id: "figure-eight",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0.1875, -1, 1, 0, 0, 0, 0, 0],
        [4, 0, 0, 0, 0, 0, 0, 0],
        [-0.09375, -0.3125, -0.5, 1, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([circle], undefined, {
      trainEnvelopeRadius: 1,
      samplesPerSpan: 32,
    });
    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
    expect(diagnostics[0]?.relatedIds).toEqual([
      "figure-eight",
      "figure-eight",
    ]);
  });

  it("catches an off-grid polynomial crossing missed by sampled boxes", () => {
    const center = 0.37;
    const epsilon = 0.001;
    const canonicalFirst = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [0, 10, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const canonicalSecondRows = [
      [10 * center, 0, 0, 0, 0, 0, 0, 0],
      [
        100_000 * center ** 2 - epsilon,
        -200_000 * center,
        100_000,
        0,
        0,
        0,
        0,
        0,
      ],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ] as const;
    const canonicalSecond =
      SeventhOrderHermiteSpan.fromCoefficients<Vec3>(canonicalSecondRows);
    const shifted = (
      source: SeventhOrderHermiteSpan<Vec3>,
      yOffset: number,
    ) => ({
      position: (u: number) => {
        const point = source.position(u);
        return vec3(point[0], point[1] + yOffset, point[2]);
      },
      derivative: (u: number, order = 1) => source.derivative(u, order),
    });
    const first = {
      id: "off-grid-first",
      span: shifted(canonicalFirst, 100),
      positionCoefficients: canonicalFirst.coefficients,
      bank: { position: () => 0, derivative: () => 0 },
    };
    const second = {
      id: "off-grid-second",
      span: shifted(canonicalSecond, 200),
      positionCoefficients: canonicalSecondRows,
      bank: { position: () => 0, derivative: () => 0 },
    };
    const legacySites = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
    const sampledFirst = legacySites.map((u) => first.span.position(u));
    const sampledSecond = legacySites.map((u) => second.span.position(u));
    expect(
      Math.min(
        ...sampledFirst.flatMap((left) =>
          sampledSecond.map((right) =>
            Math.hypot(left[0] - right[0], left[1] - right[1]),
          ),
        ),
      ),
    ).toBeGreaterThan(50);
    expect(
      canonicalSecond.position(center - Math.sqrt(epsilon / 100_000)),
    ).toEqual(expect.arrayContaining([10 * center, expect.closeTo(0, 10), 0]));
    const diagnostics = validateClearance([first, second], undefined, {
      trainEnvelopeRadius: 0.01,
      samplesPerSpan: 5,
    });
    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
  });

  it("does not discard non-adjacent segments merely because their path gap is short", () => {
    const folded = {
      id: "folded",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0.1875, -1, 1, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [-0.09375, -0.3125, -0.5, 1, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([folded], undefined, {
      trainEnvelopeRadius: 0.25,
      samplesPerSpan: 4,
    });
    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
  });

  it("catches terrain penetration between coarse samples", () => {
    const environment = {
      signedDistance: (point: readonly [number, number, number]) =>
        point[1] - (Math.abs(point[0] - 5) < 0.2 ? 2 : 0),
      raycast: () => undefined,
    };
    const span = {
      id: "terrain-span",
      span: SeventhOrderHermiteSpan.line(vec3(0, 1, 0), vec3(10, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], environment, {
      trainEnvelopeRadius: 0.5,
      samplesPerSpan: 4,
    });
    expect(diagnostics.some((item) => item.code === "TERRAIN_CLEARANCE")).toBe(
      true,
    );
    expect(diagnostics[0]?.location?.s).toBeGreaterThan(0);
  });

  it("catches a narrow swept-terrain penetration between all initial samples", () => {
    const environment = {
      signedDistance: (point: readonly [number, number, number]) =>
        point[1] - (Math.abs(point[0] - 5.003) < 0.005 ? 2 : 0),
      raycast: () => undefined,
    };
    const span = {
      id: "narrow-terrain-span",
      span: SeventhOrderHermiteSpan.line(vec3(0, 1, 0), vec3(10, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], environment, {
      trainEnvelopeRadius: 0.5,
      samplesPerSpan: 2,
    });
    expect(diagnostics.some((item) => item.code === "TERRAIN_CLEARANCE")).toBe(
      true,
    );
  });

  it("rejects exact zero-clearance self intersections", () => {
    const span = {
      id: "zero-clearance",
      span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const crossing = {
      id: "crossing",
      span: SeventhOrderHermiteSpan.line(vec3(5, -1, 0), vec3(5, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    expect(
      validateClearance([span, crossing], undefined, {
        trainEnvelopeRadius: 0,
        trackClearance: 0,
        samplesPerSpan: 8,
      }).some((item) => item.code === "TRACK_CLEARANCE"),
    ).toBe(true);
  });

  it("rejects invalid clearance configuration instead of shrinking the search", () => {
    const generated = generateCoaster(directedIntent);
    expect(() =>
      validateClearance(generated.solvedSpans, undefined, {
        trackClearance: -1,
      }),
    ).toThrow();
    expect(() =>
      validateClearance(generated.solvedSpans, undefined, {
        samplesPerSpan: Number.NaN,
      }),
    ).toThrow();
  });

  it("preserves both pinned sides byte-for-byte during local refit", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "launch-001",
          kind: "launch",
          type: "launch",
          parameters: { length: 30, targetSpeed: 25, bank: 0 },
        },
        {
          id: "stall-002",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0 },
        },
        {
          id: "brake-003",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
      ],
      pinnedElementIds: ["station-000", "brake-003"],
    });
    const result = regenerateLocal(generated, "stall-002", {
      changes: { "stall-002": { height: 22 } },
      pinnedElementIds: ["station-000", "brake-003"],
    });
    expect(result.feasible).toBe(true);
    expect(result.generation.file.solvedSpans[0]).toEqual(
      generated.file.solvedSpans[0],
    );
    expect(
      result.generation.file.solvedSpans.find(
        (span) => span.id === "brake-003",
      ),
    ).toEqual(
      generated.file.solvedSpans.find((span) => span.id === "brake-003"),
    );
  });

  it("regenerates full-auto windows from existing elements without global generation", () => {
    const directed = generateCoaster({
      ...directedIntent,
      elements: [
        ...directedIntent.elements,
        {
          id: "brake-002",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
      ],
    });
    const generated = {
      ...directed,
      intent: { ...directed.intent, mode: "full-auto" as const },
    };
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    const result = regenerateLocal(generated, "stall-001", {
      changes: { "stall-001": { height: 26 } },
    });
    expect(solveSpy).toHaveBeenCalled();
    expect(
      solveSpy.mock.calls.every(([elements]) => elements.length <= 3),
    ).toBe(true);
    solveSpy.mockRestore();
    expect(result.generation.elements[1]?.parameters).toMatchObject({
      height: 26,
    });
    expect(result.changedWindow).toEqual([1, 2]);
    expect(result.generation.spanBytes["station-000"]).toBe(
      generated.spanBytes["station-000"],
    );
    expect(result.generation.spanBytes["brake-002"]).toBe(
      generated.spanBytes["brake-002"],
    );
  });

  it("anchors an optimized local window to the solved coefficient boundary", () => {
    const generated = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
      constraints: [
        { id: "soft-floor", kind: "min-height", target: -1000, hard: false },
      ],
    });
    expect(generated.selectedLmIterations).toBeGreaterThan(0);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    const result = regenerateLocal(generated, "launch-001", {
      changes: { "launch-001": { length: 261 } },
    });
    const localCall = solveSpy.mock.calls.find(
      ([, options]) => options?.startPose !== undefined,
    );
    solveSpy.mockRestore();
    expect(localCall).toBeDefined();
    const localOptions = localCall![1]!;
    const boundary = generated.solvedSpans.find((span) =>
      span.id.startsWith("station-000"),
    );
    expect(boundary).toBeDefined();
    expect(localOptions.startPose?.position).toEqual(
      boundary?.span.position(1),
    );
    expect(localOptions.startPose?.tangent).toEqual(
      vec3Normalize(boundary!.span.derivative(1, 1)),
    );
    const boundaryIndex = generated.track.elementBoundaries[1]!;
    expect(localOptions.startPose?.normal).toEqual(
      vec3(
        generated.track.normals[boundaryIndex * 3]!,
        generated.track.normals[boundaryIndex * 3 + 1]!,
        generated.track.normals[boundaryIndex * 3 + 2]!,
      ),
    );
    expect(localOptions.startPose?.bank).toBe(boundary?.bank?.position(1));
    expect(result.feasible).toBe(true);
    expect(
      result.generation.solvedSpans
        .filter((span) => span.id.startsWith("topHat-002#"))
        .map((span) => span.id),
    ).toEqual(["topHat-002#0", "topHat-002#1"]);
    expect(result.generation.spanHashes["topHat-002"]).toBe(
      result.generation.spanHashes["topHat-002#0"],
    );
    expect(result.generation.spanBytes["topHat-002"]).toBe(
      result.generation.spanBytes["topHat-002#0"],
    );
    expect(result.generation.spanBytes["station-000"]).toBe(
      generated.spanBytes["station-000"],
    );
  }, 120000);

  it("rejects a local merge that violates a hard track-clearance intent", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        directedIntent.elements[0]!,
        {
          id: "stall-001",
          kind: "stall",
          type: "stall",
          parameters: { length: 4, height: 0, bank: 0 },
        },
        {
          id: "brake-002",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
      ],
      pinnedElementIds: [],
    });
    const result = regenerateLocal(generated, "stall-001", {
      changes: { "stall-001": { height: 1 } },
      intent: {
        ...generated.intent,
        constraints: [
          {
            id: "hard-clearance",
            kind: "track-clearance",
            target: 10,
            hard: true,
          },
        ],
      },
    });
    expect(result.feasible).toBe(false);
    const clearanceFailure = result.diagnostics.find(
      (item) => item.code === "TRACK_CLEARANCE",
    );
    expect(clearanceFailure?.relatedIds).toContain("hard-clearance");
  }, 120000);

  it("applies changes on top of an explicit intent and exposes a bounded window", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        ...directedIntent.elements,
        {
          id: "brake-002",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
        {
          id: "brake-003",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
      ],
    });
    const result = regenerateLocal(generated, "stall-001", {
      intent: generated.intent,
      changes: { "stall-001": { length: 40 } },
    });
    expect(result.feasible).toBe(true);
    expect(result.changedWindow).toEqual([1, 2]);
    expect(result.generation.spanBytes["stall-001"]).not.toBe(
      generated.spanBytes["stall-001"],
    );
    expect(result.generation.spanBytes["brake-003"]).toBe(
      generated.spanBytes["brake-003"],
    );
  });

  it("includes every remotely patched owner in the local solve window", () => {
    const elements = ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    }));
    const generated = generateCoaster({
      ...directedIntent,
      elements,
      pinnedElementIds: [],
    });
    const result = regenerateLocal(generated, "s1", {
      changes: { s4: { length: 20 } },
    });
    const saved = result.generation.file.solvedSpans.find(
      (span) => span.id === "s4",
    );
    const runtime = result.generation.solvedSpans.find(
      (span) => span.id === "s4",
    );

    expect(result.feasible).toBe(true);
    expect(result.changedWindow).toEqual([0, 3]);
    expect(result.generation.intent.elements[3]!.parameters?.length).toBe(20);
    expect(saved?.length).toBe(20);
    expect(runtime).toBeDefined();
    if (!runtime) throw new Error("Missing regenerated s4 span");
    expect(runtime.span.position(1)[2] - runtime.span.position(0)[2]).toBe(20);
  });

  it("includes intent-only parameter changes in the local solve window", () => {
    const elements = ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    }));
    const generated = generateCoaster({
      ...directedIntent,
      elements,
      pinnedElementIds: [],
    });
    const replacementIntent = {
      ...generated.intent,
      elements: generated.intent.elements.map((element) =>
        element.id === "s4"
          ? {
              ...element,
              parameters: { ...element.parameters, length: 20 },
            }
          : element,
      ),
    };
    const result = regenerateLocal(generated, "s1", {
      intent: replacementIntent,
    });
    const runtime = result.generation.solvedSpans.find(
      (span) => span.id === "s4",
    );

    expect(result.feasible).toBe(true);
    expect(result.changedWindow).toEqual([0, 3]);
    expect(runtime).toBeDefined();
    if (!runtime) throw new Error("Missing regenerated s4 span");
    expect(runtime.span.position(1)[2] - runtime.span.position(0)[2]).toBe(20);
    expect(result.generation.file.solvedSpans[3]?.length).toBe(20);
  });

  it("rejects replacement intent topology changes and missing patch owners", () => {
    const elements = ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    }));
    const generated = generateCoaster({
      ...directedIntent,
      elements,
      pinnedElementIds: [],
    });
    const missing = regenerateLocal(generated, "s1", {
      intent: {
        ...generated.intent,
        elements: generated.intent.elements.slice(0, -1),
      },
      changes: { s4: { length: 20 } },
    });
    const reordered = regenerateLocal(generated, "s1", {
      intent: {
        ...generated.intent,
        elements: [
          generated.intent.elements[1]!,
          generated.intent.elements[0]!,
          ...generated.intent.elements.slice(2),
        ],
      },
    });

    expect(missing.feasible).toBe(false);
    expect(missing.generation).toBe(generated);
    expect(
      missing.diagnostics.some(
        (item) => item.severity === "fatal" && item.relatedIds?.includes("s4"),
      ),
    ).toBe(true);
    expect(reordered.feasible).toBe(false);
    expect(reordered.generation).toBe(generated);
    expect(reordered.diagnostics[0]?.severity).toBe("fatal");
  });

  it("rejects an intent-only parameter change to a pinned element", () => {
    const elements = ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    }));
    const generated = generateCoaster({
      ...directedIntent,
      elements,
      pinnedElementIds: ["s4"],
    });
    const result = regenerateLocal(generated, "s1", {
      intent: {
        ...generated.intent,
        elements: generated.intent.elements.map((element) =>
          element.id === "s4"
            ? {
                ...element,
                parameters: { ...element.parameters, length: 20 },
              }
            : element,
        ),
      },
    });

    expect(result.feasible).toBe(false);
    expect(result.generation).toBe(generated);
    expect(
      result.diagnostics.some(
        (item) =>
          item.severity === "fatal" &&
          item.relatedIds?.includes("s4") &&
          /pinned/i.test(item.message),
      ),
    ).toBe(true);
  });

  it("rejects a remote patch blocked by a pinned boundary with its exact ID", () => {
    const elements = ["s1", "s2", "s3", "s4"].map((id) => ({
      id,
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    }));
    const generated = generateCoaster({
      ...directedIntent,
      elements,
      pinnedElementIds: ["s3"],
    });
    const result = regenerateLocal(generated, "s1", {
      changes: { s4: { length: 20 } },
    });

    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.some(
        (item) =>
          item.relatedIds?.includes("s4") && /pinned/i.test(item.message),
      ),
    ).toBe(true);
    expect(result.generation).toBe(generated);
  });

  it("accepts a true polynomial maximum below a loose Bernstein hull", () => {
    const geometry = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, -1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0],
    ]);
    const bank = QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0]);
    const base = solver.solveSemanticChain([
      createElement("station", "parabola", { length: 2 }),
    ]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain").mockReturnValue({
      ...base,
      solvedSpans: [
        {
          id: "parabola",
          kind: "station",
          span: geometry,
          bank,
          positionCoefficients: geometry.coefficients,
          rollCoefficients: bank.coefficients,
        },
      ],
    });
    try {
      const accepted = generateCoaster({
        ...directedIntent,
        elements: [
          {
            id: "parabola",
            kind: "station",
            type: "station",
            parameters: { length: 2, bank: 0, closed: false },
          },
        ],
        constraints: [
          { id: "loose-max", kind: "max-height", target: 0.26, hard: true },
        ],
        pinnedElementIds: [],
      });
      const violated = generateCoaster({
        ...directedIntent,
        elements: [
          {
            id: "parabola",
            kind: "station",
            type: "station",
            parameters: { length: 2, bank: 0, closed: false },
          },
        ],
        constraints: [
          { id: "tight-max", kind: "max-height", target: 0.24, hard: true },
        ],
        pinnedElementIds: [],
      });
      const witness = violated.diagnostics.find((item) =>
        item.relatedIds?.includes("tight-max"),
      );

      expect(accepted.feasible).toBe(true);
      expect(violated.feasible).toBe(false);
      expect(witness?.actual).toBeCloseTo(0.25, 10);
      expect(witness?.limit).toBe(0.24);
      expect(witness?.margin).toBeCloseTo(-0.01, 10);
      expect(witness?.location?.s).toBeGreaterThan(0);
      expect(witness?.location?.position?.[1]).toBeCloseTo(
        witness?.actual ?? Number.NaN,
        12,
      );
    } finally {
      solveSpy.mockRestore();
    }
  });

  it("fails closed when an exact polynomial limit cannot be certified", () => {
    const geometry = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 1, -1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0, 0, 0],
    ]);
    const bank = QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0]);
    const base = solver.solveSemanticChain([
      createElement("station", "parabola", { length: 2 }),
    ]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain").mockReturnValue({
      ...base,
      solvedSpans: [
        {
          id: "parabola",
          kind: "station",
          span: geometry,
          bank,
          positionCoefficients: geometry.coefficients,
          rollCoefficients: bank.coefficients,
        },
      ],
    });
    try {
      const result = generateCoaster({
        ...directedIntent,
        elements: [
          {
            id: "parabola",
            kind: "station",
            type: "station",
            parameters: { length: 2, bank: 0, closed: false },
          },
        ],
        constraints: [
          { id: "exact-max", kind: "max-height", target: 0.25, hard: true },
        ],
        pinnedElementIds: [],
      });

      expect(result.feasible).toBe(false);
      expect(
        result.diagnostics.some(
          (item) =>
            item.code === "MAX_HEIGHT_UNCERTIFIED" &&
            item.severity === "fatal" &&
            item.relatedIds?.includes("exact-max"),
        ),
      ).toBe(true);
    } finally {
      solveSpy.mockRestore();
    }
  });

  it("round-trips and locally regenerates child spans for IDs containing #", () => {
    const id = "hat#primary";
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id,
          kind: "topHat",
          type: "topHat",
          parameters: { height: 80, width: 40, bank: 0 },
        },
      ],
      pinnedElementIds: [],
    });
    const childIds = [`${id}#0`, `${id}#1`];

    expect(generated.solvedSpans.map((span) => span.id)).toEqual(childIds);
    expect(
      compileCoasterFile(generated.serializedFile).solvedSpans.map(
        (span) => span.id,
      ),
    ).toEqual(childIds);
    const local = regenerateLocal(generated, id);
    expect(local.feasible).toBe(true);
    expect(local.generation.solvedSpans.map((span) => span.id)).toEqual(
      childIds,
    );
    expect(local.generation.serializedFile).toBe(generated.serializedFile);
  });

  it("reports below-minimum height with a negative margin", () => {
    const result = generateCoaster({
      ...directedIntent,
      constraints: [{ id: "min", kind: "min-height", target: 1, hard: true }],
    });
    const diagnostic = result.diagnostics.find((item) =>
      item.relatedIds?.includes("min"),
    );
    expect(diagnostic?.margin).toBeLessThan(0);
  });

  it("bounds terrain certification with fatal evidence when a margin stays uncertified", () => {
    const span = {
      id: "uncertified-terrain",
      span: SeventhOrderHermiteSpan.line(vec3(0, 1, 0), vec3(1, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance(
      [span],
      {
        signedDistance: () => 0.500000000001,
        raycast: () => undefined,
      },
      { trainEnvelopeRadius: 0.5 },
    );
    const failure = diagnostics.find(
      (diagnostic) => diagnostic.code === "CLEARANCE_UNCERTIFIED",
    );
    expect(failure?.severity).toBe("fatal");
    expect(failure?.location?.s).toBeDefined();
    expect(failure?.margin).toBeDefined();
  });

  it("certifies a narrow seventh-order interior terrain dip instead of accepting samples", () => {
    const a = 0.37;
    const b = 0.370001;
    const span = {
      id: "interior-wiggle",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, 10, 0, 0, 0, 0, 0, 0],
        [1e8 * a * b, -1e8 * (a + b), 1e8, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance(
      [span],
      {
        signedDistance: (point) => point[1],
        raycast: () => undefined,
      },
      { samplesPerSpan: 2, maxDepth: 40, maxWork: 10000 },
    );
    expect(diagnostics.some((item) => item.code === "TERRAIN_CLEARANCE")).toBe(
      true,
    );
  });

  it("excludes the first/last segment seam for an explicitly closed chain", () => {
    const first = {
      id: "closed-first",
      span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const last = {
      id: "closed-last",
      span: SeventhOrderHermiteSpan.line(vec3(10, 0, 0), vec3(0, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    expect(
      validateClearance([first, last], undefined, {
        trackClearance: 0,
        samplesPerSpan: 2,
        closed: true,
      }).some((item) => item.code === "TRACK_CLEARANCE"),
    ).toBe(false);
  });

  it("detects interior collisions between adjacent spans", () => {
    const first = {
      id: "adjacent-first",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 0, 0), vec3(10, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const second = {
      id: "adjacent-second",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(10, 0, 0), vec3(0, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([first, second], undefined, {
      trainEnvelopeRadius: 0.1,
      samplesPerSpan: 4,
    });
    expect(
      diagnostics.some(
        (item) =>
          item.code === "TRACK_CLEARANCE" &&
          item.relatedIds?.includes("adjacent-first") &&
          item.relatedIds.includes("adjacent-second"),
      ),
    ).toBe(true);
  });

  it("detects first/last interior collisions while excluding only a closed seam", () => {
    const first = {
      id: "closure-first",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 0, 0), vec3(10, 0, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const middle = {
      id: "closure-middle",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(10, 0, 0), vec3(10, 0, 10)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const last = {
      id: "closure-last",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [10, -10, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [10, -50, 80, -40, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([first, middle, last], undefined, {
      closed: true,
      samplesPerSpan: 4,
    });
    const collision = diagnostics.find(
      (item) => item.code === "TRACK_CLEARANCE",
    );
    expect(collision?.relatedIds).toEqual(
      expect.arrayContaining(["closure-first", "closure-last"]),
    );
  });

  it("returns fatal clearance uncertainty when a configured self-check budget is exhausted", () => {
    const span = {
      id: "budget-span",
      span: SeventhOrderHermiteSpan.line(vec3(0, 1, 0), vec3(1, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance(
      [span],
      { signedDistance: () => 0.500000000001, raycast: () => undefined },
      { trainEnvelopeRadius: 0.5, maxDepth: 0, maxWork: 100 },
    );
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it("revalidates a local edit against the global closure seam", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: true },
        },
        {
          id: "stall-001",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0 },
        },
        {
          id: "brake-002",
          kind: "brake",
          type: "brake",
          parameters: { length: 20, targetSpeed: 8, bank: 0 },
        },
      ],
      pinnedElementIds: [],
    });
    const result = regenerateLocal(generated, "stall-001", {
      changes: { "stall-001": { height: 19 } },
    });
    const closure = result.diagnostics.find(
      (item) =>
        item.code === "LOCAL_REGENERATION" &&
        item.message.includes("->station-000"),
    );
    expect(result.feasible).toBe(false);
    expect(closure?.message).toContain("brake-002->station-000");
    expect(closure?.relatedIds).toEqual(
      expect.arrayContaining(["brake-002", "station-000#0"]),
    );
    expect(closure?.location?.s).toBeDefined();
  }, 120000);

  it("anchors a non-horizontal banked local solve to the transported global frame", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "transition-001",
          kind: "transition",
          type: "transition",
          parameters: { length: 24, rise: 8, pitch: 0.25, bank: 0.7 },
        },
        {
          id: "stall-002",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0.7 },
        },
      ],
      pinnedElementIds: ["station-000", "transition-001"],
    });
    expect(generated.diagnostics).toEqual([]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    const result = regenerateLocal(generated, "stall-002", {
      changes: { "stall-002": { height: 19 } },
      pinnedElementIds: ["station-000", "transition-001"],
    });
    const localCall = solveSpy.mock.calls.find(
      ([, options]) => options?.startPose !== undefined,
    );
    solveSpy.mockRestore();
    expect(result.feasible).toBe(true);
    expect(localCall).toBeDefined();
    const startPose = localCall![1]!.startPose!;
    const boundaryIndex = generated.track.elementBoundaries[3]!;
    const tangent = vec3(
      generated.track.tangents[boundaryIndex * 3]!,
      generated.track.tangents[boundaryIndex * 3 + 1]!,
      generated.track.tangents[boundaryIndex * 3 + 2]!,
    );
    const rolledNormal = vec3(
      generated.track.normals[boundaryIndex * 3]!,
      generated.track.normals[boundaryIndex * 3 + 1]!,
      generated.track.normals[boundaryIndex * 3 + 2]!,
    );
    const bank = generated.solvedSpans
      .find((span) => span.id === "transition-001")!
      .bank!.position(1);
    expect(Math.abs(tangent[1])).toBeGreaterThan(0.01);
    const compiledBinormal = vec3(
      generated.track.binormals[boundaryIndex * 3]!,
      generated.track.binormals[boundaryIndex * 3 + 1]!,
      generated.track.binormals[boundaryIndex * 3 + 2]!,
    );
    const expectedUnrolled = vec3Normalize(
      vec3(
        rolledNormal[0] * Math.cos(bank) - compiledBinormal[0] * Math.sin(bank),
        rolledNormal[1] * Math.cos(bank) - compiledBinormal[1] * Math.sin(bank),
        rolledNormal[2] * Math.cos(bank) - compiledBinormal[2] * Math.sin(bank),
      ),
    );
    expect(startPose.normal).toEqual(expectedUnrolled);
    const reappliedNormal = vec3Normalize(
      vec3(
        startPose.normal[0] * Math.cos(bank) +
          vec3Cross(tangent, startPose.normal)[0] * Math.sin(bank),
        startPose.normal[1] * Math.cos(bank) +
          vec3Cross(tangent, startPose.normal)[1] * Math.sin(bank),
        startPose.normal[2] * Math.cos(bank) +
          vec3Cross(tangent, startPose.normal)[2] * Math.sin(bank),
      ),
    );
    const reappliedBinormal = vec3Normalize(
      vec3Cross(tangent, reappliedNormal),
    );
    for (const component of [0, 1, 2] as const) {
      expect(reappliedNormal[component]).toBeCloseTo(
        rolledNormal[component]!,
        12,
      );
      expect(reappliedBinormal[component]).toBeCloseTo(
        compiledBinormal[component]!,
        12,
      );
    }
    expect(startPose.bank).toBeCloseTo(bank, 10);
  }, 120000);

  it("rigidly transforms local anchors with a rotated and translated solved file", () => {
    const generated = generateCoaster({
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "transition-001",
          kind: "transition",
          type: "transition",
          parameters: { length: 24, rise: 8, pitch: 0.25, bank: 0.7 },
        },
        {
          id: "stall-002",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0.7 },
        },
      ],
      pinnedElementIds: ["station-000", "transition-001"],
    });
    expect(generated.diagnostics).toEqual([]);
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    const original = regenerateLocal(generated, "stall-002", {
      changes: { "stall-002": { height: 19 } },
      pinnedElementIds: ["station-000", "transition-001"],
    });
    const originalCall = solveSpy.mock.calls.find(
      ([, options]) => options?.startPose !== undefined,
    );
    expect(original.diagnostics).toEqual([]);
    expect(originalCall).toBeDefined();
    const originalPose = originalCall![1]!.startPose!;

    solveSpy.mockClear();
    const transformedSpans = generated.solvedSpans.map(rigidlyTransformSpan);
    const transformedGenerated = {
      ...generated,
      solvedSpans: Object.freeze(transformedSpans),
      track: rigidlyTransformTrack(generated.track),
    };
    const transformed = regenerateLocal(transformedGenerated, "stall-002", {
      changes: { "stall-002": { height: 19 } },
      pinnedElementIds: ["station-000", "transition-001"],
    });
    const transformedCall = solveSpy.mock.calls.find(
      ([, options]) => options?.startPose !== undefined,
    );
    solveSpy.mockRestore();
    expect(transformed.feasible).toBe(true);
    expect(transformedCall).toBeDefined();
    const transformedPose = transformedCall![1]!.startPose!;
    const expectedPosition = rigidlyTransform(originalPose.position);
    const expectedTangent = rigidlyRotate(originalPose.tangent);
    const expectedNormal = rigidlyRotate(originalPose.normal);
    for (const component of [0, 1, 2] as const) {
      expect(transformedPose.position[component]).toBeCloseTo(
        expectedPosition[component]!,
        10,
      );
      expect(transformedPose.tangent[component]).toBeCloseTo(
        expectedTangent[component]!,
        10,
      );
      expect(transformedPose.normal[component]).toBeCloseTo(
        expectedNormal[component]!,
        10,
      );
    }
    expect(transformedPose.bank).toBeCloseTo(originalPose.bank, 10);
  }, 120000);

  it("reports authoritative off-grid maximum bounds through generation", () => {
    const center = 0.371;
    const curvature = 1500;
    const peak = 1.01;
    const excursion = [
      peak - curvature * center ** 2,
      2 * curvature * center,
      -curvature,
      0,
      0,
      0,
      0,
      0.001,
    ];
    const flat = [0, 0, 0, 0, 0, 0, 0, 0];
    const span = {
      id: "station-000",
      kind: "station",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, 10, 0, 0, 0, 0, 0, 0],
        excursion,
        flat,
      ]),
      positionCoefficients: [[0, 10, 0, 0, 0, 0, 0, 0], excursion, flat],
      bank: { position: () => 0, derivative: () => 0 },
    };
    const oldSamples = Array.from({ length: 129 }, (_, index) => index / 128);
    for (const u of oldSamples) {
      const point = span.span.position(u);
      expect(point[1]).toBeLessThanOrEqual(1);
    }
    expect(span.span.position(center)[1]).toBeGreaterThan(1.005);

    const intent = {
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 10, bank: 0, closed: false },
        },
      ],
      footprint: {
        min: [-100, -1000, -1] as const,
        max: [100, 1, 1] as const,
      },
      heightRange: { min: -300, max: 1 },
      constraints: [{ id: "max", kind: "max-height", target: 1, hard: true }],
    };
    const solve = solver.solveSemanticChain;
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    solveSpy.mockImplementation((elements, options) => {
      const result = solve(elements, options);
      return {
        ...result,
        solvedSpans: [span],
        endPose: {
          ...result.endPose,
          position: span.span.position(1),
          tangent: vec3Normalize(span.span.derivative(1, 1)),
        },
      };
    });
    let result;
    try {
      result = generateCoaster(intent);
    } finally {
      solveSpy.mockRestore();
    }
    expect(result.feasible).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["HEIGHT_RANGE", "MAX_HEIGHT", "FOOTPRINT"]),
    );
    expect(
      result.diagnostics.find(
        (item) =>
          item.code === "MAX_HEIGHT" && item.relatedIds?.includes("max"),
      ),
    ).toBeDefined();
    for (const diagnostic of result.diagnostics) {
      for (const value of [
        diagnostic.actual,
        diagnostic.limit,
        diagnostic.margin,
      ])
        expect(value === undefined || Number.isFinite(value)).toBe(true);
      if (diagnostic.location) {
        expect(Number.isFinite(diagnostic.location.s)).toBe(true);
        if (diagnostic.location.position)
          expect(diagnostic.location.position.every(Number.isFinite)).toBe(
            true,
          );
      }
    }
  });

  it("reports authoritative off-grid minimum bounds through generation", () => {
    const center = 0.371;
    const floor = -1.01;
    const curvature = 1500;
    const rows = [
      [0, 10, 0, 0, 0, 0, 0, 0],
      [
        floor + curvature * center ** 2,
        -2 * curvature * center,
        curvature,
        0,
        0,
        0,
        0,
        0.001,
      ],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ] as const;
    const span = {
      id: "station-000",
      kind: "station",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows),
      positionCoefficients: rows,
      bank: { position: () => 0, derivative: () => 0 },
    };
    const intent = {
      ...directedIntent,
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 10, bank: 0, closed: false },
        },
      ],
      heightRange: { min: -1, max: 300 },
      constraints: [{ id: "min", kind: "min-height", target: -1, hard: true }],
    };
    for (const index of Array.from({ length: 129 }, (_, value) => value))
      expect(span.span.position(index / 128)[1]).toBeGreaterThanOrEqual(-1);
    expect(span.span.position(center)[1]).toBeLessThan(-1.005);
    const solve = solver.solveSemanticChain;
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    solveSpy.mockImplementation((elements, options) => {
      const result = solve(elements, options);
      return {
        ...result,
        solvedSpans: [span],
        endPose: {
          ...result.endPose,
          position: span.span.position(1),
          tangent: vec3Normalize(span.span.derivative(1, 1)),
        },
      };
    });
    let result;
    try {
      result = generateCoaster(intent);
    } finally {
      solveSpy.mockRestore();
    }
    expect(result.feasible).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MIN_HEIGHT", "HEIGHT_RANGE"]),
    );
    expect(
      result.diagnostics.find(
        (item) =>
          item.code === "MIN_HEIGHT" && item.relatedIds?.includes("min"),
      ),
    ).toBeDefined();
  });

  it("skips clearance queries after every hard candidate failure is known", () => {
    let signedDistanceCalls = 0;
    const result = generateCoaster(
      {
        ...directedIntent,
        targets: [
          { id: "impossible-z", kind: "end-z", target: 999, hard: true },
        ],
        constraints: [
          { id: "too-high", kind: "max-height", target: -1, hard: true },
        ],
      },
      {
        environment: {
          signedDistance: () => {
            signedDistanceCalls += 1;
            return 1;
          },
          raycast: () => undefined,
        },
      },
    );
    expect(result.feasible).toBe(false);
    expect(signedDistanceCalls).toBe(0);
  });

  it("short-circuits local clearance after a merged hard failure", () => {
    let queryCalls = 0;
    const generated = generateCoaster({
      ...directedIntent,
      targets: [{ id: "impossible-z", kind: "end-z", target: 999, hard: true }],
    });
    const generatedWithEnvironment = {
      ...generated,
      options: {
        ...generated.options,
        environment: {
          signedDistance: () => {
            queryCalls += 1;
            throw new Error("local clearance must be short-circuited");
          },
          sampleSolid: () => {
            queryCalls += 1;
            throw new Error("local solid query must be short-circuited");
          },
          bounds: () => {
            queryCalls += 1;
            throw new Error("local environment bounds must be short-circuited");
          },
          raycast: () => {
            queryCalls += 1;
            throw new Error("local raycast must be short-circuited");
          },
        },
      },
    };
    const result = regenerateLocal(generatedWithEnvironment, "stall-001", {
      changes: { "stall-001": { height: 19 } },
    });
    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.find(
        (item) =>
          item.code === "TARGET" && item.relatedIds?.includes("impossible-z"),
      ),
    ).toBeDefined();
    expect(queryCalls).toBe(0);
  });

  it("queries clearance when local validation has only a soft target residual", () => {
    const generated = generateCoaster({
      ...directedIntent,
      targets: [{ id: "soft-z", kind: "end-z", target: 999, hard: false }],
    });
    let queryCalls = 0;
    const generatedWithEnvironment = {
      ...generated,
      options: {
        ...generated.options,
        environment: {
          signedDistance: () => {
            queryCalls += 1;
            return 100;
          },
          raycast: () => undefined,
        },
      },
    };
    const result = regenerateLocal(generatedWithEnvironment, "stall-001", {
      changes: { "stall-001": { length: 40 } },
    });
    const target = result.diagnostics.find(
      (item) => item.code === "TARGET" && item.relatedIds?.includes("soft-z"),
    );
    expect(result.feasible).toBe(true);
    expect(target).toMatchObject({
      severity: "warning",
      provenance: "DESIGN_ASSUMPTION",
    });
    expect(queryCalls).toBeGreaterThan(0);
  });

  it("sanitizes both directional extreme finite bound branches", () => {
    for (const direction of ["min", "max"] as const) {
      const limit = direction === "min" ? Number.MAX_VALUE : -Number.MAX_VALUE;
      const coordinate =
        direction === "min" ? -Number.MAX_VALUE / 2 : Number.MAX_VALUE / 2;
      const rows = [
        [0, 10, 0, 0, 0, 0, 0, 0],
        [coordinate, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ] as const;
      const span = {
        id: "station-000",
        kind: "station",
        span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows),
        positionCoefficients: rows,
        bank: { position: () => 0, derivative: () => 0 },
      };
      const solve = solver.solveSemanticChain;
      const solveSpy = vi.spyOn(solver, "solveSemanticChain");
      solveSpy.mockImplementation((elements, options) => {
        const result = solve(elements, options);
        return {
          ...result,
          solvedSpans: [span],
          endPose: {
            ...result.endPose,
            position: span.span.position(1),
            tangent: vec3Normalize(span.span.derivative(1, 1)),
          },
        };
      });
      let result;
      try {
        result = generateCoaster({
          ...directedIntent,
          elements: [
            {
              id: "station-000",
              kind: "station",
              type: "station",
              parameters: { length: 10, bank: 0, closed: false },
            },
          ],
          footprint: {
            min: [limit, limit, limit] as const,
            max: [limit, limit, limit] as const,
          },
          heightRange: { min: limit, max: limit },
          constraints: [
            {
              id: `extreme-${direction}-height`,
              kind: direction === "min" ? "min-height" : "max-height",
              target: limit,
              hard: true,
            },
          ],
        });
      } finally {
        solveSpy.mockRestore();
      }
      expect(result.feasible).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(
        result.diagnostics.some(
          (item) =>
            item.code === "NUMERIC_UNCERTIFIED" &&
            item.relatedIds?.includes("station-000"),
        ),
      ).toBe(true);
      expect(
        result.diagnostics.some(
          (item) =>
            item.severity === "fatal" &&
            item.code === "NUMERIC_UNCERTIFIED" &&
            item.relatedIds?.includes(`extreme-${direction}-height`),
        ),
      ).toBe(true);
      for (const diagnostic of result.diagnostics) {
        for (const value of [
          diagnostic.actual,
          diagnostic.limit,
          diagnostic.margin,
        ])
          expect(value === undefined || Number.isFinite(value)).toBe(true);
        if (diagnostic.location) {
          expect(Number.isFinite(diagnostic.location.s)).toBe(true);
          if (diagnostic.location.position)
            expect(diagnostic.location.position.every(Number.isFinite)).toBe(
              true,
            );
        }
      }
    }
  });

  it("returns deeply independent deterministic result graphs", () => {
    const callerIntent = {
      ...directedIntent,
      elements: directedIntent.elements.map((element) => ({
        ...element,
        parameters: { ...element.parameters },
      })),
      gates: [
        {
          id: "owned-gate",
          position: [0, 0, 6] as [number, number, number],
        },
      ],
      targets: [{ id: "owned-target", kind: "end-z", target: 44, hard: false }],
      constraints: [
        { id: "owned-constraint", kind: "min-height", target: -1, hard: false },
      ],
      pinnedElementIds: ["station-000"],
    };
    const callerOptions = {
      samples: 32,
      researchSnapshotIds: ["snapshot-a"],
    };
    const first = generateCoaster(callerIntent, callerOptions);
    const second = generateCoaster(callerIntent, callerOptions);

    expect(first).not.toBe(second);
    expect(first.intent).not.toBe(second.intent);
    expect(first.intent).not.toBe(callerIntent);
    expect(first.intent.elements).not.toBe(second.intent.elements);
    expect(first.intent.elements[0]?.parameters).not.toBe(
      second.intent.elements[0]?.parameters,
    );
    expect(first.intent.gates).not.toBe(second.intent.gates);
    expect(first.intent.gates[0]?.position).not.toBe(
      second.intent.gates[0]?.position,
    );
    expect(first.intent.targets).not.toBe(second.intent.targets);
    expect(first.intent.constraints).not.toBe(second.intent.constraints);
    expect(first.file).not.toBe(second.file);
    expect(first.file.intent).not.toBe(second.file.intent);
    expect(first.file.solvedSpans).not.toBe(second.file.solvedSpans);
    expect(first.file.solvedSpans[0]?.positionCoefficients).not.toBe(
      second.file.solvedSpans[0]?.positionCoefficients,
    );
    expect(first.elements).not.toBe(second.elements);
    expect(first.elements[0]?.parameters).not.toBe(
      second.elements[0]?.parameters,
    );
    expect(first.options).not.toBe(second.options);
    expect(first.options).not.toBe(callerOptions);
    expect(first.options.researchSnapshotIds).not.toBe(
      second.options.researchSnapshotIds,
    );
    expect(first.track).not.toBe(second.track);
    expect(first.track.positions).not.toBe(second.track.positions);
    expect(first.solvedSpans).not.toBe(second.solvedSpans);
    expect(first.solvedSpans[0]?.positionCoefficients).not.toBe(
      second.solvedSpans[0]?.positionCoefficients,
    );
    expect(first.candidateLmIterations).not.toBe(second.candidateLmIterations);
    expect(first.diagnostics).not.toBe(second.diagnostics);
    expect(first.serializedFile).toBe(second.serializedFile);
    expect(first.track.positions).toEqual(second.track.positions);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first).not.toHaveProperty("stageTimings");

    callerIntent.elements[0]!.parameters.length = 999;
    callerIntent.gates[0]!.position[2] = 999;
    callerIntent.targets[0]!.target = 999;
    callerIntent.constraints[0]!.target = 999;
    callerIntent.pinnedElementIds.push("stall-001");
    callerOptions.researchSnapshotIds.push("snapshot-b");
    expect(first.intent.elements[0]?.parameters?.length).toBe(12);
    expect(first.intent.gates[0]?.position?.[2]).toBe(6);
    expect(first.intent.targets[0]?.target).toBe(44);
    expect(first.intent.constraints[0]?.target).toBe(-1);
    expect(first.intent.pinnedElementIds).toEqual(["station-000"]);
    expect(first.options.researchSnapshotIds).toEqual(["snapshot-a"]);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.intent.elements)).toBe(true);
    expect(Object.isFrozen(first.intent.elements[0]!.parameters)).toBe(true);
    expect(Object.isFrozen(first.intent.gates[0]!.position)).toBe(true);
    expect(
      Object.isFrozen(first.file.solvedSpans[0]!.positionCoefficients),
    ).toBe(true);
    expect(Object.isFrozen(first.options.researchSnapshotIds)).toBe(true);
    expect(() => {
      (first.intent.gates[0]!.position as unknown as number[])[2] = 999;
    }).toThrow(TypeError);

    const exposedPositions = first.track.positions;
    exposedPositions[0] = 999;
    expect(first.track.positions[0]).not.toBe(999);
    expect(second.track.positions[0]).not.toBe(999);
  });
});
