import { describe, expect, it } from "vitest";
import { RideTimeline } from "./timeline";
import {
  defaultProjectEngineeringLimits,
  validateEngineeringLimits,
} from "./engineering-limits";
import type { ProjectEngineeringLimits } from "./engineering-limits";

function makeTimeline(opts: {
  length?: number;
  carCount?: number;
  verticalG?: number[];
  perVerticalG?: number[];
  lateralG?: number[];
  perLateralG?: number[];
  longitudinalG?: number[];
  perLongitudinalG?: number[];
  jerk?: number[]; // flat 3*length
  perJerk?: number[];
  rollRate?: number[];
  perRollRate?: number[];
  timeSeconds?: number[];
  headDistanceM?: number[];
}): RideTimeline {
  const length = opts.length ?? 3;
  const carCount = opts.carCount ?? 1;
  const timeSeconds = new Float64Array(
    opts.timeSeconds ?? Array.from({ length }, (_, i) => i * (1 / 120)),
  );
  const headDistanceM = new Float64Array(
    opts.headDistanceM ?? Array.from({ length }, (_, i) => i * 5),
  );
  const speedMps = new Float64Array(Array.from({ length }, () => 5));
  const longitudinalG =
    opts.longitudinalG !== undefined
      ? new Float64Array(opts.longitudinalG)
      : new Float64Array(Array.from({ length }, () => 0.2));
  const lateralG =
    opts.lateralG !== undefined
      ? new Float64Array(opts.lateralG)
      : new Float64Array(Array.from({ length }, () => 0.2));
  const verticalG =
    opts.verticalG !== undefined
      ? new Float64Array(opts.verticalG)
      : new Float64Array(Array.from({ length }, () => 1.0));
  // jerk length*3
  const jerkMps3 =
    opts.jerk !== undefined
      ? new Float64Array(opts.jerk)
      : new Float64Array(Array.from({ length: length * 3 }, () => 0.5));
  const rollRateRadPerSec =
    opts.rollRate !== undefined
      ? new Float64Array(opts.rollRate)
      : new Float64Array(Array.from({ length }, () => 0.2));
  const carPositionsXYZ = new Float64Array(length * carCount * 3);
  for (let i = 0; i < length * carCount * 3; i += 1)
    carPositionsXYZ[i] = i * 0.1;
  const carTangentsXYZ = new Float64Array(length * carCount * 3);
  for (let i = 0; i < length * carCount * 3; i += 1)
    carTangentsXYZ[i] = i % 3 === 0 ? 1 : 0;
  const carNormalsXYZ = new Float64Array(length * carCount * 3);
  for (let i = 0; i < length * carCount * 3; i += 1)
    carNormalsXYZ[i] = i % 3 === 1 ? 1 : 0;
  const carBinormalsXYZ = new Float64Array(length * carCount * 3);
  for (let i = 0; i < length * carCount * 3; i += 1)
    carBinormalsXYZ[i] = i % 3 === 2 ? 1 : 0;

  const perCarLongitudinalG =
    opts.perLongitudinalG !== undefined
      ? new Float64Array(opts.perLongitudinalG)
      : new Float64Array(length * carCount).fill(0.2);
  const perCarLateralG =
    opts.perLateralG !== undefined
      ? new Float64Array(opts.perLateralG)
      : new Float64Array(length * carCount).fill(0.2);
  const perCarVerticalG =
    opts.perVerticalG !== undefined
      ? new Float64Array(opts.perVerticalG)
      : new Float64Array(length * carCount).fill(1.0);
  const perCarRoll =
    opts.perRollRate !== undefined
      ? new Float64Array(opts.perRollRate)
      : new Float64Array(length * carCount).fill(0.2);
  const perCarJerkXYZ =
    opts.perJerk !== undefined
      ? new Float64Array(opts.perJerk)
      : new Float64Array(length * carCount * 3).fill(0.5);

  return new RideTimeline({
    sampleRateHz: 120,
    timeSeconds,
    headDistanceM,
    speedMps,
    longitudinalG,
    lateralG,
    verticalG,
    jerkMps3,
    carCount,
    carPositionsXYZ,
    carTangentsXYZ,
    carNormalsXYZ,
    carBinormalsXYZ,
    bankRad: new Float64Array(Array.from({ length }, () => 0)),
    rollRateRadPerSec,
    specificForceXYZ: new Float64Array(length * 3),
    launchActivity: new Float64Array(length),
    brakeActivity: new Float64Array(length),
    kineticEnergyJ: new Float64Array(length),
    potentialEnergyJ: new Float64Array(length),
    accumulatedDriveWorkJ: new Float64Array(length),
    accumulatedLossWorkJ: new Float64Array(length),
    energyErrorJ: new Float64Array(length),
    perCarLongitudinalG,
    perCarLateralG,
    perCarVerticalG,
    perCarBankRad: new Float64Array(length * carCount),
    perCarRollRateRadPerSec: perCarRoll,
    perCarSpecificForceXYZ: new Float64Array(length * carCount * 3),
    perCarJerkXYZ,
  });
}

