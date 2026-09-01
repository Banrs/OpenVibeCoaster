import { describe, expect, it } from "vitest";
import { HeightfieldEnvironment, vec3, type Vec3 } from "./index.js";

const robustNormalize = (value: Vec3, label: string): Vec3 => {
  const scale = Math.max(
    Math.abs(value[0]),
    Math.abs(value[1]),
    Math.abs(value[2]),
  );
  if (!(scale > 0) || !Number.isFinite(scale))
    throw new RangeError(`${label} must be finite and non-zero`);
  const x = value[0] / scale;
  const y = value[1] / scale;
  const z = value[2] / scale;
  const length = Math.hypot(x, y, z);
  return vec3(
    x === 0 ? 0 : x / length,
    y === 0 ? 0 : y / length,
    z === 0 ? 0 : z / length,
  );
};

const pointDistance = (p: Vec3, t: Vec3): number =>
  Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

const pointSegmentDistanceBrute = (point: Vec3, a: Vec3, b: Vec3): number => {
  const edge = vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (edge[0] === 0 && edge[1] === 0 && edge[2] === 0)
    return pointDistance(point, a);
  const dir = robustNormalize(edge, "edge");
  const dA = vec3(point[0] - a[0], point[1] - a[1], point[2] - a[2]);
  const alongA = dir[0] * dA[0] + dir[1] * dA[1] + dir[2] * dA[2];
  if (alongA <= 0) return pointDistance(point, a);
  const dB = vec3(point[0] - b[0], point[1] - b[1], point[2] - b[2]);
  const alongB = dir[0] * dB[0] + dir[1] * dB[1] + dir[2] * dB[2];
  if (alongB >= 0) return pointDistance(point, b);
  const t = alongA / (alongA - alongB);
  return pointDistance(
    point,
    vec3(a[0] + edge[0] * t, a[1] + edge[1] * t, a[2] + edge[2] * t),
  );
};

function bruteTriangle(
  env: HeightfieldEnvironment,
  column: number,
  row: number,
  first: boolean,
): { a: Vec3; b: Vec3; c: Vec3; normal: Vec3; column: number; row: number; first: boolean } {
  const origin = env.origin;
  const cs = env.cellSize;
  const sample = (c: number, r: number): number =>
    env.heights[r * env.width + c]!;
  const pt = (c: number, r: number): Vec3 =>
    vec3(origin[0] + c * cs, sample(c, r), origin[1] + r * cs);
  const p00 = pt(column, row);
  const p10 = pt(column + 1, row);
  const p01 = pt(column, row + 1);
  const p11 = pt(column + 1, row + 1);
  const xDiff = (first ? p10[1] : p11[1]) - (first ? p00[1] : p01[1]);
  const zDiff = (first ? p11[1] : p01[1]) - (first ? p10[1] : p00[1]);
  const plane = vec3(-xDiff, cs, -zDiff);
  const normal = robustNormalize(plane, "normal");
  return {
    a: p00,
    b: first ? p10 : p11,
    c: first ? p11 : p01,
    normal,
    column,
    row,
    first,
  };
}

function triangleContainsBrute(
  tri: ReturnType<typeof bruteTriangle>,
  x: number,
  z: number,
  env: HeightfieldEnvironment,
): boolean {
  const cellX = env.origin[0] + tri.column * env.cellSize;
  const cellZ = env.origin[1] + tri.row * env.cellSize;
  if (x < cellX || x > cellX + env.cellSize || z < cellZ || z > cellZ + env.cellSize)
    return false;
  const localX = x - cellX;
  const localZ = z - cellZ;
  const diagonal = localX - localZ;
  return tri.first ? diagonal >= 0 : diagonal <= 0;
}

function triangleDistanceBrute(
  env: HeightfieldEnvironment,
  point: Vec3,
  tri: ReturnType<typeof bruteTriangle>,
): number {
  const rel = vec3(point[0] - tri.a[0], point[1] - tri.a[1], point[2] - tri.a[2]);
  const planeDist = tri.normal[0] * rel[0] + tri.normal[1] * rel[1] + tri.normal[2] * rel[2];
  const px = point[0] - planeDist * tri.normal[0];
  const pz = point[2] - planeDist * tri.normal[2];
  if (triangleContainsBrute(tri, px, pz, env)) return Math.abs(planeDist);
  return Math.min(
    pointSegmentDistanceBrute(point, tri.a, tri.b),
    pointSegmentDistanceBrute(point, tri.b, tri.c),
    pointSegmentDistanceBrute(point, tri.c, tri.a),
  );
}

