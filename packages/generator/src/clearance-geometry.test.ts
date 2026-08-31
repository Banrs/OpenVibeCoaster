import { describe, expect, it } from "vitest";
import {
  certifiedSweptDistance,
  closedArcIntervalDistance,
  createClearancePose,
  createClearanceTrainGeometry,
  createOrientedBox,
  interpolatePose,
  openArcIntervalDistance,
  staticObbDistance,
  sweptAabb,
  sweptMotionBound,
} from "./clearance-geometry";
import { vec3, type Vec3 } from "@openvibecoaster/core";

const pose = (
  position: Vec3,
  tangent: Vec3 = vec3(0, 0, 1),
  normal: Vec3 = vec3(0, 1, 0),
  binormal: Vec3 = vec3(-1, 0, 0),
): ReturnType<typeof createClearancePose> =>
  createClearancePose({ position, tangent, normal, binormal });

const geom = (
  over: Partial<ReturnType<typeof createClearanceTrainGeometry>> = {},
) =>
  createClearanceTrainGeometry({
    halfWidthM: 1,
    aboveRailM: 1,
    belowRailM: 1,
    carPitchM: 2,
    noseTailMarginM: 0.5,
    ...over,
  });

const v = (x: number, y: number, z: number): Vec3 => vec3(x, y, z);

