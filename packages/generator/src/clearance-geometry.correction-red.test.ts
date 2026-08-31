import { describe, expect, it } from "vitest";
import {
  certifiedSweptDistance,
  createClearancePose,
  createClearanceTrainGeometry,
  createOrientedBox,
  segmentClosest,
  staticObbDistance,
  sweptAabb,
  sweptMotionBound,
  interpolatePose,
  type CertifiedDistanceResult,
} from "./clearance-geometry";
import { vec3, type Vec3 } from "@openvibecoaster/core";

const v = (x: number, y: number, z: number): Vec3 => vec3(x, y, z);
const pose = (
  position: Vec3,
  tangent: Vec3 = vec3(0, 0, 1),
  normal: Vec3 = vec3(0, 1, 0),
  binormal: Vec3 = vec3(-1, 0, 0),
) => createClearancePose({ position, tangent, normal, binormal });
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

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function vertices(box: ReturnType<typeof createOrientedBox>): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      for (const sz of [-1, 1] as const)
        out.push(
          vec3(
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
          ),
        );
  return out;
}

function assertCertified(
  res: CertifiedDistanceResult,
): asserts res is Extract<
  CertifiedDistanceResult,
  { ok: true; excluded: false }
> {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("expected certified ok true");
  expect(res.excluded).toBe(false);
  if (res.excluded !== false) throw new Error("expected not excluded");
}

function assertUncertified(
  res: CertifiedDistanceResult,
): asserts res is Extract<CertifiedDistanceResult, { ok: false }> {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected uncertified");
}

function assertExcluded(
  res: CertifiedDistanceResult,
): asserts res is Extract<
  CertifiedDistanceResult,
  { ok: true; excluded: true }
> {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("expected ok");
  expect(res.excluded).toBe(true);
  if (!res.excluded) throw new Error("expected excluded");
}

