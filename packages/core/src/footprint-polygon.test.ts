import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createCoasterFileV1,
  deserializeCoasterFileV1,
  parseDesignIntentV1,
  serializeCoasterFileV1,
  serializeDesignIntentV1,
  validateDesignIntentV1,
  coasterFileChecksum,
  footprintBounds,
  isPointInsidePolygon,
  signedDistanceXZ,
  segmentWithinPolygon,
  validateFootprintPolygon,
  vec3,
  SeventhOrderHermiteSpan,
  compileTrack,
  reconstructSolvedSpan,
  type CoasterFileV1,
  type DesignIntentV1,
  type SerializedSolvedSpanV1,
} from "./index";
import type { Vec3 } from "./index";

const asciiToBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const pentagon: Vec3[] = [
  vec3(0, 0, 0),
  vec3(100, 0, 0),
  vec3(100, 0, 50),
  vec3(50, 0, 80),
  vec3(0, 0, 50),
];
const concaveCW: Vec3[] = [
  vec3(0, 5, 0),
  vec3(0, 2, 10),
  vec3(5, 9, 10),
  vec3(5, 1, 5),
  vec3(10, 0, 5),
  vec3(10, 0, 0),
];
const concaveCCW = [...concaveCW].reverse() as Vec3[];

const makeIntent = (
  footprint: unknown,
  heightRange?: { min: number; max: number },
): DesignIntentV1 =>
  ({
    schemaVersion: 1 as const,
    generatorVersion: "test-v1",
    seed: 123,
    mode: "directed" as const,
    family: "steel-sitdown-lsm-v1" as const,
    elements: [
      {
        id: "station-000",
        kind: "station",
        type: "station",
        parameters: { length: 10 },
      },
    ],
    gates: [],
    targets: [],
    constraints: [],
    ...(footprint !== undefined
      ? { footprint: footprint as unknown as DesignIntentV1["footprint"] }
      : {}),
    ...(heightRange ? { heightRange } : {}),
    terrainProfileId: "test",
    pinnedElementIds: [],
  }) as unknown as DesignIntentV1;

describe("footprint polygon validation", () => {
  it("valid pentagon and concave CW/CCW polygons preserve order", () => {
    for (const poly of [pentagon, concaveCW, concaveCCW]) {
      const out = validateFootprintPolygon(poly, "footprint");
      expect(out).toEqual(poly);
      const intent = makeIntent(poly);
      const ser = serializeDesignIntentV1(intent);
      const parsed = parseDesignIntentV1(ser);
      expect(parsed.footprint).toEqual(poly);
      const ser2 = serializeDesignIntentV1(parsed);
      expect(JSON.parse(ser2).footprint).toEqual(JSON.parse(ser).footprint);
    }
  });

  it("rejects explicit repeated closing vertex", () => {
    const closed = [...pentagon, vec3(0, 0, 0)];
    expect(() => validateFootprintPolygon(closed, "footprint")).toThrow(
      /explicit repeated closing vertex/,
    );
    const intent = makeIntent(closed);
    expect(() => validateDesignIntentV1(intent)).toThrow(
      /explicit repeated closing vertex/,
    );
  });

  it("rejects any duplicate projected X/Z vertex", () => {
    const dup = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 0),
    ] as Vec3[];
    expect(() => validateFootprintPolygon(dup, "footprint")).toThrow(
      /duplicate/,
    );
    const dup2 = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(5, 0, 5),
      vec3(10, 0, 0),
      vec3(0, 0, 10),
    ] as Vec3[];
    expect(() => validateFootprintPolygon(dup2, "footprint")).toThrow(
      /duplicate/,
    );
  });

  it("rejects zero-length projected edge", () => {
    const zeroEdge = [
      vec3(0, 0, 0),
      vec3(0, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ] as Vec3[];
    expect(() => validateFootprintPolygon(zeroEdge, "footprint")).toThrow(
      /duplicate|zero-length/,
    );
  });

  it("rejects zero projected shoelace area (collinear)", () => {
    const collinear = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0)] as Vec3[];
    expect(() => validateFootprintPolygon(collinear, "footprint")).toThrow(
      /zero projected shoelace area/,
    );
  });

  it("rejects non-adjacent crossing/touching bow-tie", () => {
    const bow = [
      vec3(0, 0, 0),
      vec3(2, 0, 2),
      vec3(2, 0, 0),
      vec3(0, 0, 2),
    ] as Vec3[];
    expect(() => validateFootprintPolygon(bow, "footprint")).toThrow(
      /non-adjacent|zero projected shoelace/,
    );
  });

  it("rejects adjacent edges overlapping/retracing beyond shared endpoint", () => {
    const retrace = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(5, 0, 0),
      vec3(5, 0, 10),
      vec3(0, 0, 10),
    ] as Vec3[];
    expect(() => validateFootprintPolygon(retrace, "footprint")).toThrow(
      /adjacent.*overlapping\/retracing/,
    );
  });

  it("preserves Y finite but ignored", () => {
    const withY = pentagon.map((p) => vec3(p[0], 999, p[2])) as Vec3[];
    const out = validateFootprintPolygon(withY, "footprint");
    expect(out[0]![1]).toBe(999);
    expect(isPointInsidePolygon(withY, vec3(50, 123, 25))).toBe(
      isPointInsidePolygon(pentagon, vec3(50, 0, 25)),
    );
    expect(() =>
      validateFootprintPolygon(
        [vec3(0, Infinity, 0), vec3(1, 0, 0), vec3(0, 0, 1)],
        "footprint",
      ),
    ).toThrow(/finite/);
  });
});

