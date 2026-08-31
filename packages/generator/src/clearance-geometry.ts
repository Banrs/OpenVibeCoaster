import { vec3, type Vec3 } from "@openvibecoaster/core";
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
  return vec3(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}
function scale(a: Vec3, s: number): Vec3 {
  return vec3(a[0] * s, a[1] * s, a[2] * s);
}
function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
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
  const center = add(pp.position, scale(pp.normal, off));
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
function getVertices(box: OrientedBox): Vec3[] {
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
function pointToBoxClosest(p: Vec3, box: OrientedBox): Vec3 {
  const d = sub(p, box.center);
  let r = vec3(box.center[0], box.center[1], box.center[2]);
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!,
      proj = dot(d, ax),
      c = Math.max(-box.halfExtents[i]!, Math.min(box.halfExtents[i]!, proj));
    r = add(r, scale(ax, c));
  }
  return r;
}
function pointInBox(p: Vec3, box: OrientedBox, eps = 1e-9): boolean {
  const d = sub(p, box.center);
  for (let i = 0; i < 3; i += 1) {
    const proj = dot(d, box.axes[i]!);
    if (Math.abs(proj) > box.halfExtents[i]! + eps) return false;
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
  const EPS_F = 1e-12;
  for (let i = 0; i < 3; i += 1) {
    const ax = box.axes[i]!;
    const e = dot(ax, diff);
    const f = dot(ax, dir);
    const h = box.halfExtents[i]!;
    if (Math.abs(f) < EPS_F) {
      if (e < -h - 1e-9 || e > h + 1e-9) return null;
      continue;
    }
    let t1 = (-h - e) / f;
    let t2 = (h - e) / f;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax + 1e-12) return null;
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
  for (let axis = 0; axis < 3; axis += 1) {
    const others = [0, 1, 2].filter((v) => v !== axis);
    const o0 = others[0]!,
      o1 = others[1]!;
    for (const s0 of [-1, 1] as const)
      for (const s1 of [-1, 1] as const) {
        const p0 = add(
          add(box.center, scale(box.axes[o0]!, s0 * box.halfExtents[o0]!)),
          scale(box.axes[o1]!, s1 * box.halfExtents[o1]!),
        );
        edges.push([
          add(p0, scale(box.axes[axis]!, -box.halfExtents[axis]!)),
          add(p0, scale(box.axes[axis]!, box.halfExtents[axis]!)),
        ]);
      }
  }
  return edges;
}
export function segmentClosest(
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
  const axes: Vec3[] = [];
  for (let i = 0; i < 3; i += 1) axes.push(a.axes[i]!);
  for (let i = 0; i < 3; i += 1) axes.push(b.axes[i]!);
  for (let i = 0; i < 3; i += 1)
    for (let j = 0; j < 3; j += 1) {
      const cc = cross(a.axes[i]!, b.axes[j]!);
      const l2 = dot(cc, cc);
      if (l2 === 0) continue;
      axes.push(scale(cc, 1 / Math.sqrt(l2)));
    }
  const delta = sub(b.center, a.center);
  let separated = false;
  for (const ax of axes) {
    const l = len(ax);
    if (l === 0) continue;
    const n = scale(ax, 1 / l);
    let ra = 0;
    let rb = 0;
    for (let i = 0; i < 3; i += 1)
      ra += a.halfExtents[i]! * Math.abs(dot(n, a.axes[i]!));
    for (let i = 0; i < 3; i += 1)
      rb += b.halfExtents[i]! * Math.abs(dot(n, b.axes[i]!));
    if (Math.abs(dot(delta, n)) > ra + rb + 1e-9) separated = true;
  }
  if (!separated) {
    const vertsA = getVertices(a);
    for (const va of vertsA)
      if (pointInBox(va, b)) return { distance: 0, pointA: va, pointB: va };
    const vertsB = getVertices(b);
    for (const vb of vertsB)
      if (pointInBox(vb, a)) return { distance: 0, pointA: vb, pointB: vb };
    const edgesA = getEdges(a);
    for (const [p0, p1] of edgesA) {
      const ip = segmentObbIntersect(p0, p1, b);
      if (ip) return { distance: 0, pointA: ip, pointB: ip };
    }
    const edgesB = getEdges(b);
    for (const [q0, q1] of edgesB) {
      const ip = segmentObbIntersect(q0, q1, a);
      if (ip) return { distance: 0, pointA: ip, pointB: ip };
    }
    if (pointInBox(a.center, b))
      return { distance: 0, pointA: a.center, pointB: a.center };
    if (pointInBox(b.center, a))
      return { distance: 0, pointA: b.center, pointB: b.center };
    throw new RangeError("SAT intersect but no witness");
  }
  const cf = closestFeature(a, b);
  return { distance: cf.dist, pointA: cf.pa, pointB: cf.pb };
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
  for (const va of vertsA) {
    const cb = pointToBoxClosest(va, b);
    const d = len(sub(va, cb));
    if (d < bestDist) {
      bestDist = d;
      bestA = va;
      bestB = cb;
    }
  }
  for (const vb of vertsB) {
    const ca = pointToBoxClosest(vb, a);
    const d = len(sub(vb, ca));
    if (d < bestDist) {
      bestDist = d;
      bestA = ca;
      bestB = vb;
    }
  }
  const edgesA = getEdges(a);
  const edgesB = getEdges(b);
  for (const [p0, p1] of edgesA)
    for (const [q0, q1] of edgesB) {
      const seg = segmentClosest(p0, p1, q0, q1);
      if (seg.dist < bestDist) {
        bestDist = seg.dist;
        bestA = seg.pa;
        bestB = seg.pb;
      }
    }
  return { dist: bestDist, pa: bestA, pb: bestB };
}
type Quat = readonly [number, number, number, number];
function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (l < 1e-12) throw new RangeError("zero quat");
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l] as const;
}
function quatFromFrame(b: Vec3, n: Vec3, t: Vec3): Quat {
  const m00 = t[0],
    m01 = n[0],
    m02 = b[0];
  const m10 = t[1],
    m11 = n[1],
    m12 = b[1];
  const m20 = t[2],
    m21 = n[2],
    m22 = b[2];
  const tr = m00 + m11 + m22;
  let x = 0,
    y = 0,
    z = 0,
    w = 0;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return quatNormalize([x, y, z, w]);
}
function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}
function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = quatDot(a, b);
  let bx = b[0],
    by = b[1],
    bz = b[2],
    bw = b[3];
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  d = Math.max(-1, Math.min(1, d));
  if (d > 0.9995)
    return quatNormalize([
      a[0] + t * (bx - a[0]),
      a[1] + t * (by - a[1]),
      a[2] + t * (bz - a[2]),
      a[3] + t * (bw - a[3]),
    ]);
  const th0 = Math.acos(d),
    th = th0 * t,
    sTh = Math.sin(th),
    sTh0 = Math.sin(th0);
  const s0 = Math.cos(th) - (d * sTh) / sTh0,
    s1 = sTh / sTh0;
  return quatNormalize([
    a[0] * s0 + bx * s1,
    a[1] * s0 + by * s1,
    a[2] * s0 + bz * s1,
    a[3] * s0 + bw * s1,
  ]);
}
function quatToFrame(q: Quat): { b: Vec3; n: Vec3; t: Vec3 } {
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
  const qa = quatFromFrame(s.start.binormal, s.start.normal, s.start.tangent);
  const qb = quatFromFrame(s.end.binormal, s.end.normal, s.end.tangent);
  const q = quatSlerp(qa, qb, tt);
  const f = quatToFrame(q);
  return { position: pos, tangent: f.t, normal: f.n, binormal: f.b };
}
function conservativeRadius(g: ClearanceTrainGeometry): number {
  const hx = g.halfWidthM;
  const maxY = Math.max(g.aboveRailM, g.belowRailM);
  const hz = g.carPitchM / 2 + g.noseTailMarginM;
  return Math.sqrt(hx * hx + maxY * maxY + hz * hz);
}
function totalAngle(seg: SweptClearanceSegment): number {
  const qa = quatFromFrame(
    seg.start.binormal,
    seg.start.normal,
    seg.start.tangent,
  );
  const qb = quatFromFrame(seg.end.binormal, seg.end.normal, seg.end.tangent);
  const d = Math.abs(quatDot(qa, qb));
  return 2 * Math.acos(Math.max(-1, Math.min(1, d)));
}
function motionBoundForDelta(
  seg: SweptClearanceSegment,
  delta: number,
): number {
  const dPos = len(sub(seg.end.position, seg.start.position));
  const r = conservativeRadius(seg.geometry);
  const th = totalAngle(seg);
  const linear = dPos * delta;
  const angular = 2 * r * Math.sin((th * delta) / 2);
  const raw = linear + angular;
  const eps = 1e-12 * (1 + dPos + r) * (1 + th);
  return raw + eps + 1e-12;
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
export function openArcIntervalDistance(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): { min: number; max: number } {
  for (const v of [a0, a1, b0, b1] as const) finiteScalar(v, "arc");
  if (a0 > a1 || b0 > b1) throw new RangeError("interval must be ordered");
  const overlap = Math.max(a0, b0) <= Math.min(a1, b1);
  const min = overlap ? 0 : Math.min(Math.abs(b0 - a1), Math.abs(a0 - b1));
  const max = Math.max(
    Math.abs(a0 - b0),
    Math.abs(a0 - b1),
    Math.abs(a1 - b0),
    Math.abs(a1 - b1),
  );
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
  const min = contains(0) ? 0 : Math.min(fold(lo), fold(hi));
  const half = L / 2,
    max = contains(half) ? half : Math.max(fold(lo), fold(hi));
  return { min, max };
}
export function sweptAabb(seg: SweptClearanceSegment): {
  min: Vec3;
  max: Vec3;
} {
  const r = conservativeRadius(seg.geometry);
  return {
    min: vec3(
      Math.min(seg.start.position[0], seg.end.position[0]) - r,
      Math.min(seg.start.position[1], seg.end.position[1]) - r,
      Math.min(seg.start.position[2], seg.end.position[2]) - r,
    ),
    max: vec3(
      Math.max(seg.start.position[0], seg.end.position[0]) + r,
      Math.max(seg.start.position[1], seg.end.position[1]) + r,
      Math.max(seg.start.position[2], seg.end.position[2]) + r,
    ),
  };
}
function sInterval(
  s: SweptClearanceSegment,
  u0: number,
  u1: number,
): [number, number] {
  const a = s.startS + (s.endS - s.startS) * u0,
    b = s.startS + (s.endS - s.startS) * u1;
  return [Math.min(a, b), Math.max(a, b)];
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
  if (!closed) return Math.abs(sA - sB);
  const d = sA - sB;
  const r = ((d % L) + L) % L;
  return Math.min(r, L - r);
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
  // root wholly local check
  if (localityM !== undefined) {
    const [a0, a1] = sInterval(segA, 0, 1);
    const [b0, b1] = sInterval(segB, 0, 1);
    const d0 = closed
      ? closedArcIntervalDistance(a0, a1, b0, b1, trackLen)
      : openArcIntervalDistance(a0, a1, b0, b1);
    if (d0.max <= localityM + 1e-12) {
      return { ok: true, excluded: true, work: 0 };
    }
  }
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
  const queue: QueueNode[] = [];
  const push = (n: QueueNode): boolean => {
    if (queue.length >= opts.maxWork) return false;
    queue.push(n);
    queue.sort((x, y) =>
      x.lower === y.lower ? x.seq - y.seq : x.lower - y.lower,
    );
    return true;
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
    if (d.max <= localityM + 1e-12) return null;
    if (d.min > localityM + 1e-12)
      return { u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
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
      if (pd > localityM + 1e-12) return { u: cu, v: cv };
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
    | { kind: "budget" } => {
    const sample = findFeasibleSample(u0, u1, v0, v1);
    if (sample === null) {
      // check if wholly local already handled; if straddling with no feasible sample, need subdivide with lower 0
      const [a0, a1] = sInterval(segA, u0, u1);
      const [b0, b1] = sInterval(segB, v0, v1);
      const d = closed
        ? closedArcIntervalDistance(a0, a1, b0, b1, trackLen)
        : openArcIntervalDistance(a0, a1, b0, b1);
      if (d.max <= localityM! + 1e-12) return { kind: "excluded" };
      return { kind: "needSubdivide" };
    }
    if (work + 1 > opts.maxWork) return { kind: "budget" };
    if (queue.length >= opts.maxWork) return { kind: "budget" };
    work += 1;
    const boxA = createOrientedBox(
      interpolatePose(segA, sample.u),
      segA.geometry,
    );
    const boxB = createOrientedBox(
      interpolatePose(segB, sample.v),
      segB.geometry,
    );
    const sd = staticObbDistance(boxA, boxB);
    const deltaA = Math.max(Math.abs(sample.u - u0), Math.abs(sample.u - u1));
    const deltaB = Math.max(Math.abs(sample.v - v0), Math.abs(sample.v - v1));
    const mA = motionBoundForDelta(segA, deltaA);
    const mB = motionBoundForDelta(segB, deltaB);
    const lower = Math.max(0, sd.distance - mA - mB);
    const node: QueueNode = {
      u0,
      u1,
      v0,
      v1,
      lower,
      upper: sd.distance,
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
  if (rootEval.kind === "needSubdivide") {
    const midU = 0.5;
    const midV = 0.5;
    // Choose split dimension by larger motion potential from midpoint sample to interval
    const mA0 = motionBoundForDelta(segA, 0.5);
    const mB0 = motionBoundForDelta(segB, 0.5);
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
      if (ev.kind === "needSubdivide") {
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
        if (!push(ph))
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
      if (ev.node.lower < bestUpper - 1e-12) {
        if (!push(ev.node))
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
    if (!push(rootEval.node))
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
  }
  if (queue.length === 0) {
    if (bestWitness) {
      return {
        ok: true,
        excluded: false,
        lowerM: bestWitness.lower,
        upperM: bestWitness.upper,
        witnessU: bestWitness.wU,
        witnessV: bestWitness.wV,
        pointA: bestWitness.pa,
        pointB: bestWitness.pb,
        work,
      };
    }
    return {
      ok: false,
      code: "CLEARANCE_UNCERTIFIED",
      message: "budget",
      work,
    };
  }
  // best-first loop
  while (queue.length > 0) {
    const globalLower = queue[0]!.lower;
    if (bestWitness && bestUpper - globalLower <= opts.resolutionM + 1e-12) {
      return {
        ok: true,
        excluded: false,
        lowerM: globalLower,
        upperM: bestUpper,
        witnessU: bestWitness.wU,
        witnessV: bestWitness.wV,
        pointA: bestWitness.pa,
        pointB: bestWitness.pb,
        work,
      };
    }
    const cur = queue.shift()!;
    if (cur.hasWitness && cur.lower >= bestUpper - 1e-12) continue;
    if (!cur.hasWitness && cur.lower >= bestUpper - 1e-12) continue;
    // split cur
    // compute motion potentials for cur
    // Use deltas from its witness if has witness else from midpoint
    let mAcur: number;
    let mBcur: number;
    if (cur.hasWitness) {
      const dA = Math.max(Math.abs(cur.wU - cur.u0), Math.abs(cur.wU - cur.u1));
      const dB = Math.max(Math.abs(cur.wV - cur.v0), Math.abs(cur.wV - cur.v1));
      mAcur = motionBoundForDelta(segA, dA);
      mBcur = motionBoundForDelta(segB, dB);
    } else {
      const umid = (cur.u0 + cur.u1) / 2;
      const vmid = (cur.v0 + cur.v1) / 2;
      const dA = Math.max(Math.abs(umid - cur.u0), Math.abs(umid - cur.u1));
      const dB = Math.max(Math.abs(vmid - cur.v0), Math.abs(vmid - cur.v1));
      mAcur = motionBoundForDelta(segA, dA);
      mBcur = motionBoundForDelta(segB, dB);
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
      if (ev.kind === "needSubdivide") {
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
        if (ph.lower >= bestUpper - 1e-12) continue;
        if (!push(ph))
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
      if (ev.node.lower >= bestUpper - 1e-12) continue;
      if (!push(ev.node))
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
    if (queue.length > opts.maxWork)
      return {
        ok: false,
        code: "CLEARANCE_UNCERTIFIED",
        message: "budget",
        work,
      };
  }
  if (bestWitness) {
    const globalLower = bestUpper;
    if (bestUpper - globalLower <= opts.resolutionM + 1e-12) {
      return {
        ok: true,
        excluded: false,
        lowerM: globalLower,
        upperM: bestUpper,
        witnessU: bestWitness.wU,
        witnessV: bestWitness.wV,
        pointA: bestWitness.pa,
        pointB: bestWitness.pb,
        work,
      };
    }
  }
  return { ok: false, code: "CLEARANCE_UNCERTIFIED", message: "budget", work };
}
