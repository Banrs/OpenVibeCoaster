import { describe, expect, it } from "vitest";
import type { EngineeringLimitsProfile } from "@openvibecoaster/core";
import { validateEngineeringLimitsProfile } from "@openvibecoaster/core";
import { validateEngineeringLimits } from "./engineering-limits";
import type { CarState, CarTelemetry, SimulationFrame } from "./contracts";
import { vec3 } from "@openvibecoaster/core";
import { compileTrack, SeventhOrderHermiteSpan } from "@openvibecoaster/core";

const profile: EngineeringLimitsProfile = {
  schemaVersion: 1,
  profileId: "project-engineering-limits-v1",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  verticalG: { minimum: -1.2, maximum: 5.0 },
  maximumAbsoluteLateralG: 1.5,
  maximumAbsoluteLongitudinalG: 1.5,
  maximumJerkMps3: 15,
  maximumRollRateRadPerSecond: 1.5,
  clearanceMarginM: 0.5,
  seams: {
    positionM: 0.0001,
    tangentRad: 0.00001,
    curvaturePerM: 0.0001,
    curvatureGradientPerM2: 0.0001,
    bankRad: 0.0001,
    bankDerivativeRadPerM: 0.0001,
    specificForceJumpG: 0.05,
    sustainedForceDeviationG: 0.05,
  },
};

function tel(over: Partial<CarTelemetry>): CarTelemetry {
  return {
    longitudinalG: 0.2,
    lateralG: 0.2,
    verticalG: 1.0,
    specificForceMps2: vec3(0, 9.8, 0),
    jerkMps3: vec3(0, 0, 0),
    bankRad: 0,
    rollRateRadPerSec: 0.2,
    ...over,
  } as CarTelemetry;
}

function car(
  distanceM: number,
  position: [number, number, number],
  telemetry: CarTelemetry,
): CarState {
  return {
    index: 0,
    distanceM,
    position: vec3(...position),
    tangent: vec3(1, 0, 0),
    normal: vec3(0, 1, 0),
    binormal: vec3(0, 0, 1),
    frame: {
      position: vec3(...position),
      tangent: vec3(1, 0, 0),
      normal: vec3(0, 1, 0),
      binormal: vec3(0, 0, 1),
      distance: distanceM,
      curvature: 0,
      curvatureVector: vec3(0, 0, 0),
      bank: 0,
      bankDerivative: 0,
    },
    seatOffsets: [],
    seatPositions: [],
    telemetry,
    seats: [],
  } as unknown as CarState;
}

function frame(time: number, cars: CarState[]): SimulationFrame {
  return {
    timeSeconds: time,
    headDistanceM: cars[0]!.distanceM,
    speedMps: 5,
    status: "rolling",
    cars,
    selection: { front: cars[0]!, middle: cars[0]!, rear: cars[0]! },
    telemetry: {
      perCar: cars.map((c) => c.telemetry),
      longitudinalG: cars[0]!.telemetry.longitudinalG,
      lateralG: cars[0]!.telemetry.lateralG,
      verticalG: cars[0]!.telemetry.verticalG,
      specificForceMps2: cars[0]!.telemetry.specificForceMps2,
      jerkMps3: cars[0]!.telemetry.jerkMps3,
      bankRad: 0,
      rollRateRadPerSec: 0.2,
      launchActivity: false,
      brakeActivity: false,
      kineticEnergyJ: 0,
      potentialEnergyJ: 0,
      accumulatedDriveWorkJ: 0,
      accumulatedLossWorkJ: 0,
      energyErrorJ: 0,
    },
  } as unknown as SimulationFrame;
}

function trackWithSpans(ids: string[]) {
  const spans = ids.map((id) => ({
    id,
    span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
  }));
  const t = compileTrack(spans as never, { samples: 8 });
  return { track: t, spanIds: ids };
}

