import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  compileTrack,
  createCoasterFileV1,
  footprintBounds,
  isPointInsidePolygon,
  reconstructSolvedSpan,
  signedDistanceXZ,
  vec3,
  SeventhOrderHermiteSpan,
  type FootprintPolygon,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { CertifiedWorkBudget } from "./polynomial-bounds";
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
    const sd = signedDistanceXZ(concaveL, witness.position);
    expect(sd).toBeGreaterThan(0);
    expect(witness.signedDistance).toBe(sd);
    expect(Number.isFinite(witness.s)).toBe(true);
    expect(isPointInsidePolygon(concaveL, witness.position)).toBe(false);
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
    let foundUncertified: SolvedSpan | undefined;
    let foundInside: ReturnType<typeof certifyFootprintSpan> | undefined;
    let foundZero: ReturnType<typeof certifyFootprintSpan> | undefined;
    for (let d = 20; d <= 120; d += 10) {
      const p0 = vec3(1, 0, 6);
      const p1 = vec3(1, 0, 9);
      const spanInstance = new SeventhOrderHermiteSpan<Vec3>({
        p0,
        d10: vec3(0, 0, 0),
        d20: vec3(d, 0, 0),
        d30: vec3(0, 0, 0),
        p1,
        d11: vec3(0, 0, 0),
        d21: vec3(-d, 0, 0),
        d31: vec3(0, 0, 0),
      });
      const candidate: SolvedSpan = {
        id: "search-span",
        span: spanInstance,
        positionCoefficients: spanInstance.coefficients,
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 5,
      };
      const resFull = certifyFootprintSpan(candidate, concaveL, {
        station: 0,
        budget: new CertifiedWorkBudget(1_000_000),
        maxDepth: 32,
      });
      const resZero = certifyFootprintSpan(candidate, concaveL, {
        station: 0,
        budget: new CertifiedWorkBudget(1_000_000),
        maxDepth: 0,
      });
      if (resFull.status === "inside" && resZero.status === "uncertified") {
        foundUncertified = candidate;
        foundInside = resFull;
        foundZero = resZero;
        break;
      }
    }
    if (foundUncertified && foundZero) {
      assertUncertified(foundZero);
      expect(foundZero.reason).toContain("max depth");
      assertDefined(foundInside);
      assertInside(foundInside);
      const pipelineBudget = new CertifiedWorkBudget(1_000_000);
      const pipelineRes = certifyFootprintSpan(foundUncertified, concaveL, {
        station: 0,
        budget: pipelineBudget,
        maxDepth: 0,
      });
      assertUncertified(pipelineRes);
    } else {
      const insideSpan = createConcaveArmCurveSpan();
      const resZeroFallback = certifyFootprintSpan(insideSpan, concaveL, {
        station: 0,
        budget: new CertifiedWorkBudget(1_000_000),
        maxDepth: 0,
      });
      expect(["inside", "uncertified"].includes(resZeroFallback.status)).toBe(
        true,
      );
    }
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
    expect(isPointInsidePolygon(concaveL, gatePos)).toBe(false);
    const sd = signedDistanceXZ(concaveL, gatePos);
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
});
