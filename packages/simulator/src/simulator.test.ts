import { describe, expect, it } from "vitest";
import {
  CompiledTrackData,
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
      initial: { headDistanceM: 6, speedMps: 0.1 },
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
      initial: { headDistanceM: 6, speedMps: speed },
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
      initial: { headDistanceM: 6, speedMps: 0 },
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
    const curved = compileTrack(
      [
        {
          id: "curved-graded",
          span: {
            position: (u: number) =>
              vec3(
                80 * u,
                6 * Math.sin(2 * Math.PI * u),
                12 * u + 4 * Math.sin(Math.PI * u),
              ),
            derivative: (u: number, order = 1) => {
              if (order === 1)
                return vec3(
                  80,
                  12 * Math.PI * Math.cos(2 * Math.PI * u),
                  12 + 4 * Math.PI * Math.cos(Math.PI * u),
                );
              return vec3(
                0,
                -24 * Math.PI ** 2 * Math.sin(2 * Math.PI * u),
                -4 * Math.PI ** 2 * Math.sin(Math.PI * u),
              );
            },
          },
        },
      ],
      { samples: 257 },
    );
    expect(
      sampleTrackAtDistance(curved, curved.totalLength / 2).curvature,
    ).toBeGreaterThan(0);
    const run = (stepSeconds: number) =>
      simulateRide(curved, {
        durationSeconds: 0.5,
        config: config({ fixedStepSeconds: stepSeconds }),
        initial: { headDistanceM: 30, speedMps: 8 },
      });
    const one = run(1 / 120);
    const two = run(1 / 240);
    const four = run(1 / 480);
    const speed120To240 = Math.abs(
      (one.frames.at(-1)?.speedMps ?? 0) - (two.frames.at(-1)?.speedMps ?? 0),
    );
    const speed240To480 = Math.abs(
      (two.frames.at(-1)?.speedMps ?? 0) - (four.frames.at(-1)?.speedMps ?? 0),
    );
    const distance120To240 = Math.abs(
      (one.frames.at(-1)?.headDistanceM ?? 0) -
        (two.frames.at(-1)?.headDistanceM ?? 0),
    );
    const distance240To480 = Math.abs(
      (two.frames.at(-1)?.headDistanceM ?? 0) -
        (four.frames.at(-1)?.headDistanceM ?? 0),
    );
    expect(speed120To240).toBeLessThan(0.01);
    expect(speed240To480).toBeLessThan(0.01);
    expect(distance120To240).toBeLessThan(0.01);
    expect(distance240To480).toBeLessThan(0.01);
    expect(one.timeline.timeSeconds).toEqual(two.timeline.timeSeconds);
    expect(one.timeline.headDistanceM[one.timeline.length - 1]).toBeCloseTo(
      two.timeline.headDistanceM[two.timeline.length - 1] ?? 0,
      2,
    );
    expect(two.frames).toEqual(run(1 / 240).frames);
  });

  it("includes initial kinetic energy and wraps closed-track cars without changing unwrapped distances", () => {
    const track = compileTrack(
      [
        {
          id: "closed-graded",
          span: {
            position: (u: number) =>
              vec3(
                20 * Math.cos(2 * Math.PI * u),
                3 * Math.sin(2 * Math.PI * u),
                20 * Math.sin(2 * Math.PI * u),
              ),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(
                    -40 * Math.PI * Math.sin(2 * Math.PI * u),
                    6 * Math.PI * Math.cos(2 * Math.PI * u),
                    40 * Math.PI * Math.cos(2 * Math.PI * u),
                  )
                : vec3(
                    -80 * Math.PI ** 2 * Math.cos(2 * Math.PI * u),
                    -12 * Math.PI ** 2 * Math.sin(2 * Math.PI * u),
                    -80 * Math.PI ** 2 * Math.sin(2 * Math.PI * u),
                  ),
          },
        },
      ],
      { samples: 257 },
    );
    const closedConfig = {
      ...config(),
      closedTrack: true,
      train: {
        ...config().train,
        cars: [
          { massKg: 1000, seatCount: 0 },
          { massKg: 1000, seatCount: 0 },
        ],
        spacingM: 3,
      },
    } as SimulatorConfig;
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: closedConfig,
      initial: { headDistanceM: 1, speedMps: 4 },
    });
    const frame = result.frames[0]!;
    expect(frame.cars[0]!.distanceM).toBe(1);
    expect(frame.telemetry.kineticEnergyJ).toBeCloseTo(16000, 8);
    expect(frame.telemetry.energyErrorJ).toBeCloseTo(0, 8);

    expect(frame.cars[1]!.distanceM).toBe(-2);
    expect(frame.cars[1]!.frame.distance).toBeCloseTo(track.totalLength - 2, 6);
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

  it("rejects non-finite timeline data at the exported boundary", () => {
    expect(
      () =>
        new RideTimeline({
          sampleRateHz: 120,
          timeSeconds: new Float64Array([0]),
          headDistanceM: new Float64Array([Number.NaN]),
          speedMps: new Float64Array([0]),
        }),
    ).toThrow(/headDistanceM/);
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
      initial: { headDistanceM: 6, speedMps: 12 },
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
    const boostForces = computePerCarForces(line(100), config({ zones }), 6, 0);
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
    expect(reverse.events[0]!.timeSeconds).toBeCloseTo(0.2, 12);
    expect(reverse.events[1]!.timeSeconds).toBeCloseTo(0.4, 12);
  });

  it("deduplicates train-wide zone events while tracking a rear car outside the head", () => {
    const zone: OperationZone = {
      id: "rear-only",
      kind: "block",
      startDistanceM: 0,
      endDistanceM: 2,
    };
    const result = simulateRide(line(30), {
      durationSeconds: 1,
      config: config({
        fixedStepSeconds: 1,
        timelineStepSeconds: 1,
        train: {
          ...config().train,
          cars: [
            { massKg: 1000, seatCount: 0 },
            { massKg: 1000, seatCount: 0 },
          ],
          spacingM: 5,
        },
        zones: [zone],
      }),
      initial: { headDistanceM: 6, speedMps: 2 },
    });
    expect(
      result.events.map(({ type, boundary, direction }) => [
        type,
        boundary,
        direction,
      ]),
    ).toEqual([
      ["zone-entry", "start", "forward"],
      ["zone-exit", "end", "forward"],
    ]);
    expect(result.events.map((event) => event.timeSeconds)).toEqual([0, 0.5]);
  });

  it("preserves exact zone endpoint crossings in forward and reverse travel", () => {
    const zone: OperationZone = {
      id: "endpoint",
      kind: "block",
      startDistanceM: 1,
      endDistanceM: 2,
    };
    const make = (headDistanceM: number, speedMps: number) =>
      simulateRide(line(10), {
        durationSeconds: 1,
        config: config({
          fixedStepSeconds: 0.5,
          timelineStepSeconds: 0.5,
          train: {
            ...config().train,
            cars: [{ massKg: 1000, seatCount: 0 }],
          },
          zones: [zone],
        }),
        initial: { headDistanceM, speedMps },
      });
    const forward = make(0, 2);
    const reverse = make(3, -2);
    expect(
      forward.events.map((event) => [
        event.type,
        event.boundary,
        event.timeSeconds,
      ]),
    ).toEqual([
      ["zone-entry", "start", 0.5],
      ["zone-exit", "end", 1],
    ]);
    expect(
      reverse.events.map((event) => [
        event.type,
        event.boundary,
        event.timeSeconds,
      ]),
    ).toEqual([
      ["zone-entry", "end", 0.5],
      ["zone-exit", "start", 1],
    ]);
  });

  it("repeats train-wide zone transitions on explicit closed-track laps", () => {
    const track = compileTrack(
      [
        {
          id: "loop",
          span: {
            position: (u: number) =>
              vec3(
                20 * Math.cos(2 * Math.PI * u),
                0,
                20 * Math.sin(2 * Math.PI * u),
              ),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(
                    -40 * Math.PI * Math.sin(2 * Math.PI * u),
                    0,
                    40 * Math.PI * Math.cos(2 * Math.PI * u),
                  )
                : vec3(
                    -80 * Math.PI ** 2 * Math.cos(2 * Math.PI * u),
                    0,
                    -80 * Math.PI ** 2 * Math.sin(2 * Math.PI * u),
                  ),
          },
        },
      ],
      { samples: 257 },
    );
    const result = simulateRide(track, {
      durationSeconds: 2,
      config: {
        ...config(),
        closedTrack: true,
        fixedStepSeconds: 1,
        timelineStepSeconds: 1,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [
          {
            id: "lap-zone",
            kind: "block",
            startDistanceM: 10,
            endDistanceM: 20,
          },
        ],
      },
      initial: { headDistanceM: 0, speedMps: 100 },
    });
    expect(result.events.map(({ type, boundary }) => [type, boundary])).toEqual(
      [
        ["zone-entry", "start"],
        ["zone-exit", "end"],
        ["zone-entry", "start"],
        ["zone-exit", "end"],
      ],
    );
  });

  it("validates nested overrides, seat offsets, envelope dimensions, and zones precisely", () => {
    expect(() =>
      computePerCarForces(
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
      ),
    ).toThrow(/brakeForcePerCarN/);
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
      initial: { headDistanceM: 6, speedMps: Number.MAX_VALUE },
    });
    expect(result.diagnostics).toContainEqual({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "train.cars[0].force.drag",
      message: "Aerodynamic drag force must be finite",
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
    const middle = result.timeline.frames[1]!;
    const car = middle.cars[0]!;
    expect(Object.isFrozen(middle)).toBe(true);
    expect(Object.isFrozen(car)).toBe(true);
    expect(car.frame.distance).toBeCloseTo(car.distanceM, 12);
    expect(car.telemetry.bankRad).toBe(car.frame.bank);
    expect(car.seats).toHaveLength(0);
    expect(middle.selection.front).toBe(car);
    expect(middle.telemetry.perCar[0]).toBe(car.telemetry);
    expect(middle.telemetry.kineticEnergyJ).toBeCloseTo(
      (result.frames[0]!.telemetry.kineticEnergyJ +
        result.frames[1]!.telemetry.kineticEnergyJ) /
        2,
      12,
    );
  });

  it("interpolates seat frames and all per-car/top-level telemetry coherently", () => {
    const result = simulateRide(line(50, 5), {
      durationSeconds: 0.2,
      config: config({
        fixedStepSeconds: 0.2,
        timelineStepSeconds: 0.1,
        train: {
          ...config().train,
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(0, 1, 0.5)],
            },
          ],
        },
      }),
      initial: { headDistanceM: 10, speedMps: 4 },
    });
    const middle = result.timeline.frames[1]!;
    const car = middle.cars[0]!;
    const seat = car.seats[0]!;
    expect(car.frame.distance).toBeCloseTo(car.distanceM, 12);
    expect(seat.frame.distance).toBeCloseTo(seat.distanceM, 12);
    expect(seat.position).toEqual(car.seatPositions[0]);
    expect(car.telemetry).toEqual(middle.telemetry.perCar[0]);
    expect(middle.telemetry.bankRad).toBe(car.telemetry.bankRad);
    expect(middle.telemetry.rollRateRadPerSec).toBe(
      car.telemetry.rollRateRadPerSec,
    );
    expect(middle.telemetry.accumulatedDriveWorkJ).toBeCloseTo(
      (result.frames[0]!.telemetry.accumulatedDriveWorkJ +
        result.frames[1]!.telemetry.accumulatedDriveWorkJ) /
        2,
      12,
    );
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
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(0.4, 0.8, 0.7)],
            },
            {
              massKg: 1200,
              seatCount: 1,
              seatPositionsM: [vec3(-0.3, 0.5, -0.4)],
            },
          ],
          spacingM: 2,
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
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(0.4, 0.8, 0.7)],
            },
            {
              massKg: 1200,
              seatCount: 1,
              seatPositionsM: [vec3(-0.3, 0.5, -0.4)],
            },
          ],
          spacingM: 2,
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
    const originalFrame = a.frames.at(-1)!;
    const transformedFrame = b.frames.at(-1)!;
    expect(transformedFrame.telemetry.lateralG).toBeCloseTo(
      originalFrame.telemetry.lateralG,
      5,
    );
    expect(transformedFrame.telemetry.verticalG).toBeCloseTo(
      originalFrame.telemetry.verticalG,
      5,
    );
    expect(transformedFrame.telemetry.bankRad).toBeCloseTo(
      originalFrame.telemetry.bankRad,
      8,
    );
    expect(transformedFrame.telemetry.rollRateRadPerSec).toBeCloseTo(
      originalFrame.telemetry.rollRateRadPerSec,
      8,
    );
    expect(transformedFrame.telemetry.kineticEnergyJ).toBeCloseTo(
      originalFrame.telemetry.kineticEnergyJ,
      8,
    );
    expect(transformedFrame.telemetry.accumulatedDriveWorkJ).toBeCloseTo(
      originalFrame.telemetry.accumulatedDriveWorkJ,
      8,
    );
    expect(transformedFrame.telemetry.accumulatedLossWorkJ).toBeCloseTo(
      originalFrame.telemetry.accumulatedLossWorkJ,
      8,
    );
    expect(transformedFrame.telemetry.energyErrorJ).toBeCloseTo(
      originalFrame.telemetry.energyErrorJ,
      8,
    );
    transformedFrame.cars.forEach((car, index) => {
      const originalCar = originalFrame.cars[index]!;
      expect(car.telemetry.longitudinalG).toBeCloseTo(
        originalCar.telemetry.longitudinalG,
        5,
      );
      expect(car.telemetry.lateralG).toBeCloseTo(
        originalCar.telemetry.lateralG,
        5,
      );
      expect(car.telemetry.verticalG).toBeCloseTo(
        originalCar.telemetry.verticalG,
        5,
      );
      expect(car.telemetry.bankRad).toBeCloseTo(
        originalCar.telemetry.bankRad,
        8,
      );
      expect(car.telemetry.rollRateRadPerSec).toBeCloseTo(
        originalCar.telemetry.rollRateRadPerSec,
        8,
      );
      expect(car.seats[0]!.telemetry.longitudinalG).toBeCloseTo(
        originalCar.seats[0]!.telemetry.longitudinalG,
        5,
      );
      expect(car.seats[0]!.telemetry.lateralG).toBeCloseTo(
        originalCar.seats[0]!.telemetry.lateralG,
        5,
      );
      expect(car.seats[0]!.telemetry.verticalG).toBeCloseTo(
        originalCar.seats[0]!.telemetry.verticalG,
        5,
      );
      expect(car.seats[0]!.telemetry.bankRad).toBeCloseTo(
        originalCar.seats[0]!.telemetry.bankRad,
        8,
      );
    });
  });

  it("rejects malformed force queries at the exported boundary", () => {
    expect(() =>
      computePerCarForces(line(10), config({ gravityMps2: Number.NaN }), 1, 0),
    ).toThrow(/gravityMps2/);
    expect(() =>
      computePerCarForces(line(10), config(), Number.NaN, 0),
    ).toThrow(/initial/);
  });

  it("rejects open-track car and longitudinal seat placements outside the track", () => {
    const result = simulateRide(line(10), {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(0, 0, 8)],
            },
            { massKg: 1000, seatCount: 0 },
          ],
          spacingM: 4,
        },
      }),
      initial: { headDistanceM: 3, speedMps: 0 },
    });

    expect(result.frames).toHaveLength(0);
    expect(result.diagnostics.map((diagnostic) => diagnostic.field)).toEqual(
      expect.arrayContaining([
        "initial.train.cars[1].distanceM",
        "initial.train.cars[0].seatPositionsM[0].distanceM",
      ]),
    );
  });

  it("rejects force products that overflow despite finite configuration values", () => {
    const extreme = config({
      train: {
        ...config().train,
        cars: [{ massKg: 1000, seatCount: 0 }],
      },
      airDensityKgPerM3: Number.MAX_VALUE,
      dragCdA: Number.MAX_VALUE,
    });

    expect(() => computePerCarForces(line(10), extreme, 1, 2)).toThrow(
      /airDensityKgPerM3.*dragCdA|dragCdA.*airDensityKgPerM3/,
    );
    const result = simulateRide(line(10), {
      durationSeconds: 0,
      config: extreme,
      initial: { headDistanceM: 1, speedMps: 2 },
    });
    expect(result.frames).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SIM_INVALID_CONFIGURATION",
        field: "airDensityKgPerM3*dragCdA",
      }),
    );
  });

  it("uses half-open closed-track zone ownership at the canonical seam", () => {
    const track = line(10);
    const zone: OperationZone = {
      id: "full-lap",
      kind: "block",
      startDistanceM: 0,
      endDistanceM: track.totalLength,
    };
    const forward = simulateRide(track, {
      durationSeconds: 0,
      config: config({
        closedTrack: true,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [zone],
      }),
      initial: { headDistanceM: track.totalLength, speedMps: 2 },
    });
    expect(forward.events).toEqual([
      expect.objectContaining({
        type: "zone-entry",
        boundary: "start",
        direction: "forward",
        timeSeconds: 0,
      }),
    ]);

    const reverse = simulateRide(track, {
      durationSeconds: 0.5,
      config: config({
        closedTrack: true,
        fixedStepSeconds: 0.5,
        timelineStepSeconds: 0.5,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [
          {
            id: "partial-lap",
            kind: "block",
            startDistanceM: 0,
            endDistanceM: 4,
          },
        ],
      }),
      initial: { headDistanceM: 0, speedMps: -2 },
    });
    expect(
      reverse.events.map(({ type, boundary, timeSeconds }) => [
        type,
        boundary,
        timeSeconds,
      ]),
    ).toEqual([["zone-exit", "start", 0]]);

    const endingAtSeam = simulateRide(track, {
      durationSeconds: 0.5,
      config: config({
        closedTrack: true,
        fixedStepSeconds: 0.5,
        timelineStepSeconds: 0.5,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [
          {
            id: "ending-at-track-end",
            kind: "block",
            startDistanceM: 4,
            endDistanceM: track.totalLength,
          },
        ],
      }),
      initial: { headDistanceM: track.totalLength, speedMps: -2 },
    });
    expect(
      endingAtSeam.events.map(({ type, boundary, timeSeconds }) => [
        type,
        boundary,
        timeSeconds,
      ]),
    ).toEqual([["zone-entry", "end", 0]]);
  });

  it("keeps seat placement invariant when all authoritative frame arrays rotate", () => {
    const original = compileTrack(
      [
        {
          id: "authoritative-frame",
          span: {
            position: (u: number) => vec3(u * 10, u * u * 3, u * 2),
            derivative: (u: number, order = 1) =>
              order === 1 ? vec3(10, 6 * u, 2) : vec3(0, 6, 0),
          },
        },
      ],
      { samples: 129 },
    );
    const axis = vec3(1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14));
    const angle = 0.7;
    const rotateVector = (value: ReturnType<typeof vec3>) => {
      const [x, y, z] = value;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const oneMinusCosine = 1 - cosine;
      return vec3(
        (cosine + axis[0] ** 2 * oneMinusCosine) * x +
          (axis[0] * axis[1] * oneMinusCosine - axis[2] * sine) * y +
          (axis[0] * axis[2] * oneMinusCosine + axis[1] * sine) * z,
        (axis[1] * axis[0] * oneMinusCosine + axis[2] * sine) * x +
          (cosine + axis[1] ** 2 * oneMinusCosine) * y +
          (axis[1] * axis[2] * oneMinusCosine - axis[0] * sine) * z,
        (axis[2] * axis[0] * oneMinusCosine - axis[1] * sine) * x +
          (axis[2] * axis[1] * oneMinusCosine + axis[0] * sine) * y +
          (cosine + axis[2] ** 2 * oneMinusCosine) * z,
      );
    };
    const translation = vec3(3, -4, 7);
    const rotatePosition = (value: ReturnType<typeof vec3>) => {
      const rotated = rotateVector(value);
      return vec3(
        rotated[0] + translation[0],
        rotated[1] + translation[1],
        rotated[2] + translation[2],
      );
    };
    const mapVectors = (
      values: Float64Array,
      transform: (value: ReturnType<typeof vec3>) => ReturnType<typeof vec3>,
    ) => {
      const output = new Float64Array(values.length);
      for (let index = 0; index < values.length; index += 3) {
        const value = transform(
          vec3(values[index]!, values[index + 1]!, values[index + 2]!),
        );
        output.set(value, index);
      }
      return output;
    };
    const rotated = new CompiledTrackData({
      positions: mapVectors(original.positions, rotatePosition),
      tangents: mapVectors(original.tangents, rotateVector),
      normals: mapVectors(original.normals, rotateVector),
      binormals: mapVectors(original.binormals, rotateVector),
      distances: original.distances,
      curvature: original.curvature,
      curvatureVector: mapVectors(original.curvatureVector, rotateVector),
      bank: original.bank,
      bankDerivative: original.bankDerivative,
      zoneMasks: original.zoneMasks,
      zoneNames: original.zoneNames,
      elementIndices: original.elementIndices,
      elementBoundaries: original.elementBoundaries,
      parameters: original.parameters,
      totalLength: original.totalLength,
    });
    const train = {
      ...config().train,
      cars: [
        {
          massKg: 1000,
          seatCount: 1,
          seatPositionsM: [vec3(0.4, 0.8, 0.7)],
        },
      ],
    };
    const a = simulateRide(original, {
      durationSeconds: 0,
      config: config({ train }),
      initial: { headDistanceM: 4, speedMps: 6 },
    });
    const b = simulateRide(rotated, {
      durationSeconds: 0,
      config: config({
        gravityDirection: rotateVector(vec3(0, -1, 0)),
        train,
      }),
      initial: { headDistanceM: 4, speedMps: 6 },
    });
    const originalSeat = a.frames[0]!.cars[0]!.seats[0]!;
    const rotatedSeat = b.frames[0]!.cars[0]!.seats[0]!;
    const expectedPosition = rotatePosition(originalSeat.position);
    expect(rotatedSeat.position[0]).toBeCloseTo(expectedPosition[0], 10);
    expect(rotatedSeat.position[1]).toBeCloseTo(expectedPosition[1], 10);
    expect(rotatedSeat.position[2]).toBeCloseTo(expectedPosition[2], 10);
    for (const index of [0, 1, 2]) {
      expect(rotatedSeat.frame.normal[index]).toBeCloseTo(
        rotateVector(originalSeat.frame.normal)[index]!,
        10,
      );
      expect(rotatedSeat.frame.binormal[index]).toBeCloseTo(
        rotateVector(originalSeat.frame.binormal)[index]!,
        10,
      );
    }
  });

  it("terminates at the open-track car boundary before geometry leaves the track", () => {
    const track = line(10);
    const result = simulateRide(track, {
      durationSeconds: 0.1,
      config: config({
        fixedStepSeconds: 0.1,
        timelineStepSeconds: 0.1,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: 9, speedMps: 20 },
    });

    expect(result.frames).toHaveLength(2);
    expect(result.frames.at(-1)?.timeSeconds).toBeCloseTo(0.05, 12);
    expect(result.frames.at(-1)?.headDistanceM).toBe(track.totalLength);
    expect(result.frames.at(-1)?.cars[0]?.distanceM).toBe(track.totalLength);
    expect(result.diagnostics).toContainEqual({
      code: "SIM_INVALID_STATE",
      severity: "error",
      field: "state.train.cars[0].distanceM",
      message: `Open-track car distance left [0, ${track.totalLength}] during integration`,
    });
  });

  it("sweeps arbitrarily narrow zone boundaries exactly without epsilon probes", () => {
    const startDistanceM = 5;
    const endDistanceM = startDistanceM + 1e-12;
    const result = simulateRide(line(20), {
      durationSeconds: 2,
      config: config({
        fixedStepSeconds: 2,
        timelineStepSeconds: 2,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [
          {
            id: "narrow",
            kind: "block",
            startDistanceM,
            endDistanceM,
          },
        ],
      }),
      initial: { headDistanceM: 4, speedMps: 1 },
    });

    expect(
      result.events.map(({ type, boundary, timeSeconds }) => [
        type,
        boundary,
        timeSeconds,
      ]),
    ).toEqual([
      ["zone-entry", "start", 1],
      ["zone-exit", "end", 1 + 1e-12],
    ]);
  });

  it("terminates at the open-track longitudinal seat boundary", () => {
    const track = line(10);
    const result = simulateRide(track, {
      durationSeconds: 0.1,
      config: config({
        fixedStepSeconds: 0.1,
        timelineStepSeconds: 0.1,
        train: {
          ...config().train,
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [vec3(0, 0, 1)],
            },
          ],
        },
      }),
      initial: { headDistanceM: 8, speedMps: 20 },
    });

    expect(result.frames.at(-1)?.timeSeconds).toBeCloseTo(0.05, 12);
    expect(result.frames.at(-1)?.cars[0]?.distanceM).toBe(
      track.totalLength - 1,
    );
    expect(result.frames.at(-1)?.cars[0]?.seats[0]?.distanceM).toBe(
      track.totalLength,
    );
    expect(result.diagnostics).toContainEqual({
      code: "SIM_INVALID_STATE",
      severity: "error",
      field: "state.train.cars[0].seats[0].distanceM",
      message: `Open-track seat distance left [0, ${track.totalLength}] during integration`,
    });
  });

  it("rejects non-finite aggregate force and mass results", () => {
    const overflowingMass = config({
      gravityMps2: Number.MIN_VALUE,
      train: {
        ...config().train,
        cars: [
          { massKg: Number.MAX_VALUE, seatCount: 0 },
          { massKg: Number.MAX_VALUE, seatCount: 0 },
        ],
      },
    });
    const massResult = simulateRide(line(10), {
      durationSeconds: 0,
      config: overflowingMass,
      initial: { headDistanceM: 4, speedMps: 0 },
    });
    expect(massResult.frames).toHaveLength(0);
    expect(massResult.diagnostics).toContainEqual({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "train.totalMassKg",
      message: "Total train mass must be finite",
    });

    const overflowingForce = config({
      zones: [
        {
          id: "force-overflow",
          kind: "launch",
          startDistanceM: 0,
          endDistanceM: 10,
          lsmForcePerCarN: Number.MAX_VALUE,
        },
      ],
      train: {
        ...config().train,
        cars: [
          { massKg: 1000, seatCount: 0 },
          { massKg: 1000, seatCount: 0 },
        ],
      },
    });
    expect(() => computePerCarForces(line(10), overflowingForce, 4, 0)).toThrow(
      /totalForce/,
    );
    const forceResult = simulateRide(line(10), {
      durationSeconds: 0,
      config: overflowingForce,
      initial: { headDistanceM: 4, speedMps: 0 },
    });
    expect(forceResult.frames).toHaveLength(0);
    expect(forceResult.diagnostics).toContainEqual({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "totalForce",
      message: "Summed train force must be finite",
    });
  });

  it("rejects non-finite derived telemetry instead of exposing it", () => {
    const result = simulateRide(line(10), {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: 1, speedMps: Number.MAX_VALUE },
    });

    expect(result.frames).toHaveLength(0);
    expect(result.diagnostics).toContainEqual({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "telemetry.worldAccelerationMps2",
      message: "World acceleration must be finite",
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns an empty constructible timeline for invalid timeline step %s",
    (timelineStepSeconds) => {
      expect(() =>
        simulateRide(line(10), {
          durationSeconds: 0.1,
          config: config({ timelineStepSeconds }),
          initial: { headDistanceM: 1, speedMps: 0 },
        }),
      ).not.toThrow();
      const result = simulateRide(line(10), {
        durationSeconds: 0.1,
        config: config({ timelineStepSeconds }),
        initial: { headDistanceM: 1, speedMps: 0 },
      });
      expect(result.frames).toHaveLength(0);
      expect(result.timeline.length).toBe(0);
      expect(result.timeline.sampleRateHz).toBe(120);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ field: "timelineStepSeconds" }),
      );
    },
  );

  it("returns a finite timeline and one precise diagnostic when work accumulation overflows", () => {
    const result = simulateRide(line(100), {
      durationSeconds: 2,
      config: config({
        fixedStepSeconds: 2,
        timelineStepSeconds: 2,
        gravityMps2: 9.80665,
        train: {
          ...config().train,
          cars: [{ massKg: Number.MAX_VALUE / 9.80665, seatCount: 0 }],
        },
        zones: [
          {
            id: "max-drive",
            kind: "launch",
            startDistanceM: 0,
            endDistanceM: 100,
            lsmForcePerCarN: Number.MAX_VALUE,
            lsmPowerPerCarW: Number.MAX_VALUE,
          },
        ],
      }),
      initial: { headDistanceM: 0, speedMps: 1 },
    });

    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.timeline.length).toBe(result.frames.length);
    expect(result.diagnostics).toEqual([
      {
        code: "SIM_NUMERICAL",
        severity: "error",
        field: "work.driveJ",
        message: "Drive work increment must be finite",
      },
    ]);
    expect(
      result.timeline.frames.every((frame) =>
        [
          frame.timeSeconds,
          frame.headDistanceM,
          frame.speedMps,
          frame.telemetry.accumulatedDriveWorkJ,
        ].every(Number.isFinite),
      ),
    ).toBe(true);
  });

  it("does not append a generic diagnostic to a specific numerical failure", () => {
    const result = simulateRide(line(10), {
      durationSeconds: 0,
      config: config({
        gravityMps2: Number.MIN_VALUE,
        train: {
          ...config().train,
          cars: [
            { massKg: Number.MAX_VALUE, seatCount: 0 },
            { massKg: Number.MAX_VALUE, seatCount: 0 },
          ],
        },
      }),
      initial: { headDistanceM: 4, speedMps: 0 },
    });

    expect(result.diagnostics).toEqual([
      {
        code: "SIM_NUMERICAL",
        severity: "error",
        field: "train.totalMassKg",
        message: "Total train mass must be finite",
      },
    ]);
  });

  it("preserves distinct representable crossing timestamps near one second", () => {
    const startDistanceM = 1 + 1e-15;
    const endDistanceM = 1 + 2e-15;
    const result = simulateRide(line(4), {
      durationSeconds: 2,
      config: config({
        fixedStepSeconds: 2,
        timelineStepSeconds: 2,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones: [
          {
            id: "ultra-narrow",
            kind: "block",
            startDistanceM,
            endDistanceM,
          },
        ],
      }),
      initial: { headDistanceM: 0, speedMps: 1 },
    });

    expect(result.events.map((event) => event.timeSeconds)).toEqual([
      startDistanceM,
      endDistanceM,
    ]);
    expect(result.events[0]!.timeSeconds).not.toBe(
      result.events[1]!.timeSeconds,
    );
  });

  it("rejects non-finite numeric content nested inside public timeline frames", () => {
    const source = simulateRide(line(10), {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: 1, speedMps: 0 },
    }).frames[0]!;
    const invalid = {
      ...source,
      cars: [
        {
          ...source.cars[0]!,
          position: vec3(Number.POSITIVE_INFINITY, 0, 0),
        },
      ],
    };

    expect(
      () =>
        new RideTimeline({
          sampleRateHz: 120,
          timeSeconds: new Float64Array([0]),
          headDistanceM: new Float64Array([1]),
          speedMps: new Float64Array([0]),
          frames: [invalid],
        }),
    ).toThrow(/frames\[0\]\.cars\[0\]\.position/);
  });

  it("returns a diagnostic instead of publishing an overflowing seat position", () => {
    const track = compileTrack(
      [
        {
          id: "large-position",
          span: {
            position: (u: number) => vec3(Number.MAX_VALUE, 0, u * 10),
            derivative: () => vec3(0, 0, 10),
          },
        },
      ],
      { samples: 65 },
    );
    const sample = sampleTrackAtDistance(track, 1);
    const offsetSign = Math.sign(-sample.binormal[0]);
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: config({
        train: {
          ...config().train,
          cars: [
            {
              massKg: 1000,
              seatCount: 1,
              seatPositionsM: [
                vec3(Number.MAX_VALUE * (offsetSign || 1), 0, 0),
              ],
            },
          ],
        },
      }),
      initial: { headDistanceM: 1, speedMps: 0 },
    });

    expect(result.frames).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SIM_NUMERICAL",
        field: "state.train.cars[0].seats[0].position",
      }),
    );
    expect(result.timeline.length).toBe(0);
  });

  it("rejects a subnormal fixed step that cannot provide a finite reciprocal", () => {
    const result = simulateRide(line(10), {
      durationSeconds: 0,
      config: config({
        fixedStepSeconds: Number.MIN_VALUE,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
      }),
      initial: { headDistanceM: 1, speedMps: 0 },
    });

    expect(result.frames).toHaveLength(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SIM_INVALID_CONFIGURATION",
        field: "fixedStepSeconds",
      }),
    );
  });

  it("processes a large deterministic event sequence without quadratic cleanup", () => {
    const zones: OperationZone[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `zone-${index}`,
      kind: "block",
      startDistanceM: index * 2 + 0.25,
      endDistanceM: index * 2 + 0.75,
    }));
    const result = simulateRide(line(2000), {
      durationSeconds: 2000,
      config: config({
        fixedStepSeconds: 2000,
        timelineStepSeconds: 2000,
        train: {
          ...config().train,
          cars: [{ massKg: 1000, seatCount: 0 }],
        },
        zones,
      }),
      initial: { headDistanceM: 0, speedMps: 1 },
    });

    expect(result.events).toHaveLength(zones.length * 2);
    expect(
      new Set(
        result.events.map(
          (event) =>
            `${event.timeSeconds}|${event.type}|${event.zoneId}|${event.boundary}|${event.direction}`,
        ),
      ).size,
    ).toBe(result.events.length);
  });
});
