import { describe, expect, it, vi } from "vitest";
import { RideTimeline } from "@openvibecoaster/simulator";
import type {
  CarState,
  CarTelemetry,
  SeatState,
  SimulationFrame,
} from "@openvibecoaster/simulator";
import type { TrackSample, Vec3 } from "@openvibecoaster/core";
import {
  createRidePlayback,
  type RideCameraId,
  type RideSelectionId,
} from "./controller.js";

const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];

const sample = (
  distance: number,
  x: number,
  angle = 0,
  carIndex = 0,
): TrackSample => ({
  position: vec(x, 2, carIndex),
  tangent: vec(Math.cos(angle), Math.sin(angle), 0),
  normal: vec(-Math.sin(angle), Math.cos(angle), 0),
  binormal: vec(0, 0, 1),
  distance,
  curvature: 0,
  curvatureVector: vec(0, 0, 0),
  bank: 0,
  bankDerivative: 0,
});

const telemetry = (timeIndex = 0): CarTelemetry => ({
  longitudinalG: timeIndex * 2,
  lateralG: timeIndex,
  verticalG: 1,
  specificForceMps2: vec(timeIndex, 0, 9.80665),
  jerkMps3: vec(0, timeIndex, 0),
  bankRad: timeIndex * 0.1,
  rollRateRadPerSec: timeIndex * 0.2,
});

const makeCar = (carIndex: number, timeIndex: number): CarState => {
  const distance = timeIndex * 10 - carIndex * 3;
  const angle = timeIndex * (Math.PI / 2);
  const frame = sample(distance, distance, angle, carIndex);
  const seats: SeatState[] = [0, 1].map((seatIndex) => ({
    index: seatIndex,
    distanceM: distance + seatIndex * 0.5,
    position: vec(distance, 2 + seatIndex + Math.sin(angle) * 0.25, carIndex),
    frame: sample(distance + seatIndex * 0.5, distance, angle, carIndex),
    telemetry: telemetry(timeIndex),
  }));
  return {
    index: carIndex,
    distanceM: distance,
    position: vec(distance, 2, carIndex),
    tangent: frame.tangent,
    normal: frame.normal,
    binormal: frame.binormal,
    frame,
    seatOffsets: [vec(0, 0, 0), vec(0, 1, 0)],
    seatPositions: seats.map((seat) => seat.position),
    telemetry: telemetry(timeIndex),
    seats,
  };
};

const makeFrame = (timeIndex: number, speedMps: number): SimulationFrame => {
  const cars = [0, 1, 2].map((carIndex) => makeCar(carIndex, timeIndex));
  return {
    timeSeconds: timeIndex,
    headDistanceM: timeIndex * 10,
    speedMps,
    status: speedMps < 0 ? "rollback" : "rolling",
    cars,
    selection: {
      front: cars[0]!,
      middle: cars[1]!,
      rear: cars[2]!,
    },
    telemetry: {
      perCar: cars.map((car) => car.telemetry),
      longitudinalG: timeIndex * 2,
      lateralG: timeIndex,
      verticalG: 1,
      specificForceMps2: vec(timeIndex, 0, 9.80665),
      bankRad: timeIndex * 0.1,
      rollRateRadPerSec: timeIndex * 0.2,
      jerkMps3: vec(0, timeIndex, 0),
      launchActivity: speedMps > 4,
      brakeActivity: speedMps === 0,
      kineticEnergyJ: timeIndex * 10,
      potentialEnergyJ: timeIndex * 20,
      accumulatedDriveWorkJ: timeIndex * 30,
      accumulatedLossWorkJ: timeIndex * 4,
      energyErrorJ: timeIndex * 0.5,
    },
  };
};

const makeTimeline = (): RideTimeline =>
  new RideTimeline({
    sampleRateHz: 1,
    timeSeconds: new Float64Array([0, 1, 2]),
    headDistanceM: new Float64Array([0, 10, 4]),
    speedMps: new Float64Array([3, -4, 2]),
    jerkMps3: new Float64Array([0, 0, 0, 0, 1, 0, 0, 2, 0]),
    carCount: 3,
    carPositionsXYZ: new Float64Array(3 * 3 * 3),
    carTangentsXYZ: new Float64Array(3 * 3 * 3),
    carNormalsXYZ: new Float64Array(3 * 3 * 3),
    carBinormalsXYZ: new Float64Array(3 * 3 * 3),
    frames: [makeFrame(0, 3), makeFrame(1, -4), makeFrame(2, 2)],
  });

