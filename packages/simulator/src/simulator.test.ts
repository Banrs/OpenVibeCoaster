import { describe, expect, it } from "vitest";
import {
  SeventhOrderHermiteSpan,
  compileTrack,
  sampleTrackAtDistance,
  vec3,
} from "../../core/src/index";
import {
  RideTimeline,
  computePerCarForces,
  createDefaultSimulatorConfig,
  simulateRide,
  type OperationZone,
  type SimulatorConfig,
} from "./index";

const line = (length: number, height = 0) =>
  compileTrack(
    [
      {
        id: "line",
        span: SeventhOrderHermiteSpan.line(
          vec3(0, height, 0),
          vec3(0, height, length),
        ),
      },
    ],
    { samples: 65 },
  );

const config = (overrides: Partial<SimulatorConfig> = {}): SimulatorConfig => ({
  ...createDefaultSimulatorConfig(),
  gravityMps2: 9.80665,
  rollingResistanceCoefficient: 0,
  staticStictionCoefficient: 0,
  dragCdA: 0,
  train: {
    ...createDefaultSimulatorConfig().train,
    cars: [
      { massKg: 1000, seatCount: 2 },
      { massKg: 1000, seatCount: 2 },
      { massKg: 1000, seatCount: 2 },
    ],
    spacingM: 3,
  },
  ...overrides,
});