function curtainDistanceBrute(env: HeightfieldEnvironment, point: Vec3, a: Vec3, b: Vec3): number {
  const edgeX = b[0] - a[0];
  const edgeZ = b[2] - a[2];
  const edgeLength = Math.hypot(edgeX, edgeZ);
  const dirX = edgeX / edgeLength;
  const dirZ = edgeZ / edgeLength;
  const relX = point[0] - a[0];
  const relZ = point[2] - a[2];
  const along = dirX * relX + dirZ * relZ;
  const perp = -dirZ * relX + dirX * relZ;
  if (along >= 0 && along <= edgeLength) {
    const top = a[1] + (b[1] - a[1]) * (along / edgeLength);
    if (point[1] <= top) return Math.abs(perp);
  }
  const upA = point[1] <= a[1] ? 0 : point[1] - a[1];
  const upB = point[1] <= b[1] ? 0 : point[1] - b[1];
  const vert = Math.min(Math.hypot(along, upA), Math.hypot(along - edgeLength, upB));
  let planar = vert;
  if (point[1] > Math.min(a[1], b[1])) {
    const seg = pointSegmentDistanceBrute(
      vec3(along, point[1], 0),
      vec3(0, a[1], 0),
      vec3(edgeLength, b[1], 0),
    );
    planar = Math.min(vert, seg);
  }
  return Math.hypot(perp, planar);
}

function bruteSignedDistance(env: HeightfieldEnvironment, point: Vec3): number {
  let closest = Infinity;
  for (let r = 0; r < env.depth - 1; r++)
    for (let c = 0; c < env.width - 1; c++)
      for (const first of [true, false] as const) {
        const tri = bruteTriangle(env, c, r, first);
        closest = Math.min(closest, triangleDistanceBrute(env, point, tri));
      }
  const surf = (c: number, r: number): Vec3 =>
    vec3(env.origin[0] + c * env.cellSize, env.heights[r * env.width + c]!, env.origin[1] + r * env.cellSize);
  for (let c = 0; c < env.width - 1; c++) {
    closest = Math.min(
      closest,
      curtainDistanceBrute(env, point, surf(c, 0), surf(c + 1, 0)),
      curtainDistanceBrute(env, point, surf(c, env.depth - 1), surf(c + 1, env.depth - 1)),
    );
  }
  for (let r = 0; r < env.depth - 1; r++) {
    closest = Math.min(
      closest,
      curtainDistanceBrute(env, point, surf(0, r), surf(0, r + 1)),
      curtainDistanceBrute(env, point, surf(env.width - 1, r), surf(env.width - 1, r + 1)),
    );
  }
  const inside =
    point[0] > env.origin[0] &&
    point[0] < env.origin[0] + (env.width - 1) * env.cellSize &&
    point[2] > env.origin[1] &&
    point[2] < env.origin[1] + (env.depth - 1) * env.cellSize &&
    point[1] < env.heightAt(point[0], point[2]);
  return inside ? -closest : closest;
}

describe("heightfield SDF acceleration – exact analytic flat cases", () => {
  const flat = new HeightfieldEnvironment({
    width: 2,
    depth: 2,
    cellSize: 1,
    heights: new Float64Array([0, 0, 0, 0]),
    origin: [0, 0],
  });

  it("above interior returns vertical distance", () => {
    const p = vec3(0.5, 2, 0.5);
    expect(flat.signedDistance(p)).toBeCloseTo(2, 10);
    expect(bruteSignedDistance(flat, p)).toBeCloseTo(2, 10);
  });

  it("below/inside returns negative distance", () => {
    const p = vec3(0.5, -1, 0.5);
    expect(flat.signedDistance(p)).toBeCloseTo(-1, 10);
    expect(flat.signedDistance(p)).toBeLessThan(0);
  });

  it("outside horizontally uses curtain/edge distance", () => {
    const p = vec3(5, 2, 0.5);
    const d = flat.signedDistance(p);
    const brute = bruteSignedDistance(flat, p);
    expect(d).toBeCloseTo(brute, 9);
    expect(d).toBeCloseTo(Math.hypot(4, 2), 6);
  });

  it("corner outside is exact", () => {
    const p = vec3(2, 1, 2);
    expect(flat.signedDistance(p)).toBeCloseTo(bruteSignedDistance(flat, p), 9);
    expect(flat.signedDistance(p)).toBeGreaterThan(0);
  });

  it("curtain below top returns horizontal distance", () => {
    const p = vec3(2, -1, 0.5);
    const d = flat.signedDistance(p);
    expect(d).toBeCloseTo(1, 10);
  });

  it("point on surface returns zero", () => {
    expect(flat.signedDistance(vec3(0.5, 0, 0.5))).toBeCloseTo(0, 10);
  });
});

