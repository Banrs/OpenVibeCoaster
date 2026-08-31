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

// helper to get vertices of a box
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

describe("correction RED proof – must fail on 6648fec", () => {
  it("interior-skew and disjoint collinear parallel: edge pair vs vertex-only", () => {
    // disjoint collinear parallel: returns gap 2, defective returns 3
    const p0 = v(0, 0, 0);
    const p1 = v(1, 0, 0);
    const q0 = v(3, 0, 0);
    const q1 = v(4, 0, 0);
    const seg = segmentClosest(p0, p1, q0, q1);
    expect(seg.dist).toBeCloseTo(2, 6);
    expect(dist(seg.pa, seg.pb)).toBeCloseTo(seg.dist, 6);
    expect(seg.pa[0]).toBeCloseTo(1, 6);
    expect(seg.pb[0]).toBeCloseTo(3, 6);
    // degenerate: first segment point
    const dp0 = v(0, 0, 0);
    const dp1 = v(0, 0, 0);
    const dq0 = v(1, 0, 0);
    const dq1 = v(2, 0, 0);
    const seg2 = segmentClosest(dp0, dp1, dq0, dq1);
    expect(seg2.dist).toBeCloseTo(1, 6);
    // interior-skew: crossing interior points distance 1
    const s1p0 = v(0, 0, 0);
    const s1p1 = v(1, 0, 0);
    const s2q0 = v(0.5, 1, 1);
    const s2q1 = v(0.5, 1, -1);
    const seg3 = segmentClosest(s1p0, s1p1, s2q0, s2q1);
    expect(seg3.dist).toBeCloseTo(1, 6);
    expect(dist(seg3.pa, seg3.pb)).toBeCloseTo(seg3.dist, 6);
    // endpoint clamp case
    const sp0 = v(0, 0, 0);
    const sp1 = v(10, 0, 0);
    const sq0 = v(5, 1, 10);
    const sq1 = v(5, 1, 11);
    const seg4 = segmentClosest(sp0, sp1, sq0, sq1);
    expect(dist(seg4.pa, seg4.pb)).toBeCloseTo(seg4.dist, 6);
    // also verify OBB edge case still works
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
    // near-parallel: tiny angle 1e-7 rad, separation requires cross axis
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
    // Box A axis-aligned
    const a = createOrientedBox(pose(v(0, 0, 0)), g);
    // Box B rotated tiny angle around Z and separated along cross direction
    // Use tangent slightly rotated, N slightly rotated
    const bPose = createClearancePose({
      position: v(0, 2.1, 0), // just beyond gap
      tangent: vec3(s, 0, c),
      normal: vec3(0, 1, 0),
      binormal: vec3(-c, 0, s),
    });
    const b = createOrientedBox(bPose, g);
    const r = staticObbDistance(a, b);
    // They are separated: distance should be >0.5 (gap 2.1 -1 =1.1? Actually hy 0.5 each => gap 1.1)
    expect(r.distance).toBeGreaterThan(0.5);
    expect(dist(r.pointA, r.pointB)).toBeCloseTo(r.distance, 6);

    // intersecting boxes with no vertex inside: long rods crossing offset
    const gRod = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 4,
      noseTailMarginM: 0,
    });
    // Box A long along Z at origin
    const boxA = createOrientedBox(pose(v(0, 0, 0)), gRod);
    // Box B long along X at offset 0.5 in Z, same Y
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
    // witness must be coincident and distance between points ==0
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
    // off-midpoint collision: segA moves in X, segB moves in Y crossing at off-midpoint
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
    // Collision at u≈0.9, v≈0.5 off-midpoint (midpoint u=0.5 => x=5 vs 9 gap 4)
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 4000,
      resolutionM: 0.01,
    });
    expect(res.ok).toBe(true);
    if (res.ok && "lowerM" in res) {
      // dense oracle at collision
      const uCol = 0.9;
      const vCol = 0.5;
      const boxA = createOrientedBox(interpolatePose(segA, uCol), g);
      const boxB = createOrientedBox(interpolatePose(segB, vCol), g);
      const d = staticObbDistance(boxA, boxB).distance;
      expect(d).toBeCloseTo(0, 6);
      // certified interval must contain true minimum 0 and width <=0.01
      expect((res as unknown as { lowerM: number }).lowerM).toBeLessThanOrEqual(
        d + 1e-9,
      );
      expect(
        (res as unknown as { upperM: number }).upperM,
      ).toBeGreaterThanOrEqual(d - 1e-9);
      expect(
        (res as unknown as { upperM: number }).upperM -
          (res as unknown as { lowerM: number }).lowerM,
      ).toBeLessThanOrEqual(0.011);
      // midpoint distance alone would be ~3.2, not containing 0
      const midA = createOrientedBox(interpolatePose(segA, 0.5), g);
      const midB = createOrientedBox(interpolatePose(segB, 0.5), g);
      const midD = staticObbDistance(midA, midB).distance;
      expect(midD).toBeGreaterThan(2);
      // ensure cert lower is not equal to upper (forging)
      expect((res as unknown as { lowerM: number }).lowerM).not.toBeCloseTo(
        midD,
        6,
      );
    }

    // endpoint minimum: minimal gap at u=0,v=0
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
    expect(res2.ok).toBe(true);
    if (res2.ok && "lowerM" in res2) {
      // brute dense scan
      let best = Infinity;
      for (let i = 0; i <= 20; i++)
        for (let j = 0; j <= 20; j++) {
          const aa = createOrientedBox(interpolatePose(segC, i / 20), g);
          const bb = createOrientedBox(interpolatePose(segD, j / 20), g);
          best = Math.min(best, staticObbDistance(aa, bb).distance);
        }
      expect(
        (res2 as unknown as { lowerM: number }).lowerM,
      ).toBeLessThanOrEqual(best + 1e-9);
      expect(
        (res2 as unknown as { upperM: number }).upperM,
      ).toBeGreaterThanOrEqual(best - 1e-9);
    }
  });

  it(
    "dense oracle lies in [lower,upper] and width <=0.01 for moving/rotating cases",
    { timeout: 20000 },
    () => {
      const gSmall = createClearanceTrainGeometry({
        halfWidthM: 0.2,
        aboveRailM: 0.2,
        belowRailM: 0.2,
        carPitchM: 0.5,
        noseTailMarginM: 0,
      });
      const g = geom({
        halfWidthM: 0.5,
        aboveRailM: 0.5,
        belowRailM: 0.5,
        carPitchM: 1,
        noseTailMarginM: 0,
      });
      const cases: Array<
        [
          typeof g,
          ReturnType<typeof pose>,
          ReturnType<typeof pose>,
          ReturnType<typeof pose>,
          ReturnType<typeof pose>,
        ]
      > = [
        // case 1: translation only (small, honest)
        [
          gSmall,
          pose(v(0, 0, 0)),
          pose(v(0.05, 0, 0)),
          pose(v(0, 2, 0)),
          pose(v(0.05, 2, 0)),
        ],
        // case 2: 10-degree slerp (nontrivial >=5deg) with small translation, small radius
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
        // case 3: asymmetric rotating case with 5-degree slerp, small radius
        [
          createClearanceTrainGeometry({
            halfWidthM: 0.3,
            aboveRailM: 0.4,
            belowRailM: 0.2,
            carPitchM: 0.6,
            noseTailMarginM: 0,
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
      ];
      for (let idx = 0; idx < cases.length; idx++) {
        const [gg, sA0, sA1, sB0, sB1] = cases[idx]!;
        const segA = { startS: 0, endS: 1, start: sA0, end: sA1, geometry: gg };
        const segB = { startS: 0, endS: 1, start: sB0, end: sB1, geometry: gg };
        const res = certifiedSweptDistance(segA, segB, {
          maxWork: 10000,
          resolutionM: 0.01,
        });
        expect(res.ok).toBe(true);
        if (!res.ok || !("lowerM" in res)) continue;
        // dense oracle
        let best = Infinity;
        for (let i = 0; i <= 40; i++)
          for (let j = 0; j <= 40; j++) {
            const aa = createOrientedBox(interpolatePose(segA, i / 40), gg);
            const bb = createOrientedBox(interpolatePose(segB, j / 40), gg);
            best = Math.min(best, staticObbDistance(aa, bb).distance);
          }
        expect(best).toBeGreaterThanOrEqual(
          (res as unknown as { lowerM: number }).lowerM - 1e-9,
        );
        expect(best).toBeLessThanOrEqual(
          (res as unknown as { upperM: number }).upperM + 1e-9,
        );
        expect(
          (res as unknown as { upperM: number }).upperM -
            (res as unknown as { lowerM: number }).lowerM,
        ).toBeLessThanOrEqual(0.011);
        // witness must satisfy distance equality
        const r = res as unknown as {
          pointA: Vec3;
          pointB: Vec3;
          lowerM: number;
          upperM: number;
        };
        expect(dist(r.pointA, r.pointB)).toBeCloseTo(r.upperM, 6);
      }
    },
  );

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
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) {
      expect(tiny.code).toBe("CLEARANCE_UNCERTIFIED");
      expect(
        (tiny as unknown as Record<string, unknown>).lowerM,
      ).toBeUndefined();
      expect(
        (tiny as unknown as Record<string, unknown>).upperM,
      ).toBeUndefined();
      expect(
        (tiny as unknown as Record<string, unknown>).witnessU,
      ).toBeUndefined();
    }
    const tiny2 = certifiedSweptDistance(segA, segB, {
      maxWork: 2,
      resolutionM: 0.0005,
    });
    expect(tiny2.ok).toBe(false);
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
    // check that every vertex at any t is within bound of midpoint
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
    // swept AABB must contain all vertices
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
    // also check conservative radius correctness
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
    // wholly-local open: intervals overlapping => distance 0 <= locality
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
    expect(resLocal.ok).toBe(true);
    expect((resLocal as unknown as Record<string, unknown>).excluded).toBe(
      true,
    );

    // wholly-local closed
    const resLocalClosed = certifiedSweptDistance(segA1, segB1, {
      maxWork: 2000,
      resolutionM: 0.01,
      localityM: 5,
      closed: true,
      trackLengthM: 10,
    });
    expect(resLocalClosed.ok).toBe(true);
    expect(
      (resLocalClosed as unknown as Record<string, unknown>).excluded,
    ).toBe(true);

    // wholly-nonlocal: far apart arc distance > locality
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
    expect(resNonLocal.ok).toBe(true);
    expect(
      (resNonLocal as unknown as Record<string, unknown>).excluded,
    ).not.toBe(true);
    if (resNonLocal.ok && "lowerM" in resNonLocal) {
      expect((resNonLocal as unknown as Record<string, unknown>).excluded).toBe(
        false,
      );
    }

    // straddling domain still finds a nonlocal collision
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
      // B moves to cross A at off-midpoint but arc intervals straddle locality 2
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
    expect(resStraddle.ok).toBe(true);
    // Must be either excluded false with collision (distance ~0) or if wholly local would be excluded but this straddles so must find nonlocal
    if (resStraddle.ok && "lowerM" in resStraddle) {
      expect(
        (resStraddle as unknown as { upperM: number }).upperM,
      ).toBeLessThan(1);
    }
  });
});
