import { describe, expect, it } from "vitest";
import { vec3, type Vec3 } from "@openvibecoaster/core";
import {
  createOrientedBox,
  interpolatePose,
  sweptAabb,
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
});
