import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { RideTimeline } from "@openvibecoaster/simulator";
import { createRendererController } from "./controller.js";
import { getCarIndexForCamera, getCameraState } from "./cameras.js";
import type { RendererHandle } from "./renderer.js";
import type { RidePlaybackSnapshot } from "../ride/controller.js";

function makeTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) =>
            vec3(u * 40, 5 + Math.sin(u * Math.PI) * 2, 0),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(40, Math.cos(u * Math.PI) * Math.PI * 2, 0)
              : vec3(0, 0, 0),
        },
      },
    ],
    { samples: 12 },
  );
}

function makeHandle(): RendererHandle {
  const scene = new THREE.Scene();
  const mockRenderer = {
    render: () => {},
    dispose: () => {},
    capabilities: {},
  } as unknown as THREE.WebGLRenderer;
  return {
    scene,
    renderer: mockRenderer,
    dispose: () => {},
    resize: () => {},
  } as unknown as RendererHandle;
}

function makeCompleteSnapshot(): RidePlaybackSnapshot {
  const posFront = vec3(0, 5, 0);
  const tanFront = vec3(1, 0, 0);
  const normFront = vec3(0, 1, 0);
  const binFront = vec3(0, 0, 1);
  const posMid = vec3(10, 5, 0);
  const tanMid = vec3(1, 0, 0);
  const normMid = vec3(0, 1, 0);
  const binMid = vec3(0, 0, 1);
  const posRear = vec3(20, 5, 0);
  const tanRear = vec3(1, 0, 0);
  const normRear = vec3(0, 1, 0);
  const binRear = vec3(0, 0, 1);
  const carPos = (v: ReturnType<typeof vec3>): ReturnType<typeof vec3> => v;
  const timeline = new RideTimeline({
    sampleRateHz: 120,
    timeSeconds: new Float64Array([0, 1]),
    headDistanceM: new Float64Array([0, 5]),
    speedMps: new Float64Array([5, 5]),
    carCount: 3,
    carPositionsXYZ: new Float64Array(2 * 3 * 3),
    carTangentsXYZ: new Float64Array(2 * 3 * 3),
    carNormalsXYZ: new Float64Array(2 * 3 * 3),
    carBinormalsXYZ: new Float64Array(2 * 3 * 3),
    perCarVerticalG: new Float64Array(2 * 3),
    perCarRollRateRadPerSec: new Float64Array(2 * 3),
    perCarLongitudinalG: new Float64Array(2 * 3),
    perCarLateralG: new Float64Array(2 * 3),
    perCarBankRad: new Float64Array(2 * 3),
    perCarSpecificForceXYZ: new Float64Array(2 * 3 * 3),
    perCarJerkXYZ: new Float64Array(2 * 3 * 3),
    frames: [],
  });
  // Build minimal cars and selections with complete telemetry
  const makeCar = (idx: number, pos: ReturnType<typeof vec3>) => ({
    index: idx,
    position: pos,
    tangent: vec3(1, 0, 0),
    normal: vec3(0, 1, 0),
    binormal: vec3(0, 0, 1),
    telemetry: {
      longitudinalG: 0.1,
      lateralG: 0.2,
      verticalG: 1.0 + idx * 0.5,
      specificForceMps2: vec3(0, 9.81, 0),
      jerkMps3: vec3(0, 0, 0),
      bankRad: 0.1,
      rollRateRadPerSec: 0.05 * idx,
    },
  });
  const cars = [
    makeCar(0, posFront),
    makeCar(1, posMid),
    makeCar(2, posRear),
  ] as const;
  const snapshot: RidePlaybackSnapshot = {
    timeSeconds: 0.5,
    sampleIndex: 0,
    headDistanceM: 5,
    speedMps: 5,
    telemetry: {
      perCar: [
        {
          longitudinalG: 0.1,
          lateralG: 0.2,
          verticalG: 1.0,
          specificForceMps2: vec3(0, 9.81, 0),
          jerkMps3: vec3(0, 0, 0),
          bankRad: 0.1,
          rollRateRadPerSec: 0,
        },
        {
          longitudinalG: 0.1,
          lateralG: 0.2,
          verticalG: 1.25,
          specificForceMps2: vec3(0, 9.81, 0),
          jerkMps3: vec3(0, 0, 0),
          bankRad: 0.1,
          rollRateRadPerSec: 0.05,
        },
        {
          longitudinalG: 0.1,
          lateralG: 0.2,
          verticalG: 1.5,
          specificForceMps2: vec3(0, 9.81, 0),
          jerkMps3: vec3(0, 0, 0),
          bankRad: 0.1,
          rollRateRadPerSec: 0.1,
        },
      ],
      longitudinalG: 0.1,
      lateralG: 0.2,
      verticalG: 1.0,
      specificForceMps2: vec3(0, 9.81, 0),
      bankRad: 0.1,
      rollRateRadPerSec: 0,
      jerkMps3: vec3(0, 0, 0),
      launchActivity: false,
      brakeActivity: false,
      kineticEnergyJ: 1000,
      potentialEnergyJ: 2000,
      accumulatedDriveWorkJ: 0,
      accumulatedLossWorkJ: 0,
      energyErrorJ: 0,
    },
    isPlaying: true,
    ended: false,
    rate: 1,
    camera: "front",
    selectedSeat: "front",
    reducedMotion: false,
    disposed: false,
    selections: {
      front: {
        id: "front",
        carIndex: 0,
        car: cars[0],
        seatIndex: 0,
        seat: undefined,
        position: posFront,
        tangent: tanFront,
        normal: normFront,
        binormal: binFront,
      },
      middle: {
        id: "middle",
        carIndex: 1,
        car: cars[1],
        seatIndex: 1,
        seat: undefined,
        position: posMid,
        tangent: tanMid,
        normal: normMid,
        binormal: binMid,
      },
      rear: {
        id: "rear",
        carIndex: 2,
        car: cars[2],
        seatIndex: 2,
        seat: undefined,
        position: posRear,
        tangent: tanRear,
        normal: normRear,
        binormal: binRear,
      },
    },
    cars: [...cars],
    carCount: 3,
  };
  return snapshot;
}