describe("correction RED proof – must fail on 6648fec", () => {
  it("interior-skew and disjoint collinear parallel: edge pair vs vertex-only", () => {
    const p0 = v(0, 0, 0);
    const p1 = v(1, 0, 0);
    const q0 = v(3, 0, 0);
    const q1 = v(4, 0, 0);
    const seg = segmentClosest(p0, p1, q0, q1);
    expect(seg.dist).toBeCloseTo(2, 6);
    expect(dist(seg.pa, seg.pb)).toBeCloseTo(seg.dist, 6);
    expect(seg.pa[0]).toBeCloseTo(1, 6);
    expect(seg.pb[0]).toBeCloseTo(3, 6);
    const dp0 = v(0, 0, 0);
    const dp1 = v(0, 0, 0);
    const dq0 = v(1, 0, 0);
    const dq1 = v(2, 0, 0);
    const seg2 = segmentClosest(dp0, dp1, dq0, dq1);
    expect(seg2.dist).toBeCloseTo(1, 6);
    const s1p0 = v(0, 0, 0);
    const s1p1 = v(1, 0, 0);
    const s2q0 = v(0.5, 1, 1);
    const s2q1 = v(0.5, 1, -1);
    const seg3 = segmentClosest(s1p0, s1p1, s2q0, s2q1);
    expect(seg3.dist).toBeCloseTo(1, 6);
    expect(dist(seg3.pa, seg3.pb)).toBeCloseTo(seg3.dist, 6);
    const sp0 = v(0, 0, 0);
    const sp1 = v(10, 0, 0);
    const sq0 = v(5, 1, 10);
    const sq1 = v(5, 1, 11);
    const seg4 = segmentClosest(sp0, sp1, sq0, sq1);
    expect(dist(seg4.pa, seg4.pb)).toBeCloseTo(seg4.dist, 6);
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 2,
      noseTailMarginM: 0,
    });
    const a2 = createOrientedBox(pose(v(0, 0, 0)), g);
    const b2 = createOrientedBox(pose(v(4, 0, 0)), g);
    const r2 = staticObbDistance(a2, b2);
    expect(r2.distance).toBeCloseTo(3, 6);
    expect(dist(r2.pointA, r2.pointB)).toBeCloseTo(r2.distance, 6);
  });

  it("near-parallel boxes and intersecting boxes with coincident genuine witnesses", () => {
    const g = geom({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 0.5,
      noseTailMarginM: 0,
    });
    const ang = 5e-8;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    const bPose = createClearancePose({
      position: v(0, 2.1, 0),
      tangent: vec3(s, 0, c),
      normal: vec3(0, 1, 0),
      binormal: vec3(-c, 0, s),
    });
    const b = createOrientedBox(bPose, g);
    const r = staticObbDistance(a, b);
    expect(r.distance).toBeGreaterThan(0.5);
    expect(dist(r.pointA, r.pointB)).toBeCloseTo(r.distance, 6);
    const gRod = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 4,
      noseTailMarginM: 0,
    });
    const boxA = createOrientedBox(pose(v(0, 0, 0)), gRod);
    const boxB = createOrientedBox(
      createClearancePose({
        position: v(0, 0, 0.5),
        tangent: v(1, 0, 0),
        normal: v(0, 1, 0),
        binormal: v(0, 0, 1),
      }),
      gRod,
    );
    const ri = staticObbDistance(boxA, boxB);
    expect(ri.distance).toBeCloseTo(0, 9);
    expect(dist(ri.pointA, ri.pointB)).toBeCloseTo(0, 6);
    expect(ri.pointA[0]).toBeCloseTo(ri.pointB[0], 6);
    expect(ri.pointA[1]).toBeCloseTo(ri.pointB[1], 6);
    expect(ri.pointA[2]).toBeCloseTo(ri.pointB[2], 6);
  });

  it("off-midpoint product-domain collision plus endpoint minimum", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.4,
      aboveRailM: 0.4,
      belowRailM: 0.4,
      carPitchM: 1,
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
      start: pose(v(9, -5, 0)),
      end: pose(v(9, 5, 0)),
      geometry: g,
    };
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 4000,
      resolutionM: 0.01,
    });
    assertCertified(res);
    const uCol = 0.9;
    const vCol = 0.5;
    const boxA = createOrientedBox(interpolatePose(segA, uCol), g);
    const boxB = createOrientedBox(interpolatePose(segB, vCol), g);
    const d = staticObbDistance(boxA, boxB).distance;
    expect(d).toBeCloseTo(0, 6);
    expect(res.lowerM).toBeLessThanOrEqual(d + 1e-9);
    expect(res.upperM).toBeGreaterThanOrEqual(d - 1e-9);
    expect(res.upperM - res.lowerM).toBeLessThanOrEqual(0.01);
    const midA = createOrientedBox(interpolatePose(segA, 0.5), g);
    const midB = createOrientedBox(interpolatePose(segB, 0.5), g);
    const midD = staticObbDistance(midA, midB).distance;
    expect(midD).toBeGreaterThan(2);
    expect(res.lowerM).not.toBeCloseTo(midD, 6);

    const segC = {
      startS: 0,
      endS: 10,
      start: pose(v(0, 0, 0)),
      end: pose(v(10, 0, 0)),
      geometry: g,
    };
    const segD = {
      startS: 0,
      endS: 10,
      start: pose(v(0, 2, 0)),
      end: pose(v(10, 5, 0)),
      geometry: g,
    };
    const res2 = certifiedSweptDistance(segC, segD, {
      maxWork: 4000,
      resolutionM: 0.01,
    });
    assertCertified(res2);
    let best = Infinity;
    for (let i = 0; i <= 20; i++)
      for (let j = 0; j <= 20; j++) {
        const aa = createOrientedBox(interpolatePose(segC, i / 20), g);
        const bb = createOrientedBox(interpolatePose(segD, j / 20), g);
        best = Math.min(best, staticObbDistance(aa, bb).distance);
      }
    expect(res2.lowerM).toBeLessThanOrEqual(best + 1e-9);
    expect(res2.upperM).toBeGreaterThanOrEqual(best - 1e-9);
  });

  it("dense oracle lies in [lower,upper] and width <=0.01 for moving/rotating cases", () => {
    const gSmall = createClearanceTrainGeometry({
      halfWidthM: 0.2,
      aboveRailM: 0.2,
      belowRailM: 0.2,
      carPitchM: 0.5,
      noseTailMarginM: 0,
    });
    const cases = [
      [
        gSmall,
        pose(v(0, 0, 0)),
        createClearancePose({
          position: v(0.05, 0, 0),
          tangent: vec3(0.984807753012208, 0, 0.17364817766693033),
          normal: vec3(0, 1, 0),
          binormal: vec3(-0.17364817766693033, 0, 0.984807753012208),
        }),
        pose(v(0, 2, 0)),
        createClearancePose({
          position: v(0.05, 2, 0),
          tangent: vec3(0.984807753012208, 0, 0.17364817766693033),
          normal: vec3(0, 1, 0),
          binormal: vec3(-0.17364817766693033, 0, 0.984807753012208),
        }),
      ],
      [
        createClearanceTrainGeometry({
          halfWidthM: 0.5,
          aboveRailM: 1,
          belowRailM: 0.3,
          carPitchM: 1,
          noseTailMarginM: 0.1,
        }),
        createClearancePose({
          position: v(0, 0, 0),
          tangent: vec3(0, 0, 1),
          normal: vec3(0, 1, 0),
          binormal: vec3(-1, 0, 0),
        }),
        createClearancePose({
          position: v(0.05, 0, 0),
          tangent: vec3(0, 0, 1),
          normal: vec3(0.9961946980917455, 0.08715574274765817, 0),
          binormal: vec3(-0.08715574274765817, 0.9961946980917455, 0),
        }),
        pose(v(2, 0, 0)),
        pose(v(2.05, 0, 0)),
      ],
    ] as const;
    for (let idx = 0; idx < cases.length; idx++) {
      const [gg, sA0, sA1, sB0, sB1] = cases[idx]!;
      const segA = { startS: 0, endS: 1, start: sA0, end: sA1, geometry: gg };
      const segB = { startS: 0, endS: 1, start: sB0, end: sB1, geometry: gg };
      const res = certifiedSweptDistance(segA, segB, {
        maxWork: 10000,
        resolutionM: 0.01,
      });
      assertCertified(res);
      let best = Infinity;
      for (let i = 0; i <= 15; i++)
        for (let j = 0; j <= 15; j++) {
          const aa = createOrientedBox(interpolatePose(segA, i / 15), gg);
          const bb = createOrientedBox(interpolatePose(segB, j / 15), gg);
          best = Math.min(best, staticObbDistance(aa, bb).distance);
        }
      expect(best).toBeGreaterThanOrEqual(res.lowerM - 1e-9);
      expect(best).toBeLessThanOrEqual(res.upperM + 1e-9);
      expect(res.upperM - res.lowerM).toBeLessThanOrEqual(0.01);
      expect(dist(res.pointA, res.pointB)).toBeCloseTo(res.upperM, 6);
    }
  });

  it("too-small budget returns uncertified without numeric bounds", () => {
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
    const tiny = certifiedSweptDistance(segA, segB, {
      maxWork: 1,
      resolutionM: 0.001,
    });
    assertUncertified(tiny);
    expect(tiny.code).toBe("CLEARANCE_UNCERTIFIED");
    expect("lowerM" in tiny).toBe(false);
    expect("upperM" in tiny).toBe(false);
    expect("witnessU" in tiny).toBe(false);
    const tiny2 = certifiedSweptDistance(segA, segB, {
      maxWork: 2,
      resolutionM: 0.0005,
    });
    assertUncertified(tiny2);
  });

  it("deterministic repeat equality", () => {
    const g = geom();
    const segA = {
      startS: 0,
      endS: 1,
      start: pose(v(0, 0, 0)),
      end: createClearancePose({
        position: v(1, 0, 0),
        tangent: v(0.7071067811865475, 0, 0.7071067811865475),
        normal: v(0, 1, 0),
        binormal: v(-0.7071067811865475, 0, 0.7071067811865475),
      }),
      geometry: g,
    };
    const segB = {
      startS: 0,
      endS: 1,
      start: pose(v(0, 2, 0)),
      end: createClearancePose({
        position: v(1, 2, 0),
        tangent: v(0.7071067811865475, 0, 0.7071067811865475),
        normal: v(0, 1, 0),
        binormal: v(-0.7071067811865475, 0, 0.7071067811865475),
      }),
      geometry: g,
    };
    const r1 = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    const r2 = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    expect(r1).toEqual(r2);
  });

  it("dense vertices of asymmetric rotating box remain inside motion bound and swept AABB", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.8,
      aboveRailM: 2,
      belowRailM: 0.4,
      carPitchM: 1.5,
      noseTailMarginM: 0.3,
    });
    const start = createClearancePose({
      position: v(0, 0, 0),
      tangent: v(0, 0, 1),
      normal: v(0, 1, 0),
      binormal: v(-1, 0, 0),
    });
    const end = createClearancePose({
      position: v(3, 0, 0),
      tangent: v(0, 0, 1),
      normal: vec3(0.540302, 0.841471, 0),
      binormal: vec3(-0.841471, 0.540302, 0),
    });
    const seg = { startS: 0, endS: 1, start, end, geometry: g };
    const bound = sweptMotionBound(seg, 0, 1);
    expect(bound).toBeGreaterThan(0);
    const mid = interpolatePose(seg, 0.5);
    const midBox = createOrientedBox(mid, g);
    const midVerts = vertices(midBox);
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const p = interpolatePose(seg, t);
      const box = createOrientedBox(p, g);
      const vs = vertices(box);
      for (let k = 0; k < vs.length; k++) {
        const d = dist(vs[k]!, midVerts[k]!);
        expect(d).toBeLessThanOrEqual(bound + 1e-9);
      }
    }
    const aabb = sweptAabb(seg);
    for (let i = 0; i < 100; i++) {
      const t = i / 99;
      const p = interpolatePose(seg, t);
      const box = createOrientedBox(p, g);
      for (const vv of vertices(box)) {
        expect(vv[0]).toBeGreaterThanOrEqual(aabb.min[0] - 1e-9);
        expect(vv[0]).toBeLessThanOrEqual(aabb.max[0] + 1e-9);
        expect(vv[1]).toBeGreaterThanOrEqual(aabb.min[1] - 1e-9);
        expect(vv[1]).toBeLessThanOrEqual(aabb.max[1] + 1e-9);
        expect(vv[2]).toBeGreaterThanOrEqual(aabb.min[2] - 1e-9);
        expect(vv[2]).toBeLessThanOrEqual(aabb.max[2] + 1e-9);
      }
    }
    const hx = g.halfWidthM,
      maxY = Math.max(g.aboveRailM, g.belowRailM),
      hz = g.carPitchM / 2 + g.noseTailMarginM;
    const r = Math.sqrt(hx * hx + maxY * maxY + hz * hz);
    const expectedMin = Math.sqrt(
      hx * hx + ((g.aboveRailM + g.belowRailM) / 2) ** 2 + hz * hz,
    );
    expect(r).toBeGreaterThan(expectedMin);
  });

  it("wholly-local open/closed roots return excluded, wholly-nonlocal checked, straddling finds nonlocal collision", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.4,
      aboveRailM: 0.4,
      belowRailM: 0.4,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const segA1 = {
      startS: 0,
      endS: 2,
      start: pose(v(0, 0, 0)),
      end: pose(v(2, 0, 0)),
      geometry: g,
    };
    const segB1 = {
      startS: 1,
      endS: 3,
      start: pose(v(1, 0, 0)),
      end: pose(v(3, 0, 0)),
      geometry: g,
    };
    const resLocal = certifiedSweptDistance(segA1, segB1, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 5,
      closed: false,
    });
    assertExcluded(resLocal);
    const resLocalClosed = certifiedSweptDistance(segA1, segB1, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 5,
      closed: true,
      trackLengthM: 10,
    });
    assertExcluded(resLocalClosed);
    const segA2 = {
      startS: 0,
      endS: 1,
      start: pose(v(0, 0, 0)),
      end: pose(v(1, 0, 0)),
      geometry: g,
    };
    const segB2 = {
      startS: 10,
      endS: 11,
      start: pose(v(10, 5, 0)),
      end: pose(v(11, 5, 0)),
      geometry: g,
    };
    const resNonLocal = certifiedSweptDistance(segA2, segB2, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 1,
      closed: false,
    });
    assertCertified(resNonLocal);
    const segA3 = {
      startS: 0,
      endS: 5,
      start: pose(v(0, 0, 0)),
      end: pose(v(5, 0, 0)),
      geometry: g,
    };
    const segB3 = {
      startS: 4,
      endS: 9,
      start: pose(v(4.5, 0.6, 0)),
      end: pose(v(8, 0.6, 0)),
      geometry: g,
    };
    const resStraddle = certifiedSweptDistance(segA3, segB3, {
      maxWork: 5000,
      resolutionM: 0.01,
      localityM: 2,
      closed: false,
    });
    assertCertified(resStraddle);
    expect(resStraddle.upperM).toBeLessThan(1);
  });
});