describe("pure multi-car simulator", () => {
  it("holds a stationary train on a level frictionless line", () => {
    const result = simulateRide(line(100), {
      durationSeconds: 0.5,
      config: config(),
      initial: { headDistanceM: 30, speedMps: 0 },
    });

    expect(result.frames.at(-1)?.headDistanceM).toBeCloseTo(30, 10);
    expect(result.frames.at(-1)?.speedMps).toBe(0);
    expect(result.frames.at(-1)?.status).toBe("static-hold");
  });

  it("integrates gravity on a frictionless drop and conserves energy", () => {
    const track = compileTrack(
      [
        {
          id: "drop",
          span: SeventhOrderHermiteSpan.line(vec3(0, 10, 0), vec3(0, 0, 100)),
        },
      ],
      { samples: 129 },
    );
    const result = simulateRide(track, {
      durationSeconds: 1,
      config: config(),
      initial: { headDistanceM: 0, speedMps: 0.1 },
    });
    const frame = result.frames.at(-1);
    expect(frame?.speedMps).toBeGreaterThan(0.5);
    expect(frame?.telemetry.energyErrorJ).toBeLessThan(5);
    expect(frame?.telemetry.potentialEnergyJ).toBeLessThan(
      result.frames[0]?.telemetry.potentialEnergyJ ?? Infinity,
    );
  });

  it("reports centripetal lateral specific force as v squared over radius", () => {
    const radius = 20;
    const track = compileTrack(
      [
        {
          id: "circle",
          span: {
            position: (u: number) =>
              vec3(radius * Math.cos(u), 0, radius * Math.sin(u)),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(-radius * Math.sin(u), 0, radius * Math.cos(u))
                : vec3(-radius * Math.cos(u), 0, -radius * Math.sin(u)),
          },
        },
      ],
      { samples: 257 },
    );
    const speed = 12;
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config(),
      initial: { headDistanceM: 0, speedMps: speed },
    });
    const lateral = Math.abs(result.frames[0]?.telemetry.lateralG ?? 0);
    expect(lateral * 9.80665).toBeCloseTo((speed * speed) / radius, 2);
  });

  it("keeps authoritative front, middle, and rear positions at fixed spacing", () => {
    const result = simulateRide(line(100), {
      durationSeconds: 0,
      config: config(),
      initial: { headDistanceM: 30, speedMps: 5 },
    });
    const frame = result.frames[0];
    expect(frame?.cars.map((car) => car.distanceM)).toEqual([30, 27, 24]);
    expect(frame?.selection.front.distanceM).toBe(30);
    expect(frame?.selection.middle.distanceM).toBe(27);
    expect(frame?.selection.rear.distanceM).toBe(24);
    expect(
      frame!.selection.front.position[2] - frame!.selection.rear.position[2],
    ).toBeCloseTo(6);
  });

  it("applies launch force and magnetic brake with signed work", () => {
    const zones: OperationZone[] = [
      {
        id: "launch",
        kind: "launch",
        startDistanceM: 0,
        endDistanceM: 15,
        targetSpeedMps: 20,
      },
      {
        id: "brake",
        kind: "brake",
        startDistanceM: 15,
        endDistanceM: 60,
        brakeForcePerCarN: 5000,
      },
    ];
    const result = simulateRide(line(100), {
      durationSeconds: 4,
      config: config({ zones }),
      initial: { headDistanceM: 0, speedMps: 0 },
    });
    expect(result.events.some((event) => event.zoneId === "launch")).toBe(true);
    expect(result.frames.some((frame) => frame.telemetry.launchActivity)).toBe(
      true,
    );
    expect(result.frames.some((frame) => frame.telemetry.brakeActivity)).toBe(
      true,
    );
    expect(
      result.frames.at(-1)?.telemetry.accumulatedDriveWorkJ,
    ).toBeGreaterThan(0);
    expect(
      result.frames.at(-1)?.telemetry.accumulatedLossWorkJ,
    ).toBeGreaterThan(0);
  });

  it("allows uphill rollback, reversal, and explicit invalid-state diagnostics", () => {
    const uphill = compileTrack(
      [
        {
          id: "uphill",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 20, 100)),
        },
      ],
      { samples: 65 },
    );
    const result = simulateRide(uphill, {
      durationSeconds: 1,
      config: config(),
      initial: { headDistanceM: 20, speedMps: 0 },
    });
    expect(result.frames.at(-1)?.speedMps).toBeLessThan(0);
    expect(
      result.frames.some(
        (frame) => frame.status === "rollback" || frame.status === "reversal",
      ),
    ).toBe(true);

    const invalid = simulateRide(line(10), {
      durationSeconds: 1,
      config: config({ train: { ...config().train, cars: [] } }),
      initial: { headDistanceM: Number.NaN, speedMps: 0 },
    });
    expect(
      invalid.diagnostics.some(
        (diagnostic) => diagnostic.code === "SIM_INVALID_STATE",
      ),
    ).toBe(true);
  });

  it("converges with smaller fixed steps and is deterministic", () => {
    const run = (stepSeconds: number) =>
      simulateRide(line(100, 5), {
        durationSeconds: 0.5,
        config: config({ fixedStepSeconds: stepSeconds }),
        initial: { headDistanceM: 0, speedMps: 2 },
      });
    const one = run(1 / 120);
    const two = run(1 / 240);
    const four = run(1 / 480);
    expect(
      Math.abs(
        (two.frames.at(-1)?.speedMps ?? 0) -
          (four.frames.at(-1)?.speedMps ?? 0),
      ),
    ).toBeLessThan(0.01);
    expect(one.timeline.timeSeconds).toEqual(two.timeline.timeSeconds);
    expect(one.timeline.headDistanceM[one.timeline.length - 1]).toBeCloseTo(
      two.timeline.headDistanceM[two.timeline.length - 1] ?? 0,
      2,
    );
    expect(two.frames).toEqual(run(1 / 240).frames);
  });

  it("keeps RideTimeline immutable and copy-transferable", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120]),
      headDistanceM: new Float64Array([1, 2]),
      speedMps: new Float64Array([3, 4]),
    });
    const head = timeline.headDistanceM;
    head[0] = 999;
    expect(timeline.headDistanceM[0]).toBe(1);
    expect(timeline.toTransferable().buffers).toHaveLength(11);
    expect(
      RideTimeline.fromTransferable(timeline.toTransferable()).toJSON(),
    ).toEqual(timeline.toJSON());
    expect(Object.isFrozen(timeline)).toBe(true);
  });

  it("uses compiled zone masks and exposes operation state", () => {
    const track = compileTrack(
      [
        {
          id: "station",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 20)),
          zones: ["station"],
        },
      ],
      { samples: 33 },
    );
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config({
        zones: [
          {
            id: "station",
            kind: "station",
            startDistanceM: 0,
            endDistanceM: 20,
          },
        ],
      }),
      initial: { headDistanceM: 10, speedMps: 0 },
    });
    expect(result.operationState.activeZoneIds).toEqual(["station"]);
    expect(result.operationState.trainCount).toBe(1);
    expect(sampleTrackAtDistance(track, 10).position[2]).toBeCloseTo(10);
  });

  it("reports banked-turn curvature in the banked local frame", () => {
    const radius = 20;
    const track = compileTrack(
      [
        {
          id: "banked-circle",
          bank: () => Math.PI / 4,
          span: {
            position: (u: number) =>
              vec3(radius * Math.cos(u), 0, radius * Math.sin(u)),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(-radius * Math.sin(u), 0, radius * Math.cos(u))
                : vec3(-radius * Math.cos(u), 0, -radius * Math.sin(u)),
          },
        },
      ],
      { samples: 257 },
    );
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config(),
      initial: { headDistanceM: 0, speedMps: 12 },
    });
    expect(result.frames[0]?.telemetry.bankRad).toBeCloseTo(Math.PI / 4, 4);
    expect(
      Math.abs(result.frames[0]?.telemetry.lateralG ?? 0) * 9.80665,
    ).toBeCloseTo(
      Math.abs(
        9.80665 * Math.sin(Math.PI / 4) -
          ((12 * 12) / radius) * Math.cos(Math.PI / 4),
      ),
      2,
    );
  });

  it("keeps configured seats as world-space positions with the car frame", () => {
    const result = simulateRide(line(100), {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [
            { massKg: 1000, seatCount: 1, seatPositionsM: [vec3(0, 1, 0)] },
          ],
        },
      }),
      initial: { headDistanceM: 10, speedMps: 0 },
    });
    const seat = result.frames[0]?.cars[0]?.seats[0];
    expect(seat?.position[1]).toBeCloseTo(1);
    expect(seat?.frame.tangent).toEqual(result.frames[0]?.cars[0]?.tangent);
  });

  it("keeps a shallow slope held by explicit near-zero stiction and exposes force signs", () => {
    const shallow = compileTrack(
      [
        {
          id: "shallow",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 1, 100)),
        },
      ],
      { samples: 65 },
    );
    const held = simulateRide(shallow, {
      durationSeconds: 1,
      config: config({ staticStictionCoefficient: 0.2 }),
      initial: { headDistanceM: 10, speedMps: 0 },
    });
    expect(held.frames.at(-1)?.status).toBe("static-hold");
    const forces = computePerCarForces(shallow, config(), 10, 5);
    expect(forces[0]?.gravity).toBeLessThan(0);
    expect(forces[0]?.rolling).toBe(0);
  });

  it("preserves dynamics under a rigid yaw and translation", () => {
    const original = line(100, 5);
    const transformed = compileTrack(
      [
        {
          id: "line",
          span: SeventhOrderHermiteSpan.line(vec3(17, 5, -9), vec3(17, 5, 91)),
        },
      ],
      { samples: 65 },
    );
    const initial = { headDistanceM: 10, speedMps: 4 };
    const a = simulateRide(original, {
      durationSeconds: 0.5,
      config: config(),
      initial,
    });
    const b = simulateRide(transformed, {
      durationSeconds: 0.5,
      config: config(),
      initial,
    });
    expect(b.frames.at(-1)?.speedMps).toBeCloseTo(
      a.frames.at(-1)?.speedMps ?? 0,
      10,
    );
    expect(b.frames.at(-1)?.telemetry.verticalG).toBeCloseTo(
      a.frames.at(-1)?.telemetry.verticalG ?? 0,
      10,
    );
  });

  it("treats target-speed LSM force as a cap and settles opposing brakes", () => {
    const zones: OperationZone[] = [
      {
        id: "boost",
        kind: "boost",
        startDistanceM: 0,
        endDistanceM: 100,
        targetSpeedMps: 10,
        lsmForcePerCarN: 1000,
      },
      {
        id: "magnetic",
        kind: "brake",
        startDistanceM: 20,
        endDistanceM: 100,
        brakeForcePerCarN: 20000,
      },
    ];
    const boostForces = computePerCarForces(line(100), config({ zones }), 5, 0);
    expect(boostForces[0]?.drive).toBe(1000);
    const result = simulateRide(line(100), {
      durationSeconds: 3,
      config: config({ zones: [zones[1]!] }),
      initial: { headDistanceM: 20, speedMps: 8 },
    });
    expect(result.frames.at(-1)?.speedMps).toBe(0);
    expect(result.frames.at(-1)?.status).toBe("stall");
  });

  it("returns diagnostics instead of throwing for malformed numeric configuration", () => {
    const invalid = simulateRide(line(10), {
      durationSeconds: 1,
      config: config({
        fixedStepSeconds: Number.NaN,
        gravityDirection: vec3(0, 0, 0),
      }),
      initial: { headDistanceM: 0, speedMps: 0 },
    });
    expect(invalid.frames).toHaveLength(0);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(
      expect.arrayContaining(["fixedStepSeconds", "gravityDirection"]),
    );
  });

  it("uses the compiled world curvature vector for crest, valley, and turns", () => {
    const makeSpan = (direction: -1 | 1) => ({
      position: (u: number) => vec3(u, direction * (u - 0.5) ** 2, 0),
      derivative: (u: number, order = 1) =>
        order === 1
          ? vec3(1, direction * 2 * (u - 0.5), 0)
          : vec3(0, direction * 2, 0),
    });
    for (const direction of [-1, 1] as const) {
      const track = compileTrack(
        [{ id: direction < 0 ? "crest" : "valley", span: makeSpan(direction) }],
        { samples: 65 },
      );
      const distance = track.totalLength / 2;
      const sample = sampleTrackAtDistance(track, distance);
      const speed = 8;
      const result = simulateRide(track, {
        durationSeconds: 0,
        config: config({
          train: {
            ...config().train,
            cars: [{ massKg: 1000, seatCount: 0 }],
          },
        }),
        initial: { headDistanceM: distance, speedMps: speed },
      });
      const telemetry = result.frames[0]!.telemetry;
      const expected = [
        sample.curvatureVector[0]! * speed ** 2,
        sample.curvatureVector[1]! * speed ** 2 + 9.80665,
        sample.curvatureVector[2]! * speed ** 2,
      ];
      expect(telemetry.specificForceMps2[0]!).toBeCloseTo(expected[0]!, 3);
      expect(telemetry.specificForceMps2[1]!).toBeCloseTo(expected[1]!, 3);
      expect(telemetry.verticalG).toBeCloseTo(
        (expected[0]! * sample.normal[0]! +
          expected[1]! * sample.normal[1]! +
          expected[2]! * sample.normal[2]!) /
          9.80665,
        3,
      );
    }
  });

  it("uses corrected radians-per-metre bank derivative for signed roll rate", () => {
    const track = compileTrack(
      [
        {
          id: "banked-line",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 20)),
          bank: (u: number) => u * Math.PI,
        },
      ],
      { samples: 65 },
    );
    const distance = 7;
    const speed = -3;
    const sample = sampleTrackAtDistance(track, distance);
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: distance, speedMps: speed },
    });
    expect(result.frames[0]!.telemetry.rollRateRadPerSec).toBeCloseTo(
      sample.bankDerivative * speed,
      8,
    );
  });

  it("samples each seat at its longitudinal track distance and exposes seat telemetry", () => {
    const track = compileTrack(
      [
        {
          id: "seat-track",
          span: {
            position: (u: number) => vec3(0, u * u, u * 20),
            derivative: (u: number, order = 1) =>
              order === 1 ? vec3(0, 2 * u, 20) : vec3(0, 2, 0),
          },
        },
      ],
      { samples: 129 },
    );
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [
            {
              massKg: 1000,
              seatCount: 2,
              seatPositionsM: [vec3(0, 0, -2), vec3(0, 0, 2)],
            },
          ],
        },
      }),
      initial: { headDistanceM: 10, speedMps: 4 },
    });
    const car = result.frames[0]!.cars[0]!;
    expect(car.seats[0]!.frame.distance).toBeCloseTo(8, 2);
    expect(car.seats[1]!.frame.distance).toBeCloseTo(12, 2);
    expect(car.seats[0]!.telemetry.verticalG).not.toBe(
      car.seats[1]!.telemetry.verticalG,
    );
    expect(car.seats[0]!.telemetry.jerkMps3).toEqual(vec3());
    expect(car.seats[0]!.telemetry.bankRad).toBe(car.seats[0]!.frame.bank);
  });

  it("aggregates operation occupancy across the complete train", () => {
    const result = simulateRide(line(100), {
      durationSeconds: 0,
      config: config({
        zones: [
          {
            id: "rear-station",
            kind: "station",
            startDistanceM: 0,
            endDistanceM: 5,
          },
          {
            id: "rear-block",
            kind: "block",
            blockId: "B1",
            startDistanceM: 0,
            endDistanceM: 5,
          },
        ],
      }),
      initial: { headDistanceM: 8, speedMps: 0 },
    });
    expect(result.operationState.activeZoneIds).toEqual([
      "rear-station",
      "rear-block",
    ]);
    expect(result.operationState.occupiedBlockIds).toEqual(["B1"]);
    expect(result.operationState.stationId).toBe("rear-station");
  });

  it("emits deterministic entry and exit crossings for short zones in both directions", () => {
    const zone: OperationZone = {
      id: "short",
      kind: "block",
      startDistanceM: 1,
      endDistanceM: 2,
    };
    const forward = simulateRide(line(20), {
      durationSeconds: 1,
      config: config({
        fixedStepSeconds: 1,
        timelineStepSeconds: 0.5,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [zone],
      }),
      initial: { headDistanceM: 0.5, speedMps: 5 },
    });
    expect(
      forward.events.map((event) => [event.type, event.direction]),
    ).toEqual([
      ["zone-entry", "forward"],
      ["zone-exit", "forward"],
    ]);
    expect(forward.events.map((event) => event.timeSeconds)).toEqual([
      0.1, 0.3,
    ]);

    const reverse = simulateRide(line(20), {
      durationSeconds: 1,
      config: config({
        fixedStepSeconds: 1,
        timelineStepSeconds: 0.5,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [zone],
      }),
      initial: { headDistanceM: 3, speedMps: -5 },
    });
    expect(
      reverse.events.map((event) => [event.type, event.direction]),
    ).toEqual([
      ["zone-entry", "reverse"],
      ["zone-exit", "reverse"],
    ]);
    expect(reverse.events.map((event) => event.timeSeconds)).toEqual([
      0.2, 0.4,
    ]);
  });

  it("validates nested overrides, seat offsets, envelope dimensions, and zones precisely", () => {
    const negativeBrake = computePerCarForces(
      line(10),
      config({
        zones: [
          {
            id: "unsafe-brake",
            kind: "brake",
            startDistanceM: 0,
            endDistanceM: 10,
            brakeForcePerCarN: -100,
          },
        ],
      }),
      5,
      -2,
    );
    expect(negativeBrake[0]!.brake).toBe(0);
    const invalid = simulateRide(line(10), {
      durationSeconds: 1,
      config: config({
        gravityMps2: 0,
        lsmTargetGainNPerMps: -1,
        dragCdA: -1,
        train: {
          ...config().train,
          envelope: {
            halfWidthM: 0,
            aboveRailM: Number.NaN,
            belowRailM: 1,
            noseTailMarginM: -1,
          },
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(Number.NaN, 0, 0)],
            },
          ],
        },
        zones: [
          {
            id: "bad",
            kind: "brake",
            startDistanceM: 8,
            endDistanceM: 4,
            brakeForcePerCarN: -1,
            targetSpeedMps: Number.POSITIVE_INFINITY,
          },
        ],
      }),
      initial: { headDistanceM: 0, speedMps: 0 },
    });
    expect(invalid.frames).toHaveLength(0);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(
      expect.arrayContaining([
        "gravityMps2",
        "lsmTargetGainNPerMps",
        "dragCdA",
        "train.envelope.halfWidthM",
        "train.envelope.aboveRailM",
        "train.envelope.noseTailMarginM",
        "train.cars[0].seatPositionsM[0]",
        "zones[0].startDistanceM",
        "zones[0].brakeForcePerCarN",
        "zones[0].targetSpeedMps",
      ]),
    );
  });

  it("emits a numerical diagnostic when an integration state overflows", () => {
    const result = simulateRide(line(10), {
      durationSeconds: 0.1,
      config: config({ dragCdA: 1 }),
      initial: { headDistanceM: 0, speedMps: Number.MAX_VALUE },
    });
    expect(result.diagnostics).toContainEqual({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "state",
      message: "Fixed-step integration produced a non-finite state",
    });
  });

  it("interpolates timeline states at exact output times", () => {
    const result = simulateRide(line(20), {
      durationSeconds: 0.1,
      config: config({
        fixedStepSeconds: 0.1,
        timelineStepSeconds: 0.05,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: 0, speedMps: 10 },
    });
    expect(Array.from(result.timeline.timeSeconds)).toEqual([0, 0.05, 0.1]);
    expect(Array.from(result.timeline.headDistanceM)).toEqual([0, 0.5, 1]);
  });

  it("preserves dynamics under arbitrary rigid 3D rotation", () => {
    const original = compileTrack(
      [
        {
          id: "3d",
          span: {
            position: (u: number) => vec3(u * 10, u * u * 3, u * 2),
            derivative: (u: number, order = 1) =>
              order === 1 ? vec3(10, 6 * u, 2) : vec3(0, 6, 0),
          },
        },
      ],
      { samples: 129 },
    );
    const rotateVector = (point: ReturnType<typeof vec3>) => {
      const [x, y, z] = point;
      const axis = vec3(
        1 / Math.sqrt(14),
        2 / Math.sqrt(14),
        3 / Math.sqrt(14),
      );
      const angle = 0.7;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const oneMinusCosine = 1 - cosine;
      return vec3(
        (cosine + axis[0] ** 2 * oneMinusCosine) * x +
          (axis[0] * axis[1] * oneMinusCosine - axis[2] * sine) * y +
          (axis[0] * axis[2] * oneMinusCosine + axis[1] * sine) * z +
          0,
        (axis[1] * axis[0] * oneMinusCosine + axis[2] * sine) * x +
          (cosine + axis[1] ** 2 * oneMinusCosine) * y +
          (axis[1] * axis[2] * oneMinusCosine - axis[0] * sine) * z -
          0,
        (axis[2] * axis[0] * oneMinusCosine - axis[1] * sine) * x +
          (axis[2] * axis[1] * oneMinusCosine + axis[0] * sine) * y +
          (cosine + axis[2] ** 2 * oneMinusCosine) * z +
          0,
      );
    };
    const rotate = (point: ReturnType<typeof vec3>) => {
      const rotated = rotateVector(point);
      return vec3(rotated[0] + 3, rotated[1] - 4, rotated[2] + 7);
    };
    const transformed = compileTrack(
      [
        {
          id: "3d",
          span: {
            position: (u: number) => rotate(vec3(u * 10, u * u * 3, u * 2)),
            derivative: (u: number, order = 1) =>
              rotateVector(order === 1 ? vec3(10, 6 * u, 2) : vec3(0, 6, 0)),
          },
        },
      ],
      { samples: 129 },
    );
    const initial = { headDistanceM: 4, speedMps: 6 };
    const a = simulateRide(original, {
      durationSeconds: 0.2,
      config: config({
        gravityDirection: vec3(0, -1, 0),
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial,
    });
    const b = simulateRide(transformed, {
      durationSeconds: 0.2,
      config: config({
        gravityDirection: rotateVector(vec3(0, -1, 0)),
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial,
    });
    expect(b.frames.at(-1)!.speedMps).toBeCloseTo(a.frames.at(-1)!.speedMps, 8);
    const originalForce = a.frames.at(-1)!.telemetry.specificForceMps2;
    const transformedForce = b.frames.at(-1)!.telemetry.specificForceMps2;
    const expectedForce = rotateVector(originalForce);
    expect(transformedForce[0]).toBeCloseTo(expectedForce[0], 5);
    expect(transformedForce[1]).toBeCloseTo(expectedForce[1], 5);
    expect(transformedForce[2]).toBeCloseTo(expectedForce[2], 5);
    expect(b.frames.at(-1)!.telemetry.longitudinalG).toBeCloseTo(
      a.frames.at(-1)!.telemetry.longitudinalG,
      5,
    );
  });
});