describe("render evidence seat", () => {
  it("railColorHash distinct for available metrics and null when unavailable", () => {
    const track = makeTrack();
    const camera = new THREE.PerspectiveCamera();
    const handle = makeHandle();
    const ctrl = createRendererController(handle, camera);
    const mkData = (val: number): Float64Array => {
      const arr = new Float64Array(track.distances.length);
      for (let i = 0; i < arr.length; i++) arr[i] = val + i * 0.1;
      return arr;
    };
    ctrl.attachTrack(track, {
      metric: "speed",
      metricData: { speed: mkData(0) },
    });
    const h1 = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(h1).not.toBeNull();
    ctrl.attachTrack(track, {
      metric: "gForce",
      metricData: { gForce: mkData(5) },
    });
    const h2 = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(h2).not.toBeNull();
    expect(h2).not.toBe(h1);
    ctrl.attachTrack(track, {
      metric: "rollRate",
      metricData: { rollRate: mkData(10) },
    });
    const h3 = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(h3).not.toBeNull();
    expect(h3).not.toBe(h1);
    expect(h3).not.toBe(h2);
    ctrl.attachTrack(track, {
      metric: "clearance",
      metricData: { clearance: mkData(20) },
    });
    const h4 = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(h4).not.toBeNull();
    expect(h4).not.toBe(h1);
    // unavailable metric must be null even though neutral color attribute exists
    ctrl.attachTrack(track, { metric: "speed" });
    const hUnavail = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(hUnavail).toBeNull();
    // unavailable gForce also null
    ctrl.attachTrack(track, { metric: "gForce" });
    const hGUnavail = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(hGUnavail).toBeNull();
  });

  it("seam signature derived only from actual geometry buffers, not requested state", () => {
    const track = makeTrack();
    const camera = new THREE.PerspectiveCamera();
    const handle = makeHandle();
    const ctrl = createRendererController(handle, camera);
    const trackLen = track.positions.length / 3 - 1;
    ctrl.attachTrack(track, {
      metric: "height",
      seamInspectionEnabled: false,
      seamIndices: [0],
    });
    const sOff = ctrl.getDiagnosticSnapshot()!.seamSignature;
    ctrl.attachTrack(track, {
      metric: "height",
      seamInspectionEnabled: true,
      seamIndices: [0, trackLen],
    });
    const sOn = ctrl.getDiagnosticSnapshot()!.seamSignature;
    expect(sOff).not.toBeNull();
    expect(sOn).not.toBeNull();
    // Seam inspection visually changes the actual rendered rail color BufferAttribute; signature must observe color.
    expect(sOff).not.toBe(sOn);
  });

  it("highlight/train world XYZ mutate via actual car objects", () => {
    const track = makeTrack();
    const camera = new THREE.PerspectiveCamera();
    const handle = makeHandle();
    const ctrl = createRendererController(handle, camera);
    ctrl.attachTrack(track, { metric: "height" });
    const before = ctrl.getDiagnosticSnapshot()!.trainWorldPositions;
    expect(before).not.toBeNull();
    const beforePos = [...before!];
    ctrl.updatePlayback(5, 5, null);
    const after = ctrl.getDiagnosticSnapshot()!.trainWorldPositions;
    expect(after).not.toBeNull();
    let mutated = false;
    for (let i = 0; i < Math.min(beforePos.length, after!.length); i++) {
      const a = beforePos[i] as [number, number, number];
      const b = after![i] as [number, number, number];
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
        mutated = true;
        break;
      }
    }
    expect(mutated).toBe(true);
    // Highlight world position is null when no marker or hidden
    expect(ctrl.getDiagnosticSnapshot()!.highlightWorldPosition).toBeNull();
    expect(ctrl.getDiagnosticSnapshot()!.highlightDistance).toBeNull();
    ctrl.setHighlight(10);
    const withHighlight = ctrl.getDiagnosticSnapshot()!;
    expect(withHighlight.highlightDistance).toBe(10);
    expect(withHighlight.highlightWorldPosition).not.toBeNull();
    const firstPos = withHighlight.highlightWorldPosition!;
    expect(firstPos[0]).toBeTypeOf("number");
    expect(firstPos[1]).toBeTypeOf("number");
    expect(firstPos[2]).toBeTypeOf("number");
    // Changing to a different distance must change actual XYZ
    ctrl.setHighlight(20);
    const second = ctrl.getDiagnosticSnapshot()!.highlightWorldPosition;
    expect(second).not.toBeNull();
    expect(
      second![0] !== firstPos[0] ||
        second![1] !== firstPos[1] ||
        second![2] !== firstPos[2],
    ).toBe(true);
    // Clearing/hiding makes it null
    ctrl.setHighlight(null);
    expect(ctrl.getDiagnosticSnapshot()!.highlightWorldPosition).toBeNull();
    expect(ctrl.getDiagnosticSnapshot()!.highlightDistance).toBeNull();
    ctrl.setHighlight(5);
    expect(ctrl.getDiagnosticSnapshot()!.highlightWorldPosition).not.toBeNull();
    ctrl.setHighlight(NaN);
    expect(ctrl.getDiagnosticSnapshot()!.highlightWorldPosition).toBeNull();
    expect(ctrl.getDiagnosticSnapshot()!.seamSignature).not.toBeNull();
  });

  it("camera carCount 2/6 and rollback positions use complete snapshot", () => {
    void makeTrack();
    expect(getCarIndexForCamera("front", 2)).toBe(0);
    expect(getCarIndexForCamera("middle", 2)).toBe(0);
    expect(getCarIndexForCamera("rear", 2)).toBe(1);
    expect(getCarIndexForCamera("front", 6)).toBe(0);
    expect(getCarIndexForCamera("middle", 6)).toBe(2);
    expect(getCarIndexForCamera("rear", 6)).toBe(5);
    const data = makeTrack();
    const snap = makeCompleteSnapshot();
    const sFront = getCameraState("front", data, 10, 5, { snapshot: snap });
    const sFrontRollback = getCameraState("front", data, 5, -3, {
      snapshot: snap,
    });
    expect(sFront.position[0]).toBe(sFrontRollback.position[0]);
    expect(sFront.fov).not.toBe(sFrontRollback.fov);
    const handle2 = makeHandle();
    const camera2 = new THREE.PerspectiveCamera();
    const ctrl2 = createRendererController(handle2, camera2);
    ctrl2.attachTrack(data, { metric: "height" });
    ctrl2.applyCamera("front", { snapshot: snap });
    expect(ctrl2.getDiagnosticSnapshot()!.cameraUsedFallback).toBe(false);
    ctrl2.applyCamera("front", { snapshot: null });
    expect(ctrl2.getDiagnosticSnapshot()!.cameraUsedFallback).toBe(true);
    expect(ctrl2.getDiagnosticSnapshot()!.cameraFallbackReason).toBeTruthy();
  });
});
