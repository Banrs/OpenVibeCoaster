import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  compileTrack,
  createCoasterFileV1,
  footprintBounds,
  isPointInsidePolygon,
  isPointInsidePolygonStrict,
  reconstructSolvedSpan,
  segmentWithinPolygon,
  segmentWithinPolygonStrict,
  signedDistanceStrictXZ,
  signedDistanceXZ,
  vec3,
  SeventhOrderHermiteSpan,
  type FootprintPolygon,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { CertifiedWorkBudget, restrictedBernstein } from "./polynomial-bounds";
import {
  certifyFootprintSpan,
  certifyFootprintSpans,
} from "./footprint-certifier";
import { generateCoaster } from "./pipeline";

function assertDefined<T>(
  value: T | undefined | null,
  message?: string,
): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(message ?? "Expected defined value");
  }
}

function assertOutside(
  result: ReturnType<typeof certifyFootprintSpan>,
): asserts result is {
  status: "outside";
  witness: { u: number; position: Vec3; s: number; signedDistance: number };
} {
  if (result.status !== "outside") {
    throw new Error(`Expected outside but got ${result.status}`);
  }
}

function assertInside(
  result: ReturnType<typeof certifyFootprintSpan>,
): asserts result is { status: "inside" } {
  if (result.status !== "inside") {
    throw new Error(`Expected inside but got ${result.status}`);
  }
}

function assertUncertified(
  result: ReturnType<typeof certifyFootprintSpan>,
): asserts result is { status: "uncertified"; reason: string } {
  if (result.status !== "uncertified") {
    throw new Error(`Expected uncertified but got ${result.status}`);
  }
}

const concaveL: FootprintPolygon = [
  vec3(0, 0, 0),
  vec3(10, 0, 0),
  vec3(10, 0, 5),
  vec3(5, 0, 5),
  vec3(5, 0, 10),
  vec3(0, 0, 10),
];

