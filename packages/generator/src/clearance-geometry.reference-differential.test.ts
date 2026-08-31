import { describe, expect, it } from "vitest";
import {
  certifiedSweptDistance,
  createClearancePose,
  createClearanceTrainGeometry,
  createOrientedBox,
  segmentClosest,
  staticObbDistance,
  type OrientedBox,
  type SweptClearanceSegment,
  type ClearancePose,
} from "./clearance-geometry";
import { nextDown, nextUp } from "./polynomial-bounds";
import { vec3, type Vec3 } from "@openvibecoaster/core";

// ─────────────────────────────────────────────────────────────────────────────
// Literal reference copy of pre-optimization closest-feature / static OBB
// behavior. Copied verbatim from packages/generator/src/clearance-geometry.ts
// at base 1fc0353 so differential tests fail if any arithmetic, candidate
// order, branch or tolerance diverges. This block must stay independent of the
// optimized implementation above.
// ─────────────────────────────────────────────────────────────────────────────
function refDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function refCross(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}
function refSub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function refAdd(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}
function refScale(a: Vec3, s: number): Vec3 {
  return vec3(a[0] * s, a[1] * s, a[2] * s);
}
function refLen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
type RefInterval = { lo: number; hi: number };
function refIntervalDot(a: Vec3, b: Vec3): RefInterval {
  const p0lo = nextDown(a[0]! * b[0]!);
  const p0hi = nextUp(a[0]! * b[0]!);
  const p1lo = nextDown(a[1]! * b[1]!);
  const p1hi = nextUp(a[1]! * b[1]!);
  const p2lo = nextDown(a[2]! * b[2]!);
  const p2hi = nextUp(a[2]! * b[2]!);
  const lo = nextDown(nextDown(p0lo + p1lo) + p2lo);
  const hi = nextUp(nextUp(p0hi + p1hi) + p2hi);
  return { lo, hi };
}
function refIntervalAbs(iv: RefInterval): RefInterval {
  if (iv.lo >= 0) return { lo: nextDown(iv.lo), hi: nextUp(iv.hi) };
  if (iv.hi <= 0) return { lo: nextDown(-iv.hi), hi: nextUp(-iv.lo) };
  const hi = Math.max(-iv.lo, iv.hi);
  return { lo: 0, hi: nextUp(hi) };
}
function refGetVertices(box: OrientedBox): Vec3[] {
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
function refPointToBoxClosest(p: Vec3, box: OrientedBox): Vec3 {
  const d = refSub(p, box.center);
  let r = vec3(box.center[0], box.center[1], box.center[2]);
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!,
      proj = refDot(d, ax),
      c = Math.max(-box.halfExtents[i]!, Math.min(box.halfExtents[i]!, proj));
    r = refAdd(r, refScale(ax, c));
  }
  return r;
}
function refPointInBox(p: Vec3, box: OrientedBox): boolean {
  const d = refSub(p, box.center);
  for (let i = 0; i < 3; i += 1) {
    const iv = refIntervalDot(d, box.axes[i]!);
    const absIv = refIntervalAbs(iv);
    const h = box.halfExtents[i]!;
    if (absIv.hi <= nextUp(h)) continue;
    if (absIv.lo > nextUp(h)) return false;
    return false;
  }
  return true;
}
function refSegmentObbIntersect(
  p0: Vec3,
  p1: Vec3,
  box: OrientedBox,
): Vec3 | null {
  const dir = refSub(p1, p0);
  const diff = refSub(p0, box.center);
  let tMin = 0;
  let tMax = 1;
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!;
    const eIv = refIntervalDot(diff, ax);
    const fIv = refIntervalDot(dir, ax);
    const h = box.halfExtents[i]!;
    if (fIv.lo <= 0 && fIv.hi >= 0) {
      if (eIv.hi < nextDown(-h) || eIv.lo > nextUp(h)) return null;
      if (eIv.lo < nextDown(-h) || eIv.hi > nextUp(h)) return null;
      continue;
    }
    const f = refDot(dir, ax);
    const e = refDot(diff, ax);
    if (Math.abs(f) < 1e-12) {
      if (e < -h || e > h) return null;
      continue;
    }
    let t1 = (-h - e) / f;
    let t2 = (h - e) / f;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = nextDown(t1) > tMin ? nextDown(t1) : tMin;
    if (t2 < tMax) tMax = nextUp(t2) < tMax ? nextUp(t2) : tMax;
    if (tMin > tMax) return null;
  }
  if (tMin < 0 || tMin > 1) {
    if (tMin < 0) {
      if (0 > tMax) return null;
      tMin = 0;
    } else return null;
  }
  if (tMin > tMax) return null;
  return refAdd(p0, refScale(dir, tMin));
}
function refGetEdges(box: OrientedBox): Array<[Vec3, Vec3]> {
  const edges: Array<[Vec3, Vec3]> = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const others = [0, 1, 2].filter((v) => v !== axis);
    const o0 = others[0]!,
      o1 = others[1]!;
    for (const s0 of [-1, 1] as const)
      for (const s1 of [-1, 1] as const) {
        const p0 = refAdd(
          refAdd(
            box.center,
            refScale(box.axes[o0]!, s0 * box.halfExtents[o0]!),
          ),
          refScale(box.axes[o1]!, s1 * box.halfExtents[o1]!),
        );
        edges.push([
          refAdd(p0, refScale(box.axes[axis]!, -box.halfExtents[axis]!)),
          refAdd(p0, refScale(box.axes[axis]!, box.halfExtents[axis]!)),
        ]);
      }
  }
  return edges;
}
export function refSegmentClosest(
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3,
): { pa: Vec3; pb: Vec3; dist: number } {
  const u = refSub(p1, p0);
  const v = refSub(q1, q0);
  const w = refSub(p0, q0);
  const a = refDot(u, u);
  const b = refDot(u, v);
  const c = refDot(v, v);
  const d = refDot(u, w);
  const e = refDot(v, w);
  const EPS_D = 1e-12;
  let s: number;
  let t: number;
  if (a <= EPS_D && c <= EPS_D) {
    s = 0;
    t = 0;
  } else if (a <= EPS_D) {
    s = 0;
    t = c === 0 ? 0 : Math.max(0, Math.min(1, e / c));
  } else if (c <= EPS_D) {
    t = 0;
    s = Math.max(0, Math.min(1, -d / a));
  } else {
    const denom = a * c - b * b;
    if (denom !== 0) s = Math.max(0, Math.min(1, (b * e - c * d) / denom));
    else s = 0;
    t = (b * s + e) / c;
    if (t < 0) {
      t = 0;
      s = Math.max(0, Math.min(1, -d / a));
    } else if (t > 1) {
      t = 1;
      s = Math.max(0, Math.min(1, (b - d) / a));
    }
  }
  const pa = refAdd(p0, refScale(u, s));
  const pb = refAdd(q0, refScale(v, t));
  return { pa, pb, dist: refLen(refSub(pa, pb)) };
}
function refClosestFeature(
  a: OrientedBox,
  b: OrientedBox,
): { dist: number; pa: Vec3; pb: Vec3 } {
  let bestDist = Infinity;
  let bestA: Vec3 = a.center;
  let bestB: Vec3 = b.center;
  const vertsA = refGetVertices(a);
  const vertsB = refGetVertices(b);
  for (const va of vertsA) {
    const cb = refPointToBoxClosest(va, b);
    const raw = refLen(refSub(va, cb));
    if (raw < bestDist) {
      bestDist = raw;
      bestA = va;
      bestB = cb;
    }
  }
  for (const vb of vertsB) {
    const ca = refPointToBoxClosest(vb, a);
    const raw = refLen(refSub(vb, ca));
    if (raw < bestDist) {
      bestDist = raw;
      bestA = ca;
      bestB = vb;
    }
  }
  const edgesA = refGetEdges(a);
  const edgesB = refGetEdges(b);
  for (const [p0, p1] of edgesA)
    for (const [q0, q1] of edgesB) {
      const seg = refSegmentClosest(p0, p1, q0, q1);
      if (seg.dist < bestDist) {
        bestDist = seg.dist;
        bestA = seg.pa;
        bestB = seg.pb;
      }
    }
  return { dist: bestDist, pa: bestA, pb: bestB };
}
function refStaticObbDistance(
  a: OrientedBox,
  b: OrientedBox,
): { distance: number; pointA: Vec3; pointB: Vec3 } {
  for (const box of [a, b] as const) {
    if (!Array.isArray(box.center) || box.center.length !== 3)
      throw new RangeError("center must be Vec3");
    for (let i = 0; i < 3; i += 1) {
      if (!Number.isFinite(box.halfExtents[i]!))
        throw new RangeError("halfExtent must be finite");
      if (box.halfExtents[i]! < 0)
        throw new RangeError("halfExtent must be non-negative");
      if (!Array.isArray(box.axes[i]!) || box.axes[i]!.length !== 3)
        throw new RangeError("axis must be Vec3");
      if (Math.abs(refLen(box.axes[i]!) - 1) > 1e-5)
        throw new RangeError("axis must be unit");
    }
  }
  const axes: Vec3[] = [];
  for (let i = 0; i < 3; i += 1) axes.push(a.axes[i]!);
  for (let i = 0; i < 3; i += 1) axes.push(b.axes[i]!);
  for (let i = 0; i < 3; i += 1)
    for (let j = 0; j < 3; j += 1) {
      const cc = refCross(a.axes[i]!, b.axes[j]!);
      const l2 = refDot(cc, cc);
      if (l2 === 0) continue;
      axes.push(refScale(cc, 1 / Math.sqrt(l2)));
    }
  const delta = refSub(b.center, a.center);
  let separatedProven = false;
  let intersectingProven = true;
  for (const ax of axes) {
    const l = refLen(ax);
    if (l === 0) continue;
    const n = refScale(ax, 1 / l);
    const dotDeltaIv = refIntervalDot(delta, n);
    const absDotDelta = refIntervalAbs(dotDeltaIv);
    let ra: RefInterval = { lo: 0, hi: 0 };
    let rb: RefInterval = { lo: 0, hi: 0 };
    for (let i = 0; i < 3; i += 1) {
      const dotA = refIntervalDot(n, a.axes[i]!);
      const absDotA = refIntervalAbs(dotA);
      const termAlo = nextDown(a.halfExtents[i]! * absDotA.lo);
      const termAhi = nextUp(a.halfExtents[i]! * absDotA.hi);
      ra = { lo: nextDown(ra.lo + termAlo), hi: nextUp(ra.hi + termAhi) };
      const dotB = refIntervalDot(n, b.axes[i]!);
      const absDotB = refIntervalAbs(dotB);
      const termBlo = nextDown(b.halfExtents[i]! * absDotB.lo);
      const termBhi = nextUp(b.halfExtents[i]! * absDotB.hi);
      rb = { lo: nextDown(rb.lo + termBlo), hi: nextUp(rb.hi + termBhi) };
    }
    const sumLo = nextDown(ra.lo + rb.lo);
    const sumHi = nextUp(ra.hi + rb.hi);
    if (absDotDelta.lo > sumHi) {
      separatedProven = true;
      break;
    }
    if (absDotDelta.hi < sumLo) continue;
    intersectingProven = false;
  }
  if (separatedProven) {
    const cf = refClosestFeature(a, b);
    return { distance: cf.dist, pointA: cf.pa, pointB: cf.pb };
  }
  const vertsA = refGetVertices(a);
  for (const va of vertsA)
    if (refPointInBox(va, b)) return { distance: 0, pointA: va, pointB: va };
  const vertsB = refGetVertices(b);
  for (const vb of vertsB)
    if (refPointInBox(vb, a)) return { distance: 0, pointA: vb, pointB: vb };
  const edgesA = refGetEdges(a);
  for (const [p0, p1] of edgesA) {
    const ip = refSegmentObbIntersect(p0, p1, b);
    if (ip && refPointInBox(ip, a) && refPointInBox(ip, b))
      return { distance: 0, pointA: ip, pointB: ip };
  }
  const edgesB = refGetEdges(b);
  for (const [q0, q1] of edgesB) {
    const ip = refSegmentObbIntersect(q0, q1, a);
    if (ip && refPointInBox(ip, a) && refPointInBox(ip, b))
      return { distance: 0, pointA: ip, pointB: ip };
  }
  if (refPointInBox(a.center, b) && refPointInBox(a.center, a))
    return { distance: 0, pointA: a.center, pointB: a.center };
  if (refPointInBox(b.center, a) && refPointInBox(b.center, b))
    return { distance: 0, pointA: b.center, pointB: b.center };
  if (!intersectingProven) throw new RangeError("SAT ambiguous");
  throw new RangeError("SAT intersect but no witness");
}
// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────
const v = (x: number, y: number, z: number): Vec3 => vec3(x, y, z);

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitQuat(rng: () => number): [number, number, number, number] {
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  const sq1 = Math.sqrt(1 - u1);
  const sq2 = Math.sqrt(u1);
  const t1 = 2 * Math.PI * u2;
  const t2 = 2 * Math.PI * u3;
  return [
    sq1 * Math.sin(t1),
    sq1 * Math.cos(t1),
    sq2 * Math.sin(t2),
    sq2 * Math.cos(t2),
  ];
}

