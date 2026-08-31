import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "../engineering/worker.js";
import { hydrateEngineeringSuccess } from "../engineering/hydrate.js";
import { createRidePlayback } from "./controller.js";
import { RideTimeline } from "@openvibecoaster/simulator";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 80, targetSpeed: 15, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 80, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("ride controller compact fallback RED", () => {
  it(
    "compact fallback gives finite/distinct front/middle/rear transforms and truthful telemetry",
    { timeout: 20000 },
    () => {
      const success = handleGenerate("compact-ride-1", validIntent as unknown);
      expect(success.type).toBe("success");
      if (success.type !== "success") throw new Error("gen fail");
      const { timeline } = hydrateEngineeringSuccess(success);
      expect(timeline.frames.length).toBe(0);
      const controller = createRidePlayback(timeline);
      const s0 = controller.getSnapshot();
      expect(s0.telemetry).toBeDefined();
      expect(Number.isFinite(s0.telemetry!.kineticEnergyJ)).toBe(true);
      expect(Number.isFinite(s0.telemetry!.energyErrorJ)).toBe(true);
      expect(s0.selections.front.position).toBeDefined();
      expect(s0.selections.middle.position).toBeDefined();
      expect(s0.selections.rear.position).toBeDefined();
      // distinct transforms
      const frontPos = s0.selections.front.position!;
      const rearPos = s0.selections.rear.position!;
      expect(
        frontPos[0] !== rearPos[0] ||
          frontPos[1] !== rearPos[1] ||
          frontPos[2] !== rearPos[2],
      ).toBe(true);
      // finite orthonormal check
      for (const sel of [
        s0.selections.front,
        s0.selections.middle,
        s0.selections.rear,
      ]) {
        expect(sel.tangent).toBeDefined();
        expect(sel.normal).toBeDefined();
        expect(sel.binormal).toBeDefined();
        expect(sel.tangent!.every(Number.isFinite)).toBe(true);
      }
      // scrub and play changes preserve distinct
      controller.scrubTime(
        timeline.timeSeconds[Math.floor(timeline.length / 2)]!,
      );
      const mid = controller.getSnapshot();
      expect(mid.telemetry!.kineticEnergyJ).not.toBe(
        s0.telemetry!.kineticEnergyJ,
      );
      expect(mid.headDistanceM).not.toBe(s0.headDistanceM);
      controller.setCamera("orbit");
      expect(controller.getSnapshot().camera).toBe("orbit");
      controller.play();
      controller.tick(0.1);
      const ticked = controller.getSnapshot();
      expect(Number.isFinite(ticked.timeSeconds)).toBe(true);
    },
  );

  it("compact zero-frame timeline without telemetry still yields finite front position via SoA and undefined telemetry", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2]),
      headDistanceM: new Float64Array([0, 10, 20]),
      speedMps: new Float64Array([5, 5, 5]),
      carCount: 1,
      carPositionsXYZ: new Float64Array([0, 0, 0, 10, 0, 0, 20, 0, 0]),
      carTangentsXYZ: new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
      carNormalsXYZ: new Float64Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      carBinormalsXYZ: new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      frames: [] as unknown as never,
    });
    const c = createRidePlayback(timeline);
    expect(c.getSnapshot().selections.front.position).toBeDefined();
    expect(
      c.getSnapshot().selections.front.position!.every(Number.isFinite),
    ).toBe(true);
    expect(c.getSnapshot().telemetry).toBeUndefined();
  });

  it("valid complete compact timeline with carCount=0 yields empty perCar and truthful global telemetry", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120]),
      headDistanceM: new Float64Array([0, 10]),
      speedMps: new Float64Array([5, 5]),
      carCount: 0,
      carPositionsXYZ: new Float64Array(0),
      carTangentsXYZ: new Float64Array(0),
      carNormalsXYZ: new Float64Array(0),
      carBinormalsXYZ: new Float64Array(0),
      longitudinalG: new Float64Array([0.11, 0.22]),
      lateralG: new Float64Array([0.05, 0.06]),
      verticalG: new Float64Array([1, 1.1]),
      jerkMps3: new Float64Array([0, 0, 0, 1, 1, 1]),
      launchActivity: new Float64Array([1, 0]),
      brakeActivity: new Float64Array([0, 1]),
      kineticEnergyJ: new Float64Array([100, 200]),
      potentialEnergyJ: new Float64Array([300, 400]),
      accumulatedDriveWorkJ: new Float64Array([10, 20]),
      accumulatedLossWorkJ: new Float64Array([5, 6]),
      energyErrorJ: new Float64Array([1, 2]),
      bankRad: new Float64Array([0.1, 0.2]),
      rollRateRadPerSec: new Float64Array([0.01, 0.02]),
      specificForceXYZ: new Float64Array([0, 0, 1, 0, 0, 1]),
      perCarLongitudinalG: new Float64Array(0),
      perCarLateralG: new Float64Array(0),
      perCarVerticalG: new Float64Array(0),
      perCarBankRad: new Float64Array(0),
      perCarRollRateRadPerSec: new Float64Array(0),
      perCarSpecificForceXYZ: new Float64Array(0),
      perCarJerkXYZ: new Float64Array(0),
      frames: [],
    });
    const controller = createRidePlayback(timeline);
    const snap = controller.getSnapshot();
    expect(snap.telemetry).toBeDefined();
    expect(snap.telemetry!.perCar.length).toBe(0);
    expect(snap.telemetry!.longitudinalG).toBeCloseTo(0.11);
    expect(snap.telemetry!.lateralG).toBeCloseTo(0.05);
    expect(snap.telemetry!.verticalG).toBeCloseTo(1);
    expect(snap.telemetry!.bankRad).toBeCloseTo(0.1);
    expect(snap.telemetry!.rollRateRadPerSec).toBeCloseTo(0.01);
    expect(snap.telemetry!.kineticEnergyJ).toBeCloseTo(100);
    expect(snap.telemetry!.specificForceMps2[2]).toBeCloseTo(1);
    // scrub to second sample ensures interpolation from global series, not perCar[0]
    controller.scrubTime(1 / 120);
    const snap2 = controller.getSnapshot();
    expect(snap2.telemetry!.longitudinalG).toBeCloseTo(0.22);
    expect(snap2.telemetry!.perCar.length).toBe(0);
  });
});