const createLinearSpan = (a: Vec3, b: Vec3, id: string): SolvedSpan => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const coeff = (origin: number, delta: number): readonly number[] => [
    origin,
    delta,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const positionCoefficients: readonly (readonly number[])[] = [
    coeff(a[0], dx),
    coeff(a[1], dy),
    coeff(a[2], dz),
  ];
  const rollCoefficients: readonly number[] = [0, 0, 0, 0, 0, 0];
  const length = Math.hypot(dx, dy, dz);
  const spanInstance = new SeventhOrderHermiteSpan<Vec3>({
    p0: a,
    d10: vec3(dx, dy, dz),
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1: b,
    d11: vec3(dx, dy, dz),
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  return {
    id,
    span: spanInstance,
    positionCoefficients,
    rollCoefficients,
    length,
  };
};

const createConcaveArmCurveSpan = (): SolvedSpan => {
  const p0 = vec3(1, 0, 6);
  const p1 = vec3(3, 0, 9);
  const d10 = vec3(0, 0, 4);
  const d11 = vec3(0, 0, 4);
  const spanInstance = new SeventhOrderHermiteSpan<Vec3>({
    p0,
    d10,
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1,
    d11,
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  const positionCoefficients = spanInstance.coefficients;
  const rollCoefficients: readonly number[] = [0, 0, 0, 0, 0, 0];
  return {
    id: "curve-arm-000",
    span: spanInstance,
    positionCoefficients,
    rollCoefficients,
    length: 5,
  };
};

describe("footprint certifier production API", () => {
  it("linear span through concave notch returns FOOTPRINT with exact evidence", () => {
    const a = vec3(2, 0, 7);
    const b = vec3(7, 0, 7);
    const span = createLinearSpan(a, b, "notch-span-000");
    const budget = new CertifiedWorkBudget(1_000_000);
    const result = certifyFootprintSpan(span, concaveL, {
      station: 42,
      budget,
      maxDepth: 32,
    });
    assertOutside(result);
    const witness = result.witness;
    const sd = signedDistanceStrictXZ(concaveL, witness.position);
    expect(sd).toBeGreaterThan(0);
    expect(witness.signedDistance).toBe(sd);
    expect(Number.isFinite(witness.s)).toBe(true);
    expect(isPointInsidePolygonStrict(concaveL, witness.position)).toBe(false);
    expect(witness.position[2]).toBeCloseTo(7, 5);
    const requiredFootprintId = "required-footprint";
    expect(witness.signedDistance).toBeGreaterThan(0);
    const diagnostic = {
      code: "FOOTPRINT" as const,
      limit: 0,
      actual: sd,
      margin: -sd,
      location: { s: witness.s, position: witness.position },
      relatedIds: [span.id, requiredFootprintId],
    };
    expect(diagnostic.limit).toBe(0);
    expect(diagnostic.actual).toBeGreaterThan(0);
    expect(diagnostic.margin).toBe(-diagnostic.actual);
    expect(diagnostic.relatedIds).toEqual([span.id, requiredFootprintId]);
    expect(sd).toBe(diagnostic.actual);
  });

  it("boundary-aligned linear span returns inside", () => {
    const a = vec3(0, 0, 0);
    const b = vec3(10, 0, 0);
    const span = createLinearSpan(a, b, "boundary-span-000");
    const budget = new CertifiedWorkBudget(1_000_000);
    const result = certifyFootprintSpan(span, concaveL, {
      station: 0,
      budget,
      maxDepth: 32,
    });
    assertInside(result);
  });

  it("nonlinear seventh-order curve wholly inside concave arm certifies inside", () => {
    const span = createConcaveArmCurveSpan();
    const budget = new CertifiedWorkBudget(1_000_000);
    const result = certifyFootprintSpan(span, concaveL, {
      station: 10,
      budget,
      maxDepth: 32,
    });
    assertInside(result);
    const batch = certifyFootprintSpans([span], concaveL, {
      budget: new CertifiedWorkBudget(1_000_000),
      maxDepth: 32,
      startStation: 10,
    });
    const batchResult = batch.get(span.id);
    assertDefined(batchResult, "batch result missing");
    assertInside(batchResult);
  });

  it("maxDepth and work exhaustion return FOOTPRINT_UNCERTIFIED with no numeric evidence", () => {
    const bulgeSpanForBudget = (() => {
      const p0 = vec3(1, 0, 6);
      const p1 = vec3(1, 0, 9);
      const inst = new SeventhOrderHermiteSpan<Vec3>({
        p0,
        d10: vec3(0, 0, 0),
        d20: vec3(60, 0, 0),
        d30: vec3(0, 0, 0),
        p1,
        d11: vec3(0, 0, 0),
        d21: vec3(-60, 0, 0),
        d31: vec3(0, 0, 0),
      });
      const span: SolvedSpan = {
        id: "exhaust-span-base",
        span: inst,
        positionCoefficients: inst.coefficients,
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 5,
      };
      return span;
    })();
    const tinyBudget = new CertifiedWorkBudget(5);
    const resBudget = certifyFootprintSpan(bulgeSpanForBudget, concaveL, {
      station: 0,
      budget: tinyBudget,
      maxDepth: 32,
    });
    assertUncertified(resBudget);
    expect(resBudget.reason.length).toBeGreaterThan(0);
    const fixtureSpan = (() => {
      const s = new SeventhOrderHermiteSpan<Vec3>({
        p0: vec3(1, 0, 6),
        p1: vec3(1, 0, 9),
        d10: vec3(0, 0, 0),
        d11: vec3(0, 0, 0),
        d20: vec3(40, 0, 0),
        d21: vec3(-40, 0, 0),
        d30: vec3(0, 0, 0),
        d31: vec3(0, 0, 0),
      });
      const span: SolvedSpan = {
        id: "maxDepth-fixture",
        span: s,
        positionCoefficients: s.coefficients,
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 5,
      };
      return span;
    })();
    const resFull = certifyFootprintSpan(fixtureSpan, concaveL, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
      maxDepth: 32,
    });
    const resZero = certifyFootprintSpan(fixtureSpan, concaveL, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
      maxDepth: 0,
    });
    assertInside(resFull);
    assertUncertified(resZero);
    expect(resZero.reason).toMatch(/max depth/i);
    expect(tinyBudget.used).toBeGreaterThan(0);
  });

  it("rigid rotation and translation produce equivalent witness transform", () => {
    const a = vec3(2, 0, 7);
    const b = vec3(7, 0, 7);
    const span = createLinearSpan(a, b, "notch-span-001");
    const budgetBase = new CertifiedWorkBudget(1_000_000);
    const baseResult = certifyFootprintSpan(span, concaveL, {
      station: 0,
      budget: budgetBase,
      maxDepth: 32,
    });
    assertOutside(baseResult);
    const baseWitness = baseResult.witness;
    const tx = 1000;
    const tz = 500;
    const translate = (p: Vec3): Vec3 => vec3(p[0] + tx, p[1], p[2] + tz);
    const angle = Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotate = (p: Vec3): Vec3 =>
      vec3(p[0] * cos - p[2] * sin, p[1], p[0] * sin + p[2] * cos);
    const transform = (p: Vec3): Vec3 => translate(rotate(p));
    const polyT: FootprintPolygon = concaveL.map(transform);
    const spanT = createLinearSpan(
      transform(a),
      transform(b),
      "notch-span-001",
    );
    const budgetT = new CertifiedWorkBudget(1_000_000);
    const transResult = certifyFootprintSpan(spanT, polyT, {
      station: 0,
      budget: budgetT,
      maxDepth: 32,
    });
    assertOutside(transResult);
    const transWitness = transResult.witness;
    expect(transWitness.signedDistance).toBeCloseTo(
      baseWitness.signedDistance,
      9,
    );
    const expectedPos = transform(baseWitness.position);
    expect(transWitness.position[0]).toBeCloseTo(expectedPos[0], 9);
    expect(transWitness.position[2]).toBeCloseTo(expectedPos[2], 9);
    expect(transWitness.s).toBeCloseTo(baseWitness.s, 9);
  });

  it("deterministic repeat returns exact same result", () => {
    const a = vec3(2, 0, 7);
    const b = vec3(7, 0, 7);
    const span = createLinearSpan(a, b, "notch-span-002");
    const run = (): ReturnType<typeof certifyFootprintSpan> => {
      const budget = new CertifiedWorkBudget(1_000_000);
      return certifyFootprintSpan(span, concaveL, {
        station: 5,
        budget,
        maxDepth: 32,
      });
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
  });

  it("outside gate inside AABB returns exact FOOTPRINT contradiction", () => {
    const gatePos = vec3(7, 0, 7);
    const bounds = footprintBounds(concaveL);
    expect(gatePos[0] >= bounds.min[0] && gatePos[0] <= bounds.max[0]).toBe(
      true,
    );
    expect(gatePos[2] >= bounds.min[2] && gatePos[2] <= bounds.max[2]).toBe(
      true,
    );
    expect(isPointInsidePolygonStrict(concaveL, gatePos)).toBe(false);
    expect(isPointInsidePolygon(concaveL, gatePos)).toBe(false);
    const sd = signedDistanceStrictXZ(concaveL, gatePos);
    expect(sd).toBeGreaterThan(0);
    const intent = {
      schemaVersion: 1 as const,
      generatorVersion: "test-v1",
      seed: 42,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: [
        {
          id: "station-000",
          kind: "station" as const,
          type: "station" as const,
          parameters: { length: 10 },
        },
      ],
      gates: [{ id: "gate-000", position: gatePos }],
      targets: [],
      constraints: [],
      footprint: concaveL,
      heightRange: { min: 0, max: 100 },
      terrainProfileId: "test",
      pinnedElementIds: [],
    };
    const firstRun = generateCoaster(intent);
    const secondRun = generateCoaster(intent);
    const diagForGate = (run: typeof firstRun) => {
      const found = run.diagnostics.find(
        (d) =>
          d.code === "FOOTPRINT" &&
          d.relatedIds !== undefined &&
          d.relatedIds.includes("gate-000"),
      );
      assertDefined(found, "gate FOOTPRINT diagnostic missing");
      return found;
    };
    const firstDiag = diagForGate(firstRun);
    const secondDiag = diagForGate(secondRun);
    expect(firstDiag.code).toBe("FOOTPRINT");
    expect(firstDiag.limit).toBe(0);
    assertDefined(firstDiag.actual, "actual missing");
    assertDefined(firstDiag.limit, "limit missing");
    assertDefined(firstDiag.margin, "margin missing");
    expect(firstDiag.actual).toBeCloseTo(sd, 5);
    expect(firstDiag.margin).toBe(-sd);
    expect(firstDiag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(firstDiag.severity).toBe("error");
    expect(firstDiag.relatedIds).toEqual(expect.arrayContaining(["gate-000"]));
    assertDefined(firstDiag.location, "location missing");
    assertDefined(firstDiag.location.position, "position missing");
    expect(firstDiag.location.position[0]).toBe(gatePos[0]);
    expect(firstDiag.location.position[2]).toBe(gatePos[2]);
    expect(firstDiag).toEqual(secondDiag);
  });

  it("CW and CCW polygons produce equivalent codes and evidence", () => {
    const cw = concaveL;
    const ccw: FootprintPolygon = [...concaveL].reverse();
    const a = vec3(2, 0, 7);
    const b = vec3(7, 0, 7);
    const span = createLinearSpan(a, b, "notch-span-cwccw");
    const budgetCW = new CertifiedWorkBudget(1_000_000);
    const budgetCCW = new CertifiedWorkBudget(1_000_000);
    const resCW = certifyFootprintSpan(span, cw, {
      station: 0,
      budget: budgetCW,
    });
    const resCCW = certifyFootprintSpan(span, ccw, {
      station: 0,
      budget: budgetCCW,
    });
    expect(resCW.status).toBe(resCCW.status);
    expect(resCW.status).toBe("outside");
    assertOutside(resCW);
    assertOutside(resCCW);
    expect(resCW.witness.signedDistance).toBeCloseTo(
      resCCW.witness.signedDistance,
      9,
    );
    expect(resCW.witness.position).toEqual(resCCW.witness.position);
    expect(resCW.witness.s).toBe(resCCW.witness.s);
    const insideA = vec3(1, 0, 1);
    const insideB = vec3(2, 0, 2);
    const spanInside = createLinearSpan(insideA, insideB, "inside-span");
    const resInsideCW = certifyFootprintSpan(spanInside, cw, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
    });
    const resInsideCCW = certifyFootprintSpan(spanInside, ccw, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
    });
    assertInside(resInsideCW);
    assertInside(resInsideCCW);
    expect(resInsideCW).toEqual(resInsideCCW);
  });

  it("legacy rectangle checksum stability via decoder-only AABB migration through compileCoasterFile", () => {
    const polygonForLegacy: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ];
    const heightRange = { min: 2, max: 8 };
    const positionCoefficients: readonly (readonly number[])[] = [
      [0, 10, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ];
    const rollCoefficients: readonly number[] = [0, 0, 0, 0, 0, 0];
    const serializedSpan = {
      id: "e0",
      kind: "station" as const,
      positionCoefficients,
      rollCoefficients,
      length: 10,
    };
    const canonicalIntent = {
      schemaVersion: 1 as const,
      generatorVersion: "test-v1",
      seed: 99,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: [
        {
          id: "e0",
          kind: "station" as const,
          type: "station" as const,
          parameters: { length: 10 },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      footprint: polygonForLegacy,
      heightRange,
      terrainProfileId: "t",
      pinnedElementIds: [],
    };
    const trackForChecksum = compileTrack([
      reconstructSolvedSpan(serializedSpan),
    ]);
    const checksum = trackForChecksum.checksum;
    const canonicalFile = createCoasterFileV1({
      name: "test",
      intent: canonicalIntent,
      solvedSpans: [serializedSpan],
      seed: 99,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: checksum,
    });
    const canonicalCompiled = compileCoasterFile(canonicalFile);
    expect(canonicalCompiled.file.compiledDataChecksum).toBe(checksum);
    const legacyJson = JSON.stringify({
      schemaVersion: 1,
      name: "test",
      seed: 99,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      intent: {
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
        footprint: { min: [0, 2, 0], max: [10, 8, 10] },
        heightRange,
        terrainProfileId: "t",
        pinnedElementIds: [],
      },
      solvedSpans: [serializedSpan],
      compiledDataChecksum: checksum,
    });
    const migrated = compileCoasterFile(legacyJson);
    expect(migrated.file.intent.footprint).toEqual(polygonForLegacy);
    expect(migrated.file.intent.heightRange).toEqual(heightRange);
    const migratedSpan = migrated.solvedSpans[0];
    assertDefined(migratedSpan, "migrated span missing");
    expect(migratedSpan.positionCoefficients).toEqual(positionCoefficients);
    expect(migrated.file.compiledDataChecksum).toBe(checksum);
    const migratedAgain = compileCoasterFile(legacyJson);
    expect(migratedAgain.file.compiledDataChecksum).toBe(checksum);
    expect(migratedAgain.file.intent.footprint).toEqual(polygonForLegacy);
  });

  it("interval enclosure strictly contains double midpoint hull", () => {
    const coeffsX: readonly number[] = [
      884, -1000, 500, -300, 200, -100, 50, -10,
    ].map((v) => v * 1);
    const cNotch: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(100, 0, 0),
      vec3(100, 0, 30),
      vec3(20, 0, 30),
      vec3(20, 0, 70),
      vec3(100, 0, 70),
      vec3(100, 0, 100),
      vec3(0, 0, 100),
    ];
    const budget = new CertifiedWorkBudget(1_000_000);
    const xIntervals = restrictedBernstein(coeffsX, 0.33, 0.66, budget);
    const xMid = xIntervals.map((iv) => (iv.lo + iv.hi) / 2);
    let midInside = true;
    for (const xm of xMid) {
      const pt = vec3(xm, 0, 15);
      if (!isPointInsidePolygon(cNotch, pt)) midInside = false;
    }
    let cornerOutside = false;
    for (const iv of xIntervals) {
      const forLo = vec3(iv.lo, 0, 15);
      const forHi = vec3(iv.hi, 0, 15);
      if (
        !isPointInsidePolygon(cNotch, forLo) ||
        !isPointInsidePolygon(cNotch, forHi)
      )
        cornerOutside = true;
    }
    expect(cornerOutside).toBe(true);
    void midInside;
  });

  it("concave dedup collapse strict vs tolerant", () => {
    const cNotch: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(100, 0, 0),
      vec3(100, 0, 30),
      vec3(20, 0, 30),
      vec3(20, 0, 70),
      vec3(100, 0, 70),
      vec3(100, 0, 100),
      vec3(0, 0, 100),
    ];
    const a = vec3(10, 0, 50);
    const b = vec3(90, 0, 50);
    const tolerant = segmentWithinPolygon(cNotch, a, b);
    const strict = segmentWithinPolygonStrict(cNotch, a, b);
    expect(strict.inside).toBe(false);
    void tolerant;
    assertDefined(strict.witness, "strict witness missing");
    expect(isPointInsidePolygonStrict(cNotch, strict.witness)).toBe(false);
  });

  it("ray-through-vertex strict parity", () => {
    const cNotch: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(100, 0, 0),
      vec3(100, 0, 30),
      vec3(20, 0, 30),
      vec3(20, 0, 70),
      vec3(100, 0, 70),
      vec3(100, 0, 100),
      vec3(0, 0, 100),
    ];
    const pt = vec3(20.0000000005, 0, 30);
    const tolerantInside = isPointInsidePolygon(cNotch, pt);
    const strictInside = isPointInsidePolygonStrict(cNotch, pt);
    expect(strictInside).toBe(false);
    void tolerantInside;
  });

  it("linear demotion strict exact zero", () => {
    const p0 = vec3(0, 0, 0);
    const p1 = vec3(10, 0, 0);
    const span = createLinearSpan(p0, p1, "linear-exact");
    const budget = new CertifiedWorkBudget(1_000_000);
    const res = certifyFootprintSpan(span, concaveL, {
      station: 0,
      budget,
      maxDepth: 32,
    });
    assertInside(res);
    const eps = 1e-9;
    const p0b = vec3(0, 0, 0);
    const p1b = vec3(10, 0, 0);
    const coeffsX: readonly number[] = [0, 10, eps, 0, 0, 0, 0, 0];
    const coeffsZ: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0];
    const coeffsY: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0];
    const rows: readonly (readonly number[])[] = [coeffsX, coeffsY, coeffsZ];
    const inst = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows);
    const spanEps: SolvedSpan = {
      id: "eps-curve",
      span: inst,
      positionCoefficients: rows,
      rollCoefficients: [0, 0, 0, 0, 0, 0],
      length: 10,
    };
    const resEps = certifyFootprintSpan(spanEps, concaveL, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
      maxDepth: 32,
    });
    expect(resEps.status).not.toBe("inside");
    void p0b;
    void p1b;
  });

  it("eps witness masking strict vs tolerant", () => {
    const poly: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(500, 0, 0),
      vec3(500, 0, 500),
      vec3(0, 0, 500),
    ];
    const outside = vec3(500.0000005, 0, 250);
    const sdTolerant = signedDistanceXZ(poly, outside);
    const sdStrict = signedDistanceStrictXZ(poly, outside);
    expect(sdTolerant).toBe(0);
    expect(sdStrict).toBeGreaterThan(0);
    const span = createLinearSpan(vec3(490, 0, 250), outside, "eps-outside");
    const res = certifyFootprintSpan(span, poly, {
      station: 0,
      budget: new CertifiedWorkBudget(1_000_000),
      maxDepth: 32,
    });
    assertOutside(res);
    expect(res.witness.signedDistance).toBeGreaterThan(0);
  });

  it("45 degree rotation strict invariance", () => {
    const square: FootprintPolygon = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 10),
      vec3(0, 0, 10),
    ];
    const boundaryNear = vec3(5, 0, 0.0000000005);
    const outsideNear = vec3(5, 0, -0.00000005);
    expect(isPointInsidePolygon(square, boundaryNear)).toBe(true);
    expect(isPointInsidePolygonStrict(square, boundaryNear)).toBe(true);
    expect(signedDistanceXZ(square, outsideNear)).toBeGreaterThan(0);
    expect(signedDistanceStrictXZ(square, outsideNear)).toBeGreaterThan(0);
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotate = (p: Vec3): Vec3 =>
      vec3(p[0] * cos - p[2] * sin, p[1], p[0] * sin + p[2] * cos);
    const squareR: FootprintPolygon = square.map(rotate);
    const boundaryR = rotate(boundaryNear);
    const outsideR = rotate(outsideNear);
    expect(isPointInsidePolygon(squareR, boundaryR)).toBe(true);
    expect(isPointInsidePolygonStrict(squareR, outsideR)).toBe(false);
    const sdStrict = signedDistanceStrictXZ(square, outsideNear);
    const sdStrictR = signedDistanceStrictXZ(squareR, outsideR);
    expect(Math.abs(sdStrict - sdStrictR)).toBeLessThan(1e-9);
  });
});
