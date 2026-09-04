import {
  interpolateTrackFrame,
  quatDot,
  quatFromFrame,
  vec3,
  type Vec3,
} from "@openvibecoaster/core";
import { nextDown, nextUp } from "./polynomial-bounds";
export interface ClearanceTrainGeometry {
  halfWidthM: number;
  aboveRailM: number;
  belowRailM: number;
  carPitchM: number;
  noseTailMarginM: number;
}
export interface ClearancePose {
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}
export interface OrientedBox {
  center: Vec3;
  axes: readonly [Vec3, Vec3, Vec3];
  halfExtents: readonly [number, number, number];
}
export interface SweptClearanceSegment {
  startS: number;
  endS: number;
  start: ClearancePose;
  end: ClearancePose;
  geometry: ClearanceTrainGeometry;
}
export type CertifiedDistanceResult =
  | {
      ok: true;
      excluded: false;
      lowerM: number;
      upperM: number;
      witnessU: number;
      witnessV: number;
      pointA: Vec3;
      pointB: Vec3;
      work: number;
    }
  | {
      ok: true;
      excluded: true;
      work: number;
    }
  | { ok: false; code: "CLEARANCE_UNCERTIFIED"; message: string; work: number };
const EPS = 1e-6;
function finiteScalar(v: number, l: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${l} must be finite`);
  return v;
}
function finiteVec(v: Vec3, l: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3)
    throw new RangeError(`${l} must be Vec3`);
  finiteScalar(v[0]!, `${l}.x`);
  finiteScalar(v[1]!, `${l}.y`);
  finiteScalar(v[2]!, `${l}.z`);
  return vec3(v[0]!, v[1]!, v[2]!);
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ] as Vec3;
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as Vec3;
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as Vec3;
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s] as Vec3;
}
function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
type Interval = { lo: number; hi: number };
function intervalDot(a: Vec3, b: Vec3): Interval {
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
function intervalAbs(iv: Interval): Interval {
  if (iv.lo >= 0) return { lo: nextDown(iv.lo), hi: nextUp(iv.hi) };
  if (iv.hi <= 0) return { lo: nextDown(-iv.hi), hi: nextUp(-iv.lo) };
  const hi = Math.max(-iv.lo, iv.hi);
  return { lo: 0, hi: nextUp(hi) };
}
export function createClearanceTrainGeometry(
  i: ClearanceTrainGeometry,
): ClearanceTrainGeometry {
  finiteScalar(i.halfWidthM, "halfWidthM");
  finiteScalar(i.aboveRailM, "aboveRailM");
  finiteScalar(i.belowRailM, "belowRailM");
  finiteScalar(i.carPitchM, "carPitchM");
  finiteScalar(i.noseTailMarginM, "noseTailMarginM");
  if (i.halfWidthM <= 0) throw new RangeError("halfWidthM must be positive");
  if (i.aboveRailM < 0 || i.belowRailM < 0)
    throw new RangeError("above/below must be non-negative");
  if (i.carPitchM <= 0) throw new RangeError("carPitchM must be positive");
  if (i.noseTailMarginM < 0)
    throw new RangeError("noseTailMarginM must be non-negative");
  return Object.freeze({ ...i });
}
export function createClearancePose(i: ClearancePose): ClearancePose {
  const p = finiteVec(i.position, "position");
  const t = finiteVec(i.tangent, "tangent");
  const n = finiteVec(i.normal, "normal");
  const b = finiteVec(i.binormal, "binormal");
  if (Math.abs(len(t) - 1) > 1e-6) throw new RangeError("tangent must be unit");
  if (Math.abs(len(n) - 1) > 1e-6) throw new RangeError("normal must be unit");
  if (Math.abs(len(b) - 1) > 1e-6)
    throw new RangeError("binormal must be unit");
  if (Math.abs(dot(t, n)) > EPS)
    throw new RangeError("tangent/normal not orthogonal");
  if (Math.abs(dot(t, b)) > EPS)
    throw new RangeError("tangent/binormal not orthogonal");
  if (Math.abs(dot(n, b)) > EPS)
    throw new RangeError("normal/binormal not orthogonal");
  const c = cross(t, n);
  if (Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) > 1e-5)
    throw new RangeError("cross(T,N) must equal B");
  return Object.freeze({ position: p, tangent: t, normal: n, binormal: b });
}
export function createOrientedBox(
  pose: ClearancePose,
  geometry: ClearanceTrainGeometry,
): OrientedBox {
  const pp = createClearancePose(pose);
  const gg = createClearanceTrainGeometry(geometry);
  const hx = gg.halfWidthM;
  const hy = (gg.aboveRailM + gg.belowRailM) / 2;
  const hz = gg.carPitchM / 2 + gg.noseTailMarginM;
  const off = (gg.aboveRailM - gg.belowRailM) / 2;
  const centerRaw = add(pp.position, scale(pp.normal, off));
  const center = vec3(centerRaw[0], centerRaw[1], centerRaw[2]);
  return Object.freeze({
    center,
    axes: Object.freeze([
      pp.binormal,
      pp.normal,
      pp.tangent,
    ] as const) as readonly [Vec3, Vec3, Vec3],
    halfExtents: Object.freeze([hx, hy, hz] as const) as readonly [
      number,
      number,
      number,
    ],
  });
}
function createOrientedBoxFastInternal(
  pose: ClearancePose,
  geometry: ClearanceTrainGeometry,
): OrientedBox {
  const hx = geometry.halfWidthM;
  const hy = (geometry.aboveRailM + geometry.belowRailM) / 2;
  const hz = geometry.carPitchM / 2 + geometry.noseTailMarginM;
  const off = (geometry.aboveRailM - geometry.belowRailM) / 2;
  const center = add(pose.position, scale(pose.normal, off));
  return {
    center,
    axes: [pose.binormal, pose.normal, pose.tangent] as const as readonly [
      Vec3,
      Vec3,
      Vec3,
    ],
    halfExtents: [hx, hy, hz] as const,
  };
}
function getVertices(box: OrientedBox): Vec3[] {
  const out: Vec3[] = [];
  const cx = box.center[0]!,
    cy = box.center[1]!,
    cz = box.center[2]!;
  const hx = box.halfExtents[0]!,
    hy = box.halfExtents[1]!,
    hz = box.halfExtents[2]!;
  const ax0 = box.axes[0]!,
    ax1 = box.axes[1]!,
    ax2 = box.axes[2]!;
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      for (const sz of [-1, 1] as const)
        out.push([
          cx + sx * hx * ax0[0] + sy * hy * ax1[0] + sz * hz * ax2[0],
          cy + sx * hx * ax0[1] + sy * hy * ax1[1] + sz * hz * ax2[1],
          cz + sx * hx * ax0[2] + sy * hy * ax1[2] + sz * hz * ax2[2],
        ] as Vec3);
  return out;
}
function pointToBoxClosest(p: Vec3, box: OrientedBox): Vec3 {
  const d = sub(p, box.center);
  let r = [box.center[0], box.center[1], box.center[2]] as Vec3;
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!,
      proj = dot(d, ax),
      c = Math.max(-box.halfExtents[i]!, Math.min(box.halfExtents[i]!, proj));
    r = add(r, scale(ax, c));
  }
  return r;
}
function pointInBox(p: Vec3, box: OrientedBox): boolean {
  const d = sub(p, box.center);
  for (let i = 0; i < 3; i += 1) {
    const iv = intervalDot(d, box.axes[i]!);
    const absIv = intervalAbs(iv);
    // Need to check if |proj| <= h + outward? For strictly verified containment, we need projHi <= h and projLo >= -h
    // Use interval: if absIv.hi <= box.halfExtents[i]! (with nextDown for hi), then definitely inside
    // If absIv.lo > box.halfExtents[i]! then definitely outside
    // Otherwise ambiguous -> not strictly verified, return false for fail-closed
    // For pointInBox used for witness, we need strict verification: only return true if definitely inside
    const h = box.halfExtents[i]!;
    if (absIv.hi <= nextUp(h)) continue;
    if (absIv.lo > nextUp(h)) return false;
    return false;
  }
  return true;
}
function segmentObbIntersect(
  p0: Vec3,
  p1: Vec3,
  box: OrientedBox,
): Vec3 | null {
  const dir = sub(p1, p0);
  const diff = sub(p0, box.center);
  let tMin = 0;
  let tMax = 1;
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!;
    const eIv = intervalDot(diff, ax);
    const fIv = intervalDot(dir, ax);
    const h = box.halfExtents[i]!;
    // If f interval straddles 0, check if e interval is definitely outside
    if (fIv.lo <= 0 && fIv.hi >= 0) {
      // f ~0, need e interval within [-h, h] to be potentially intersecting
      if (eIv.hi < nextDown(-h) || eIv.lo > nextUp(h)) return null;
      // Ambiguous: if e interval straddles boundary within outward, cannot prove, treat as no intersect for witness
      if (eIv.lo < nextDown(-h) || eIv.hi > nextUp(h)) return null;
      continue;
    }
    const f = dot(dir, ax);
    const e = dot(diff, ax);
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
  return add(p0, scale(dir, tMin));
}
function getEdges(box: OrientedBox): Array<[Vec3, Vec3]> {
  const edges: Array<[Vec3, Vec3]> = [];
  const c = box.center;
  const a0 = box.axes[0]!,
    a1 = box.axes[1]!,
    a2 = box.axes[2]!;
  const h0 = box.halfExtents[0]!,
    h1 = box.halfExtents[1]!,
    h2 = box.halfExtents[2]!;
  // axis 0 edges: vary axis 0, others are 1,2
  for (const s1 of [-1, 1] as const)
    for (const s2 of [-1, 1] as const) {
      const p0 = add(add(c, scale(a1, s1 * h1)), scale(a2, s2 * h2));
      edges.push([add(p0, scale(a0, -h0)), add(p0, scale(a0, h0))]);
    }
  // axis 1 edges: others 0,2
  for (const s0 of [-1, 1] as const)
    for (const s2 of [-1, 1] as const) {
      const p0 = add(add(c, scale(a0, s0 * h0)), scale(a2, s2 * h2));
      edges.push([add(p0, scale(a1, -h1)), add(p0, scale(a1, h1))]);
    }
  // axis 2 edges: others 0,1
  for (const s0 of [-1, 1] as const)
    for (const s1 of [-1, 1] as const) {
      const p0 = add(add(c, scale(a0, s0 * h0)), scale(a1, s1 * h1));
      edges.push([add(p0, scale(a2, -h2)), add(p0, scale(a2, h2))]);
    }
  return edges;
}
function segmentClosestCore(
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3,
): { pa: Vec3; pb: Vec3; dist: number } {
  const u = sub(p1, p0);
  const v = sub(q1, q0);
  const w = sub(p0, q0);
  const a = dot(u, u);
  const b = dot(u, v);
  const c = dot(v, v);
  const d = dot(u, w);
  const e = dot(v, w);
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
  const pa = add(p0, scale(u, s));
  const pb = add(q0, scale(v, t));
  return { pa, pb, dist: len(sub(pa, pb)) };
}
export function segmentClosest(
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3,
): { pa: Vec3; pb: Vec3; dist: number } {
  const { pa, pb, dist } = segmentClosestCore(p0, p1, q0, q1);
  return { pa: vec3(pa[0], pa[1], pa[2]), pb: vec3(pb[0], pb[1], pb[2]), dist };
}
function closestFeature(
  a: OrientedBox,
  b: OrientedBox,
): { dist: number; pa: Vec3; pb: Vec3 } {
  let bestDist = Infinity;
  let bestA: Vec3 = a.center;
  let bestB: Vec3 = b.center;
  const vertsA = getVertices(a);
  const vertsB = getVertices(b);
  for (let i = 0; i < vertsA.length; i += 1) {
    const va = vertsA[i]!;
    const cb = pointToBoxClosest(va, b);
    const raw = len(sub(va, cb));
    if (raw < bestDist) {
      bestDist = raw;
      bestA = va;
      bestB = cb;
    }
  }
  for (let i = 0; i < vertsB.length; i += 1) {
    const vb = vertsB[i]!;
    const ca = pointToBoxClosest(vb, a);
    const raw = len(sub(vb, ca));
    if (raw < bestDist) {
      bestDist = raw;
      bestA = ca;
      bestB = vb;
    }
  }
  const edgesA = getEdges(a);
  const edgesB = getEdges(b);
  for (let i = 0; i < edgesA.length; i += 1) {
    const ea = edgesA[i]!;
    const p0 = ea[0]!,
      p1 = ea[1]!;
    for (let j = 0; j < edgesB.length; j += 1) {
      const eb = edgesB[j]!;
      const q0 = eb[0]!,
        q1 = eb[1]!;
      const seg = segmentClosestCore(p0, p1, q0, q1);
      if (seg.dist < bestDist) {
        bestDist = seg.dist;
        bestA = seg.pa;
        bestB = seg.pb;
      }
    }
  }
  return { dist: bestDist, pa: bestA, pb: bestB };
}
function obbDistanceCore(
  a: OrientedBox,
  b: OrientedBox,
): { distance: number; pointA: Vec3; pointB: Vec3 } {
  const delta = sub(b.center, a.center);
  let separatedProven = false;
  let intersectingProven = true;
  const testAxis = (ax: Vec3): boolean => {
    const l = len(ax);
    if (l === 0) return false;
    const n = scale(ax, 1 / l);
    const dotDeltaIv = intervalDot(delta, n);
    const absDotDelta = intervalAbs(dotDeltaIv);
    let ra: Interval = { lo: 0, hi: 0 };
    let rb: Interval = { lo: 0, hi: 0 };
    for (let i = 0; i < 3; i += 1) {
      const dotA = intervalDot(n, a.axes[i]!);
      const absDotA = intervalAbs(dotA);
      const termAlo = nextDown(a.halfExtents[i]! * absDotA.lo);
      const termAhi = nextUp(a.halfExtents[i]! * absDotA.hi);
      ra = { lo: nextDown(ra.lo + termAlo), hi: nextUp(ra.hi + termAhi) };
      const dotB = intervalDot(n, b.axes[i]!);
      const absDotB = intervalAbs(dotB);
      const termBlo = nextDown(b.halfExtents[i]! * absDotB.lo);
      const termBhi = nextUp(b.halfExtents[i]! * absDotB.hi);
      rb = { lo: nextDown(rb.lo + termBlo), hi: nextUp(rb.hi + termBhi) };
    }
    const sumLo = nextDown(ra.lo + rb.lo);
    const sumHi = nextUp(ra.hi + rb.hi);
    if (absDotDelta.lo > sumHi) {
      separatedProven = true;
      return true;
    }
    if (absDotDelta.hi < sumLo) return false;
    intersectingProven = false;
    return false;
  };
  for (let i = 0; i < 3; i += 1) if (testAxis(a.axes[i]!)) break;
  if (!separatedProven)
    for (let i = 0; i < 3; i += 1) if (testAxis(b.axes[i]!)) break;
  if (!separatedProven)
    for (let i = 0; i < 3; i += 1)
      for (let j = 0; j < 3; j += 1) {
        if (separatedProven) break;
        const cc = cross(a.axes[i]!, b.axes[j]!);
        const l2 = dot(cc, cc);
        if (l2 === 0) continue;
        if (testAxis(scale(cc, 1 / Math.sqrt(l2)))) break;
      }
  if (separatedProven) {
    const cf = closestFeature(a, b);
    return { distance: cf.dist, pointA: cf.pa, pointB: cf.pb };
  }
  const vertsA = getVertices(a);
  for (const va of vertsA)
    if (pointInBox(va, b)) return { distance: 0, pointA: va, pointB: va };
  const vertsB = getVertices(b);
  for (const vb of vertsB)
    if (pointInBox(vb, a)) return { distance: 0, pointA: vb, pointB: vb };
  const edgesA = getEdges(a);
  for (const [p0, p1] of edgesA) {
    const ip = segmentObbIntersect(p0, p1, b);
    if (ip && pointInBox(ip, a) && pointInBox(ip, b))
      return { distance: 0, pointA: ip, pointB: ip };
  }
  const edgesB = getEdges(b);
  for (const [q0, q1] of edgesB) {
    const ip = segmentObbIntersect(q0, q1, a);
    if (ip && pointInBox(ip, a) && pointInBox(ip, b))
      return { distance: 0, pointA: ip, pointB: ip };
  }
  if (pointInBox(a.center, b) && pointInBox(a.center, a))
    return { distance: 0, pointA: a.center, pointB: a.center };
  if (pointInBox(b.center, a) && pointInBox(b.center, b))
    return { distance: 0, pointA: b.center, pointB: b.center };
  if (!intersectingProven) throw new RangeError("SAT ambiguous");
  throw new RangeError("SAT intersect but no witness");
}

function obbSeparationLowerBoundCore(a: OrientedBox, b: OrientedBox): number {
  const delta = sub(b.center, a.center);
  let best = 0;
  const testAxis = (axis: Vec3): void => {
    const axisLength = len(axis);
    if (axisLength === 0) return;
    const normalized = scale(axis, 1 / axisLength);
    const normalizedLengthUp = nextUp(len(normalized));
    const projectedDelta = intervalAbs(intervalDot(delta, normalized));
    let radiusA: Interval = { lo: 0, hi: 0 };
    let radiusB: Interval = { lo: 0, hi: 0 };
    for (let index = 0; index < 3; index += 1) {
      const projectedA = intervalAbs(intervalDot(normalized, a.axes[index]!));
      const projectedB = intervalAbs(intervalDot(normalized, b.axes[index]!));
      radiusA = {
        lo: 0,
        hi: nextUp(
          radiusA.hi +
            nextUp(a.halfExtents[index]! * projectedA.hi),
        ),
      };
      radiusB = {
        lo: 0,
        hi: nextUp(
          radiusB.hi +
            nextUp(b.halfExtents[index]! * projectedB.hi),
        ),
      };
    }
    const extent = nextUp(radiusA.hi + radiusB.hi);
    const projectedGap = nextDown(projectedDelta.lo - extent);
    if (projectedGap <= 0) return;
    best = Math.max(best, nextDown(projectedGap / normalizedLengthUp));
  };
  for (let index = 0; index < 3; index += 1) testAxis(a.axes[index]!);
  for (let index = 0; index < 3; index += 1) testAxis(b.axes[index]!);
  for (let aIndex = 0; aIndex < 3; aIndex += 1)
    for (let bIndex = 0; bIndex < 3; bIndex += 1)
      testAxis(cross(a.axes[aIndex]!, b.axes[bIndex]!));
  return best;
}

export function sweptObbSeparationLowerBound(
  first: SweptClearanceSegment,
  second: SweptClearanceSegment,
): number {
  const firstInvariants = getSegmentInvariants(first);
  const secondInvariants = getSegmentInvariants(second);
  const firstMidpoint = createOrientedBoxFastInternal(
    interpolatePose(first, 0.5),
    first.geometry,
  );
  const secondMidpoint = createOrientedBoxFastInternal(
    interpolatePose(second, 0.5),
    second.geometry,
  );
  const staticLower = obbSeparationLowerBoundCore(
    firstMidpoint,
    secondMidpoint,
  );
  const motion = nextUp(
    motionBoundForDeltaFast(firstInvariants, 0.5) +
      motionBoundForDeltaFast(secondInvariants, 0.5),
  );
  return Math.max(0, nextDown(staticLower - motion));
}

export function staticObbDistance(
  a: OrientedBox,
  b: OrientedBox,
): { distance: number; pointA: Vec3; pointB: Vec3 } {
  for (const box of [a, b] as const) {
    finiteVec(box.center, "center");
    for (let i = 0; i < 3; i += 1) {
      finiteScalar(box.halfExtents[i]!, `halfExtent${i}`);
      if (box.halfExtents[i]! < 0)
        throw new RangeError("halfExtent must be non-negative");
      finiteVec(box.axes[i]!, `axis${i}`);
      if (Math.abs(len(box.axes[i]!) - 1) > 1e-5)
        throw new RangeError("axis must be unit");
    }
  }
  const res = obbDistanceCore(a, b);
  return {
    distance: res.distance,
    pointA: vec3(res.pointA[0], res.pointA[1], res.pointA[2]),
    pointB: vec3(res.pointB[0], res.pointB[1], res.pointB[2]),
  };
}

export function interpolatePose(
  s: SweptClearanceSegment,
  t: number,
): ClearancePose {
  if (!Number.isFinite(t)) throw new RangeError("t must be finite");
  if (t < -1e-9 || t > 1 + 1e-9) throw new RangeError("t out of range");
  const tt = Math.max(0, Math.min(1, t));
  const pos = vec3(
    s.start.position[0] + (s.end.position[0] - s.start.position[0]) * tt,
    s.start.position[1] + (s.end.position[1] - s.start.position[1]) * tt,
    s.start.position[2] + (s.end.position[2] - s.start.position[2]) * tt,
  );
  const frame = interpolateTrackFrame(
    s.start.tangent,
    s.start.normal,
    s.start.binormal,
    s.end.tangent,
    s.end.normal,
    s.end.binormal,
    tt,
  );
  return {
    position: pos,
    tangent: frame.tangent,
    normal: frame.normal,
    binormal: frame.binormal,
  };
}
function conservativeRadius(g: ClearanceTrainGeometry): number {
  const hx = g.halfWidthM;
  const maxY = Math.max(g.aboveRailM, g.belowRailM);
  const hz = g.carPitchM / 2 + g.noseTailMarginM;
  return nextUp(Math.sqrt(nextUp(hx * hx + maxY * maxY + hz * hz)));
}
function totalAngle(seg: SweptClearanceSegment): number {
  const qa = quatFromFrame(
    seg.start.tangent,
    seg.start.normal,
    seg.start.binormal,
  );
  const qb = quatFromFrame(seg.end.tangent, seg.end.normal, seg.end.binormal);
  const lenQa = Math.hypot(qa[0], qa[1], qa[2], qa[3]);
  const lenQb = Math.hypot(qb[0], qb[1], qb[2], qb[3]);
  if (Math.abs(lenQa - 1) > 1e-6 || Math.abs(lenQb - 1) > 1e-6)
    throw new RangeError("quaternion not unit");
  const d = quatDot(qa, qb);
  if (!Number.isFinite(d)) throw new RangeError("quaternion dot not finite");
  const absDot = Math.abs(d);
  const clampedDown = nextDown(Math.min(1, absDot));
  const th = 2 * Math.acos(Math.max(-1, clampedDown));
  return nextUp(th);
}
type SegmentInvariants = {
  dPosUp: number;
  rUp: number;
  thUp: number;
};
function getSegmentInvariants(seg: SweptClearanceSegment): SegmentInvariants {
  const dPos = len(sub(seg.end.position, seg.start.position));
  const r = conservativeRadius(seg.geometry);
  const qa = quatFromFrame(
    seg.start.tangent,
    seg.start.normal,
    seg.start.binormal,
  );
  const qb = quatFromFrame(seg.end.tangent, seg.end.normal, seg.end.binormal);
  const lenQa = Math.hypot(qa[0], qa[1], qa[2], qa[3]);
  const lenQb = Math.hypot(qb[0], qb[1], qb[2], qb[3]);
  if (Math.abs(lenQa - 1) > 1e-6 || Math.abs(lenQb - 1) > 1e-6)
    throw new RangeError("quaternion not unit");
  const d = quatDot(qa, qb);
  if (!Number.isFinite(d)) throw new RangeError("quaternion dot not finite");
  const absDot = Math.abs(d);
  const clampedDown = nextDown(Math.min(1, absDot));
  const th = nextUp(2 * Math.acos(Math.max(-1, clampedDown)));
  return {
    dPosUp: nextUp(dPos),
    rUp: nextUp(r),
    thUp: nextUp(th),
  };
}
function motionBoundForDeltaFast(
  inv: SegmentInvariants,
  delta: number,
): number {
  if (!Number.isFinite(delta) || delta < 0)
    throw new RangeError("delta must be finite non-negative");
  const deltaUp = nextUp(delta);
  const linear = nextUp(inv.dPosUp * deltaUp);
  const thDeltaUp = nextUp(inv.thUp * deltaUp);
  const halfUp = nextUp(thDeltaUp / 2);
  const sinHalfUp = nextUp(Math.sin(halfUp));
  const angular = nextUp(2 * nextUp(inv.rUp * sinHalfUp));
  const rawUp = nextUp(linear + angular);
  return nextUp(rawUp);
}
function motionBoundForDelta(
  seg: SweptClearanceSegment,
  delta: number,
): number {
  if (!Number.isFinite(delta) || delta < 0)
    throw new RangeError("delta must be finite non-negative");
  const dPos = len(sub(seg.end.position, seg.start.position));
  const r = conservativeRadius(seg.geometry);
  const th = totalAngle(seg);
  const deltaUp = nextUp(delta);
  const dPosUp = nextUp(dPos);
  const rUp = nextUp(r);
  const thUp = nextUp(th);
  const linear = nextUp(dPosUp * deltaUp);
  const thDeltaUp = nextUp(thUp * deltaUp);
  const halfUp = nextUp(thDeltaUp / 2);
  const sinHalfUp = nextUp(Math.sin(halfUp));
  const angular = nextUp(2 * nextUp(rUp * sinHalfUp));
  const rawUp = nextUp(linear + angular);
  return nextUp(rawUp);
}
export function sweptMotionBound(
  seg: SweptClearanceSegment,
  a: number,
  b: number,
): number {
  finiteScalar(a, "a");
  finiteScalar(b, "b");
  if (a > b) throw new RangeError("a must be <= b");
  const delta = (b - a) / 2;
  return motionBoundForDelta(seg, delta);
}
export interface PreparedTerrainSegmentEvaluator {
  obbAtPose(pose: ClearancePose): OrientedBox;
  motionBound(a: number, b: number): number;
}
export function prepareTerrainSegmentEvaluator(
  seg: SweptClearanceSegment,
): PreparedTerrainSegmentEvaluator {
  const start = createClearancePose(seg.start);
  const end = createClearancePose(seg.end);
  const geometry = createClearanceTrainGeometry(seg.geometry);
  const validated: SweptClearanceSegment = {
    startS: seg.startS,
    endS: seg.endS,
    start,
    end,
    geometry,
  };
  const inv = getSegmentInvariants(validated);
  return {
    obbAtPose(pose: ClearancePose): OrientedBox {
      return createOrientedBoxFastInternal(pose, geometry);
    },
    motionBound(a: number, b: number): number {
      finiteScalar(a, "a");
      finiteScalar(b, "b");
      if (a > b) throw new RangeError("a must be <= b");
      const delta = (b - a) / 2;
      return motionBoundForDeltaFast(inv, delta);
    },
  };
}
export function openArcIntervalDistance(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): { min: number; max: number } {
  for (const v of [a0, a1, b0, b1] as const) finiteScalar(v, "arc");
  if (a0 > a1 || b0 > b1) throw new RangeError("interval must be ordered");
  const overlap = Math.max(a0, b0) <= Math.min(a1, b1);
  let min: number;
  if (overlap) {
    min = 0;
  } else {
    const d1 = Math.abs(b0 - a1);
    const d2 = Math.abs(a0 - b1);
    min = nextDown(Math.min(d1, d2));
  }
  const cands = [
    Math.abs(a0 - b0),
    Math.abs(a0 - b1),
    Math.abs(a1 - b0),
    Math.abs(a1 - b1),
  ].map((v) => nextUp(v));
  const max = nextUp(Math.max(...cands));
  return { min, max };
}
export function closedArcIntervalDistance(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  L: number,
): { min: number; max: number } {
  for (const v of [a0, a1, b0, b1] as const) finiteScalar(v, "arc");
  finiteScalar(L, "lengthM");
  if (!(L > 0 && Number.isFinite(L)))
    throw new RangeError("length must be finite positive");
  if (a0 > a1 || b0 > b1) throw new RangeError("interval must be ordered");
  const lo = a0 - b1,
    hi = a1 - b0;
  const fold = (d: number): number => {
    const r = ((d % L) + L) % L;
    return Math.min(r, L - r);
  };
  const contains = (off: number): boolean => {
    const kLow = Math.ceil((lo - off) / L - 1e-9),
      kHigh = Math.floor((hi - off) / L + 1e-9);
    return kLow <= kHigh;
  };
  let min: number;
  if (contains(0)) min = 0;
  else {
    const fLo = fold(lo);
    const fHi = fold(hi);
    min = nextDown(Math.min(fLo, fHi));
  }
  const half = L / 2;
  let max: number;
  if (contains(half)) max = nextUp(half);
  else {
    const fLo = fold(lo);
    const fHi = fold(hi);
    max = nextUp(Math.max(fLo, fHi));
  }
  return { min, max };
}
function vecEqual(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function isConstantOrientation(seg: SweptClearanceSegment): boolean {
  return (
    vecEqual(seg.start.tangent, seg.end.tangent) &&
    vecEqual(seg.start.normal, seg.end.normal) &&
    vecEqual(seg.start.binormal, seg.end.binormal)
  );
}
function orientedBoxAabbOutward(box: OrientedBox): { min: Vec3; max: Vec3 } {
  const c = box.center;
  const ax = box.axes;
  const he = box.halfExtents;
  let min0: number, min1: number, min2: number;
  let max0: number, max1: number, max2: number;
  for (let j = 0 as 0 | 1 | 2; j < 3; j += 1) {
    const term0 = nextUp(Math.abs(ax[0]![j]!) * he[0]!);
    const term1 = nextUp(Math.abs(ax[1]![j]!) * he[1]!);
    const term2 = nextUp(Math.abs(ax[2]![j]!) * he[2]!);
    const projUp = nextUp(nextUp(term0 + term1) + term2);
    if (j === 0) {
      min0 = nextDown(c[0]! - projUp);
      max0 = nextUp(c[0]! + projUp);
    } else if (j === 1) {
      min1 = nextDown(c[1]! - projUp);
      max1 = nextUp(c[1]! + projUp);
    } else {
      min2 = nextDown(c[2]! - projUp);
      max2 = nextUp(c[2]! + projUp);
    }
  }
  return {
    min: vec3(min0!, min1!, min2!),
    max: vec3(max0!, max1!, max2!),
  };
}
export function sweptAabb(seg: SweptClearanceSegment): {
  min: Vec3;
  max: Vec3;
} {
  const box0 = createOrientedBoxFastInternal(seg.start, seg.geometry);
  const box1 = createOrientedBoxFastInternal(seg.end, seg.geometry);
  const aabb0 = orientedBoxAabbOutward(box0);
  const aabb1 = orientedBoxAabbOutward(box1);
  // Every interpolated pose is at most half a segment from its nearer endpoint.
  // Expanding both endpoint boxes by that certified translation+rotation motion
  // bound encloses the complete sweep without circumsphere-wide world axes.
  const expansion = isConstantOrientation(seg)
    ? 0
    : motionBoundForDeltaFast(getSegmentInvariants(seg), 0.5);
  return {
    min: vec3(
      nextDown(Math.min(aabb0.min[0]!, aabb1.min[0]!) - nextUp(expansion)),
      nextDown(Math.min(aabb0.min[1]!, aabb1.min[1]!) - nextUp(expansion)),
      nextDown(Math.min(aabb0.min[2]!, aabb1.min[2]!) - nextUp(expansion)),
    ),
    max: vec3(
      nextUp(Math.max(aabb0.max[0]!, aabb1.max[0]!) + nextUp(expansion)),
      nextUp(Math.max(aabb0.max[1]!, aabb1.max[1]!) + nextUp(expansion)),
      nextUp(Math.max(aabb0.max[2]!, aabb1.max[2]!) + nextUp(expansion)),
    ),
  };
}
function sweptAabbGapLower(
  a: { min: Vec3; max: Vec3 },
  b: { min: Vec3; max: Vec3 },
): number {
  let gx = 0;
  let gy = 0;
  let gz = 0;
  if (a.max[0]! < b.min[0]!) gx = nextDown(b.min[0]! - nextUp(a.max[0]!));
  else if (b.max[0]! < a.min[0]!) gx = nextDown(a.min[0]! - nextUp(b.max[0]!));
  if (a.max[1]! < b.min[1]!) gy = nextDown(b.min[1]! - nextUp(a.max[1]!));
  else if (b.max[1]! < a.min[1]!) gy = nextDown(a.min[1]! - nextUp(b.max[1]!));
  if (a.max[2]! < b.min[2]!) gz = nextDown(b.min[2]! - nextUp(a.max[2]!));
  else if (b.max[2]! < a.min[2]!) gz = nextDown(a.min[2]! - nextUp(b.max[2]!));
  if (gx < 0) gx = 0;
  if (gy < 0) gy = 0;
  if (gz < 0) gz = 0;
  if (gx === 0 && gy === 0 && gz === 0) return 0;
  const sqX = nextDown(gx * gx);
  const sqY = nextDown(gy * gy);
  const sqZ = nextDown(gz * gz);
  const sum = nextDown(nextDown(sqX + sqY) + sqZ);
  if (sum <= 0) return 0;
  return nextDown(Math.sqrt(sum));
}
function sInterval(
  s: SweptClearanceSegment,
  u0: number,
  u1: number,
): [number, number] {
  const aLo = nextDown(s.startS + nextDown(nextDown(s.endS - s.startS) * u0));
  const aHi = nextUp(s.startS + nextUp(nextUp(s.endS - s.startS) * u0));
  const bLo = nextDown(s.startS + nextDown(nextDown(s.endS - s.startS) * u1));
  const bHi = nextUp(s.startS + nextUp(nextUp(s.endS - s.startS) * u1));
  return [nextDown(Math.min(aLo, bLo)), nextUp(Math.max(aHi, bHi))];
}
export function areSweptIntervalsWithinLocality(
  segA: SweptClearanceSegment,
  segB: SweptClearanceSegment,
  localityM: number,
  closed: boolean,
  trackLengthM: number,
): boolean {
  finiteScalar(segA.startS, "aStartS");
  finiteScalar(segA.endS, "aEndS");
  finiteScalar(segB.startS, "bStartS");
  finiteScalar(segB.endS, "bEndS");
  finiteScalar(localityM, "localityM");
  if (localityM < 0) throw new RangeError("localityM must be non-negative");
  if (closed) {
    finiteScalar(trackLengthM, "trackLengthM");
    if (!(trackLengthM > 0))
      throw new RangeError("trackLengthM must be positive");
  }
  const [a0, a1] = sInterval(segA, 0, 1);
  const [b0, b1] = sInterval(segB, 0, 1);
  const d0 = closed
    ? closedArcIntervalDistance(a0, a1, b0, b1, trackLengthM)
    : openArcIntervalDistance(a0, a1, b0, b1);
  return d0.max <= localityM;
}
function pointArcDistance(
  segA: SweptClearanceSegment,
  segB: SweptClearanceSegment,
  u: number,
  v: number,
  closed: boolean,
  L: number,
): number {
  const sA = segA.startS + (segA.endS - segA.startS) * u;
  const sB = segB.startS + (segB.endS - segB.startS) * v;
  if (!closed) return nextUp(Math.abs(nextUp(sA) - nextDown(sB)));
  const d = nextUp(sA - nextDown(sB));
  const r = ((d % L) + L) % L;
  return nextUp(Math.min(nextUp(r), nextUp(L - r)));
}
export function certifiedSweptDistance(
  segA: SweptClearanceSegment,
  segB: SweptClearanceSegment,
  opts: {
    maxWork: number;
    resolutionM: number;
    localityM?: number;
    closed?: boolean;
    trackLengthM?: number;
    readonly separationThresholds?: readonly number[];
  },
): CertifiedDistanceResult {
  if (!Number.isSafeInteger(opts.maxWork) || opts.maxWork < 1)
    throw new RangeError("maxWork must be positive");
  finiteScalar(opts.resolutionM, "resolutionM");
  if (!(opts.resolutionM > 0))
    throw new RangeError("resolutionM must be positive");
  if (opts.localityM !== undefined) {
    finiteScalar(opts.localityM, "localityM");
    if (opts.localityM < 0)
      throw new RangeError("localityM must be non-negative");
  }
  const closed = opts.closed ?? false;
  if (closed && opts.trackLengthM === undefined)
    throw new RangeError("trackLengthM required");
  if (closed) {
    finiteScalar(opts.trackLengthM!, "trackLengthM");
    if (!(opts.trackLengthM! > 0))
      throw new RangeError("trackLengthM must be positive");
  }
  const separationThresholds = opts.separationThresholds ?? [];
  if (!Array.isArray(separationThresholds))
    throw new RangeError("separationThresholds must be array");
  for (const t of separationThresholds) {
    finiteScalar(t, "separationThreshold");
    if (t < 0 || !Number.isFinite(t))
      throw new RangeError("separationThreshold must be non-negative finite");
  }
  finiteScalar(segA.startS, "a");
  finiteScalar(segA.endS, "a");
  finiteScalar(segB.startS, "b");
  finiteScalar(segB.endS, "b");
  createClearancePose(segA.start);
  createClearancePose(segA.end);
  createClearancePose(segB.start);
  createClearancePose(segB.end);
  createClearanceTrainGeometry(segA.geometry);
  createClearanceTrainGeometry(segB.geometry);
  const localityM = opts.localityM;
  const trackLen = opts.trackLengthM ?? 0;
  if (localityM !== undefined) {
    if (
      areSweptIntervalsWithinLocality(segA, segB, localityM, closed, trackLen)
    ) {
      return { ok: true, excluded: true, work: 0 };
    }
  }
  const invA = getSegmentInvariants(segA);
  const invB = getSegmentInvariants(segB);
  const aabbLower = sweptAabbGapLower(sweptAabb(segA), sweptAabb(segB));
  type QueueNode = {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    lower: number;
    upper: number;
    wU: number;
    wV: number;
    pa: Vec3;
    pb: Vec3;
    seq: number;
    hasWitness: boolean;
  };
  let work = 0;
  let seq = 0;
  let bestUpper = Infinity;
  let bestWitness: QueueNode | null = null;
  const heap: QueueNode[] = [];
  const heapLess = (a: QueueNode, b: QueueNode): boolean =>
    a.lower !== b.lower ? a.lower < b.lower : a.seq < b.seq;
  const heapPush = (n: QueueNode): boolean => {
    if (heap.length >= opts.maxWork) return false;
    heap.push(n);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
    return true;
  };
  const heapPeek = (): QueueNode | undefined => heap[0];
  const heapPop = (): QueueNode | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heapLess(heap[l]!, heap[smallest]!))
          smallest = l;
        if (r < heap.length && heapLess(heap[r]!, heap[smallest]!))
          smallest = r;
        if (smallest === i) break;
        const tmp = heap[i]!;
        heap[i] = heap[smallest]!;
        heap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  };
  const findFeasibleSample = (
    u0: number,
    u1: number,
    v0: number,
    v1: number,
  ): { u: number; v: number } | null => {
    if (localityM === undefined) return { u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
    const [a0, a1] = sInterval(segA, u0, u1);
    const [b0, b1] = sInterval(segB, v0, v1);
    const d = closed
      ? closedArcIntervalDistance(a0, a1, b0, b1, trackLen)
      : openArcIntervalDistance(a0, a1, b0, b1);
    if (d.max <= localityM) return null;
    if (d.min > localityM) return { u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
    const umid = (u0 + u1) / 2;
    const vmid = (v0 + v1) / 2;
    const candidates: Array<[number, number]> = [
      [u0, v0],
      [u0, v1],
      [u1, v0],
      [u1, v1],
      [umid, v0],
      [umid, v1],
      [u0, vmid],
      [u1, vmid],
      [umid, vmid],
    ];
    for (const [cu, cv] of candidates) {
      const pd = pointArcDistance(segA, segB, cu, cv, closed, trackLen);
      if (pd > localityM) return { u: cu, v: cv };
    }
    return null;
  };
  const evaluate = (
    u0: number,
    u1: number,
    v0: number,
    v1: number,
  ):
    | { kind: "excluded" }
    | { kind: "needSubdivide" }
    | { kind: "ok"; node: QueueNode }
    | { kind: "budget" }
    | { kind: "uncertain" } => {
    const sample = findFeasibleSample(u0, u1, v0, v1);
    if (sample === null) {
      const [a0, a1] = sInterval(segA, u0, u1);
      const [b0, b1] = sInterval(segB, v0, v1);
      const d = closed
        ? closedArcIntervalDistance(a0, a1, b0, b1, trackLen)
        : openArcIntervalDistance(a0, a1, b0, b1);
      if (d.max <= localityM!) return { kind: "excluded" };
      return { kind: "needSubdivide" };
    }
    if (work + 1 > opts.maxWork) return { kind: "budget" };
    if (heap.length >= opts.maxWork) return { kind: "budget" };
    work += 1;
    let sd: { distance: number; pointA: Vec3; pointB: Vec3 };
    try {
      sd = obbDistanceCore(
        createOrientedBoxFastInternal(
          interpolatePose(segA, sample.u),
          segA.geometry,
        ),
        createOrientedBoxFastInternal(
          interpolatePose(segB, sample.v),
          segB.geometry,
        ),
      );
    } catch (e) {
      if (
        e instanceof RangeError &&
        (e.message.includes("SAT ambiguous") ||
          e.message.includes("SAT intersect but no witness"))
      ) {
        return { kind: "uncertain" };
      }
      throw e;
    }
    const deltaA = Math.max(Math.abs(sample.u - u0), Math.abs(sample.u - u1));
    const deltaB = Math.max(Math.abs(sample.v - v0), Math.abs(sample.v - v1));
    const mA = motionBoundForDeltaFast(invA, deltaA);
    const mB = motionBoundForDeltaFast(invB, deltaB);
    const lower = Math.max(0, nextDown(sd.distance - nextUp(mA + mB)));
    const upper = nextUp(len(sub(sd.pointA, sd.pointB)));
    // Upper must be at least the distance between the returned points, outward
    const node: QueueNode = {
      u0,
      u1,
      v0,
      v1,
      lower,
      upper,
      wU: sample.u,
      wV: sample.v,
      pa: sd.pointA,
      pb: sd.pointB,
      seq: seq++,
      hasWitness: true,
    };
    return { kind: "ok", node };
  };
  const rootEval = evaluate(0, 1, 0, 1);
  if (rootEval.kind === "budget") {
    return {
      ok: false,
      code: "CLEARANCE_UNCERTIFIED",
      message: "budget",
      work,
    };
  }
  if (rootEval.kind === "excluded") {
    return { ok: true, excluded: true, work };
  }
  if (rootEval.kind === "uncertain") {
    // Treat uncertain root as needSubdivide
    const midU = 0.5;
    const midV = 0.5;
    const mA0 = motionBoundForDeltaFast(invA, 0.5);
    const mB0 = motionBoundForDeltaFast(invB, 0.5);
    const splitU = mA0 >= mB0;
    const children: Array<[number, number, number, number]> = splitU
      ? [
          [0, midU, 0, 1],
          [midU, 1, 0, 1],
        ]
      : [
          [0, 1, 0, midV],
          [0, 1, midV, 1],
        ];
    for (const [u0, u1, v0, v1] of children) {
      const ev = evaluate(u0, u1, v0, v1);
      if (ev.kind === "budget")
        return {
          ok: false,
          code: "CLEARANCE_UNCERTIFIED",
          message: "budget",
          work,
        };
      if (ev.kind === "excluded") continue;
      if (ev.kind === "needSubdivide" || ev.kind === "uncertain") {
        const ph: QueueNode = {
          u0,
          u1,
          v0,
          v1,
          lower: 0,
          upper: Infinity,
          wU: (u0 + u1) / 2,
          wV: (v0 + v1) / 2,
          pa: vec3(0, 0, 0),
          pb: vec3(0, 0, 0),
          seq: seq++,
          hasWitness: false,
        };
        if (!heapPush(ph))
          return {
            ok: false,
            code: "CLEARANCE_UNCERTIFIED",
            message: "budget",
            work,
          };
        continue;
      }
      if (ev.node.upper < bestUpper) {
        bestUpper = ev.node.upper;
        bestWitness = ev.node;
      }
      if (ev.node.lower < bestUpper) {
        if (!heapPush(ev.node))
          return {
            ok: false,
            code: "CLEARANCE_UNCERTIFIED",
            message: "budget",
            work,
          };
      }
    }
  } else if (rootEval.kind === "needSubdivide") {
    const midU = 0.5;
    const midV = 0.5;
    const mA0 = motionBoundForDeltaFast(invA, 0.5);
    const mB0 = motionBoundForDeltaFast(invB, 0.5);
    const splitU = mA0 >= mB0;
    const children: Array<[number, number, number, number]> = splitU
      ? [
          [0, midU, 0, 1],
          [midU, 1, 0, 1],
        ]
      : [
          [0, 1, 0, midV],
          [0, 1, midV, 1],
        ];
    for (const [u0, u1, v0, v1] of children) {
      const ev = evaluate(u0, u1, v0, v1);
      if (ev.kind === "budget")
        return {
          ok: false,
          code: "CLEARANCE_UNCERTIFIED",
          message: "budget",
          work,
        };
      if (ev.kind === "excluded") continue;
      if (ev.kind === "needSubdivide" || ev.kind === "uncertain") {
        const ph: QueueNode = {
          u0,
          u1,
          v0,
          v1,
          lower: 0,
          upper: Infinity,
          wU: (u0 + u1) / 2,
          wV: (v0 + v1) / 2,
          pa: vec3(0, 0, 0),
          pb: vec3(0, 0, 0),
          seq: seq++,
          hasWitness: false,
        };
        if (!heapPush(ph))
          return {
            ok: false,
            code: "CLEARANCE_UNCERTIFIED",
            message: "budget",
            work,
          };
        continue;
      }
      if (ev.node.upper < bestUpper) {
        bestUpper = ev.node.upper;
        bestWitness = ev.node;
      }
      if (ev.node.lower < bestUpper) {
        if (!heapPush(ev.node))
          return {
            ok: false,
            code: "CLEARANCE_UNCERTIFIED",
            message: "budget",
            work,
          };
      }
    }
  } else if (rootEval.kind === "ok") {
    if (rootEval.node.upper < bestUpper) {
      bestUpper = rootEval.node.upper;
      bestWitness = rootEval.node;
    }
    if (!heapPush(rootEval.node))
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
  }
  // Initial heap-empty: either root was needSubdivide with both children excluded (no feasible witness)
  // or budget prevented any push. If bestWitness exists, globalLower = bestUpper is proven with width 0.
  if (heap.length === 0) {
    if (bestWitness) {
      const globalLower = bestUpper;
      if (bestUpper - globalLower <= opts.resolutionM) {
        return {
          ok: true,
          excluded: false,
          lowerM: globalLower,
          upperM: bestUpper,
          witnessU: bestWitness.wU,
          witnessV: bestWitness.wV,
          pointA: vec3(bestWitness.pa[0], bestWitness.pa[1], bestWitness.pa[2]),
          pointB: vec3(bestWitness.pb[0], bestWitness.pb[1], bestWitness.pb[2]),
          work,
        };
      }
    }
    return {
      ok: false,
      code: "CLEARANCE_UNCERTIFIED",
      message: "budget",
      work,
    };
  }
  const thresholdsSeparatedForEarlyExit = (
    lower: number,
    upper: number,
  ): boolean => {
    for (const t of separationThresholds) {
      if (lower >= t) continue;
      if (upper < t) continue;
      return false;
    }
    return true;
  };
  while (heap.length > 0) {
    const heapLower = heapPeek()!.lower;
    const globalLower = Math.max(aabbLower, heapLower);
    if (bestWitness && bestUpper - globalLower <= opts.resolutionM) {
      return {
        ok: true,
        excluded: false,
        lowerM: globalLower,
        upperM: bestUpper,
        witnessU: bestWitness.wU,
        witnessV: bestWitness.wV,
        pointA: vec3(bestWitness.pa[0], bestWitness.pa[1], bestWitness.pa[2]),
        pointB: vec3(bestWitness.pb[0], bestWitness.pb[1], bestWitness.pb[2]),
        work,
      };
    }
    if (
      bestWitness &&
      Number.isFinite(bestUpper) &&
      separationThresholds.length > 0 &&
      thresholdsSeparatedForEarlyExit(globalLower, bestUpper)
    ) {
      return {
        ok: true,
        excluded: false,
        lowerM: globalLower,
        upperM: bestUpper,
        witnessU: bestWitness.wU,
        witnessV: bestWitness.wV,
        pointA: vec3(bestWitness.pa[0], bestWitness.pa[1], bestWitness.pa[2]),
        pointB: vec3(bestWitness.pb[0], bestWitness.pb[1], bestWitness.pb[2]),
        work,
      };
    }
    const cur = heapPop()!;
    if (cur.lower >= bestUpper) continue;
    let mAcur: number;
    let mBcur: number;
    if (cur.hasWitness) {
      const dA = Math.max(Math.abs(cur.wU - cur.u0), Math.abs(cur.wU - cur.u1));
      const dB = Math.max(Math.abs(cur.wV - cur.v0), Math.abs(cur.wV - cur.v1));
      mAcur = motionBoundForDeltaFast(invA, dA);
      mBcur = motionBoundForDeltaFast(invB, dB);
    } else {
      const umid = (cur.u0 + cur.u1) / 2;
      const vmid = (cur.v0 + cur.v1) / 2;
      const dA = Math.max(Math.abs(umid - cur.u0), Math.abs(umid - cur.u1));
      const dB = Math.max(Math.abs(vmid - cur.v0), Math.abs(vmid - cur.v1));
      mAcur = motionBoundForDeltaFast(invA, dA);
      mBcur = motionBoundForDeltaFast(invB, dB);
    }
    const splitU = mAcur >= mBcur;
    const midU = (cur.u0 + cur.u1) / 2;
    const midV = (cur.v0 + cur.v1) / 2;
    if (midU === cur.u0 || midV === cur.v0) {
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
    }
    const children: Array<[number, number, number, number]> = splitU
      ? [
          [cur.u0, midU, cur.v0, cur.v1],
          [midU, cur.u1, cur.v0, cur.v1],
        ]
      : [
          [cur.u0, cur.u1, cur.v0, midV],
          [cur.u0, cur.u1, midV, cur.v1],
        ];
    for (const [u0, u1, v0, v1] of children) {
      const ev = evaluate(u0, u1, v0, v1);
      if (ev.kind === "budget")
        return {
          ok: false,
          code: "CLEARANCE_UNCERTIFIED",
          message: "budget",
          work,
        };
      if (ev.kind === "excluded") continue;
      if (ev.kind === "needSubdivide" || ev.kind === "uncertain") {
        const ph: QueueNode = {
          u0,
          u1,
          v0,
          v1,
          lower: 0,
          upper: Infinity,
          wU: (u0 + u1) / 2,
          wV: (v0 + v1) / 2,
          pa: vec3(0, 0, 0),
          pb: vec3(0, 0, 0),
          seq: seq++,
          hasWitness: false,
        };
        if (ph.lower >= bestUpper) continue;
        if (!heapPush(ph))
          return {
            ok: false,
            code: "CLEARANCE_UNCERTIFIED",
            message: "budget",
            work,
          };
        continue;
      }
      if (ev.node.upper < bestUpper) {
        bestUpper = ev.node.upper;
        bestWitness = ev.node;
      }
      if (ev.node.lower >= bestUpper) continue;
      if (!heapPush(ev.node))
        return {
          ok: false,
          code: "CLEARANCE_UNCERTIFIED",
          message: "budget",
          work,
        };
    }
    if (work > opts.maxWork)
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
    if (heap.length > opts.maxWork)
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
  }
  // Invariant: heap empty implies every enqueued node's lower >= bestUpper was pruned,
  // or every split produced children that were either pruned or led to bestUpper.
  // Therefore the true global minimum is achieved at bestWitness, so globalLower = bestUpper
  // and width 0 <= resolution is proven. If heap empty but no witness, fail closed.
  if (bestWitness) {
    const globalLower = bestUpper;
    // Width 0 is proven <= resolution
    return {
      ok: true,
      excluded: false,
      lowerM: globalLower,
      upperM: bestUpper,
      witnessU: bestWitness.wU,
      witnessV: bestWitness.wV,
      pointA: vec3(bestWitness.pa[0], bestWitness.pa[1], bestWitness.pa[2]),
      pointB: vec3(bestWitness.pb[0], bestWitness.pb[1], bestWitness.pb[2]),
      work,
    };
  }
  return { ok: false, code: "CLEARANCE_UNCERTIFIED", message: "budget", work };
}
