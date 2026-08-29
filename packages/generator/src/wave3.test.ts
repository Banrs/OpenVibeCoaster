import { describe, expect, it, vi } from "vitest";
import {
  compileCoasterFile,
  generateCoaster,
  regenerateLocal,
  validateClearance,
} from "./index";
import {
  aabbFromPoints,
  compileTrack,
  HeightfieldEnvironment,
  serializeCoasterFileV1,
  vec3,
  vec3Normalize,
  type SolvedSpan,
} from "@openvibecoaster/core";
import { SeventhOrderHermiteSpan, type Vec3 } from "@openvibecoaster/core";
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
  const rotatedZ = vec3(
    cosZ * x - sinZ * y,
    sinZ * x + cosZ * y,
    z,
  );
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
  const positionCoefficients = [0, 1, 2].map((component) =>
    Array.from({ length: 8 }, (_, power) => {
      const rotated = rigidlyRotate(
        vec3(rows[0]![power]!, rows[1]![power]!, rows[2]![power]!),
      );
      return rotated[component]! +
        (power === 0 ? [31, -17, 23][component]! : 0);
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

describe("wave 3 deterministic generator", () => {
  it("builds the flagship semantic sequence for automatic modes", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(result.feasible).toBe(true);
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
    const topHatSpans = result.file.solvedSpans.filter((span) =>
      span.id.startsWith("topHat-002#"),
    );
    expect(topHatSpans.length).toBeGreaterThan(1);
    const topHatHeights = topHatSpans.map(
      (span) =>
        SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
          span.positionCoefficients,
        ).position(0.5)[1],
    );
    expect(Math.max(...topHatHeights)).toBeGreaterThan(79);
    expect(
      Math.max(...topHatHeights) - Math.min(...topHatHeights),
    ).toBeGreaterThan(1);
    expect(
      topHatSpans.some((span) =>
        span.rollCoefficients.some((value) => value !== 0),
      ),
    ).toBe(true);
    const loaded = compileCoasterFile(result.serializedFile);
    const sampleTopHat = (spans: typeof topHatSpans, u: number) => {
      const boundaries = [0, 0.2, 0.35, 0.4, 0.6, 0.65, 0.8, 1];
      const child = Math.min(
        boundaries.length - 2,
        boundaries.findIndex((boundary) => u <= boundary) - 1,
      );
      const index = child < 0 ? 0 : child;
      const local =
        (u - boundaries[index]!) /
        (boundaries[index + 1]! - boundaries[index]!);
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
    for (const u of [0.35, 0.5, 0.65]) {
      const sample = sampleTopHat(topHatSpans, u);
      const loadedSample = sampleTopHat(
        loaded.file.solvedSpans.filter((span) =>
          span.id.startsWith("topHat-002#"),
        ),
        u,
      );
      expect(sample.height).toBeCloseTo(80, 8);
      expect(loadedSample).toEqual(sample);
    }
    expect(sampleTopHat(topHatSpans, 0.5).bank).toBeCloseTo(Math.PI, 8);
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
    expect(result.lmIterations).toBeGreaterThanOrEqual(0);
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
          (iterations) => iterations >= 0 && iterations <= 32,
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

  it("catches a narrow polynomial self-crossing missed by the initial chord", () => {
    const first = {
      id: "narrow-first",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, 10, 0, 0, 0, 0, 0, 0],
        [1, -4, 4, 0, 0, 0, 0, 0],
        [1, -4, 4, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const second = {
      id: "narrow-second",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [5.5, -2, 2, 0, 0, 0, 0, 0],
        [-2, 4, 0, 0, 0, 0, 0, 0],
        [2, -8, 8, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([first, second], undefined, {
      trainEnvelopeRadius: 0.1,
      samplesPerSpan: 3,
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
    expect(startPose.normal).toEqual(rolledNormal);
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
          id: "turn-001",
          kind: "overbankedTurn",
          type: "overbankedTurn",
          parameters: { radius: 20, angle: Math.PI / 2, bank: 0.4 },
        },
        {
          id: "transition-002",
          kind: "transition",
          type: "transition",
          parameters: { length: 24, rise: 8, pitch: 0.25, bank: 0.7 },
        },
        {
          id: "stall-003",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0.7 },
        },
      ],
      pinnedElementIds: ["station-000", "turn-001", "transition-002"],
    });
    const solveSpy = vi.spyOn(solver, "solveSemanticChain");
    const original = regenerateLocal(generated, "stall-003", {
      changes: { "stall-003": { height: 19 } },
      pinnedElementIds: ["station-000", "turn-001", "transition-002"],
    });
    const originalCall = solveSpy.mock.calls.find(
      ([, options]) => options?.startPose !== undefined,
    );
    expect(original.feasible).toBe(true);
    expect(originalCall).toBeDefined();
    const originalPose = originalCall![1]!.startPose!;

    solveSpy.mockClear();
    const transformedSpans = generated.solvedSpans.map(rigidlyTransformSpan);
    const transformedGenerated = {
      ...generated,
      solvedSpans: Object.freeze(transformedSpans),
      track: compileTrack(transformedSpans, { samples: 32 }),
    };
    const transformed = regenerateLocal(transformedGenerated, "stall-003", {
      changes: { "stall-003": { height: 19 } },
      pinnedElementIds: ["station-000", "turn-001", "transition-002"],
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

  it("uses certified interior bounds for hard height and footprint violations", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [
        directedIntent.elements[0]!,
        {
          id: "stall-001",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: 18, bank: 0 },
        },
      ],
      footprint: { min: [-1, -1, -1] as const, max: [100, 1, 100] as const },
      heightRange: { min: -1, max: 1 },
      constraints: [{ id: "max", kind: "max-height", target: 1, hard: true }],
    });
    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.some((item) => item.code === "HEIGHT_RANGE"),
    ).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "MAX_HEIGHT")).toBe(
      true,
    );
    expect(result.diagnostics.some((item) => item.code === "FOOTPRINT")).toBe(
      true,
    );
  });

  it("uses certified interior bounds for hard minimum-height violations", () => {
    const result = generateCoaster({
      ...directedIntent,
      elements: [
        directedIntent.elements[0]!,
        {
          id: "stall-001",
          kind: "stall",
          type: "stall",
          parameters: { length: 32, height: -18, bank: 0 },
        },
      ],
      heightRange: { min: -1, max: 100 },
      constraints: [{ id: "min", kind: "min-height", target: -1, hard: true }],
    });
    expect(result.feasible).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "MIN_HEIGHT")).toBe(
      true,
    );
    expect(
      result.diagnostics.some((item) => item.code === "HEIGHT_RANGE"),
    ).toBe(true);
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
});
