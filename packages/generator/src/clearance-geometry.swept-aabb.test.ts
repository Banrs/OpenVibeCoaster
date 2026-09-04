import { describe, expect, it } from "vitest";
import { vec3, type Vec3 } from "@openvibecoaster/core";
import {
  createOrientedBox,
  interpolatePose,
  staticObbDistance,
  sweptAabb,
  sweptObbSeparationLowerBound,
  type ClearanceTrainGeometry,
  type SweptClearanceSegment,
} from "./clearance-geometry.js";

const geometry: ClearanceTrainGeometry = {
  halfWidthM: 1.25,
  aboveRailM: 2.1,
  belowRailM: 0.8,
  carPitchM: 3.4,
  noseTailMarginM: 0.75,
};

function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}

function scale(value: Vec3, scalar: number): Vec3 {
  return vec3(value[0] * scalar, value[1] * scalar, value[2] * scalar);
}

function vertices(segment: SweptClearanceSegment, t: number): readonly Vec3[] {
  const box = createOrientedBox(interpolatePose(segment, t), geometry);
  const result: Vec3[] = [];
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      for (const sz of [-1, 1] as const)
        result.push(
          add(
            add(
              add(box.center, scale(box.axes[0], sx * box.halfExtents[0])),
              scale(box.axes[1], sy * box.halfExtents[1]),
            ),
            scale(box.axes[2], sz * box.halfExtents[2]),
          ),
        );
  return result;
}

describe("swept AABB tight rotation bound", () => {
  it("contains the interpolated OBB sweep without circumsphere-wide axes", () => {
    const angle = 0.05;
    const segment: SweptClearanceSegment = {
      start: {
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      },
      end: {
        position: vec3(0, 0, 1),
        tangent: vec3(Math.sin(angle), 0, Math.cos(angle)),
        normal: vec3(0, 1, 0),
        binormal: vec3(-Math.cos(angle), 0, Math.sin(angle)),
      },
      startS: 0,
      endS: 1,
      geometry,
    };

    const bounds = sweptAabb(segment);
    expect(bounds.max[1] - bounds.min[1]).toBeLessThan(4.2);
    for (let sample = 0; sample <= 128; sample += 1)
      for (const vertex of vertices(segment, sample / 128))
        for (const axis of [0, 1, 2] as const) {
          expect(vertex[axis]).toBeGreaterThanOrEqual(bounds.min[axis]);
          expect(vertex[axis]).toBeLessThanOrEqual(bounds.max[axis]);
        }
  });

  it("certifies rotated parallel sweeps whose world AABBs overlap", () => {
    const c = Math.SQRT1_2;
    const tangent = vec3(c, 0, c);
    const normal = vec3(0, 1, 0);
    const binormal = vec3(-c, 0, c);
    const offset = scale(binormal, 4);
    const makeSegment = (start: Vec3, startS: number): SweptClearanceSegment => ({
      start: { position: start, tangent, normal, binormal },
      end: {
        position: add(start, scale(tangent, 0.2)),
        tangent,
        normal,
        binormal,
      },
      startS,
      endS: startS + 0.2,
      geometry,
    });
    const first = makeSegment(vec3(0, 0, 0), 0);
    const second = makeSegment(offset, 30);
    const firstBounds = sweptAabb(first);
    const secondBounds = sweptAabb(second);
    const axisGap = (axis: 0 | 1 | 2): number =>
      Math.max(
        0,
        secondBounds.min[axis] - firstBounds.max[axis],
        firstBounds.min[axis] - secondBounds.max[axis],
      );
    expect(Math.hypot(axisGap(0), axisGap(1), axisGap(2))).toBe(0);

    const lower = sweptObbSeparationLowerBound(first, second);
    expect(lower).toBeGreaterThanOrEqual(0.5);
    let sampledMinimum = Number.POSITIVE_INFINITY;
    for (let firstSample = 0; firstSample <= 16; firstSample += 1)
      for (let secondSample = 0; secondSample <= 16; secondSample += 1) {
        const distance = staticObbDistance(
          createOrientedBox(interpolatePose(first, firstSample / 16), geometry),
          createOrientedBox(
            interpolatePose(second, secondSample / 16),
            geometry,
          ),
        ).distance;
        sampledMinimum = Math.min(sampledMinimum, distance);
      }
    expect(lower).toBeLessThanOrEqual(sampledMinimum);
  });
});
