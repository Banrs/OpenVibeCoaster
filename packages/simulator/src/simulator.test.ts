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
    expect(Object.is(forces[0]?.rolling, -0)).toBe(true);
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
});
