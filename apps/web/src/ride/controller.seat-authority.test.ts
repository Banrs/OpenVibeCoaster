import { describe, it, expect } from "vitest";
import { createRidePlayback } from "./controller.js";
import { RideTimeline } from "@openvibecoaster/simulator";
import type { Vec3 } from "@openvibecoaster/core";

function makeCompactTimeline(carCount: number, withTelemetry: boolean) {
  const length = 3;
  const times = new Float64Array([0, 1, 2]);
  const headDistanceM = new Float64Array([0, 10, 5]); // includes rollback: 10->5
  const speedMps = new Float64Array([5, -2, 3]); // stall/rollback negative
  const positions = new Float64Array(length * carCount * 3);
  const tangents = new Float64Array(length * carCount * 3);
  const normals = new Float64Array(length * carCount * 3);
  const binormals = new Float64Array(length * carCount * 3);
  for (let t = 0; t < length; t++) {
    for (let c = 0; c < carCount; c++) {
      const off = (t * carCount + c) * 3;
      positions[off] = t * 10 + c * 5;
      positions[off + 1] = c * 2 + (t % 2 === 0 ? 0 : 0.5);
      positions[off + 2] = 0;
      tangents[off] = 1;
      tangents[off + 1] = 0;
      tangents[off + 2] = 0;
      normals[off] = 0;
      normals[off + 1] = 1;
      normals[off + 2] = 0;
      binormals[off] = 0;
      binormals[off + 1] = 0;
      binormals[off + 2] = 1;
    }
  }
  const perCarLen = length * carCount;
  const perCarVecLen = perCarLen * 3;
  const mkScalar = (base: number): Float64Array => {
    const arr = new Float64Array(perCarLen);
    for (let i = 0; i < perCarLen; i++) {
      const carIdx = i % carCount;
      arr[i] = base + carIdx * 1.5 + Math.floor(i / carCount) * 0.1;
    }
    return arr;
  };
  const mkVec = (): Float64Array => {
    const arr = new Float64Array(perCarVecLen);
    for (let i = 0; i < perCarLen; i++) {
      const carIdx = i % carCount;
      const off = i * 3;
      arr[off] = carIdx * 0.3;
      arr[off + 1] = carIdx * 0.2;
      arr[off + 2] = 9.8 + carIdx * 0.5;
    }
    return arr;
  };
  return new RideTimeline({
    sampleRateHz: 1,
    timeSeconds: times,
    headDistanceM,
    speedMps,
    jerkMps3: new Float64Array(length * 3),
    carCount,
    carPositionsXYZ: positions,
    carTangentsXYZ: tangents,
    carNormalsXYZ: normals,
    carBinormalsXYZ: binormals,
    longitudinalG: withTelemetry
      ? new Float64Array([0, 0, 0])
      : new Float64Array(0),
    lateralG: withTelemetry ? new Float64Array([0, 0, 0]) : new Float64Array(0),
    verticalG: withTelemetry
      ? new Float64Array([0, 0, 0])
      : new Float64Array(0),
    launchActivity: new Float64Array(0),
    brakeActivity: new Float64Array(0),
    kineticEnergyJ: new Float64Array(0),
    potentialEnergyJ: new Float64Array(0),
    accumulatedDriveWorkJ: new Float64Array(0),
    accumulatedLossWorkJ: new Float64Array(0),
    energyErrorJ: new Float64Array(0),
    bankRad: new Float64Array(0),
    rollRateRadPerSec: new Float64Array(0),
    specificForceXYZ: new Float64Array(0),
    perCarLongitudinalG: withTelemetry ? mkScalar(0) : new Float64Array(0),
    perCarLateralG: withTelemetry ? mkScalar(0.5) : new Float64Array(0),
    perCarVerticalG: withTelemetry ? mkScalar(1) : new Float64Array(0),
    perCarBankRad: withTelemetry ? mkScalar(0.1) : new Float64Array(0),
    perCarRollRateRadPerSec: withTelemetry
      ? mkScalar(0.05)
      : new Float64Array(0),
    perCarSpecificForceXYZ: withTelemetry ? mkVec() : new Float64Array(0),
    perCarJerkXYZ: withTelemetry ? mkVec() : new Float64Array(0),
    frames: [],
  });
}