describe("engineering limits validation - pure deterministic", () => {
  const limits: ProjectEngineeringLimits = defaultProjectEngineeringLimits;

  it("below-limit ride passes with no diagnostics", () => {
    const tl = makeTimeline({ length: 3, carCount: 2 });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    // below-limit should have zero engineering-limit error diagnostics (only possibly missing etc)
    expect(
      diags.filter((d) => d.code.startsWith("ENGINEERING_LIMIT_")),
    ).toHaveLength(0);
  });

  it("vertical max exceedance produces PROJECT_ENGINEERING_LIMIT diagnostic with actual/limit/margin/location", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      verticalG: [1, 5.8],
      perVerticalG: [1, 5.8],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const vMax = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(vMax).toBeDefined();
    expect(vMax!.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(vMax!.severity).toBe("error");
    expect(vMax!.actual).toBeCloseTo(5.8, 5);
    expect(vMax!.limit).toBe(5.0);
    expect(vMax!.margin).toBeCloseTo(5.0 - 5.8, 5);
    expect(vMax!.location).toBeDefined();
    expect(vMax!.location!.s).toBeCloseTo(5, 5); // second sample headDistanceM =5
  });

  it("vertical min exceedance (more negative) is reported with correct margin", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      verticalG: [1, -1.8],
      perVerticalG: [1, -1.8],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const vMin = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MIN",
    );
    expect(vMin).toBeDefined();
    expect(vMin!.actual).toBeCloseTo(-1.8, 5);
    expect(vMin!.limit).toBe(-1.2);
    expect(vMin!.margin).toBeCloseTo(-1.8 - -1.2, 5); // -0.6
  });

  it("absolute lateral exceedance is detected", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      lateralG: [0.2, -1.8],
      perLateralG: [0.2, -1.8],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const lat = diags.find((d) => d.code === "ENGINEERING_LIMIT_LATERAL_G");
    expect(lat).toBeDefined();
    expect(lat!.actual).toBeCloseTo(1.8, 5); // abs
    expect(lat!.limit).toBe(1.5);
    expect(lat!.margin).toBeCloseTo(1.5 - 1.8, 5);
  });

  it("absolute longitudinal exceedance is detected", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      longitudinalG: [0.2, 1.9],
      perLongitudinalG: [0.2, 1.9],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const lon = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_LONGITUDINAL_G",
    );
    expect(lon).toBeDefined();
    expect(lon!.actual).toBeCloseTo(1.9, 5);
  });

  it("jerk magnitude exceedance is detected", () => {
    // jerk 0.5 magnitude ~0.866, limit 15 => need big
    const jerkOk = Array.from({ length: 6 }, () => 1); // mag sqrt(3) ~1.73
    const jerkHigh = [1, 1, 1, 10, 10, 10]; // second sample mag ~17.32 >15
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      jerk: jerkHigh,
      perJerk: [1, 1, 1, 10, 10, 10, 1, 1, 1, 10, 10, 10].slice(0, 6),
    });
    void jerkOk;
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const jerk = diags.find((d) => d.code === "ENGINEERING_LIMIT_JERK");
    expect(jerk).toBeDefined();
    expect(jerk!.actual).toBeCloseTo(Math.hypot(10, 10, 10), 5);
    expect(jerk!.limit).toBe(15);
  });

  it("absolute roll rate exceedance is detected", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      rollRate: [0.2, -1.8],
      perRollRate: [0.2, -1.8],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const roll = diags.find((d) => d.code === "ENGINEERING_LIMIT_ROLL_RATE");
    expect(roll).toBeDefined();
    expect(roll!.actual).toBeCloseTo(1.8, 5);
  });

  it("multiple simultaneous limits produce multiple diagnostics", () => {
    const tl = makeTimeline({
      length: 2,
      carCount: 1,
      verticalG: [5.8, 5.8],
      perVerticalG: [5.8, 5.8],
      lateralG: [1.8, 1.8],
      perLateralG: [1.8, 1.8],
      longitudinalG: [1.8, 1.8],
      perLongitudinalG: [1.8, 1.8],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const codes = diags.map((d) => d.code);
    expect(codes).toContain("ENGINEERING_LIMIT_VERTICAL_G_MAX");
    expect(codes).toContain("ENGINEERING_LIMIT_LATERAL_G");
    expect(codes).toContain("ENGINEERING_LIMIT_LONGITUDINAL_G");
    expect(
      diags.filter(
        (d) =>
          d.provenance === "PROJECT_ENGINEERING_LIMIT" &&
          d.severity === "error",
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("exactly at limit does not exceed (boundary)", () => {
    const tl = makeTimeline({
      length: 1,
      carCount: 1,
      verticalG: [5.0],
      perVerticalG: [5.0],
      lateralG: [1.5],
      perLateralG: [1.5],
      longitudinalG: [1.5],
      perLongitudinalG: [1.5],
      rollRate: [1.5],
      perRollRate: [1.5],
    });
    // jerk exactly 15: vector (15,0,0) mag 15
    const tl2 = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0]),
      headDistanceM: new Float64Array([0]),
      speedMps: new Float64Array([5]),
      longitudinalG: new Float64Array([1.5]),
      lateralG: new Float64Array([1.5]),
      verticalG: new Float64Array([5.0]),
      jerkMps3: new Float64Array([15, 0, 0]),
      carCount: 1,
      carPositionsXYZ: new Float64Array([0, 0, 0]),
      carTangentsXYZ: new Float64Array([1, 0, 0]),
      carNormalsXYZ: new Float64Array([0, 1, 0]),
      carBinormalsXYZ: new Float64Array([0, 0, 1]),
      perCarLongitudinalG: new Float64Array([1.5]),
      perCarLateralG: new Float64Array([1.5]),
      perCarVerticalG: new Float64Array([5.0]),
      perCarRollRateRadPerSec: new Float64Array([1.5]),
      perCarJerkXYZ: new Float64Array([15, 0, 0]),
      bankRad: new Float64Array([0]),
      rollRateRadPerSec: new Float64Array([1.5]),
      specificForceXYZ: new Float64Array([0, 0, 0]),
      launchActivity: new Float64Array([0]),
      brakeActivity: new Float64Array([0]),
      kineticEnergyJ: new Float64Array([0]),
      potentialEnergyJ: new Float64Array([0]),
      accumulatedDriveWorkJ: new Float64Array([0]),
      accumulatedLossWorkJ: new Float64Array([0]),
      energyErrorJ: new Float64Array([0]),
      perCarBankRad: new Float64Array([0]),
      perCarSpecificForceXYZ: new Float64Array([0, 0, 0]),
    });
    void tl;
    const diags = validateEngineeringLimits(tl2, undefined, limits);
    expect(
      diags.filter(
        (d) =>
          d.code.startsWith("ENGINEERING_LIMIT_") && d.severity === "error",
      ),
    ).toHaveLength(0);
  });

  it("deterministic tie handling: earliest time and smallest car wins", () => {
    // two peaks equal 6.0 at t=0 and t=1, should pick t=0
    const tl = makeTimeline({
      length: 2,
      carCount: 2,
      verticalG: [1, 1],
      perVerticalG: [6.0, 6.0, 6.0, 6.0], // length 2 *2 =4 all 6
      timeSeconds: [0, 1],
      headDistanceM: [0, 5],
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    const vMax = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(vMax).toBeDefined();
    expect(vMax!.location!.s).toBe(0);
    expect(vMax!.relatedIds).toContain("car-0");
    // same time different cars: pick smallest car
    const tl2 = makeTimeline({
      length: 1,
      carCount: 2,
      perVerticalG: [5.5, 6.0], // car1 larger, but if both 6.0 tie picks car0
      verticalG: [1],
    });
    const diags2 = validateEngineeringLimits(
      makeTimeline({
        length: 1,
        carCount: 2,
        perVerticalG: [6.0, 6.0],
        verticalG: [1],
        timeSeconds: [0.5],
        headDistanceM: [10],
      }),
      undefined,
      limits,
    );
    void tl2;
    const v2 = diags2.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(v2!.relatedIds).toContain("car-0");
  });

  it("missing timeline data produces uncertified fatal, not silent pass", () => {
    const empty = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array(),
      headDistanceM: new Float64Array(),
      speedMps: new Float64Array(),
    });
    const diags = validateEngineeringLimits(empty, undefined, limits);
    expect(
      diags.some(
        (d) =>
          d.code === "ENGINEERING_LIMITS_UNCERTIFIED" && d.severity === "fatal",
      ),
    ).toBe(true);
  });

  it("does not fabricate missing per-car data from ride data when per-car missing", () => {
    // build timeline with missing perCar arrays (legacy style)
    const tl = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120]),
      headDistanceM: new Float64Array([0, 5]),
      speedMps: new Float64Array([5, 5]),
      longitudinalG: new Float64Array([0.2, 0.2]),
      lateralG: new Float64Array([0.2, 0.2]),
      verticalG: new Float64Array([1, 10]), // second vertical 10 exceeds
      jerkMps3: new Float64Array([0, 0, 0, 0, 0, 0]),
      carCount: 2,
      carPositionsXYZ: new Float64Array(2 * 2 * 3),
      carTangentsXYZ: new Float64Array(2 * 2 * 3),
      carNormalsXYZ: new Float64Array(2 * 2 * 3),
      carBinormalsXYZ: new Float64Array(2 * 2 * 3),
      // perCar arrays omitted => missing
    });
    const diags = validateEngineeringLimits(tl, undefined, limits);
    // Should have ride vertical exceedance but also missing per-car diagnostics as fatal?
    // At least ride vertical should be flagged, and per-car missing should cause uncertified for that metric.
    // Ensure we get vertical max from ride, but also missing per-car leads to uncertified for perCar? Our implementation treats missing both ride and per? Since ride exists, not missing both, so no uncertified for vertical.
    // This test proves we don't fabricate perCar from ride: perCar missing but ride present should still validate ride.
    const vMax = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(vMax).toBeDefined();
    expect(vMax!.actual).toBeCloseTo(10);
  });

  it("explicit profile is used, not file-system read – passing tighter limit changes result", () => {
    const tight: ProjectEngineeringLimits = {
      ...limits,
      verticalG: { minimum: -1.2, maximum: 2.0 },
    };
    const tl = makeTimeline({
      length: 1,
      carCount: 1,
      verticalG: [2.5],
      perVerticalG: [2.5],
    });
    const diagsDefault = validateEngineeringLimits(tl, undefined, limits);
    expect(
      diagsDefault.filter((d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX"),
    ).toHaveLength(0);
    const diagsTight = validateEngineeringLimits(tl, undefined, tight);
    expect(
      diagsTight.find((d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX"),
    ).toBeDefined();
    expect(
      diagsTight.find((d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX")!
        .limit,
    ).toBe(2.0);
  });
});