describe("engineering limits - frames table-driven", () => {
  it("valid profile parses", () => {
    expect(() => validateEngineeringLimitsProfile(profile)).not.toThrow();
  });

  it("below limit produces no warnings", () => {
    const { track, spanIds } = trackWithSpans(["a", "b"]);
    const frames = [
      frame(0, [
        car(
          5,
          [5, 0, 0],
          tel({
            verticalG: 1,
            lateralG: 0.2,
            longitudinalG: 0.2,
            jerkMps3: vec3(1, 0, 0),
            rollRateRadPerSec: 0.2,
          }),
        ),
      ]),
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.filter((d) => d.code.startsWith("ENGINEERING_LIMIT_")),
    ).toHaveLength(0);
  });

  it.each([
    [
      "vertical max",
      tel({ verticalG: 5.8 }),
      "ENGINEERING_LIMIT_VERTICAL_G_MAX",
      5.8,
      5.0,
    ],
    [
      "vertical min",
      tel({ verticalG: -1.8 }),
      "ENGINEERING_LIMIT_VERTICAL_G_MIN",
      -1.8,
      -1.2,
    ],
    [
      "lateral",
      tel({ lateralG: 1.8 }),
      "ENGINEERING_LIMIT_LATERAL_G",
      1.8,
      1.5,
    ],
    [
      "longitudinal",
      tel({ longitudinalG: -1.9 }),
      "ENGINEERING_LIMIT_LONGITUDINAL_G",
      1.9,
      1.5,
    ],
    [
      "jerk",
      tel({ jerkMps3: vec3(10, 10, 10) }),
      "ENGINEERING_LIMIT_JERK",
      Math.hypot(10, 10, 10),
      15,
    ],
    [
      "roll",
      tel({ rollRateRadPerSec: -1.8 }),
      "ENGINEERING_LIMIT_ROLL_RATE",
      1.8,
      1.5,
    ],
  ])("exceeds %s", (_label, telemetry, code, actual, limit) => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [frame(1.2, [car(5, [5, 0, 0], telemetry)])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find((x) => x.code === code)!;
    expect(d).toBeDefined();
    expect(d.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(d.severity).toBe("warning");
    expect(d.actual).toBeCloseTo(actual, 5);
    expect(d.limit).toBeCloseTo(limit, 5);
    if (code === "ENGINEERING_LIMIT_VERTICAL_G_MIN")
      expect(d.margin).toBeCloseTo(actual - limit, 5);
    else expect(d.margin).toBeCloseTo(limit - actual, 5);
    expect(d.location?.s).toBe(5);
    expect(d.location?.time).toBe(1.2);
    expect(d.location?.position).toEqual([5, 0, 0]);
    expect(d.elementId).toBe("a");
  });

  it("exact boundary does not warn", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [
      frame(0, [
        car(
          5,
          [5, 0, 0],
          tel({
            verticalG: 5.0,
            lateralG: 1.5,
            longitudinalG: 1.5,
            jerkMps3: vec3(15, 0, 0),
            rollRateRadPerSec: 1.5,
          }),
        ),
      ]),
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.filter(
        (d) =>
          d.code.startsWith("ENGINEERING_LIMIT_") && d.severity === "warning",
      ),
    ).toHaveLength(0);
  });

  it("multiple warnings in one scan", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [
      frame(0, [
        car(5, [5, 0, 0], tel({ verticalG: 6, lateralG: 2, longitudinalG: 2 })),
      ]),
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(diags.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "ENGINEERING_LIMIT_VERTICAL_G_MAX",
        "ENGINEERING_LIMIT_LATERAL_G",
        "ENGINEERING_LIMIT_LONGITUDINAL_G",
      ]),
    );
  });

  it("deterministic tie – earliest time and smallest car wins", () => {
    const { track, spanIds } = trackWithSpans(["a", "b"]);
    const frames = [
      frame(0, [
        car(2, [2, 0, 0], tel({ verticalG: 6 })),
        car(2, [2, 0, 0], tel({ verticalG: 6 })),
      ]),
      frame(1, [car(12, [12, 0, 0], tel({ verticalG: 6 }))]),
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find((x) => x.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX")!;
    expect(d.location?.time).toBe(0);
    expect(d.location?.s).toBe(2);
    expect(d.relatedIds).toContain("car-0");
    const frames2 = [
      frame(0, [
        car(2, [2, 0, 0], tel({ verticalG: 6 })),
        car(2, [2, 0, 0], tel({ verticalG: 6 })),
      ]),
    ];
    const diags2 = validateEngineeringLimits(frames2, track, profile, spanIds);
    const d2 = diags2.find(
      (x) => x.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    )!;
    expect(d2.relatedIds).toContain("car-0");
  });

  it("containing-interval ownership, not nearest", () => {
    const { track, spanIds } = trackWithSpans(["a", "b", "c"]);
    const frames = [frame(0, [car(10, [10, 0, 0], tel({ verticalG: 6 }))])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.find((d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX")
        ?.elementId,
    ).toBe("b");
  });

  it("missing/non-finite evidence is fatal, no fabrication", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const badCar = car(5, [5, 0, 0], tel({ verticalG: Number.NaN }));
    const frames = [frame(0, [badCar])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.some(
        (d) =>
          d.code === "ENGINEERING_LIMITS_UNCERTIFIED" && d.severity === "fatal",
      ),
    ).toBe(true);
    const empty = validateEngineeringLimits([], track, profile, spanIds);
    expect(empty[0]?.severity).toBe("fatal");
  });

  it("invalid profile is fatal", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [frame(0, [car(5, [5, 0, 0], tel({}))])];
    const bad = { ...profile, verticalG: { minimum: 5, maximum: -1 } };
    const diags = validateEngineeringLimits(
      frames,
      track,
      bad as unknown,
      spanIds,
    );
    expect(diags[0]?.severity).toBe("fatal");
  });
});
