import { describe, expect, it } from "vitest";
import {
  createDesignIntentV1,
  HeightfieldEnvironment,
  vec3,
  type DesignIntentV1,
  type Vec3,
} from "@openvibecoaster/core";
import { generateCoaster } from "./pipeline";

const rollingEnvironment = (): HeightfieldEnvironment => {
  const width = 66;
  const depth = 46;
  const cellSize = 8;
  const origin: readonly [number, number] = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ];
  const heights = new Float64Array(width * depth);
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const worldX = origin[0] + x * cellSize;
      const worldZ = origin[1] + z * cellSize;
      const h =
        -9.5 + Math.sin(worldX * 0.02) * 0.6 + Math.cos(worldZ * 0.02) * 0.6;
      heights[z * width + x] = h;
    }
  }
  return new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights,
    origin,
  });
};

const yawQuaternion = (
  yawRad: number,
): readonly [number, number, number, number] => {
  const half = yawRad / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
};

const baseGate = {
  id: "gate-000",
  position: vec3(40, 12, 20) as Vec3,
  orientation: yawQuaternion((5 * Math.PI) / 180) as readonly [
    number,
    number,
    number,
    number,
  ],
};

const baseFootprint: readonly Vec3[] = [
  vec3(-260, 0, -180),
  vec3(260, 0, -180),
  vec3(260, 0, 180),
  vec3(-260, 0, 180),
];

const baseHeightRange = { min: 0, max: 100 };

const makeSuccessIntent = (
  overrides: Partial<{
    seed: number;
    footprint: DesignIntentV1["footprint"];
    heightRange: DesignIntentV1["heightRange"];
    gates: DesignIntentV1["gates"];
    elements: DesignIntentV1["elements"];
    targets: DesignIntentV1["targets"];
    constraints: DesignIntentV1["constraints"];
    terrainProfileId: string | undefined;
  }> = {},
): DesignIntentV1 => {
  const seed = overrides.seed ?? 42;
  const footprint = overrides.footprint ?? baseFootprint;
  const heightRange = overrides.heightRange ?? baseHeightRange;
  const gates = overrides.gates ?? [baseGate];
  const elements =
    overrides.elements ??
    ([
      {
        id: "stall-000",
        kind: "stall",
        type: "stall",
        parameters: { length: 32, height: 18, bank: 0 },
      },
    ] as DesignIntentV1["elements"]);
  const targets =
    overrides.targets ??
    ([
      { id: "total-length", kind: "total-length", target: 1800, hard: true },
      { id: "end-y", kind: "end-y", target: 18, hard: false },
    ] as DesignIntentV1["targets"]);
  const constraints =
    overrides.constraints ??
    ([
      {
        id: "required-element",
        kind: "required-element",
        target: "stall",
        hard: true,
      },
      { id: "required-footprint", kind: "required-footprint", hard: true },
      {
        id: "terrain-profile",
        kind: "terrain-profile",
        target: "rolling-highlands-v1",
        hard: true,
      },
    ] as DesignIntentV1["constraints"]);
  const terrainProfileId = overrides.terrainProfileId ?? "rolling-highlands-v1";
  return createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed,
    mode: "directed",
    family: "steel-sitdown-lsm-v1",
    elements: [...elements],
    gates: [...gates],
    targets: [...targets],
    constraints: [...constraints],
    footprint,
    heightRange,
    terrainProfileId,
    pinnedElementIds: [],
  });
};

