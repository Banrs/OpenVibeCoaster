import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  generateCoaster,
  regenerateLocal,
  validateClearance,
} from "./index";
import { HeightfieldEnvironment, vec3 } from "@openvibecoaster/core";
import { SeventhOrderHermiteSpan, type Vec3 } from "@openvibecoaster/core";

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

describe("wave 3 deterministic generator", () => {
  it("builds the flagship semantic sequence for automatic modes", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(result.feasible).toBe(true);
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
    const topHatSpan = result.file.solvedSpans[2]!;
    const topHatCoefficients = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
      topHatSpan.positionCoefficients,
    );
    const heights = [0.2, 0.35, 0.5, 0.65, 0.8].map(
      (u) => topHatCoefficients.position(u)[1],
    );
    expect(Math.max(...heights)).toBeGreaterThan(79);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(1);
    expect(result.file.solvedSpans[2]!.rollCoefficients).not.toEqual(
      Array(6).fill(0),
    );
    expect(compileCoasterFile(result.serializedFile).track.positions).toEqual(
      result.track.positions,
    );
  });

  it("keeps candidate search bounded and byte deterministic", () => {
    const first = generateCoaster(directedIntent);
    const second = generateCoaster(directedIntent);
    expect(first.candidatesTested).toBeLessThanOrEqual(48);
    expect(first.lmIterations).toBeLessThanOrEqual(32);
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

  it("uses actual bounded candidate and LM counts across 50 deterministic seeds", () => {
    const results = Array.from({ length: 50 }, (_, seed) =>
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
      results.every(
        (result) => result.lmIterations >= 0 && result.lmIterations <= 32,
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
    expect(results[0]!.serializedFile).not.toBe(results[5]!.serializedFile);
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
    expect(result.lmIterations).toBeLessThanOrEqual(32);
  });

  it("uses positive signed distance as free terrain space", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 0, 0, 0],
    });
    expect(environment.sampleSolid(vec3(0.5, 1, 0.5))).toBeGreaterThan(0);
  });

  it("detects a self-intersection within one span", () => {
    const circle = {
      id: "figure-eight",
      span: {
        position: (u: number) =>
          vec3(
            10 * Math.cos(2 * Math.PI * u),
            4,
            10 * Math.sin(2 * Math.PI * u),
          ),
        derivative: (u: number, order = 1) => {
          if (order === 1)
            return vec3(
              -20 * Math.PI * Math.sin(2 * Math.PI * u),
              0,
              20 * Math.PI * Math.cos(2 * Math.PI * u),
            );
          return vec3(0, 0, 0);
        },
      },
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

  it("does not discard non-adjacent segments merely because their path gap is short", () => {
    const folded = {
      id: "folded",
      span: {
        position: (u: number) => {
          if (u <= 1 / 3) return vec3(u * 3, 0, 0);
          if (u <= 2 / 3) return vec3(2 - (u - 1 / 3) * 3, 0, 0);
          return vec3(1 - (u - 2 / 3) * 3, 0, 0);
        },
        derivative: (u: number) =>
          u < 1 / 3 || u > 2 / 3 ? vec3(3, 0, 0) : vec3(-3, 0, 0),
      },
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
    expect(result.generation.file.solvedSpans[3]).toEqual(
      generated.file.solvedSpans[3],
    );
  });
});