describe("edge-case honesty", () => {
  it("valid n=3 triangle and n=32 max polygon preserve order", () => {
    const tri: Vec3[] = [vec3(0, 0, 0), vec3(10, 0, 0), vec3(5, 0, 8)];
    expect(validateFootprintPolygon(tri, "footprint")).toEqual(tri);
    const poly32: Vec3[] = Array.from({ length: 32 }, (_, i) => {
      const ang = (i * 2 * Math.PI) / 32;
      return vec3(50 + 30 * Math.cos(ang), 0, 50 + 30 * Math.sin(ang));
    });
    const out32 = validateFootprintPolygon(poly32, "footprint");
    expect(out32).toHaveLength(32);
    expect(out32[0]).toEqual(poly32[0]);
    expect(out32[31]).toEqual(poly32[31]);
  });

  it("invalid n=2 and n=33 are rejected", () => {
    const two: Vec3[] = [vec3(0, 0, 0), vec3(1, 0, 0)];
    expect(() => validateFootprintPolygon(two, "footprint")).toThrow(
      /at least 3/,
    );
    const thirtyThree: Vec3[] = Array.from({ length: 33 }, (_, i) =>
      vec3(i, 0, (i % 2) * 10),
    );
    expect(() => validateFootprintPolygon(thirtyThree, "footprint")).toThrow(
      /at most 32/,
    );
  });

  it("finite X/Z NaN/Infinity are rejected", () => {
    expect(() =>
      validateFootprintPolygon(
        [vec3(0, 0, 0), vec3(NaN, 0, 0), vec3(0, 0, 10)],
        "footprint",
      ),
    ).toThrow(/finite/);
    expect(() =>
      validateFootprintPolygon(
        [vec3(0, 0, 0), vec3(Infinity, 0, 0), vec3(0, 0, 10)],
        "footprint",
      ),
    ).toThrow(/finite/);
    expect(() =>
      validateFootprintPolygon(
        [vec3(0, 0, 0), vec3(10, 0, 0), vec3(10, 0, NaN)],
        "footprint",
      ),
    ).toThrow(/finite/);
  });

  it("non-array and wrong vector length are rejected", () => {
    expect(() =>
      validateFootprintPolygon("not-array" as unknown as Vec3[], "footprint"),
    ).toThrow(/expected polygon array/);
    expect(() =>
      validateFootprintPolygon(
        [[0, 0] as unknown as Vec3, vec3(10, 0, 0), vec3(0, 0, 10)],
        "footprint",
      ),
    ).toThrow(/3-vector/);
    expect(() =>
      validateFootprintPolygon(
        [vec3(0, 0, 0), [0, 0, 0, 0] as unknown as Vec3, vec3(0, 0, 10)],
        "footprint",
      ),
    ).toThrow(/3-vector/);
  });

  it("isolated adjacent zero-length edge reports zero-length even with differing Y", () => {
    const isolated: Vec3[] = [
      vec3(0, 0, 0),
      vec3(0, 999, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ];
    expect(() => validateFootprintPolygon(isolated, "footprint")).toThrow(
      /zero-length/,
    );
  });

  it("45-degree transform near tolerance band preserves classification and distance magnitude", () => {
    const square: Vec3[] = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ];
    const inside = vec3(5, 0, 5);
    const epsNear = 5e-10;
    const boundaryNear = vec3(5, 0, 0 + epsNear);
    const outsideNear = vec3(5, 0, -5e-8);
    const dInside = signedDistanceXZ(square, inside);
    const dBoundary = signedDistanceXZ(square, boundaryNear);
    const dOutside = signedDistanceXZ(square, outsideNear);
    expect(dBoundary).toBe(0);
    expect(dInside).toBeLessThan(0);
    expect(dOutside).toBeGreaterThan(0);

    const ang = Math.PI / 4;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const rotate = (p: Vec3): Vec3 =>
      vec3(p[0] * cos - p[2] * sin, p[1], p[0] * sin + p[2] * cos);
    const squareR = square.map(rotate) as Vec3[];
    const insideR = rotate(inside);
    const boundaryR = rotate(boundaryNear);
    const outsideR = rotate(outsideNear);
    expect(isPointInsidePolygon(squareR, insideR)).toBe(true);
    expect(isPointInsidePolygon(squareR, boundaryR)).toBe(true);
    expect(isPointInsidePolygon(squareR, outsideR)).toBe(false);
    const dInsideR = signedDistanceXZ(squareR, insideR);
    const dOutsideR = signedDistanceXZ(squareR, outsideR);
    expect(Math.abs(Math.abs(dInsideR) - Math.abs(dInside))).toBeLessThan(1e-8);
    expect(Math.abs(Math.abs(dOutsideR) - Math.abs(dOutside))).toBeLessThan(
      1e-8,
    );
    expect(signedDistanceXZ(squareR, boundaryR)).toBe(0);
  });

  it("nonfinite segment endpoints fail closed without NaN witness", () => {
    const square: Vec3[] = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ];
    const badA = vec3(NaN, 0, 0);
    const badB = vec3(Infinity, 0, 0);
    const res1 = segmentWithinPolygon(square, badA, vec3(5, 0, 5));
    const res2 = segmentWithinPolygon(square, vec3(5, 0, 5), badB);
    const res3 = segmentWithinPolygon(
      square,
      vec3(0, 0, 0) as unknown as Vec3,
      vec3(5, 0, 5),
    );
    expect(res1.inside).toBe(false);
    expect(res2.inside).toBe(false);
    expect(res1.witness === undefined || Number.isFinite(res1.witness[0])).toBe(
      true,
    );
    expect(
      res2.witness === undefined || Number.isFinite(res2.witness![0]),
    ).toBe(true);
    if (res1.witness) {
      expect(
        Number.isFinite(res1.witness[0]) &&
          Number.isFinite(res1.witness[1]) &&
          Number.isFinite(res1.witness[2]),
      ).toBe(true);
    }
    if (res2.witness) {
      expect(
        Number.isFinite(res2.witness[0]) &&
          Number.isFinite(res2.witness[1]) &&
          Number.isFinite(res2.witness[2]),
      ).toBe(true);
    }
    expect(res3.witness === undefined || Number.isFinite(res3.witness[0])).toBe(
      true,
    );
  });
});