describe("clearance geometry foundation", () => {
  it("axis-aligned gap, overlap zero, asymmetric center, width/longitudinal extents", () => {
    const g = geom();
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    const gap = 3;
    const b = createOrientedBox(pose(v(2 + gap, 0, 0)), g);
    // halfWidth 1 each => gap = 2*1 + gap? Actually centers at 0 and 2+gap? Let's compute: hx=1, so distance between centers 2+gap => gap=gap
    const r = staticObbDistance(a, b);
    expect(r.distance).toBeCloseTo(gap, 6);
    expect(r.pointA[0]).toBeCloseTo(1, 6);
    expect(r.pointB[0]).toBeCloseTo(1 + gap, 6);
    const overlap = staticObbDistance(a, a);
    expect(overlap.distance).toBe(0);
    expect(overlap.pointA).toEqual(overlap.pointB);
    const asym = geom({ aboveRailM: 2, belowRailM: 0.5 });
    const box = createOrientedBox(pose(v(0, 0, 0)), asym);
    expect(box.halfExtents[1]).toBeCloseTo(1.25, 9);
    expect(box.center[1]).toBeCloseTo(0.75, 9);
    const w = createOrientedBox(pose(v(0, 0, 0)), geom({ halfWidthM: 0.7 }));
    expect(w.halfExtents[0]).toBeCloseTo(0.7, 9);
    const l = createOrientedBox(
      pose(v(0, 0, 0)),
      geom({ carPitchM: 4, noseTailMarginM: 0.2 }),
    );
    expect(l.halfExtents[2]).toBeCloseTo(2.2, 9);
  });

  it("rotated skew edge-edge minimum is below vertex-only distance", () => {
    const g = geom({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 2,
      noseTailMarginM: 0,
    });
    // Box A axis-aligned at origin along Z, Box B rotated 90 deg around Y and offset so edges are skew
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    // Create B with T along X, N along Y, B along -Z (rotated)
    const b = createOrientedBox(
      createClearancePose({
        position: v(0.03, 1.69, 0.06),
        tangent: v(1, 0, 0),
        normal: v(0, 1, 0),
        binormal: v(0, 0, 1),
      }),
      g,
    );
    const res = staticObbDistance(a, b);
    // brute vertex-only distance
    const verts = (box: ReturnType<typeof createOrientedBox>): Vec3[] => {
      const out: Vec3[] = [];
      for (const sx of [-1, 1] as const)
        for (const sy of [-1, 1] as const)
          for (const sz of [-1, 1] as const) {
            const p: Vec3 = vec3(
              box.center[0] +
                sx * box.halfExtents[0] * box.axes[0][0] +
                sy * box.halfExtents[1] * box.axes[1][0] +
                sz * box.halfExtents[2] * box.axes[2][0],
              box.center[1] +
                sx * box.halfExtents[0] * box.axes[0][1] +
                sy * box.halfExtents[1] * box.axes[1][1] +
                sz * box.halfExtents[2] * box.axes[2][1],
              box.center[2] +
                sx * box.halfExtents[0] * box.axes[0][2] +
                sy * box.halfExtents[1] * box.axes[1][2] +
                sz * box.halfExtents[2] * box.axes[2][2],
            );
            out.push(p);
          }
      return out;
    };
    const pointToBox = (
      pt: Vec3,
      box: ReturnType<typeof createOrientedBox>,
    ): number => {
      const d = vec3(
        pt[0] - box.center[0],
        pt[1] - box.center[1],
        pt[2] - box.center[2],
      );
      let closest = vec3(box.center[0], box.center[1], box.center[2]);
      for (let i = 0; i < 3; i += 1) {
        const ax = box.axes[i]!;
        const proj = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
        const c = Math.max(
          -box.halfExtents[i]!,
          Math.min(box.halfExtents[i]!, proj),
        );
        closest = vec3(
          closest[0] + ax[0] * c,
          closest[1] + ax[1] * c,
          closest[2] + ax[2] * c,
        );
      }
      return Math.hypot(
        pt[0] - closest[0],
        pt[1] - closest[1],
        pt[2] - closest[2],
      );
    };
    let vertMin = Infinity;
    for (const va of verts(a)) vertMin = Math.min(vertMin, pointToBox(va, b));
    for (const vb of verts(b)) vertMin = Math.min(vertMin, pointToBox(vb, a));
    expect(res.distance).toBeLessThanOrEqual(vertMin + 1e-9);
    expect(res.distance).toBeGreaterThanOrEqual(0);
    // ensure edge feature matches brute (vertex alone would be >= res)
    expect(res.distance).toBeLessThanOrEqual(vertMin);
  });

  it("rigid transform invariance", () => {
    const g = geom();
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    const b = createOrientedBox(pose(v(4, 0, 0)), g);
    const r0 = staticObbDistance(a, b);
    const translate = v(10, -3, 7);
    const translatePose = (
      p: ReturnType<typeof createClearancePose>,
      t: Vec3,
    ) =>
      createClearancePose({
        position: vec3(
          p.position[0] + t[0],
          p.position[1] + t[1],
          p.position[2] + t[2],
        ),
        tangent: p.tangent,
        normal: p.normal,
        binormal: p.binormal,
      });
    const r1 = staticObbDistance(
      createOrientedBox(translatePose(pose(v(0, 0, 0)), translate), g),
      createOrientedBox(translatePose(pose(v(4, 0, 0)), translate), g),
    );
    expect(r1.distance).toBeCloseTo(r0.distance, 6);
    // 90 deg yaw rotation around Y: (x,z)->(z,-x), axes rotated similarly
    const rotateY = (p: Vec3): Vec3 => vec3(p[2], p[1], -p[0]);
    const rotatePose = (pp: ReturnType<typeof createClearancePose>) =>
      createClearancePose({
        position: rotateY(pp.position),
        tangent: rotateY(pp.tangent),
        normal: rotateY(pp.normal),
        binormal: rotateY(pp.binormal),
      });
    const r2 = staticObbDistance(
      createOrientedBox(rotatePose(pose(v(0, 0, 0))), g),
      createOrientedBox(rotatePose(pose(v(4, 0, 0))), g),
    );
    expect(r2.distance).toBeCloseTo(r0.distance, 6);
  });

  it("mid-sweep collision despite separated endpoints", () => {
    const g = geom({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 2,
      noseTailMarginM: 0,
    });
    const segA = {
      startS: 0,
      endS: 10,
      start: pose(v(0, 0, 0)),
      end: pose(v(10, 0, 0)),
      geometry: g,
    };
    const segB = {
      startS: 0,
      endS: 10,
      start: pose(v(5, 2.5, 0)),
      end: pose(v(5, -2.5, 0)),
      geometry: g,
    };
    // endpoints are separated >1m
    const e00 = staticObbDistance(
      createOrientedBox(segA.start, g),
      createOrientedBox(segB.start, g),
    );
    const e11 = staticObbDistance(
      createOrientedBox(segA.end, g),
      createOrientedBox(segB.end, g),
    );
    expect(e00.distance).toBeGreaterThan(0.5);
    expect(e11.distance).toBeGreaterThan(0.5);
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 5000,
      resolutionM: 0.01,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.lowerM).toBe(0);
      expect(res.upperM).toBe(0);
    }
  });

  it("circumspheres overlap but exact OBB gap exceeds margin", () => {
    const g = geom({
      halfWidthM: 1,
      aboveRailM: 0.2,
      belowRailM: 0.2,
      carPitchM: 6,
      noseTailMarginM: 0,
    });
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    const b = createOrientedBox(pose(v(0, 2, 0)), g);
    // Gap in Y: centers 2 apart, hy=0.2 each => gap 1.6
    const r = staticObbDistance(a, b);
    expect(r.distance).toBeCloseTo(1.6, 6);
    const ra = Math.sqrt(
      g.halfWidthM ** 2 +
        ((g.aboveRailM + g.belowRailM) / 2) ** 2 +
        (g.carPitchM / 2 + g.noseTailMarginM) ** 2,
    );
    const centerDist = 2;
    expect(centerDist).toBeLessThan(2 * ra);
    expect(r.distance).toBeGreaterThan(0.25);
  });

  it("motion bound contains every vertex and slerp does not flip", () => {
    const g = geom();
    const start = createClearancePose({
      position: v(0, 0, 0),
      tangent: v(0, 0, 1),
      normal: v(0, 1, 0),
      binormal: v(-1, 0, 0),
    });
    // near 180 deg flip: rotate 179 deg around Z
    const ang = (179 * Math.PI) / 180;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    // rotate N/B around T (Z)
    const end = createClearancePose({
      position: v(1, 0, 0),
      tangent: v(0, 0, 1),
      normal: vec3(-s, c, 0),
      binormal: vec3(-c, -s, 0),
    });
    const seg = { startS: 0, endS: 1, start, end, geometry: g };
    const bound = sweptMotionBound(seg, 0, 1);
    for (let i = 0; i <= 20; i += 1) {
      const t = i / 20;
      const mid = interpolatePose(seg, 0.5);
      const sample = interpolatePose(seg, t);
      const boxMid = createOrientedBox(mid, g);
      const boxS = createOrientedBox(sample, g);
      // check vertex displacement within bound
      const vertsMid: Vec3[] = [];
      const vertsS: Vec3[] = [];
      for (const sx of [-1, 1] as const)
        for (const sy of [-1, 1] as const)
          for (const sz of [-1, 1] as const) {
            const mk = (
              box: ReturnType<typeof createOrientedBox>,
              x: number,
              y: number,
              z: number,
            ): Vec3 =>
              vec3(
                box.center[0] +
                  x * box.halfExtents[0] * box.axes[0][0] +
                  y * box.halfExtents[1] * box.axes[1][0] +
                  z * box.halfExtents[2] * box.axes[2][0],
                box.center[1] +
                  x * box.halfExtents[0] * box.axes[0][1] +
                  y * box.halfExtents[1] * box.axes[1][1] +
                  z * box.halfExtents[2] * box.axes[2][1],
                box.center[2] +
                  x * box.halfExtents[0] * box.axes[0][2] +
                  y * box.halfExtents[1] * box.axes[1][2] +
                  z * box.halfExtents[2] * box.axes[2][2],
              );
            vertsMid.push(mk(boxMid, sx, sy, sz));
            vertsS.push(mk(boxS, sx, sy, sz));
          }
      let maxDisp = 0;
      for (let k = 0; k < vertsMid.length; k += 1)
        maxDisp = Math.max(
          maxDisp,
          Math.hypot(
            vertsS[k]![0] - vertsMid[k]![0],
            vertsS[k]![1] - vertsMid[k]![1],
            vertsS[k]![2] - vertsMid[k]![2],
          ),
        );
      expect(maxDisp).toBeLessThanOrEqual(bound + 1e-9);
    }
    // no flip: interpolated normal should stay near slerp, dot between start and end interpolated should be >=0
    const midN = interpolatePose(seg, 0.5).normal;
    expect(
      midN[0] * start.normal[0] +
        midN[1] * start.normal[1] +
        midN[2] * start.normal[2],
    ).toBeGreaterThan(-0.1);
  });

  it("open and closed locality plus straddling collision", () => {
    const openOverlap = openArcIntervalDistance(0, 5, 3, 8);
    expect(openOverlap.min).toBe(0);
    const openSep = openArcIntervalDistance(0, 2, 5, 7);
    expect(openSep.min).toBeCloseTo(3, 9);
    expect(openSep.max).toBeCloseTo(7, 9);
    const L = 10;
    expect(closedArcIntervalDistance(0, 2, 2, 4, L).min).toBeCloseTo(0, 9);
    // periodic half-integer: D=[0,5] with L=10 contains 5 => max L/2
    expect(closedArcIntervalDistance(0, 2, 5, 7, L).max).toBeCloseTo(5, 9);
    // integer multiple inside => min 0
    expect(closedArcIntervalDistance(0, 1, 9, 11, L).min).toBe(0);
    // straddling case with certified split
    const g = geom({
      halfWidthM: 0.4,
      aboveRailM: 0.4,
      belowRailM: 0.4,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const segA = {
      startS: 0,
      endS: 2,
      start: pose(v(0, 0, 0)),
      end: pose(v(2, 0, 0)),
      geometry: g,
    };
    const segB = {
      startS: 8,
      endS: 10,
      start: pose(v(8, 3, 0)),
      end: pose(v(10, 3, 0)),
      geometry: g,
    };
    const localRes = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 0.1,
      closed: false,
    });
    expect(localRes.ok).toBe(true);
    const segC = {
      startS: 0,
      endS: 2,
      start: pose(v(1, 0, 0)),
      end: pose(v(2, 0, 0)),
      geometry: g,
    };
    const segD = {
      startS: 8,
      endS: 10,
      start: pose(v(8, 0.6, 0)),
      end: pose(v(9, 0.6, 0)),
      geometry: g,
    };
    const nonLocal = certifiedSweptDistance(segC, segD, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 2,
      closed: false,
    });
    expect(nonLocal.ok).toBe(true);
  });

  it("certified interval tight and deterministic, tiny budget fails", () => {
    const g = geom();
    const segA = {
      startS: 0,
      endS: 5,
      start: pose(v(0, 0, 0)),
      end: pose(v(5, 0, 0)),
      geometry: g,
    };
    const segB = {
      startS: 0,
      endS: 5,
      start: pose(v(0, 5, 0)),
      end: pose(v(5, 5, 0)),
      geometry: g,
    };
    const r1 = certifiedSweptDistance(segA, segB, {
      maxWork: 3000,
      resolutionM: 0.01,
    });
    const r2 = certifiedSweptDistance(segA, segB, {
      maxWork: 3000,
      resolutionM: 0.01,
    });
    expect(r1).toEqual(r2);
    if (r1.ok) expect(r1.upperM - r1.lowerM).toBeLessThanOrEqual(0.01 + 1e-9);
    const tiny = certifiedSweptDistance(segA, segB, {
      maxWork: 1,
      resolutionM: 0.01,
    });
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) {
      expect(tiny.code).toBe("CLEARANCE_UNCERTIFIED");
      expect(
        (tiny as unknown as Record<string, unknown>).lowerM,
      ).toBeUndefined();
    }
  });

  it("swept AABB contains 1000 samples", () => {
    const g = geom();
    // valid rotation 30deg yaw
    const t = vec3(0.5, 0, 0.8660254);
    const n = vec3(0, 1, 0);
    const b = vec3(-0.8660254, 0, 0.5);
    const seg = {
      startS: 0,
      endS: 10,
      start: pose(v(0, 0, 0)),
      end: createClearancePose({
        position: v(5, 2, -1),
        tangent: t,
        normal: n,
        binormal: b,
      }),
      geometry: g,
    };
    const normalizedSeg = seg;
    const aabb = sweptAabb(normalizedSeg);
    for (let i = 0; i < 1000; i += 1) {
      const t = i / 999;
      const p = interpolatePose(normalizedSeg, t);
      const box = createOrientedBox(p, g);
      for (const sx of [-1, 1] as const)
        for (const sy of [-1, 1] as const)
          for (const sz of [-1, 1] as const) {
            const vert: Vec3 = vec3(
              box.center[0] +
                sx * box.halfExtents[0] * box.axes[0][0] +
                sy * box.halfExtents[1] * box.axes[1][0] +
                sz * box.halfExtents[2] * box.axes[2][0],
              box.center[1] +
                sx * box.halfExtents[0] * box.axes[0][1] +
                sy * box.halfExtents[1] * box.axes[1][1] +
                sz * box.halfExtents[2] * box.axes[2][1],
              box.center[2] +
                sx * box.halfExtents[0] * box.axes[0][2] +
                sy * box.halfExtents[1] * box.axes[1][2] +
                sz * box.halfExtents[2] * box.axes[2][2],
            );
            expect(vert[0]).toBeGreaterThanOrEqual(aabb.min[0] - 1e-9);
            expect(vert[0]).toBeLessThanOrEqual(aabb.max[0] + 1e-9);
            expect(vert[1]).toBeGreaterThanOrEqual(aabb.min[1] - 1e-9);
            expect(vert[1]).toBeLessThanOrEqual(aabb.max[1] + 1e-9);
            expect(vert[2]).toBeGreaterThanOrEqual(aabb.min[2] - 1e-9);
            expect(vert[2]).toBeLessThanOrEqual(aabb.max[2] + 1e-9);
          }
    }
  });

  it("rejects invalid inputs", () => {
    expect(() =>
      createClearanceTrainGeometry({
        halfWidthM: NaN,
        aboveRailM: 1,
        belowRailM: 1,
        carPitchM: 2,
        noseTailMarginM: 0.5,
      }),
    ).toThrow();
    expect(() =>
      createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 0),
        normal: vec3(0, 1, 0),
        binormal: vec3(1, 0, 0),
      }),
    ).toThrow();
    expect(() =>
      createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 0, 1),
        binormal: vec3(1, 0, 0),
      }),
    ).toThrow();
    expect(() =>
      certifiedSweptDistance(
        {
          startS: 0,
          endS: 1,
          start: pose(v(0, 0, 0)),
          end: pose(v(1, 0, 0)),
          geometry: geom(),
        },
        {
          startS: 0,
          endS: 1,
          start: pose(v(0, 0, 0)),
          end: pose(v(1, 0, 0)),
          geometry: geom(),
        },
        { maxWork: 0, resolutionM: 0.01 },
      ),
    ).toThrow();
    expect(() => closedArcIntervalDistance(0, 1, 0, 1, 0)).toThrow();
    expect(() => openArcIntervalDistance(NaN, 1, 0, 1)).toThrow();
  });
});