describe("RidePlaybackController", () => {
  it("accepts the simulator's populated flattened jerk output", () => {
    const timeline = makeTimeline();

    expect(Array.from(timeline.jerkMps3)).toEqual([0, 0, 0, 0, 1, 0, 0, 2, 0]);

    const controller = createRidePlayback(timeline);
    expect(controller.getSnapshot().telemetry?.jerkMps3).toEqual([0, 0, 0]);

    controller.scrubIndex(2);
    expect(controller.getSnapshot().telemetry?.jerkMps3).toEqual([0, 2, 0]);
  });

  it("derives real front/middle/rear seat selections and renderer camera IDs", () => {
    const controller = createRidePlayback(makeTimeline());

    const cameraIds: readonly RideCameraId[] = [
      "front",
      "middle",
      "rear",
      "chase",
      "orbit",
    ];
    const selectionIds: readonly RideSelectionId[] = [
      "front",
      "middle",
      "rear",
    ];

    expect(controller.getSnapshot().camera).toBe("front");
    expect(controller.getSnapshot().selections.front.carIndex).toBe(0);
    expect(controller.getSnapshot().selections.middle.carIndex).toBe(1);
    expect(controller.getSnapshot().selections.rear.carIndex).toBe(2);
    expect(controller.getSnapshot().selections.rear.seat?.index).toBe(0);

    controller.selectSeat("rear", 1);
    controller.setCamera("orbit");
    expect(controller.getSnapshot().selectedSeat).toBe("rear");
    expect(controller.getSnapshot().selections.rear.seat?.index).toBe(1);
    expect(cameraIds).toContain(controller.getSnapshot().camera);
    expect(selectionIds).toContain(controller.getSnapshot().selectedSeat);
  });

  it("plays, pauses, ticks deterministically, preserves rollback, and stops at the end", () => {
    const controller = createRidePlayback(makeTimeline());
    controller.play();
    controller.tick(0.5);

    expect(controller.getSnapshot()).toMatchObject({
      isPlaying: true,
      timeSeconds: 0.5,
      headDistanceM: 5,
      speedMps: -0.5,
      sampleIndex: 0,
    });

    controller.pause();
    controller.tick(0.5);
    expect(controller.getSnapshot().timeSeconds).toBe(0.5);

    controller.play();
    controller.tick(2);
    expect(controller.getSnapshot()).toMatchObject({
      isPlaying: false,
      ended: true,
      timeSeconds: 2,
      headDistanceM: 4,
      speedMps: 2,
      sampleIndex: 2,
    });
  });

  it("interpolates authoritative cars, seats, telemetry, and orthonormal frames at fractional time", () => {
    const controller = createRidePlayback(makeTimeline());

    controller.scrubTime(0.5);

    const snapshot = controller.getSnapshot();
    const front = snapshot.selections.front;
    const seat = front.seat!;
    const rootTwo = Math.SQRT1_2;

    expect(front.position).toEqual([5, 2.125, 0]);
    expect(seat.position).toEqual([5, 2.125, 0]);
    expect(front.car?.seats[1]?.position).toEqual([5, 3.125, 0]);
    expect(front.tangent?.[0]).toBeCloseTo(rootTwo);
    expect(front.tangent?.[1]).toBeCloseTo(rootTwo);
    expect(front.normal?.[0]).toBeCloseTo(-rootTwo);
    expect(front.normal?.[1]).toBeCloseTo(rootTwo);
    expect(front.binormal?.[0]).toBeCloseTo(0);
    expect(front.binormal?.[1]).toBeCloseTo(0);
    expect(front.binormal?.[2]).toBeCloseTo(1);
    expect(seat.frame.tangent[0]).toBeCloseTo(rootTwo);
    expect(seat.frame.tangent[1]).toBeCloseTo(rootTwo);
    expect(seat.frame.normal[0]).toBeCloseTo(-rootTwo);
    expect(seat.frame.normal[1]).toBeCloseTo(rootTwo);
    expect(seat.frame.binormal[0]).toBeCloseTo(0);
    expect(seat.frame.binormal[1]).toBeCloseTo(0);
    expect(seat.frame.binormal[2]).toBeCloseTo(1);
    expect(snapshot.telemetry?.longitudinalG).toBe(1);
    expect(snapshot.telemetry?.kineticEnergyJ).toBe(5);
    expect(front.car?.telemetry.longitudinalG).toBe(1);
    expect(seat.telemetry.bankRad).toBeCloseTo(0.05);

    expect(
      front.tangent![0]! * front.normal![0]! +
        front.tangent![1]! * front.normal![1]!,
    ).toBeCloseTo(0);
    expect(
      front.tangent![0]! * front.normal![1]! -
        front.tangent![1]! * front.normal![0]!,
    ).toBeCloseTo(front.binormal![2]!);
  });

  it("supports rates, time/index scrubbing, reset, reduced motion, and typed callbacks", () => {
    const controller = createRidePlayback(makeTimeline(), {
      reducedMotion: true,
    });
    const snapshots: number[] = [];
    const selections: RideSelectionId[] = [];
    const unsubscribe = controller.subscribe((snapshot) =>
      snapshots.push(snapshot.timeSeconds),
    );
    const unsubscribeSelection = controller.onSelectionChange((selection) =>
      selections.push(selection),
    );

    controller.setRate(2);
    controller.play();
    controller.tick(0.5);
    controller.scrubIndex(1);
    controller.selectSeat("middle");
    controller.scrubTime(1.5);

    expect(controller.getSnapshot()).toMatchObject({
      timeSeconds: 1.5,
      headDistanceM: 7,
      speedMps: -1,
      rate: 2,
      reducedMotion: true,
      ended: false,
    });
    expect(snapshots.length).toBeGreaterThan(0);
    expect(selections).toContain("middle");

    unsubscribe();
    unsubscribeSelection();
    controller.reset();
    expect(controller.getSnapshot()).toMatchObject({
      timeSeconds: 0,
      sampleIndex: 0,
      ended: false,
      isPlaying: false,
    });
    expect(() => controller.setRate(1.5)).toThrow(RangeError);
    expect(() => controller.tick(Number.NaN)).toThrow(RangeError);
  });

  it("rejects inconsistent timelines and makes disposal complete and idempotent", () => {
    expect(() =>
      createRidePlayback(
        new RideTimeline({
          sampleRateHz: 1,
          timeSeconds: new Float64Array([0, 0]),
          headDistanceM: new Float64Array([0, 1]),
          speedMps: new Float64Array([0, 1]),
        }),
      ),
    ).toThrow(RangeError);

    const controller = createRidePlayback(makeTimeline());
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();
    controller.dispose();
    controller.play();
    controller.tick(1);
    expect(controller.getSnapshot().disposed).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects non-monotonic frame timestamps and inconsistent authoritative dimensions", () => {
    expect(() =>
      createRidePlayback(
        new RideTimeline({
          sampleRateHz: 1,
          timeSeconds: new Float64Array([0, 1]),
          headDistanceM: new Float64Array([0, 1]),
          speedMps: new Float64Array([0, 1]),
          carCount: 1,
          carPositionsXYZ: new Float64Array(3),
          carTangentsXYZ: new Float64Array(6),
          carNormalsXYZ: new Float64Array(6),
          carBinormalsXYZ: new Float64Array(6),
        }),
      ),
    ).toThrow(/carPositionsXYZ/);

    const frames = [makeFrame(0, 0), makeFrame(1, 1)];
    frames[1] = { ...frames[1]!, timeSeconds: 0.5 };
    expect(() =>
      createRidePlayback(
        new RideTimeline({
          sampleRateHz: 1,
          timeSeconds: new Float64Array([0, 1]),
          headDistanceM: new Float64Array([0, 1]),
          speedMps: new Float64Array([0, 1]),
          carCount: 3,
          carPositionsXYZ: new Float64Array(18),
          carTangentsXYZ: new Float64Array(18),
          carNormalsXYZ: new Float64Array(18),
          carBinormalsXYZ: new Float64Array(18),
          frames,
        }),
      ),
    ).toThrow(/frame timestamps/);

    expect(() =>
      createRidePlayback(
        new RideTimeline({
          sampleRateHz: 1,
          timeSeconds: new Float64Array([0]),
          headDistanceM: new Float64Array([0]),
          speedMps: new Float64Array([0]),
          carCount: 1,
          carPositionsXYZ: new Float64Array([0, 0, 0]),
          carTangentsXYZ: new Float64Array([1, 0, 0]),
          carNormalsXYZ: new Float64Array([1, 0, 0]),
          carBinormalsXYZ: new Float64Array([0, 0, 1]),
        }),
      ),
    ).toThrow(/orthonormal/);

    for (const invalidLength of [1, 2, 3, 8, 10]) {
      expect(() =>
        createRidePlayback(
          new RideTimeline({
            sampleRateHz: 1,
            timeSeconds: new Float64Array([0, 1, 2]),
            headDistanceM: new Float64Array([0, 1, 2]),
            speedMps: new Float64Array([0, 1, 2]),
            jerkMps3: new Float64Array(invalidLength),
          }),
        ),
      ).toThrow(/jerkMps3/);
    }
  });
});