describe("point classification and signed distance", () => {
  const poly = pentagon;
  it("boundary/vertex/inside/outside half-open inclusive", () => {
    expect(isPointInsidePolygon(poly, vec3(50, 0, 25))).toBe(true);
    expect(isPointInsidePolygon(poly, vec3(5, 0, 5))).toBe(true);
    expect(isPointInsidePolygon(poly, vec3(0, 0, 0))).toBe(true);
    expect(isPointInsidePolygon(poly, vec3(50, 0, 0))).toBe(true);
    expect(isPointInsidePolygon(poly, vec3(200, 0, 200))).toBe(false);
    const concave = concaveCW;
    expect(isPointInsidePolygon(concave, vec3(7, 0, 7))).toBe(false);
    expect(isPointInsidePolygon(concave, vec3(2, 0, 2))).toBe(true);
  });

  it("signed distances negative inside zero boundary positive outside", () => {
    expect(signedDistanceXZ(poly, vec3(50, 0, 25))).toBeLessThan(0);
    expect(signedDistanceXZ(poly, vec3(50, 0, 0))).toBe(0);
    expect(signedDistanceXZ(poly, vec3(0, 0, 0))).toBe(0);
    const outside = signedDistanceXZ(poly, vec3(200, 0, 200));
    expect(outside).toBeGreaterThan(0);
    const d = signedDistanceXZ(poly, vec3(50, 0, -10));
    expect(d).toBeCloseTo(10, 5);
  });
});