describe("compact seat authority", () => {
  it("carCount 2 exact buffer indices and middle floor((n-1)/2)=0", () => {
    const tl = makeCompactTimeline(2, true);
    const ctrl = createRidePlayback(tl);
    const snap = ctrl.getSnapshot();
    expect(snap.carCount).toBe(2);
    expect(snap.cars.length).toBe(2);
    expect(snap.cars[0]!.index).toBe(0);
    expect(snap.cars[1]!.index).toBe(1);
    // middle for n=2 is 0
    expect(snap.selections.middle.carIndex).toBe(0);
    expect(snap.selections.front.carIndex).toBe(0);
    expect(snap.selections.rear.carIndex).toBe(1);
    // exact buffer indices: positions[0]=0, positions for car1 at offset 3 =5
    expect(snap.cars[0]!.position[0]).toBeCloseTo(0);
    expect(snap.cars[1]!.position[0]).toBeCloseTo(5);
    // telemetry divergence: perCarVerticalG for car0 base 1, car1 base 2.5
    expect(snap.cars[0]!.telemetry!.verticalG).toBeCloseTo(1);
    expect(snap.cars[1]!.telemetry!.verticalG).toBeCloseTo(2.5);
    expect(snap.selections.front.car!.telemetry!.verticalG).not.toBe(
      snap.selections.rear.car!.telemetry!.verticalG!,
    );
  });

  it("carCount 6 exact buffer indices and middle floor((n-1)/2)=2", () => {
    const tl = makeCompactTimeline(6, true);
    const ctrl = createRidePlayback(tl);
    const snap = ctrl.getSnapshot();
    expect(snap.carCount).toBe(6);
    expect(snap.cars.length).toBe(6);
    expect(snap.selections.middle.carIndex).toBe(2);
    expect(snap.selections.rear.carIndex).toBe(5);
    // position for middle car index2 at time0: 0*10+2*5=10
    expect(snap.cars[2]!.position[0]).toBeCloseTo(10);
    expect(snap.cars[5]!.position[0]).toBeCloseTo(25);
    // middle orthonormal frames
    for (const car of snap.cars) {
      const dotTN =
        car.tangent[0] * car.normal[0] +
        car.tangent[1] * car.normal[1] +
        car.tangent[2] * car.normal[2];
      const dotTB =
        car.tangent[0] * car.binormal[0] +
        car.tangent[1] * car.binormal[1] +
        car.tangent[2] * car.binormal[2];
      const dotNB =
        car.normal[0] * car.binormal[0] +
        car.normal[1] * car.binormal[1] +
        car.normal[2] * car.binormal[2];
      expect(Math.abs(dotTN)).toBeLessThan(1e-7);
      expect(Math.abs(dotTB)).toBeLessThan(1e-7);
      expect(Math.abs(dotNB)).toBeLessThan(1e-7);
      const tLen = Math.hypot(...car.tangent);
      const nLen = Math.hypot(...car.normal);
      const bLen = Math.hypot(...car.binormal);
      expect(tLen).toBeCloseTo(1, 6);
      expect(nLen).toBeCloseTo(1, 6);
      expect(bLen).toBeCloseTo(1, 6);
    }
  });

  it("rollback/stall interpolation uses exact perCar buffer indices with fraction", () => {
    const tl = makeCompactTimeline(3, true);
    const ctrl = createRidePlayback(tl);
    // at time 0.5, fraction 0.5 between sample0 and sample1
    ctrl.scrubTime(0.5);
    const snap = ctrl.getSnapshot();
    // headDistance interpolates 0->10 at 0.5 =>5
    expect(snap.headDistanceM).toBeCloseTo(5);
    // speed interpolates 5 -> -2 =>1.5
    expect(snap.speedMps).toBeCloseTo(1.5);
    // car0 position interpolates 0->10 =>5
    expect(snap.cars[0]!.position[0]).toBeCloseTo(5);
    // car1 position 5 ->15 =>10
    expect(snap.cars[1]!.position[0]).toBeCloseTo(10);
    // telemetry: verticalG car0 at t0 =1, t1=1.1 => at 0.5 =>1.05
    expect(snap.cars[0]!.telemetry!.verticalG).toBeCloseTo(1.05);
    // car2 verticalG: at n=3, base for car2=1+3=4? Wait base 1+ car*1.5 =>1+3=4 at t0, at t1 4.1 =>4.05
    expect(snap.cars[2]!.telemetry!.verticalG).toBeCloseTo(4.05);
    // front/rear divergence still holds under rollback interpolation
    expect(snap.selections.front.car!.telemetry!.verticalG).not.toBeCloseTo(
      snap.selections.rear.car!.telemetry!.verticalG!,
      1,
    );
  });

  it("legacy missing perCar telemetry marks unavailable (undefined) not 0/1g fiction", () => {
    const tl = makeCompactTimeline(2, false);
    const ctrl = createRidePlayback(tl);
    const snap = ctrl.getSnapshot();
    expect(snap.carCount).toBe(2);
    expect(snap.cars[0]!.telemetry).toBeUndefined();
    expect(snap.cars[1]!.telemetry).toBeUndefined();
    expect(snap.selections.front.car?.telemetry).toBeUndefined();
    // snapshot telemetry should be undefined for incomplete compact
    expect(snap.telemetry).toBeUndefined();
  });

  it("orthonormal frames across all compact cars", () => {
    const tl = makeCompactTimeline(6, true);
    const ctrl = createRidePlayback(tl);
    ctrl.scrubTime(1);
    const snap = ctrl.getSnapshot();
    for (const car of snap.cars) {
      const cross = [
        car.tangent[1]! * car.normal[2]! - car.tangent[2]! * car.normal[1]!,
        car.tangent[2]! * car.normal[0]! - car.tangent[0]! * car.normal[2]!,
        car.tangent[0]! * car.normal[1]! - car.tangent[1]! * car.normal[0]!,
      ] as Vec3;
      const dotCrossB =
        cross[0] * car.binormal[0] +
        cross[1] * car.binormal[1] +
        cross[2] * car.binormal[2];
      expect(dotCrossB).toBeCloseTo(1, 6);
    }
  });
});
