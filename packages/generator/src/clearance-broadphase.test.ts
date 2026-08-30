import { describe, expect, it } from "vitest";
import {
  HeightfieldEnvironment,
  vec3,
  type EnvironmentQuery,
  type Vec3,
} from "@openvibecoaster/core";
import { buildElement, createElement } from "./elements";
import { validateClearance } from "./clearance";
import { nextDown, nextUp } from "./polynomial-bounds";
import type { Pose } from "./types";

const makeEnv = (maxY: number): HeightfieldEnvironment => {
  const width = 2;
  const depth = 2;
  const cellSize = 10;
  const origin: [number, number] = [-5, -5];
  const heights = new Float64Array(width * depth);
  for (let index = 0; index < heights.length; index += 1) heights[index] = maxY;
  const hf = new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights,
    origin,
  });
  return hf;
};

const makeMockEnv = (
  maxY: number,
  signedDistanceImpl: (point: Vec3) => number,
): EnvironmentQuery => {
  const hf = makeEnv(maxY);
  const bounds = hf.bounds();
  if (bounds === undefined) throw new Error("Environment bounds missing");
  return {
    bounds: () => bounds,
    signedDistance: (point: Vec3) => signedDistanceImpl(point),
    raycast: (origin: Vec3, direction: Vec3, maxDistance: number) =>
      hf.raycast(origin, direction, maxDistance),
  };
};

describe("clearance terrain broad-phase", () => {
  it("entirely-above span passes without budget exhaustion", () => {
    let callCount = 0;
    const baseEnv = makeEnv(-8);
    const maybeBounds = baseEnv.bounds?.();
    if (maybeBounds === undefined)
      throw new Error("Environment bounds missing");
    const bounds = maybeBounds;
    const env: EnvironmentQuery = {
      bounds: () => bounds,
      signedDistance: (point: Vec3) => {
        callCount += 1;
        return baseEnv.signedDistance(point);
      },
      raycast: (origin: Vec3, direction: Vec3, maxDistance: number) =>
        baseEnv.raycast(origin, direction, maxDistance),
    };
    const station = createElement("station", "station-000", {
      length: 30,
      bank: 0,
      closed: false,
    });
    const pose: Pose = {
      position: vec3(0, 12, 0),
      tangent: vec3(0, 0, 1),
      normal: vec3(0, 1, 0),
      bank: 0,
    };
    const built = buildElement(station, pose, 44);
    const spans = built.solvedSpans;
    const diags = validateClearance(spans, env, { maxWork: 1_000_000 });
    const terrainDiags = diags.filter(
      (diag) => diag.code === "TERRAIN_CLEARANCE",
    );
    expect(terrainDiags).toHaveLength(0);
    const uncertified = diags.filter(
      (diag) => diag.code === "CLEARANCE_UNCERTIFIED",
    );
    expect(uncertified).toHaveLength(0);
    expect(callCount).toBe(0);
  });

  it("crossing/below span still reports terrain penetration", () => {
    let callCount = 0;
    const baseEnv = makeEnv(0);
    const maybeBounds = baseEnv.bounds?.();
    if (maybeBounds === undefined)
      throw new Error("Environment bounds missing");
    const bounds = maybeBounds;
    const env: EnvironmentQuery = {
      bounds: () => bounds,
      signedDistance: (point: Vec3) => {
        callCount += 1;
        return baseEnv.signedDistance(point);
      },
      raycast: (origin: Vec3, direction: Vec3, maxDistance: number) =>
        baseEnv.raycast(origin, direction, maxDistance),
    };
    const station = createElement("station", "station-001", {
      length: 20,
      bank: 0,
      closed: false,
    });
    const pose: Pose = {
      position: vec3(0, -2, 0),
      tangent: vec3(0, 0, 1),
      normal: vec3(0, 1, 0),
      bank: 0,
    };
    const built = buildElement(station, pose, 44);
    const spans = built.solvedSpans;
    const diags = validateClearance(spans, env, { maxWork: 1_000_000 });
    const terrainDiags = diags.filter(
      (diag) => diag.code === "TERRAIN_CLEARANCE",
    );
    expect(terrainDiags.length).toBeGreaterThan(0);
    expect(terrainDiags[0]!.actual).toBeLessThanOrEqual(0);
    expect(Number.isFinite(terrainDiags[0]!.actual)).toBe(true);
    expect(Number.isFinite(terrainDiags[0]!.limit)).toBe(true);
    expect(callCount).toBeGreaterThan(0);
  });

  it("near-boundary span still follows exact recursive path rather than being skipped", () => {
    const envMaxY = 10;
    let callCountAbove = 0;
    const envAbove = makeMockEnv(envMaxY, (point: Vec3) => {
      callCountAbove += 1;
      return point[1] - envMaxY;
    });
    const station = createElement("station", "station-002", {
      length: 10,
      bank: 0,
      closed: false,
    });
    const tinyAbove = nextUp(envMaxY);
    const pose: Pose = {
      position: vec3(0, tinyAbove, 0),
      tangent: vec3(0, 0, 1),
      normal: vec3(0, 1, 0),
      bank: 0,
    };
    const built = buildElement(station, pose, 44);
    const spans = built.solvedSpans;
    const diags = validateClearance(spans, envAbove, { maxWork: 1_000_000 });
    expect(callCountAbove).toBeGreaterThan(0);
    expect(diags.some((diag) => diag.code === "CLEARANCE_UNCERTIFIED")).toBe(
      true,
    );
    expect(diags.some((diag) => diag.code === "TERRAIN_CLEARANCE")).toBe(false);
    let callCountBelow = 0;
    const envBelow = makeMockEnv(envMaxY, (point: Vec3) => {
      callCountBelow += 1;
      return point[1] - envMaxY;
    });
    const poseBelow: Pose = {
      position: vec3(0, nextDown(envMaxY), 0),
      tangent: vec3(0, 0, 1),
      normal: vec3(0, 1, 0),
      bank: 0,
    };
    const builtBelow = buildElement(station, poseBelow, 44);
    const spansBelow = builtBelow.solvedSpans;
    const diagsBelow = validateClearance(spansBelow, envBelow, {
      maxWork: 1_000_000,
    });
    expect(diagsBelow.some((diag) => diag.code === "TERRAIN_CLEARANCE")).toBe(
      true,
    );
    expect(callCountBelow).toBeGreaterThan(0);
    const terrainBelow = diagsBelow.find(
      (diag) => diag.code === "TERRAIN_CLEARANCE",
    );
    expect(terrainBelow).toBeDefined();
    expect(Number.isFinite(terrainBelow!.actual)).toBe(true);
    expect(Number.isFinite(terrainBelow!.limit)).toBe(true);
  });
});