describe("segmentWithinPolygon", () => {
  const poly = pentagon;
  const concave = [
    vec3(0, 0, 0),
    vec3(10, 0, 0),
    vec3(10, 0, 5),
    vec3(5, 0, 5),
    vec3(5, 0, 10),
    vec3(0, 0, 10),
  ] as Vec3[];

  it("segment fully inside", () => {
    const a = vec3(1, 0, 1);
    const b = vec3(2, 0, 2);
    expect(segmentWithinPolygon(poly, a, b).inside).toBe(true);
  });

  it("segment crossing concave notch outside", () => {
    const a = vec3(2, 0, 7);
    const b = vec3(7, 0, 7);
    const res = segmentWithinPolygon(concave, a, b);
    expect(res.inside).toBe(false);
    expect(res.witness).toBeDefined();
    expect(isPointInsidePolygon(concave, res.witness!)).toBe(false);
  });

  it("boundary-aligned segment inside", () => {
    const a = vec3(0, 0, 0);
    const b = vec3(10, 0, 0);
    expect(segmentWithinPolygon(poly, a, b).inside).toBe(true);
  });

  it("tangent at vertex", () => {
    const a = vec3(50, 0, 80);
    const b = vec3(50, 0, 120);
    const res = segmentWithinPolygon(poly, a, b);
    expect(res.inside).toBe(false);
  });

  it("degenerate point segment", () => {
    expect(
      segmentWithinPolygon(poly, vec3(50, 0, 25), vec3(50, 0, 25)).inside,
    ).toBe(true);
    expect(
      segmentWithinPolygon(poly, vec3(200, 0, 200), vec3(200, 0, 200)).inside,
    ).toBe(false);
  });
});

describe("transform invariance", () => {
  it("translation/rotation preserves classification and distance magnitude", () => {
    const poly = pentagon;
    const ptInside = vec3(50, 0, 25);
    const ptOutside = vec3(200, 0, 200);
    const dInsideBefore = signedDistanceXZ(poly, ptInside);
    const dOutsideBefore = signedDistanceXZ(poly, ptOutside);
    const insideBefore = isPointInsidePolygon(poly, ptInside);

    const tx = 1000,
      tz = 500;
    const translate = (p: Vec3): Vec3 => vec3(p[0] + tx, p[1], p[2] + tz);
    const polyT = poly.map(translate) as Vec3[];
    expect(isPointInsidePolygon(polyT, translate(ptInside))).toBe(insideBefore);
    expect(
      Math.abs(signedDistanceXZ(polyT, translate(ptInside)) - dInsideBefore),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(signedDistanceXZ(polyT, translate(ptOutside)) - dOutsideBefore),
    ).toBeLessThan(1e-9);

    const cos = Math.cos(Math.PI / 2);
    const sin = Math.sin(Math.PI / 2);
    const rotate = (p: Vec3): Vec3 =>
      vec3(p[0] * cos - p[2] * sin, p[1], p[0] * sin + p[2] * cos);
    const polyR = poly.map(rotate) as Vec3[];
    const ptRInside = rotate(ptInside);
    const ptROutside = rotate(ptOutside);
    expect(isPointInsidePolygon(polyR, ptRInside)).toBe(insideBefore);
    expect(
      Math.abs(
        Math.abs(signedDistanceXZ(polyR, ptRInside)) - Math.abs(dInsideBefore),
      ),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(
        Math.abs(signedDistanceXZ(polyR, ptROutside)) -
          Math.abs(dOutsideBefore),
      ),
    ).toBeLessThan(1e-9);

    const polyRev = [...poly].reverse() as Vec3[];
    expect(isPointInsidePolygon(polyRev, ptInside)).toBe(insideBefore);
    expect(signedDistanceXZ(polyRev, ptInside)).toBeCloseTo(dInsideBefore, 9);
  });
});