describe("directed requirement-style generation", { timeout: 60000 }, () => {
  it("exact fixture passes with default options, 1800m, stall-000, gate pose, footprint/height and zero relaxations", () => {
    const intent = makeSuccessIntent({ seed: 42 });
    const env = rollingEnvironment();
    const result = generateCoaster(intent, { environment: env });
    if (!result.feasible) {
      console.error("DIRECTED_DIAGNOSTICS", JSON.stringify(result.diagnostics));
    }
    expect(result.feasible).toBe(true);
    expect(
      result.diagnostics.filter(
        (d) => d.severity === "error" || d.severity === "fatal",
      ),
    ).toHaveLength(0);
    expect(result.relaxations).toHaveLength(0);
    expect(result.candidateLmIterations.every((n) => n <= 32)).toBe(true);
    expect(result.track.totalLength).toBeCloseTo(1800, 4);
    const hasStall = result.elements.some(
      (e) => e.id === "stall-000" && e.type === "stall",
    );
    expect(hasStall).toBe(true);
    expect(result.intent.elements.some((e) => e.id === "stall-000")).toBe(true);
    // gate diagnostics must be absent
    const gateErrors = result.diagnostics.filter((d) =>
      d.code.startsWith("GATE_"),
    );
    expect(gateErrors).toHaveLength(0);
    // footprint/height must be certified without uncertified
    const uncertified = result.diagnostics.filter((d) =>
      d.code.includes("UNCERTIFIED"),
    );
    expect(uncertified).toHaveLength(0);
    // compiled track is the sole geometry, checksum consistent
    expect(result.track.checksum).toBe(result.file.compiledDataChecksum);
    expect(result.track.checksum).toMatch(/^[0-9a-f]{8}$/i);
  });

  it(
    "slightly tighter footprint clips and fails with FOOTPRINT evidence",
    { timeout: 60000 },
    () => {
      const tighterFootprint: readonly Vec3[] = [
        vec3(-220, 0, -150),
        vec3(220, 0, -150),
        vec3(220, 0, 150),
        vec3(-220, 0, 150),
      ];
      const intent = makeSuccessIntent({ footprint: tighterFootprint });
      const env = rollingEnvironment();
      const result = generateCoaster(intent, { environment: env });
      expect(result.feasible).toBe(false);
      const footprintDiags = result.diagnostics.filter(
        (d) => d.code === "FOOTPRINT",
      );
      expect(footprintDiags.length).toBeGreaterThan(0);
      for (const diag of footprintDiags) {
        expect(diag.actual).toBeDefined();
        expect(diag.limit).toBeDefined();
        expect(diag.margin).toBeDefined();
        expect(diag.location).toBeDefined();
      }
    },
  );

  it("translated feasible footprint still passes", { timeout: 60000 }, () => {
    const translatedFootprint: readonly Vec3[] = [
      vec3(-240, 0, -160),
      vec3(280, 0, -160),
      vec3(280, 0, 200),
      vec3(-240, 0, 200),
    ];
    const translatedGate = {
      id: "gate-000",
      position: vec3(60, 12, 40) as Vec3,
      orientation: yawQuaternion((5 * Math.PI) / 180) as readonly [
        number,
        number,
        number,
        number,
      ],
    };
    const intent = makeSuccessIntent({
      footprint: translatedFootprint,
      gates: [translatedGate],
      heightRange: baseHeightRange,
    });
    const env = rollingEnvironment();
    const result = generateCoaster(intent, { environment: env });
    expect(result.feasible).toBe(true);
    expect(result.track.totalLength).toBeCloseTo(1800, 4);
    expect(result.elements.some((e) => e.id === "stall-000")).toBe(true);
    expect(
      result.diagnostics.filter((d) => d.code.startsWith("GATE_")),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter(
        (d) => d.code === "FOOTPRINT" || d.code === "HEIGHT_RANGE",
      ),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter((d) => d.code.includes("UNCERTIFIED")),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter(
        (d) => d.severity === "error" || d.severity === "fatal",
      ),
    ).toHaveLength(0);
    const again = generateCoaster(intent, { environment: env });
    expect(again.serializedFile).toBe(result.serializedFile);
    expect(again.track.checksum).toBe(result.track.checksum);
  });

  it("scaled feasible footprint still passes", { timeout: 60000 }, () => {
    const scaledFootprint: readonly Vec3[] = [
      vec3(-400, 0, -300),
      vec3(400, 0, -300),
      vec3(400, 0, 300),
      vec3(-400, 0, 300),
    ];
    const intent = makeSuccessIntent({ footprint: scaledFootprint });
    const env = rollingEnvironment();
    const result = generateCoaster(intent, { environment: env });
    expect(result.feasible).toBe(true);
    expect(result.track.totalLength).toBeCloseTo(1800, 4);
    expect(result.elements.some((e) => e.id === "stall-000")).toBe(true);
    expect(
      result.diagnostics.filter((d) => d.code.startsWith("GATE_")),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter(
        (d) => d.code === "FOOTPRINT" || d.code === "HEIGHT_RANGE",
      ),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter((d) => d.code.includes("UNCERTIFIED")),
    ).toHaveLength(0);
    expect(
      result.diagnostics.filter(
        (d) => d.severity === "error" || d.severity === "fatal",
      ),
    ).toHaveLength(0);
  });

  it(
    "aspect-swapped feasible footprint still passes with Z-axis routing",
    { timeout: 60000 },
    () => {
      const swappedFootprint: readonly Vec3[] = [
        vec3(-180, 0, -260),
        vec3(180, 0, -260),
        vec3(180, 0, 260),
        vec3(-180, 0, 260),
      ];
      const intent = makeSuccessIntent({ footprint: swappedFootprint });
      const env = rollingEnvironment();
      const result = generateCoaster(intent, { environment: env });
      expect(result.feasible).toBe(true);
      expect(result.track.totalLength).toBeCloseTo(1800, 4);
      expect(result.elements.some((e) => e.id === "stall-000")).toBe(true);
      expect(
        result.diagnostics.filter((d) => d.code.startsWith("GATE_")),
      ).toHaveLength(0);
      expect(
        result.diagnostics.filter(
          (d) => d.code === "FOOTPRINT" || d.code === "HEIGHT_RANGE",
        ),
      ).toHaveLength(0);
      expect(
        result.diagnostics.filter((d) => d.code.includes("UNCERTIFIED")),
      ).toHaveLength(0);
      expect(
        result.diagnostics.filter(
          (d) => d.severity === "error" || d.severity === "fatal",
        ),
      ).toHaveLength(0);
      const again = generateCoaster(intent, { environment: env });
      expect(again.track.checksum).toBe(result.track.checksum);
      expect(again.serializedFile).toBe(result.serializedFile);
    },
  );

  it(
    "nearby seeds 42/43/44 all feasible and deterministic",
    { timeout: 60000 },
    () => {
      const env = rollingEnvironment();
      const results = [42, 43, 44].map((seed) =>
        generateCoaster(makeSuccessIntent({ seed }), { environment: env }),
      );
      for (const result of results) {
        expect(result.feasible).toBe(true);
        expect(result.candidateLmIterations.every((n) => n <= 32)).toBe(true);
        expect(result.track.totalLength).toBeCloseTo(1800, 4);
      }
      // determinism: same seed repeated yields identical bytes/hashes
      const a = generateCoaster(makeSuccessIntent({ seed: 42 }), {
        environment: env,
      });
      const b = generateCoaster(makeSuccessIntent({ seed: 42 }), {
        environment: env,
      });
      expect(a.serializedFile).toBe(b.serializedFile);
      expect(a.spanHashes).toEqual(b.spanHashes);
      expect(a.spanBytes).toEqual(b.spanBytes);
      expect(a.diagnostics).toEqual(b.diagnostics);
    },
  );

  it(
    "tiny footprint remains infeasible with evidence and <=3 relaxations",
    { timeout: 60000 },
    () => {
      const tinyFootprint: readonly Vec3[] = [
        vec3(-5, 0, -5),
        vec3(5, 0, -5),
        vec3(5, 0, 5),
        vec3(-5, 0, 5),
      ];
      const intent = makeSuccessIntent({ footprint: tinyFootprint });
      const env = rollingEnvironment();
      const result = generateCoaster(intent, { environment: env });
      expect(result.feasible).toBe(false);
      const hardDiags = result.diagnostics.filter(
        (d) => d.severity === "error" || d.severity === "fatal",
      );
      expect(hardDiags.length).toBeGreaterThan(0);
      const footprintDiags = hardDiags.filter(
        (d) =>
          d.code === "FOOTPRINT" ||
          d.code === "HEIGHT_RANGE" ||
          d.code === "TARGET",
      );
      expect(footprintDiags.length).toBeGreaterThan(0);
      for (const diag of footprintDiags) {
        if (diag.code === "FOOTPRINT" || diag.code === "HEIGHT_RANGE") {
          expect(Number.isFinite(diag.actual)).toBe(true);
          expect(Number.isFinite(diag.limit)).toBe(true);
          expect(Number.isFinite(diag.margin)).toBe(true);
          expect(diag.location).toBeDefined();
          expect(Number.isFinite(diag.location!.s)).toBe(true);
        }
      }
      expect(result.relaxationEvidence.length).toBeLessThanOrEqual(3);
    },
  );

  it(
    "blocking infeasible footprint remains infeasible",
    { timeout: 60000 },
    () => {
      const blockingEnv = (() => {
        const width = 66;
        const depth = 46;
        const cellSize = 8;
        const origin: readonly [number, number] = [
          -((width - 1) * cellSize) / 2,
          -((depth - 1) * cellSize) / 2,
        ];
        const heights = new Float64Array(width * depth);
        for (let i = 0; i < heights.length; i += 1) heights[i] = 40;
        return new HeightfieldEnvironment({
          width,
          depth,
          cellSize,
          heights,
          origin,
        });
      })();
      const intent = makeSuccessIntent({});
      const result = generateCoaster(intent, { environment: blockingEnv });
      expect(result.feasible).toBe(false);
      const terrainDiags = result.diagnostics.filter(
        (d) =>
          d.code === "TERRAIN_CLEARANCE" ||
          d.code === "TRACK_CLEARANCE" ||
          d.code === "FOOTPRINT",
      );
      expect(terrainDiags.length).toBeGreaterThan(0);
      for (const diag of terrainDiags) {
        if (diag.actual !== undefined)
          expect(Number.isFinite(diag.actual)).toBe(true);
        if (diag.limit !== undefined)
          expect(Number.isFinite(diag.limit)).toBe(true);
        if (diag.margin !== undefined)
          expect(Number.isFinite(diag.margin)).toBe(true);
        if (diag.location !== undefined)
          expect(Number.isFinite(diag.location.s)).toBe(true);
      }
      expect(result.relaxationEvidence.length).toBeLessThanOrEqual(3);
    },
  );

  it("authored-directed without requirement constraints stays byte deterministic", () => {
    const authoredIntent = createDesignIntentV1({
      generatorVersion: "generator-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
      pinnedElementIds: [],
    });
    const a = generateCoaster(authoredIntent);
    const b = generateCoaster(authoredIntent);
    expect(a.serializedFile).toBe(b.serializedFile);
    expect(a.spanHashes).toEqual(b.spanHashes);
    expect(a.track.checksum).toBe(b.track.checksum);
    expect(a.candidateLmIterations).toEqual(b.candidateLmIterations);
  });
});