describe("heightfield SDF acceleration – sloped/irregular brute comparison", () => {
  it("sloped heightfield matches brute force for many points", () => {
    const env = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights: new Float64Array([0, 1, 0, 1, 2, 1, 0, 1, 0]),
      origin: [0, 0],
    });
    const points: Vec3[] = [
      vec3(0.5, 2, 0.5),
      vec3(1.5, 2, 0.5),
      vec3(1, 0.5, 1),
      vec3(0.2, 3, 0.2),
      vec3(1, 5, 1),
      vec3(2.5, 1, 2.5),
      vec3(-1, 1, 1),
      vec3(1, 1, -1),
    ];
    for (const p of points) {
      const a = env.signedDistance(p);
      const b = bruteSignedDistance(env, p);
      expect(a).toBeCloseTo(b, 9);
    }
  });

  it("irregular deterministic heights match brute", () => {
    const heights = new Float64Array(4 * 4);
    for (let i = 0; i < heights.length; i++) heights[i] = Math.sin(i * 1.3) * 2;
    const env = new HeightfieldEnvironment({
      width: 4,
      depth: 4,
      cellSize: 0.7,
      heights,
      origin: [0.3, -0.4],
    });
    const pts: Vec3[] = [
      vec3(1, 1, 1),
      vec3(0.8, 0.2, 0.9),
      vec3(2, 2, 2),
      vec3(0.3, 5, 0.3),
    ];
    for (const p of pts) {
      expect(env.signedDistance(p)).toBeCloseTo(bruteSignedDistance(env, p), 8);
    }
  });

  it("no nearest triangle is pruned across grid sample", () => {
    const env = new HeightfieldEnvironment({
      width: 4,
      depth: 4,
      cellSize: 1,
      heights: new Float64Array([0, 0.5, 1, 0, 0.3, 1.2, 0.8, 0.2, 0.9, 0.1, 0.4, 0.7, 0, 0.6, 0.2, 0]),
      origin: [0, 0],
    });
    for (let x = -0.5; x <= 3.5; x += 0.5)
      for (let z = -0.5; z <= 3.5; z += 0.5)
        for (const y of [ -1, 0.2, 1.5, 3]) {
          const p = vec3(x, y, z);
          expect(env.signedDistance(p)).toBeCloseTo(bruteSignedDistance(env, p), 8);
        }
  });
});

describe("heightfield SDF acceleration – translation and large coordinates", () => {
  it("large finite translation preserves relative distance", () => {
    const baseHeights = new Float64Array([0, 0, 0, 0]);
    const base = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: baseHeights,
      origin: [0, 0],
    });
    const shifted = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: baseHeights,
      origin: [1e6, 1e6],
    });
    const pBase = vec3(0.5, 2, 0.5);
    const pShifted = vec3(1e6 + 0.5, 2, 1e6 + 0.5);
    expect(base.signedDistance(pBase)).toBeCloseTo(shifted.signedDistance(pShifted), 9);
  });

  it("large finite height scale remains exact", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([1e6, 1e6 + 1, 1e6, 1e6 + 1]),
      origin: [0, 0],
    });
    const p = vec3(0.5, 1e6 + 5, 0.5);
    expect(env.signedDistance(p)).toBeCloseTo(bruteSignedDistance(env, p), 6);
  });

  it("rejects non-finite inputs", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 0, 0, 0]),
    });
    expect(() => env.signedDistance(vec3(NaN, 0, 0))).toThrow();
    expect(() => env.signedDistance(vec3(0, Infinity, 0))).toThrow();
    expect(() => env.signedDistance([0, 0, NaN] as unknown as Vec3)).toThrow();
    expect(
      () =>
        new HeightfieldEnvironment({
          width: 2,
          depth: 2,
          cellSize: 1,
          heights: new Float64Array([0, NaN, 0, 0]),
        }),
    ).toThrow();
  });

  it("is deterministic across repeated calls", () => {
    const env = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights: new Float64Array([0, 1, 0, 1, 2, 1, 0, 1, 0]),
    });
    const p = vec3(1.2, 1.3, 0.7);
    const a = env.signedDistance(p);
    const b = env.signedDistance(p);
    expect(a).toBe(b);
  });
});
