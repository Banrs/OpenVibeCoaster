import { describe, expect, it } from "vitest";
import {
  CoasterFileError,
  HeightfieldEnvironment,
  compileCoasterFile,
  createCoasterFileV1,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
  compileTrack,
  reconstructSolvedSpan,
  validateDesignIntentV1,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  vec3,
} from "./index";

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
});