describe("footprintBounds", () => {
  it("X/Z routing bounds only Y fixed zero", () => {
    const bounds = footprintBounds(pentagon);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max[0]).toBe(100);
    expect(bounds.max[2]).toBe(80);
    expect(bounds.min[1]).toBe(0);
    expect(bounds.max[1]).toBe(0);
  });
});

describe("legacy migration", () => {
  const legacyAabb = { min: [0, 5, 0] as Vec3, max: [10, 15, 10] as Vec3 };
  const legacyIntentJson = JSON.stringify({
    schemaVersion: 1,
    generatorVersion: "test-v1",
    seed: 42,
    mode: "directed",
    family: "steel-sitdown-lsm-v1",
    elements: [
      {
        id: "station-000",
        kind: "station",
        type: "station",
        parameters: { length: 10 },
      },
    ],
    gates: [],
    targets: [],
    constraints: [],
    footprint: legacyAabb,
    terrainProfileId: "test",
    pinnedElementIds: [],
  });

  it("legacy intent string/bytes migration to polygon order", () => {
    const parsed = parseDesignIntentV1(legacyIntentJson);
    expect(parsed.footprint).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ]);
    const parsedBytes = parseDesignIntentV1(asciiToBytes(legacyIntentJson));
    expect(parsedBytes.footprint).toEqual(parsed.footprint);
  });

  it("preserves existing heightRange; derives when absent", () => {
    const withRange = JSON.parse(legacyIntentJson) as Record<string, unknown>;
    (withRange as Record<string, unknown>).heightRange = { min: 0, max: 100 };
    const parsed = parseDesignIntentV1(JSON.stringify(withRange));
    expect(parsed.heightRange).toEqual({ min: 0, max: 100 });
    const parsed2 = parseDesignIntentV1(legacyIntentJson);
    expect(parsed2.heightRange).toEqual({ min: 5, max: 15 });
  });

  it("canonical serialization contains array only", () => {
    const parsed = parseDesignIntentV1(legacyIntentJson);
    const ser = serializeDesignIntentV1(parsed);
    const obj = JSON.parse(ser) as Record<string, unknown>;
    expect(Array.isArray(obj.footprint)).toBe(true);
    const fp = obj.footprint as unknown[];
    expect(fp[0]).toEqual([0, 0, 0]);
    expect(obj).not.toHaveProperty("min");
    expect(JSON.stringify(obj.footprint)).not.toContain("min");
  });

  it("deserializeCoasterFileV1 string/bytes legacy migration", () => {
    const polyIntent: DesignIntentV1 = {
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "e0",
          kind: "station",
          type: "station",
          parameters: { length: 10 },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      footprint: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 0, 10],
        [0, 0, 10],
      ] as unknown as Vec3[],
      terrainProfileId: "t",
      pinnedElementIds: [],
    };
    const spans: SerializedSolvedSpanV1[] = [
      {
        id: "e0",
        kind: "station",
        positionCoefficients: [
          [0, 10, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
        ],
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 10,
      },
    ];
    const file = createCoasterFileV1({
      name: "test",
      intent: polyIntent,
      solvedSpans: spans,
      seed: 7,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: "00000000",
    });
    const legacyFileObj = JSON.parse(serializeCoasterFileV1(file)) as Record<
      string,
      unknown
    >;
    const intentRec = legacyFileObj.intent as Record<string, unknown>;
    intentRec.footprint = {
      min: [0, 5, 0],
      max: [10, 15, 10],
    };
    delete intentRec.heightRange;
    const legacyJson = JSON.stringify(legacyFileObj);
    const des = deserializeCoasterFileV1(legacyJson);
    expect(des.intent.footprint).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ]);
    expect(des.intent.heightRange).toEqual({ min: 5, max: 15 });
    const desBytes = deserializeCoasterFileV1(asciiToBytes(legacyJson));
    expect(desBytes.intent.footprint).toEqual(des.intent.footprint);
    const reser = JSON.parse(serializeCoasterFileV1(des)) as Record<
      string,
      unknown
    >;
    const reserIntent = reser.intent as Record<string, unknown>;
    expect(Array.isArray(reserIntent.footprint)).toBe(true);
  });

  it("compileCoasterFile object legacy migration preserves solved coefficients and checksum", () => {
    const polyIntent: DesignIntentV1 = {
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 99,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "e0",
          kind: "station",
          type: "station",
          parameters: { length: 10 },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      footprint: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 0, 10],
        [0, 0, 10],
      ] as unknown as Vec3[],
      heightRange: { min: 2, max: 8 },
      terrainProfileId: "t",
      pinnedElementIds: [],
    };
    const spans: SerializedSolvedSpanV1[] = [
      {
        id: "e0",
        kind: "station",
        positionCoefficients: [
          [0, 10, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
        ],
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 10,
      },
    ];
    const serialized = spans.map((s) => ({
      id: s.id,
      kind: s.kind,
      positionCoefficients: s.positionCoefficients,
      rollCoefficients: s.rollCoefficients,
      length: s.length,
    }));
    const canonicalSpans = serialized.map((s) =>
      reconstructSolvedSpan(s as unknown as SerializedSolvedSpanV1),
    );
    const canonicalTrack = compileTrack(canonicalSpans, {});
    const file = createCoasterFileV1({
      name: "test",
      intent: polyIntent,
      solvedSpans: spans,
      seed: 99,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: canonicalTrack.checksum,
    });
    const checksumBefore = file.compiledDataChecksum;
    const originalHash = coasterFileChecksum(file);
    const legacyFile = JSON.parse(JSON.stringify(file)) as Record<
      string,
      unknown
    >;
    const intentRec = legacyFile.intent as Record<string, unknown>;
    intentRec.footprint = { min: [0, 2, 0], max: [10, 8, 10] };
    const loaded = compileCoasterFile(legacyFile as unknown as CoasterFileV1);
    expect(loaded.file.intent.footprint).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ]);
    expect(loaded.file.intent.heightRange).toEqual({ min: 2, max: 8 });
    expect(loaded.solvedSpans[0]!.positionCoefficients).toEqual(
      spans[0]!.positionCoefficients,
    );
    expect(loaded.file.compiledDataChecksum).toBe(checksumBefore);
    expect(coasterFileChecksum(loaded.file)).toBe(originalHash);
    // ensure caller not mutated
    expect((legacyFile.intent as Record<string, unknown>).footprint).toEqual({
      min: [0, 2, 0],
      max: [10, 8, 10],
    });
  });

  it("legacy design wrapper migration via deserialize still works", () => {
    const legacyWrapperJson = JSON.stringify({
      schemaVersion: 1,
      name: "legacy",
      seed: 5,
      design: { elements: [] },
    });
    const des = deserializeCoasterFileV1(legacyWrapperJson);
    expect(des.intent.elements).toEqual([]);
    const desBytes = deserializeCoasterFileV1(asciiToBytes(legacyWrapperJson));
    expect(desBytes.intent.elements).toEqual([]);
  });

  it("corrupt checksums still reject", () => {
    const intent = makeIntent(pentagon);
    const spans: SerializedSolvedSpanV1[] = [
      {
        id: "station-000",
        kind: "station",
        positionCoefficients: [
          [0, 10, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
        ],
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 10,
      },
    ];
    const canonSpans = spans.map((s) => ({
      id: s.id,
      span: SeventhOrderHermiteSpan.fromCoefficients(
        s.positionCoefficients as unknown as Vec3[],
      ),
    }));
    const track = compileTrack(
      canonSpans as unknown as Parameters<typeof compileTrack>[0],
      {},
    );
    const file = createCoasterFileV1({
      name: "test",
      intent,
      solvedSpans: spans,
      seed: 123,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: track.checksum,
    });
    const bad = {
      ...file,
      compiledDataChecksum: "deadbeef",
    } as unknown as CoasterFileV1;
    expect(() => compileCoasterFile(bad)).toThrow(/checksum mismatch/);
  });
});
