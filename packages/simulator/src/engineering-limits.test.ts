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
  index = 0,
): CarState {
  return {
    index,
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
        car(2, [2, 0, 0], tel({ verticalG: 6 }), 0),
        car(2, [2, 0, 0], tel({ verticalG: 6 }), 1),
      ]),
      frame(1, [car(12, [12, 0, 0], tel({ verticalG: 6 }), 0)]),
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find((x) => x.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX")!;
    expect(d.location?.time).toBe(0);
    expect(d.location?.s).toBe(2);
    expect(d.relatedIds).toContain("car-0");
    const frames2 = [
      frame(0, [
        car(2, [2, 0, 0], tel({ verticalG: 6 }), 0),
        car(2, [2, 0, 0], tel({ verticalG: 6 }), 1),
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
    ).toBe("a");
  });

  it("RED: seam-boundary ownership – exact seam owned by preceding", () => {
    const { track, spanIds } = trackWithSpans(["a", "b"]);
    // track is 0-10 (a) and 10-20 (b); s=10 is seam, should be a (preceding)
    const f1 = frame(0, [car(10, [10, 0, 0], tel({ verticalG: 6 }))]);
    const d1 = validateEngineeringLimits([f1], track, profile, spanIds).find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(d1?.elementId).toBe("a");
    // s just beyond seam belongs to next
    const f2 = frame(0, [car(10.0001, [10.0001, 0, 0], tel({ verticalG: 6 }))]);
    const d2 = validateEngineeringLimits([f2], track, profile, spanIds).find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    expect(d2?.elementId).toBe("b");
    // first start and final end
    const f3 = frame(0, [car(0, [0, 0, 0], tel({ verticalG: 6 }))]);
    expect(
      validateEngineeringLimits([f3], track, profile, spanIds).find(
        (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
      )?.elementId,
    ).toBe("a");
    const f4 = frame(0, [car(20, [20, 0, 0], tel({ verticalG: 6 }))]);
    expect(
      validateEngineeringLimits([f4], track, profile, spanIds).find(
        (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
      )?.elementId,
    ).toBe("b");
  });

  it("RED: nonmonotonic distances is fatal", () => {
    const { track, spanIds } = trackWithSpans(["a", "b"]);
    // create a fake track with nonmonotonic distances
    const badTrack = {
      distances: new Float64Array([0, 5, 3, 20]),
      elementBoundaries: track.elementBoundaries,
      totalLength: track.totalLength,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;
    const frames = [frame(0, [car(5, [5, 0, 0], tel({}))])];
    const diags = validateEngineeringLimits(frames, badTrack, profile, spanIds);
    expect(diags[0]?.severity).toBe("fatal");
    expect(diags[0]?.code).toBe("ENGINEERING_LIMITS_UNCERTIFIED");
    expect(diags[0]?.actual).toBeUndefined();
    expect(diags[0]?.limit).toBeUndefined();
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

  it("RED: missing spanIds is fatal with clean evidence", () => {
    const { track } = trackWithSpans(["a"]);
    const frames = [frame(0, [car(5, [5, 0, 0], tel({}))])];
    const diags = validateEngineeringLimits(
      frames,
      track,
      profile,
      undefined as unknown as string[],
    );
    const d = diags[0]!;
    expect(d.severity).toBe("fatal");
    expect(d.code).toBe("ENGINEERING_LIMITS_UNCERTIFIED");
    expect(d.actual).toBeUndefined();
    expect(d.limit).toBeUndefined();
    expect(d.margin).toBeUndefined();
  });

  it("RED: cardinality mismatch is fatal", () => {
    const { track } = trackWithSpans(["a", "b"]);
    const frames = [frame(0, [car(5, [5, 0, 0], tel({}))])];
    const diags = validateEngineeringLimits(frames, track, profile, [
      "only-one",
    ]);
    expect(diags[0]?.severity).toBe("fatal");
    expect(diags[0]?.actual).toBeUndefined();
  });

  it("RED: unmappable s is fatal and uses location not synthesis", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [frame(0, [car(100, [100, 0, 0], tel({ verticalG: 6 }))])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find(
      (x) =>
        x.code === "ENGINEERING_LIMITS_UNCERTIFIED" &&
        x.message.includes("cannot be mapped"),
    );
    expect(d).toBeDefined();
    expect(d!.severity).toBe("fatal");
    expect(d!.location?.s).toBe(100);
    expect(d!.location?.time).toBe(0);
    expect(d!.elementId).toBeUndefined();
    expect(d!.actual).toBeUndefined();
  });

  it("RED: fatal does not fabricate actual/limit/margin from time", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const badCar = car(5, [5, 0, 0], tel({ verticalG: Number.NaN }));
    const frames = [frame(1.5, [badCar])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find((x) => x.severity === "fatal")!;
    expect(d.actual).toBeUndefined();
    expect(d.limit).toBeUndefined();
    expect(d.margin).toBeUndefined();
    expect(d.location?.time).toBe(1.5);
    expect(d.location?.s).toBe(5);
  });

  it("RED: mismatched elementIndices is fatal", () => {
    const { track, spanIds } = trackWithSpans(["a", "b"]);
    // corrupt elementIndices: make second element's start sample owned by wrong element
    const badTrack = {
      distances: track.distances,
      elementBoundaries: track.elementBoundaries,
      elementIndices: new Uint32Array(track.elementIndices),
      totalLength: track.totalLength,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;
    // flip first sample of second element to be 0 instead of 1
    (badTrack.elementIndices as Uint32Array)[track.elementBoundaries[2]! + 1] =
      0;
    const frames = [frame(0, [car(15, [15, 0, 0], tel({}))])];
    const diags = validateEngineeringLimits(frames, badTrack, profile, spanIds);
    expect(diags[0]?.severity).toBe("fatal");
    expect(diags[0]?.code).toBe("ENGINEERING_LIMITS_UNCERTIFIED");
  });

  it("RED: car index7 at slot0 uses authoritative index", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const c = car(5, [5, 0, 0], tel({ verticalG: 6 }), 7);
    const frames = [frame(0, [c])];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    const d = diags.find((x) => x.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX")!;
    expect(d.relatedIds).toEqual(["car-7"]);
    expect(d.elementId).toBe("a");
  });

  it("RED: duplicate car index is fatal", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [
      frame(0, [car(5, [5, 0, 0], tel({})), car(5, [5, 0, 0], tel({}), 0)]),
    ];
    // both cars have index 0 -> duplicate
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.some(
        (d) => d.severity === "fatal" && d.message.includes("duplicate"),
      ),
    ).toBe(true);
  });

  it("RED: dropped/reordered car is fatal", () => {
    const { track, spanIds } = trackWithSpans(["a"]);
    const frames = [
      frame(0, [car(5, [5, 0, 0], tel({}), 0), car(5, [5, 0, 0], tel({}), 1)]),
      frame(1, [car(5, [5, 0, 0], tel({}), 0)]), // dropped car 1
    ];
    const diags = validateEngineeringLimits(frames, track, profile, spanIds);
    expect(
      diags.some(
        (d) => d.severity === "fatal" && d.message.includes("changed car"),
      ),
    ).toBe(true);
    const frames2 = [
      frame(0, [car(5, [5, 0, 0], tel({}), 0), car(5, [5, 0, 0], tel({}), 1)]),
      frame(1, [car(5, [5, 0, 0], tel({}), 1), car(5, [5, 0, 0], tel({}), 0)]), // reordered
    ];
    const diags2 = validateEngineeringLimits(frames2, track, profile, spanIds);
    expect(diags2.some((d) => d.severity === "fatal")).toBe(true);
  });
});
