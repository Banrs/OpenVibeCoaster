import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CoasterFileError,
  HeightfieldEnvironment,
  compileCoasterFile,
  createCoasterFileV1,
  deserializeCoasterFileV1,
  parseDesignIntentV1,
  serializeCoasterFileV1,
  compileTrack,
  reconstructSolvedSpan,
  validateDesignIntentV1,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  vec3,
} from "./index";
import type { Vec3 } from "./index";

const intent = {
  schemaVersion: 1 as const,
  generatorVersion: "generator-v1",
  seed: 0xffffffff,
  mode: "directed" as const,
  family: "steel-sitdown-lsm-v1" as const,
  elements: [
    {
      id: "station-000",
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    },
  ],
  gates: [{ id: "start", position: [0, 0, 0] as const }],
  targets: [{ id: "length", kind: "total-length", target: 12, hard: false }],
  constraints: [],
  footprint: { min: [-10, -1, -10] as const, max: [20, 10, 10] as const },
  heightRange: { min: -1, max: 100 },
  terrainProfileId: "flat",
  pinnedElementIds: ["station-000"],
};

describe("wave 3 core contracts", () => {
  it("validates canonical intent and rejects extra fields", () => {
    expect(() => validateDesignIntentV1(intent)).not.toThrow();
    expect(() =>
      validateDesignIntentV1({ ...intent, unexpected: true }),
    ).toThrow(CoasterFileError);
    expect(() => validateDesignIntentV1({ ...intent, seed: -1 })).toThrow(
      "seed: expected uint32 integer",
    );
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        elements: [
          {
            ...intent.elements[0],
            id: "station-001",
            kind: "station",
            type: "launch",
          },
        ],
      }),
    ).toThrow("kind and type must match");
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        elements: [
          intent.elements[0],
          { ...intent.elements[0], id: "station-000" },
        ],
      }),
    ).toThrow("unique non-empty id");
  });

  it("requires a spatial gate position and accepts a finite optional orientation", () => {
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        gates: [{ id: "legacy-distance", at: 12 }],
      }),
    ).toThrow("gates[0].position: expected 3-vector");
    expect(() =>
      parseDesignIntentV1(
        JSON.stringify({
          ...intent,
          gates: [{ id: "legacy-distance", at: 12 }],
        }),
      ),
    ).toThrow("gates[0].position: expected 3-vector");

    const oriented = {
      ...intent,
      gates: [
        {
          id: "oriented",
          position: [1, 2, 3] as const,
          orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const,
        },
      ],
    };
    expect(() => validateDesignIntentV1(oriented)).not.toThrow();
    expect(parseDesignIntentV1(JSON.stringify(oriented)).gates[0]).toEqual(
      oriented.gates[0],
    );
  });

  it("rejects zero, malformed, and non-finite gate orientations during validation", () => {
    const invalidOrientations: readonly unknown[] = [
      [0, 0, 0, 0],
      [0, 0, 1],
      [0, 0, 0, 1, 0],
      [Number.NaN, 0, 0, 1],
      [0, Number.POSITIVE_INFINITY, 0, 1],
    ];
    for (const orientation of invalidOrientations)
      expect(() =>
        validateDesignIntentV1({
          ...intent,
          gates: [{ id: "invalid", position: [0, 0, 0], orientation }],
        }),
      ).toThrow(CoasterFileError);
  });

  it("preserves strict gate unknown-field and stable-id validation", () => {
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        gates: [{ id: "unknown", position: [0, 0, 0], extra: true }],
      }),
    ).toThrow("gates[0].extra: expected no extra field");
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        gates: [
          { id: "duplicate", position: [0, 0, 0] },
          { id: "duplicate", position: [1, 0, 0] },
        ],
      }),
    ).toThrow("gates[1].id: expected unique non-empty id");
  });

  it("round-trips strict coaster files canonically with exact span geometry", () => {
    const position = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(10, 0, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 5, 0),
      d11: vec3(10, 0, 0),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const roll = new QuinticScalarSpan({
      v0: 0,
      d10: 0,
      d20: 0,
      v1: 1,
      d11: 0,
      d21: 0,
    });
    const serializedSpan = {
      id: "station-000",
      kind: "station",
      length: 12,
      positionCoefficients: position.coefficients,
      rollCoefficients: roll.coefficients,
    };
    const file = createCoasterFileV1({
      name: "unicode 🎢",
      intent,
      solvedSpans: [serializedSpan],
      seed: intent.seed,
      generatorVersion: intent.generatorVersion,
      profileVersion: "profile-v1",
      researchSnapshotIds: ["snapshot-a"],
      compiledDataChecksum: compileTrack(
        [reconstructSolvedSpan(serializedSpan)],
        { samples: 32 },
      ).checksum,
    });
    const encoded = serializeCoasterFileV1(file);
    expect(serializeCoasterFileV1(deserializeCoasterFileV1(encoded))).toBe(
      encoded,
    );
    const loaded = compileCoasterFile(file, { samples: 16 });
    expect(loaded.track.positions[0]).toBe(0);
    expect(loaded.track.positions[loaded.track.positions.length - 3]).toBe(10);
    expect(file.design.elements).toEqual(intent.elements);
  });

  it("rejects a tampered compiled checksum on load", () => {
    const position = SeventhOrderHermiteSpan.line(
      vec3(0, 0, 0),
      vec3(10, 0, 0),
    );
    const roll = QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0]);
    const file = createCoasterFileV1({
      name: "checksum",
      intent,
      solvedSpans: [
        {
          id: "station-000",
          kind: "station",
          length: 10,
          positionCoefficients: position.coefficients,
          rollCoefficients: roll.coefficients,
        },
      ],
      seed: intent.seed,
      generatorVersion: intent.generatorVersion,
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: "00000000",
    });
    expect(() => compileCoasterFile(file)).toThrow("checksum");
  });

  it("rejects extra fields in the legacy compatibility entry path", () => {
    expect(() =>
      deserializeCoasterFileV1(
        JSON.stringify({
          schemaVersion: 1,
          name: "legacy",
          seed: 1,
          design: { elements: [], extra: true },
        }),
      ),
    ).toThrow("design.extra: expected no extra field");
    expect(() =>
      deserializeCoasterFileV1(
        JSON.stringify({
          schemaVersion: 1,
          name: "legacy",
          seed: 1,
          design: { elements: [] },
          extra: true,
        }),
      ),
    ).toThrow("file.extra: expected no extra field");
  });

  it("rejects target values whose shape does not match the target kind", () => {
    expect(() =>
      validateDesignIntentV1({
        ...intent,
        targets: [
          { id: "end-z", kind: "end-z", target: [0, 0, 1], hard: true },
        ],
      }),
    ).toThrow("target: expected finite number");
  });

  it("rejects vector constraint values for scalar constraint kinds", () => {
    for (const kind of ["max-height", "min-height", "track-clearance"])
      expect(() =>
        validateDesignIntentV1({
          ...intent,
          constraints: [
            { id: kind, kind, value: [0, 0, 0] as const, hard: true },
          ],
        }),
      ).toThrow(`constraints[0].value: expected finite number`);
  });

  it("keeps legacy gates, enforces their three-gate limit, and rejects unknown strict spans", () => {
    const legacy = {
      schemaVersion: 1,
      name: "legacy",
      seed: 1,
      design: {
        elements: [],
        gates: [
          { id: "a", at: 0, kind: "gate" },
          { id: "b", at: 1, kind: "gate" },
          { id: "c", at: 2, kind: "gate" },
          { id: "d", at: 3, kind: "gate" },
        ],
      },
    };
    expect(() => deserializeCoasterFileV1(JSON.stringify(legacy))).toThrow(
      "design.gates: expected at most 3 items",
    );

    const emptyIntent = { ...intent, elements: [], gates: [] };
    const span = {
      id: "unknown",
      kind: "station",
      length: 1,
      positionCoefficients: SeventhOrderHermiteSpan.line(
        vec3(0, 0, 0),
        vec3(1, 0, 0),
      ).coefficients,
      rollCoefficients: QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0])
        .coefficients,
    };
    expect(() =>
      createCoasterFileV1({
        name: "empty",
        intent: emptyIntent,
        solvedSpans: [span],
        seed: emptyIntent.seed,
        generatorVersion: emptyIntent.generatorVersion,
        profileVersion: "profile-v1",
        researchSnapshotIds: [],
        compiledDataChecksum: "00000000",
      }),
    ).toThrow("solvedSpans[0].id");
  });

  it("provides signed solid samples and finite terrain bounds", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 5,
      heights: [0, 2, 1, 3],
      origin: [10, -4],
    });
    expect(environment.sampleSolid(vec3(10, 10, -4))).toBeGreaterThan(0);
    expect(environment.sampleSolid(vec3(10, -1, -4))).toBeLessThan(0);
    expect(environment.bounds().min).toEqual([10, 0, -4]);
    expect(environment.bounds().max).toEqual([15, 3, 1]);
  });

  it("reproduces the reviewer 3 by 3 local-projection discontinuity", () => {
    const environment = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights: [0, 5, 0, 5, 20, 5, 0, 5, 0],
    });
    const first = vec3(0.02, 21.90000360197199, 1.18);
    const second = vec3(0.02854, 21.90000360197199, 1.18);
    const separation = Math.hypot(
      first[0] - second[0],
      first[1] - second[1],
      first[2] - second[2],
    );
    const distanceChange = Math.abs(
      environment.signedDistance(first) - environment.signedDistance(second),
    );

    expect(separation).toBeCloseTo(0.00854, 12);
    expect(distanceChange).toBeLessThanOrEqual(separation + 1e-9);
  });

  it("keeps deterministic randomized local signed-distance pairs 1-Lipschitz", () => {
    let checkedPairs = 0;
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20, max: 20 }), {
          minLength: 9,
          maxLength: 9,
        }),
        fc.integer({ min: -100, max: 300 }),
        fc.integer({ min: -2500, max: 2500 }),
        fc.integer({ min: -100, max: 300 }),
        fc
          .tuple(
            fc.integer({ min: -8, max: 8 }),
            fc.integer({ min: -8, max: 8 }),
            fc.integer({ min: -8, max: 8 }),
          )
          .filter(([dx, dy, dz]) => dx !== 0 || dy !== 0 || dz !== 0),
        (heights, x, y, z, [dx, dy, dz]) => {
          const environment = new HeightfieldEnvironment({
            width: 3,
            depth: 3,
            cellSize: 1,
            heights,
          });
          const first = vec3(x / 100, y / 100, z / 100);
          const second = vec3(
            first[0] + dx / 1000,
            first[1] + dy / 1000,
            first[2] + dz / 1000,
          );
          const separation = Math.hypot(dx, dy, dz) / 1000;
          const distanceChange = Math.abs(
            environment.signedDistance(first) -
              environment.signedDistance(second),
          );
          checkedPairs += 1;
          expect(distanceChange).toBeLessThanOrEqual(separation + 2e-8);
        },
      ),
      { numRuns: 75, seed: 0x3a71c0de },
    );
    expect(checkedPairs).toBe(75);
  });

  it("returns signed Euclidean distances for known flat and sloped graphs", () => {
    const flat = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 2,
      heights: [3, 3, 3, 3],
    });
    expect(flat.signedDistance(vec3(0.5, 5, 0.5))).toBeCloseTo(2, 10);
    expect(flat.signedDistance(vec3(0.5, 1, 0.5))).toBeCloseTo(-2, 10);

    const heights = Array.from({ length: 25 }, (_, index) => {
      const x = index % 5;
      const z = Math.floor(index / 5);
      return x + 2 * z;
    });
    const slope = new HeightfieldEnvironment({
      width: 5,
      depth: 5,
      cellSize: 1,
      heights,
    });
    const surface = vec3(2, 6, 2);
    const normal = vec3(-1 / Math.sqrt(6), 1 / Math.sqrt(6), -2 / Math.sqrt(6));
    const above = vec3(
      surface[0] + normal[0] * 0.5,
      surface[1] + normal[1] * 0.5,
      surface[2] + normal[2] * 0.5,
    );
    const below = vec3(
      surface[0] - normal[0] * 0.5,
      surface[1] - normal[1] * 0.5,
      surface[2] - normal[2] * 0.5,
    );
    expect(slope.signedDistance(above)).toBeCloseTo(0.5, 9);
    expect(slope.signedDistance(below)).toBeCloseTo(-0.5, 9);
  });

  it("keeps the clamped height graph 1-Lipschitz outside the sampled footprint", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 0, 0, 0],
    });
    const above = vec3(-100, 0.001, 0.5);
    const below = vec3(-100, -0.001, 0.5);

    expect(environment.signedDistance(above)).toBeCloseTo(0.001, 12);
    expect(environment.signedDistance(below)).toBeCloseTo(-0.001, 12);
    expect(
      Math.abs(
        environment.signedDistance(above) - environment.signedDistance(below),
      ),
    ).toBeLessThanOrEqual(0.002 + 1e-12);
  });

  it("rejects non-finite heightfield construction and query inputs", () => {
    const options = {
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 0, 0, 0],
    };
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, 1, 2.5])
      expect(() => new HeightfieldEnvironment({ ...options, width })).toThrow(
        RangeError,
      );
    for (const depth of [Number.NaN, Number.NEGATIVE_INFINITY, 1, 2.5])
      expect(() => new HeightfieldEnvironment({ ...options, depth })).toThrow(
        RangeError,
      );
    for (const cellSize of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1])
      expect(
        () => new HeightfieldEnvironment({ ...options, cellSize }),
      ).toThrow(RangeError);
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        () =>
          new HeightfieldEnvironment({
            ...options,
            heights: [0, 0, 0, height],
          }),
      ).toThrow(RangeError);
    expect(
      () => new HeightfieldEnvironment({ ...options, heights: [0, 0, 0] }),
    ).toThrow(RangeError);
    expect(
      () =>
        new HeightfieldEnvironment({
          ...options,
          heights: null as unknown as ArrayLike<number>,
        }),
    ).toThrow(RangeError);
    for (const origin of [
      [Number.NaN, 0],
      [0, Number.NEGATIVE_INFINITY],
    ] as const)
      expect(() => new HeightfieldEnvironment({ ...options, origin })).toThrow(
        RangeError,
      );
    expect(
      () =>
        new HeightfieldEnvironment({
          ...options,
          cellSize: Number.MAX_VALUE,
          origin: [Number.MAX_VALUE, 0],
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new HeightfieldEnvironment({
          ...options,
          origin: [Number.MAX_VALUE, 0],
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new HeightfieldEnvironment({
          ...options,
          heights: [Number.MAX_VALUE, -Number.MAX_VALUE, 0, 0],
        }),
    ).toThrow(RangeError);

    const environment = new HeightfieldEnvironment(options);
    const invalidPoints: readonly Vec3[] = [
      null as unknown as Vec3,
      [0, 0] as unknown as Vec3,
      vec3(Number.NaN, 0, 0),
      vec3(0, Number.POSITIVE_INFINITY, 0),
      vec3(0, 0, Number.NEGATIVE_INFINITY),
    ];
    for (const point of invalidPoints) {
      expect(() => environment.signedDistance(point)).toThrow(RangeError);
      expect(() => environment.sampleSolid(point)).toThrow(RangeError);
    }
    expect(() => environment.heightAt(Number.NaN, 0)).toThrow(RangeError);
    expect(() => environment.normalAt(0, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    for (const origin of invalidPoints)
      expect(() => environment.raycast(origin, vec3(0, -1, 0), 10)).toThrow(
        RangeError,
      );
    for (const direction of [
      vec3(0, 0, 0),
      vec3(Number.NaN, -1, 0),
      vec3(0, Number.POSITIVE_INFINITY, 0),
    ])
      expect(() => environment.raycast(vec3(0, 1, 0), direction, 10)).toThrow(
        RangeError,
      );
    for (const maxDistance of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(() =>
        environment.raycast(vec3(0, 1, 0), vec3(0, -1, 0), maxDistance),
      ).toThrow(RangeError);
    expect(() =>
      environment.raycast(
        vec3(Number.MAX_VALUE, 1, 0),
        vec3(1, 0, 0),
        Number.MAX_VALUE,
      ),
    ).toThrow(RangeError);
  });

  it("publishes only finite solid, bounds, and raycast results", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 1, 1, 2],
      origin: [-1, -1],
    });
    const solid = environment.sampleSolid(vec3(-0.5, 3, -0.5));
    const bounds = environment.bounds();
    const hit = environment.raycast(vec3(-0.5, 3, -0.5), vec3(0, -1, 0), 10);

    expect(Number.isFinite(solid)).toBe(true);
    expect([...bounds.min, ...bounds.max].every(Number.isFinite)).toBe(true);
    expect(hit).toBeDefined();
    expect(
      hit
        ? [hit.distance, ...hit.point, ...hit.normal].every(Number.isFinite)
        : false,
    ).toBe(true);
  });
});
