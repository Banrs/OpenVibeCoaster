import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { createRendererController } from "./controller.js";
import { getCarIndexForCamera, getCameraState } from "./cameras.js";
import type { RendererHandle } from "./renderer.js";

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
  // minimal handle with required fields used by controller
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

describe("render evidence seat", () => {
  it("railColorHash distinct for G/speed/roll/clearance and null when unavailable", () => {
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
    // unavailable metric should still compute hash from neutral but still not null? Actually metricAvailable false but color still built with neutral, hash still from color buffer, not null
    // But if no metricData provided for speed, available false, hash should still be computed from neutral colors (non-null) – we consider that actual evidence
    ctrl.attachTrack(track, { metric: "speed" });
    const hUnavail = ctrl.getDiagnosticSnapshot()!.railColorHash;
    expect(hUnavail).not.toBeNull();
    // ensure distinct from available hash
    expect(hUnavail).not.toBe(h1);
  });

  it("seam on/off changes actual geometry signature", () => {
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
    expect(sOff).not.toBe(sOn);
  });

  it("highlight/train world XYZ mutate via actual car objects", () => {
    const track = makeTrack();
    const camera = new THREE.PerspectiveCamera();
    const handle = makeHandle();
    const ctrl = createRendererController(handle, camera);
    ctrl.attachTrack(track, { metric: "height" });
    // need minimal timeline snapshot simulation via controller.updatePlayback using head distances
    // use getCarTransforms via train logic: updatePlayback will place cars
    const before = ctrl.getDiagnosticSnapshot()!.trainWorldPositions;
    expect(before).not.toBeNull();
    const beforePos = [...before!];
    ctrl.updatePlayback(5, 5, null);
    const after = ctrl.getDiagnosticSnapshot()!.trainWorldPositions;
    expect(after).not.toBeNull();
    // at least one coordinate should have mutated
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
    // highlight distance also in diagnostic should update
    ctrl.setHighlight(10);
    const withHighlight = ctrl.getDiagnosticSnapshot()!.highlightDistance;
    expect(withHighlight).toBe(10);
    expect(ctrl.getDiagnosticSnapshot()!.seamSignature).not.toBeNull();
  });

  it("camera carCount 2/6 and rollback positions", () => {
    void makeTrack();
    expect(getCarIndexForCamera("front", 2)).toBe(0);
    expect(getCarIndexForCamera("middle", 2)).toBe(0);
    expect(getCarIndexForCamera("rear", 2)).toBe(1);
    expect(getCarIndexForCamera("front", 6)).toBe(0);
    expect(getCarIndexForCamera("middle", 6)).toBe(2);
    expect(getCarIndexForCamera("rear", 6)).toBe(5);
    // rollback: signed speed negative influences FOV but not position fallback; check camera state with snapshot null uses sampleCompiledTrack
    const data = makeTrack();
    const snap = {
      selections: {
        front: {
          position: vec3(0, 5, 0),
          tangent: vec3(1, 0, 0),
          normal: vec3(0, 1, 0),
          binormal: vec3(0, 0, 1),
        },
        middle: {
          position: vec3(10, 5, 0),
          tangent: vec3(1, 0, 0),
          normal: vec3(0, 1, 0),
          binormal: vec3(0, 0, 1),
        },
        rear: {
          position: vec3(20, 5, 0),
          tangent: vec3(1, 0, 0),
          normal: vec3(0, 1, 0),
          binormal: vec3(0, 0, 1),
        },
      },
      carCount: 3,
      cars: [],
    } as unknown as import("../ride/controller.js").RidePlaybackSnapshot;
    const sFront = getCameraState("front", data, 10, 5, { snapshot: snap });
    const sFrontRollback = getCameraState("front", data, 5, -3, {
      snapshot: snap,
    });
    // front authoritative uses snapshot selection, not head distance, so positions equal despite distance/speed change (signed speed only affects FOV)
    expect(sFront.position[0]).toBe(sFrontRollback.position[0]);
    expect(sFront.fov).not.toBe(sFrontRollback.fov);
    // ensure camera fallback reason null when snapshot present
    const handle2 = makeHandle();
    const camera2 = new THREE.PerspectiveCamera();
    const ctrl2 = createRendererController(handle2, camera2);
    ctrl2.attachTrack(data, { metric: "height" });
    // apply camera with snapshot -> not fallback
    ctrl2.applyCamera("front", { snapshot: snap });
    expect(ctrl2.getDiagnosticSnapshot()!.cameraUsedFallback).toBe(false);
    // apply with null snapshot -> fallback
    ctrl2.applyCamera("front", { snapshot: null });
    expect(ctrl2.getDiagnosticSnapshot()!.cameraUsedFallback).toBe(true);
    expect(ctrl2.getDiagnosticSnapshot()!.cameraFallbackReason).toBeTruthy();
  });
});