function quatToFrame(q: [number, number, number, number]): {
  t: Vec3;
  n: Vec3;
  b: Vec3;
} {
  const x = q[0],
    y = q[1],
    z = q[2],
    w = q[3];
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  return {
    t: vec3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)),
    n: vec3(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)),
    b: vec3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)),
  };
}

function randomPose(rng: () => number, scale: number): ClearancePose {
  const q = randomUnitQuat(rng);
  const f = quatToFrame(q);
  const pos = vec3(
    (rng() - 0.5) * scale,
    (rng() - 0.5) * scale,
    (rng() - 0.5) * scale,
  );
  return createClearancePose({
    position: pos,
    tangent: f.t,
    normal: f.n,
    binormal: f.b,
  });
}

function randomGeometry(
  rng: () => number,
): ReturnType<typeof createClearanceTrainGeometry> {
  return createClearanceTrainGeometry({
    halfWidthM: 0.2 + rng() * 1.5,
    aboveRailM: rng() * 1.2,
    belowRailM: rng() * 1.2,
    carPitchM: 0.5 + rng() * 3,
    noseTailMarginM: rng() * 0.5,
  });
}

function applyRigidToPose(
  pose: ClearancePose,
  translate: Vec3,
  rotate: (p: Vec3) => Vec3,
): ClearancePose {
  return createClearancePose({
    position: vec3(
      rotate(pose.position)[0] + translate[0],
      rotate(pose.position)[1] + translate[1],
      rotate(pose.position)[2] + translate[2],
    ),
    tangent: rotate(pose.tangent),
    normal: rotate(pose.normal),
    binormal: rotate(pose.binormal),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("differential – staticObbDistance reference vs current", () => {
  it("deterministic 200 exact distance+witness vs literal reference", () => {
    const rng = mulberry32(0x1a2b3c4d);
    let mismatched = 0;
    for (let i = 0; i < 200; i += 1) {
      const poseA = randomPose(rng, 20);
      const poseB = randomPose(rng, 20);
      const gA = randomGeometry(rng);
      const gB = randomGeometry(rng);
      const boxA = createOrientedBox(poseA, gA);
      const boxB = createOrientedBox(poseB, gB);
      let cur: ReturnType<typeof staticObbDistance> | null = null;
      let ref: ReturnType<typeof refStaticObbDistance> | null = null;
      let curErr: unknown = null;
      let refErr: unknown = null;
      try {
        cur = staticObbDistance(boxA, boxB);
      } catch (e) {
        curErr = e;
      }
      try {
        ref = refStaticObbDistance(boxA, boxB);
      } catch (e) {
        refErr = e;
      }
      if (curErr || refErr) {
        expect(String(curErr)).toBe(String(refErr));
        continue;
      }
      const c = cur!;
      const r = ref!;
      if (
        !Object.is(c.distance, r.distance) ||
        c.pointA[0] !== r.pointA[0] ||
        c.pointA[1] !== r.pointA[1] ||
        c.pointA[2] !== r.pointA[2] ||
        c.pointB[0] !== r.pointB[0] ||
        c.pointB[1] !== r.pointB[1] ||
        c.pointB[2] !== r.pointB[2]
      )
        mismatched += 1;
      expect(Object.is(c.distance, r.distance)).toBe(true);
      expect(c.pointA[0]).toBe(r.pointA[0]);
      expect(c.pointA[1]).toBe(r.pointA[1]);
      expect(c.pointA[2]).toBe(r.pointA[2]);
      expect(c.pointB[0]).toBe(r.pointB[0]);
      expect(c.pointB[1]).toBe(r.pointB[1]);
      expect(c.pointB[2]).toBe(r.pointB[2]);
    }
    expect(mismatched).toBe(0);
  });

  it("degenerate and near-tie boxes", () => {
    const gThin = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.01,
      belowRailM: 0.01,
      carPitchM: 0.01,
      noseTailMarginM: 0,
    });
    const basePose = createClearancePose({
      position: v(0, 0, 0),
      tangent: v(0, 0, 1),
      normal: v(0, 1, 0),
      binormal: v(-1, 0, 0),
    });
    const cases: Array<[OrientedBox, OrientedBox]> = [];
    cases.push([
      createOrientedBox(basePose, gThin),
      createOrientedBox(
        createClearancePose({
          position: v(0, 0.5, 0),
          tangent: v(0, 0, 1),
          normal: v(0, 1, 0),
          binormal: v(-1, 0, 0),
        }),
        gThin,
      ),
    ]);
    const gCube = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 0.5,
      noseTailMarginM: 0,
    });
    const pA = createOrientedBox(basePose, gCube);
    const pB = createOrientedBox(
      createClearancePose({
        position: v(1.0000001, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      gCube,
    );
    cases.push([pA, pB]);
    const ang = 5e-8;
    const c = Math.cos(ang),
      s = Math.sin(ang);
    const bPar = createOrientedBox(
      createClearancePose({
        position: v(0, 2.1, 0),
        tangent: vec3(s, 0, c),
        normal: vec3(0, 1, 0),
        binormal: vec3(-c, 0, s),
      }),
      gCube,
    );
    cases.push([pA, bPar]);
    for (const [a, b] of cases) {
      let cur: ReturnType<typeof staticObbDistance> | null = null;
      let ref: ReturnType<typeof refStaticObbDistance> | null = null;
      let ce: unknown = null,
        re: unknown = null;
      try {
        cur = staticObbDistance(a, b);
      } catch (e) {
        ce = e;
      }
      try {
        ref = refStaticObbDistance(a, b);
      } catch (e) {
        re = e;
      }
      expect(String(ce)).toBe(String(re));
      if (cur && ref) {
        expect(Object.is(cur.distance, ref.distance)).toBe(true);
        expect(cur.pointA).toEqual(ref.pointA);
        expect(cur.pointB).toEqual(ref.pointB);
      }
    }
    const gap = 5e-10;
    const gGap = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const boxA2 = createOrientedBox(basePose, gGap);
    const boxB2 = createOrientedBox(
      createClearancePose({
        position: v(1 + gap, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      gGap,
    );
    const curGap = staticObbDistance(boxA2, boxB2);
    const refGap = refStaticObbDistance(boxA2, boxB2);
    expect(Object.is(curGap.distance, refGap.distance)).toBe(true);
    expect(curGap.distance).toBeGreaterThan(0);
  });

  it("rigid-translated stationary pairs produce overlapping certified intervals", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const segA: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const segB: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(2, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(2, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const base = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    expect(base.ok).toBe(true);
    if (!base.ok || base.excluded) throw new Error("base must be certified");
    const translate = v(1e4, -2e3, 3e3);
    const tSegA: SweptClearanceSegment = {
      startS: segA.startS,
      endS: segA.endS,
      start: applyRigidToPose(segA.start, translate, (p) => p),
      end: applyRigidToPose(segA.end, translate, (p) => p),
      geometry: g,
    };
    const tSegB: SweptClearanceSegment = {
      startS: segB.startS,
      endS: segB.endS,
      start: applyRigidToPose(segB.start, translate, (p) => p),
      end: applyRigidToPose(segB.end, translate, (p) => p),
      geometry: g,
    };
    const trans = certifiedSweptDistance(tSegA, tSegB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    expect(trans.ok).toBe(true);
    if (!trans.ok || trans.excluded) throw new Error("trans must be certified");
    const lo = Math.max(base.lowerM, trans.lowerM);
    const hi = Math.min(base.upperM, trans.upperM);
    expect(lo).toBeLessThanOrEqual(hi + 1e-12);
    expect(trans.lowerM).toBeCloseTo(base.lowerM, 9);
    expect(trans.upperM).toBeCloseTo(base.upperM, 9);
  });
});

describe("public API immutability – frozen vectors and mutation resistance", () => {
  it("createOrientedBox and segmentClosest are frozen", () => {
    const pose = createClearancePose({
      position: v(1, 2, 3),
      tangent: v(0, 0, 1),
      normal: v(0, 1, 0),
      binormal: v(-1, 0, 0),
    });
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const box = createOrientedBox(pose, g);
    expect(Object.isFrozen(box)).toBe(true);
    expect(Object.isFrozen(box.center)).toBe(true);
    expect(Object.isFrozen(box.axes)).toBe(true);
    expect(Object.isFrozen(box.axes[0])).toBe(true);
    expect(() => {
      (box.center as unknown as number[])[0] = 999;
    }).toThrow();
    const res = segmentClosest(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(1, 1, 0));
    expect(Object.isFrozen(res.pa)).toBe(true);
    expect(Object.isFrozen(res.pb)).toBe(true);
    expect(() => {
      (res.pa as unknown as number[])[0] = 999;
    }).toThrow();
  });
  it("staticObbDistance and certifiedSweptDistance points are frozen", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const a = createOrientedBox(
      createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      g,
    );
    const b = createOrientedBox(
      createClearancePose({
        position: v(3, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      g,
    );
    const r = staticObbDistance(a, b);
    expect(Object.isFrozen(r.pointA)).toBe(true);
    expect(Object.isFrozen(r.pointB)).toBe(true);
    expect(() => {
      (r.pointA as unknown as number[])[0] = 999;
    }).toThrow();
    const segA: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(0.01, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const segB: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(0, 2, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(0.01, 2, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.excluded) throw new Error("expected certified");
    expect(Object.isFrozen(res.pointA)).toBe(true);
    expect(Object.isFrozen(res.pointB)).toBe(true);
    expect(() => {
      (res.pointA as unknown as number[])[0] = 999;
    }).toThrow();
  });
});

describe("structural – single OBB core and freeze boundaries", () => {
  it("public API freezes, hot path uses shared core without per-node freeze", () => {
    const g = createClearanceTrainGeometry({
      halfWidthM: 0.5,
      aboveRailM: 0.5,
      belowRailM: 0.5,
      carPitchM: 1,
      noseTailMarginM: 0,
    });
    const a = createOrientedBox(
      createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      g,
    );
    const b = createOrientedBox(
      createClearancePose({
        position: v(3, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      g,
    );
    const first = staticObbDistance(a, b);
    const second = staticObbDistance(a, b);
    expect(Object.isFrozen(first.pointA)).toBe(true);
    expect(first.pointA).not.toBe(second.pointA);
    expect(first.pointA).toEqual(second.pointA);
    expect(staticObbDistance.toString()).toContain("obbDistanceCore");
    expect(certifiedSweptDistance.toString()).toContain("obbDistanceCore");
    const segA: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(0, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const segB: SweptClearanceSegment = {
      startS: 0,
      endS: 1,
      start: createClearancePose({
        position: v(2, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      end: createClearancePose({
        position: v(2, 0, 0),
        tangent: v(0, 0, 1),
        normal: v(0, 1, 0),
        binormal: v(-1, 0, 0),
      }),
      geometry: g,
    };
    const swept = certifiedSweptDistance(segA, segB, {
      maxWork: 2000,
      resolutionM: 0.01,
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok || swept.excluded) throw new Error("expected");
    expect(Object.isFrozen(swept.pointA)).toBe(true);
  });
});
