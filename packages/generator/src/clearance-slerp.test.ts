import { describe, it, expect } from "vitest";
import { vec3, quatFromFrame, quatDot } from "@openvibecoaster/core";
import { interpolateTrackFrame } from "@openvibecoaster/core";
import type { Vec3 } from "@openvibecoaster/core";
import {
  createClearanceTrainGeometry,
  createOrientedBox,
  interpolatePose,
  sweptMotionBound,
} from "./clearance-geometry.js";

function pose120(tangentDeg: number): { t: Vec3; n: Vec3; b: Vec3 } {
  const rad = (tangentDeg * Math.PI) / 180;
  const t = vec3(Math.sin(rad), 0, Math.cos(rad));
  const n = vec3(0, 1, 0);
  const b = vec3(-Math.cos(rad), 0, Math.sin(rad));
  return { t, n, b };
}

describe("interpolateTrackFrame SLERP", () => {
  it("120-degree narrow subinterval bound dominates actual motion", () => {
    const geom = createClearanceTrainGeometry({
      halfWidthM: 1.25,
      aboveRailM: 2.1,
      belowRailM: 0.8,
      carPitchM: 3.4,
      noseTailMarginM: 0.75,
    });
    const s0 = pose120(0);
    const s1 = pose120(120);
    const seg = {
      startS: 0,
      endS: 1,
      start: {
        position: vec3(0, 0, 0),
        tangent: s0.t,
        normal: s0.n,
        binormal: s0.b,
      },
      end: {
        position: vec3(0, 0, 0),
        tangent: s1.t,
        normal: s1.n,
        binormal: s1.b,
      },
      geometry: geom,
    };
    const bound = sweptMotionBound(seg, 0.5, 0.51);
    const mid = interpolatePose(seg, 0.505);
    const midBox = createOrientedBox(mid, geom);
    const midVerts: Vec3[] = [];
    for (let vi = 0; vi < 8; vi++) {
      const sx = vi & 1 ? 1 : -1;
      const sy = vi & 2 ? 1 : -1;
      const sz = vi & 4 ? 1 : -1;
      midVerts.push(
        vec3(
          midBox.center[0] +
            sx * midBox.halfExtents[0] * midBox.axes[0][0] +
            sy * midBox.halfExtents[1] * midBox.axes[1][0] +
            sz * midBox.halfExtents[2] * midBox.axes[2][0],
          midBox.center[1] +
            sx * midBox.halfExtents[0] * midBox.axes[0][1] +
            sy * midBox.halfExtents[1] * midBox.axes[1][1] +
            sz * midBox.halfExtents[2] * midBox.axes[2][1],
          midBox.center[2] +
            sx * midBox.halfExtents[0] * midBox.axes[0][2] +
            sy * midBox.halfExtents[1] * midBox.axes[1][2] +
            sz * midBox.halfExtents[2] * midBox.axes[2][2],
        ),
      );
    }
    let maxDist = 0;
    for (let k = 0; k <= 20; k++) {
      const t = 0.5 + (k / 20) * 0.01;
      const p = interpolatePose(seg, t);
      const b = createOrientedBox(p, geom);
      for (let vi = 0; vi < midVerts.length; vi++) {
        const sx = vi & 1 ? 1 : -1;
        const sy = vi & 2 ? 1 : -1;
        const sz = vi & 4 ? 1 : -1;
        const vx = vec3(
          b.center[0] +
            sx * b.halfExtents[0] * b.axes[0][0] +
            sy * b.halfExtents[1] * b.axes[1][0] +
            sz * b.halfExtents[2] * b.axes[2][0],
          b.center[1] +
            sx * b.halfExtents[0] * b.axes[0][1] +
            sy * b.halfExtents[1] * b.axes[1][1] +
            sz * b.halfExtents[2] * b.axes[2][1],
          b.center[2] +
            sx * b.halfExtents[0] * b.axes[0][2] +
            sy * b.halfExtents[1] * b.axes[1][2] +
            sz * b.halfExtents[2] * b.axes[2][2],
        );
        const d = Math.hypot(
          vx[0] - midVerts[vi]![0],
          vx[1] - midVerts[vi]![1],
          vx[2] - midVerts[vi]![2],
        );
        if (d > maxDist) maxDist = d;
      }
    }
    expect(maxDist).toBeLessThanOrEqual(bound + 1e-9);
    expect(bound).toBeGreaterThan(0.03);
    expect(bound).toBeLessThan(0.08);
  });

  it("endpoint exactness and orthonormality", () => {
    const s0 = pose120(0);
    const s1 = pose120(120);
    const f0 = interpolateTrackFrame(s0.t, s0.n, s0.b, s1.t, s1.n, s1.b, 0);
    expect(f0.tangent[0]).toBeCloseTo(s0.t[0], 12);
    expect(f0.normal[1]).toBeCloseTo(s0.n[1], 12);
    const f1 = interpolateTrackFrame(s0.t, s0.n, s0.b, s1.t, s1.n, s1.b, 1);
    expect(f1.tangent[0]).toBeCloseTo(s1.t[0], 12);
    const fm = interpolateTrackFrame(s0.t, s0.n, s0.b, s1.t, s1.n, s1.b, 0.5);
    const dotTN =
      fm.tangent[0] * fm.normal[0] +
      fm.tangent[1] * fm.normal[1] +
      fm.tangent[2] * fm.normal[2];
    expect(Math.abs(dotTN)).toBeLessThan(1e-9);
    expect(Math.abs(Math.hypot(...fm.tangent) - 1)).toBeLessThan(1e-9);
  });

  it("shortest-arc parity", () => {
    const s0 = pose120(0);
    const s1 = pose120(120);
    const q0 = quatFromFrame(s0.t, s0.n, s0.b);
    const q1 = quatFromFrame(s1.t, s1.n, s1.b);
    const dot = quatDot(q0, q1);
    expect(dot).toBeGreaterThan(0);
    const fMid = interpolateTrackFrame(s0.t, s0.n, s0.b, s1.t, s1.n, s1.b, 0.5);
    const expected = pose120(60);
    expect(fMid.tangent[0]).toBeCloseTo(expected.t[0], 6);
    expect(fMid.tangent[2]).toBeCloseTo(expected.t[2], 6);
  });

  it("constant-frame yields constant orientation", () => {
    const s = pose120(30);
    const f = interpolateTrackFrame(s.t, s.n, s.b, s.t, s.n, s.b, 0.37);
    expect(f.tangent[0]).toBeCloseTo(s.t[0], 12);
    expect(f.normal[1]).toBeCloseTo(s.n[1], 12);
    expect(f.binormal[0]).toBeCloseTo(s.b[0], 12);
  });
});
