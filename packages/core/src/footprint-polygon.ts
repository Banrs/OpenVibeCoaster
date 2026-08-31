import { aabb, vec3 } from "./math";
import type { Aabb, Vec3 } from "./math";

export type FootprintPolygon = readonly Vec3[];

/** Scale-aware epsilon for XZ geometry. Deterministic. */
const epsForDiameter = (diameter: number): number =>
  Math.max(1e-12, diameter * 1e-9);

const diameterXZ = (polygon: readonly Vec3[]): number => {
  let maxSq = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = polygon[i]![0] - polygon[j]![0];
      const dz = polygon[i]![2] - polygon[j]![2];
      const d2 = dx * dx + dz * dz;
      if (d2 > maxSq) maxSq = d2;
    }
  }
  return Math.max(Math.sqrt(maxSq), 1);
};

const shoelaceAbsArea = (polygon: readonly Vec3[]): number => {
  // Translation-stable: compute relative to local origin (first vertex)
  const ox = polygon[0]![0];
  const oz = polygon[0]![2];
  let sum = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const ax = a[0] - ox;
    const az = a[2] - oz;
    const bx = b[0] - ox;
    const bz = b[2] - oz;
    sum += ax * bz - bx * az;
  }
  return Math.abs(sum) / 2;
};

export function validateFootprintPolygon(
  value: unknown,
  path = "footprint",
): FootprintPolygon {
  if (!Array.isArray(value)) throw new Error(`${path}: expected polygon array`);
  const n = value.length;
  if (n < 3) throw new Error(`${path}: expected at least 3 vertices, got ${n}`);
  if (n > 32)
    throw new Error(`${path}: expected at most 32 vertices, got ${n}`);
  const polygon: Vec3[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = (value as unknown[])[i];
    const p = `${path}[${i}]`;
    if (!Array.isArray(v) || v.length !== 3)
      throw new Error(`${p}: expected 3-vector`);
    const x = (v as unknown[])[0];
    const y = (v as unknown[])[1];
    const z = (v as unknown[])[2];
    if (typeof x !== "number" || !Number.isFinite(x))
      throw new Error(`${p}[0]: expected finite number`);
    if (typeof y !== "number" || !Number.isFinite(y))
      throw new Error(`${p}[1]: expected finite number`);
    if (typeof z !== "number" || !Number.isFinite(z))
      throw new Error(`${p}[2]: expected finite number`);
    polygon.push(vec3(x, y, z));
  }
  // characteristic length (rotation-invariant diameter) for tolerances
  const diameter = diameterXZ(polygon);
  const eps = epsForDiameter(diameter);
  const epsSq = eps * eps;

  // explicit repeated closing vertex: last XZ equals first XZ
  {
    const first = polygon[0]!;
    const last = polygon[polygon.length - 1]!;
    const dx = first[0] - last[0];
    const dz = first[2] - last[2];
    if (dx * dx + dz * dz <= epsSq)
      throw new Error(
        `${path}[${polygon.length - 1}]: explicit repeated closing vertex (duplicates ${path}[0] in X/Z)`,
      );
  }
  // zero-length projected edge (adjacent) before duplicate so adjacent collapse reports as zero-length
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    if (dx * dx + dz * dz <= epsSq)
      throw new Error(
        `${path}[${i}]: zero-length projected edge to ${path}[${(i + 1) % polygon.length}]`,
      );
  }
  // any duplicate projected X/Z vertex (nonadjacent now, adjacent already handled as zero-length)
  for (let i = 0; i < polygon.length; i += 1) {
    for (let j = i + 1; j < polygon.length; j += 1) {
      const dx = polygon[i]![0] - polygon[j]![0];
      const dz = polygon[i]![2] - polygon[j]![2];
      if (dx * dx + dz * dz <= epsSq)
        throw new Error(
          `${path}[${j}]: duplicate projected X/Z vertex duplicates ${path}[${i}]`,
        );
    }
  }
  // zero projected shoelace area (scale-aware, diameter^2)
  {
    const area = shoelaceAbsArea(polygon);
    const tol = Math.max(
      1e-12,
      diameter * diameter * Number.EPSILON * polygon.length * 4,
    );
    if (area <= tol) throw new Error(`${path}: zero projected shoelace area`);
  }

  const cross2D = (ax: number, az: number, bx: number, bz: number): number =>
    ax * bz - az * bx;
  const orient = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
  ): number => cross2D(bx - ax, bz - az, cx - ax, cz - az);

  const epsOrient = Math.max(1e-12, diameter * diameter * 1e-12);
  const isZero = (v: number): boolean => Math.abs(v) <= epsOrient;
  const sign = (v: number): number => (isZero(v) ? 0 : v > 0 ? 1 : -1);
  const onSegment = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
  ): boolean =>
    Math.min(ax, cx) - eps <= bx &&
    bx <= Math.max(ax, cx) + eps &&
    Math.min(az, cz) - eps <= bz &&
    bz <= Math.max(az, cz) + eps;

  // non-adjacent crossing/touching/overlapping + adjacent retracing
  const m = polygon.length;
  for (let i = 0; i < m; i += 1) {
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % m]!;
    for (let j = i + 1; j < m; j += 1) {
      const q1 = polygon[j]!;
      const q2 = polygon[(j + 1) % m]!;
      const adjacent = (i + 1) % m === j || (j + 1) % m === i;
      if (adjacent) {
        // adjacent overlapping/retracing beyond shared endpoint
        // check colinearity
        const rX = p2[0] - p1[0];
        const rZ = p2[2] - p1[2];
        const sX = q2[0] - q1[0];
        const sZ = q2[2] - q1[2];
        const crossRS = rX * sZ - rZ * sX;
        if (Math.abs(crossRS) <= epsOrient) {
          const crossQR = (q1[0] - p1[0]) * rZ - (q1[2] - p1[2]) * rX;
          // crossQR with sign? Use absolute
          if (Math.abs(crossQR) <= epsOrient) {
            // colinear adjacent
            const dot = rX * sX + rZ * sZ;
            if (dot < -epsSq) {
              throw new Error(
                `${path}: adjacent edges ${i} and ${j} overlapping/retracing beyond shared endpoint`,
              );
            }
          }
        }
        continue;
      }
      const o1 = orient(p1[0], p1[2], p2[0], p2[2], q1[0], q1[2]);
      const o2 = orient(p1[0], p1[2], p2[0], p2[2], q2[0], q2[2]);
      const o3 = orient(q1[0], q1[2], q2[0], q2[2], p1[0], p1[2]);
      const o4 = orient(q1[0], q1[2], q2[0], q2[2], p2[0], p2[2]);
      const s1 = sign(o1);
      const s2 = sign(o2);
      const s3 = sign(o3);
      const s4 = sign(o4);
      let intersect = false;
      if (s1 !== s2 && s3 !== s4) intersect = true;
      else {
        if (s1 === 0 && onSegment(p1[0], p1[2], q1[0], q1[2], p2[0], p2[2]))
          intersect = true;
        else if (
          s2 === 0 &&
          onSegment(p1[0], p1[2], q2[0], q2[2], p2[0], p2[2])
        )
          intersect = true;
        else if (
          s3 === 0 &&
          onSegment(q1[0], q1[2], p1[0], p1[2], q2[0], q2[2])
        )
          intersect = true;
        else if (
          s4 === 0 &&
          onSegment(q1[0], q1[2], p2[0], p2[2], q2[0], q2[2])
        )
          intersect = true;
      }
      if (intersect)
        throw new Error(
          `${path}: non-adjacent edges ${i} and ${j} crossing, touching, or overlapping`,
        );
    }
  }

  return Object.freeze(
    polygon.map((p) => Object.freeze([...p] as Vec3)),
  ) as FootprintPolygon;
}

const pointToSegmentDistanceXZ = (
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number => {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  if (!(len2 > 1e-18)) return Math.hypot(px - ax, pz - az);
  let t = (wx * vx + wz * vz) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * vx;
  const cz = az + t * vz;
  return Math.hypot(px - cx, pz - cz);
};

export function isPointInsidePolygon(
  polygon: FootprintPolygon,
  point: Vec3,
): boolean {
  if (
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    !Number.isFinite(point[2])
  )
    return false;
  const diameter = diameterXZ(polygon);
  const eps = epsForDiameter(diameter);
  const x = point[0];
  const z = point[2];
  const n = polygon.length;
  // boundary-first
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const d = pointToSegmentDistanceXZ(x, z, a[0], a[2], b[0], b[2]);
    if (d <= eps) return true;
  }
  // half-open ray to +X (boundary inclusive already handled)
  let inside = false;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const az = a[2];
    const bz = b[2];
    // half-open: (az > z) !== (bz > z)
    if (az > z !== bz > z) {
      const xinters = ((b[0] - a[0]) * (z - az)) / (bz - az) + a[0];
      if (xinters > x) inside = !inside;
      else if (Math.abs(xinters - x) <= eps) return true; // on boundary edge case
    }
  }
  return inside;
}

export function signedDistanceXZ(
  polygon: FootprintPolygon,
  point: Vec3,
): number {
  if (
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    !Number.isFinite(point[2])
  )
    return Number.NaN;
  const diameter = diameterXZ(polygon);
  const eps = epsForDiameter(diameter);
  const x = point[0];
  const z = point[2];
  let minDist = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const d = pointToSegmentDistanceXZ(x, z, a[0], a[2], b[0], b[2]);
    if (d < minDist) minDist = d;
  }
  if (minDist <= eps) return 0;
  const inside = isPointInsidePolygon(polygon, point);
  return inside ? -minDist : minDist;
}

export function footprintBounds(polygon: FootprintPolygon): Aabb {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]);
    maxZ = Math.max(maxZ, p[2]);
  }
  return aabb(vec3(minX, 0, minZ), vec3(maxX, 0, maxZ));
}

// --- Strict proof predicates (reuse internals, eps=0, fail-closed) ---

export function isPointInsidePolygonStrict(
  polygon: FootprintPolygon,
  point: Vec3,
): boolean {
  if (
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    !Number.isFinite(point[2])
  )
    return false;
  const x = point[0];
  const z = point[2];
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const d = pointToSegmentDistanceXZ(x, z, a[0], a[2], b[0], b[2]);
    if (d === 0) return true;
  }
  let inside = false;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const az = a[2];
    const bz = b[2];
    if (az > z !== bz > z) {
      const xinters = ((b[0] - a[0]) * (z - az)) / (bz - az) + a[0];
      if (xinters > x) inside = !inside;
    }
  }
  return inside;
}

export function signedDistanceStrictXZ(
  polygon: FootprintPolygon,
  point: Vec3,
): number {
  if (
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    !Number.isFinite(point[2])
  )
    return Number.NaN;
  const x = point[0];
  const z = point[2];
  let minDist = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const d = pointToSegmentDistanceXZ(x, z, a[0], a[2], b[0], b[2]);
    if (d < minDist) minDist = d;
  }
  if (minDist === 0) return 0;
  const inside = isPointInsidePolygonStrict(polygon, point);
  return inside ? -minDist : minDist;
}

export function segmentWithinPolygonStrict(
  polygon: FootprintPolygon,
  a: Vec3,
  b: Vec3,
): { readonly inside: boolean; readonly witness?: Vec3 } {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== 3 ||
    b.length !== 3 ||
    !Number.isFinite(a[0]) ||
    !Number.isFinite(a[1]) ||
    !Number.isFinite(a[2]) ||
    !Number.isFinite(b[0]) ||
    !Number.isFinite(b[1]) ||
    !Number.isFinite(b[2])
  ) {
    return { inside: false };
  }
  const ax = a[0];
  const az = a[2];
  const bx = b[0];
  const bz = b[2];
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) {
    const inside = isPointInsidePolygonStrict(polygon, a);
    if (inside) return { inside: true };
    return { inside: false, witness: vec3(ax, 0, az) };
  }
  // No epsOrient: exact zero only, fail-closed on ambiguous
  const tValues: number[] = [0, 1];
  const cross = (ux: number, uz: number, vx: number, vz: number): number =>
    ux * vz - uz * vx;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const q1 = polygon[i]!;
    const q2 = polygon[(i + 1) % n]!;
    const q1x = q1[0];
    const q1z = q1[2];
    const q2x = q2[0];
    const q2z = q2[2];
    const sX = q2x - q1x;
    const sZ = q2z - q1z;
    const rX = dx;
    const rZ = dz;
    const rxs = cross(rX, rZ, sX, sZ);
    const qpx = q1x - ax;
    const qpz = q1z - az;
    if (rxs === 0) {
      const qpr = cross(qpx, qpz, rX, rZ);
      if (qpr !== 0) continue;
      const dotRR = rX * rX + rZ * rZ;
      if (!(dotRR > 1e-18)) continue;
      const t1 = ((q1x - ax) * rX + (q1z - az) * rZ) / dotRR;
      const t2 = ((q2x - ax) * rX + (q2z - az) * rZ) / dotRR;
      const tMin = Math.min(t1, t2);
      const tMax = Math.max(t1, t2);
      const overlapMin = Math.max(0, tMin);
      const overlapMax = Math.min(1, tMax);
      if (overlapMax <= overlapMin) continue;
      if (overlapMin > 0 && overlapMin < 1) tValues.push(overlapMin);
      if (overlapMax > 0 && overlapMax < 1) tValues.push(overlapMax);
      continue;
    }
    const t = cross(qpx, qpz, sX, sZ) / rxs;
    const u = cross(qpx, qpz, rX, rZ) / rxs;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const ct = Math.max(0, Math.min(1, t));
      if (ct > 0 && ct < 1) tValues.push(ct);
    }
  }
  tValues.sort((l, r) => l - r);
  const dedup: number[] = [];
  for (const t of tValues) {
    if (dedup.length === 0 || t !== dedup[dedup.length - 1]!) dedup.push(t);
  }
  if (!isPointInsidePolygonStrict(polygon, a))
    return { inside: false, witness: vec3(ax, 0, az) };
  if (!isPointInsidePolygonStrict(polygon, b))
    return { inside: false, witness: vec3(bx, 0, bz) };
  for (let i = 0; i < dedup.length - 1; i += 1) {
    const t0 = dedup[i]!;
    const t1 = dedup[i + 1]!;
    const midT = (t0 + t1) / 2;
    if (!(midT > t0 && midT < t1)) continue;
    const mx = ax + midT * dx;
    const mz = az + midT * dz;
    const mid = vec3(mx, 0, mz);
    if (!isPointInsidePolygonStrict(polygon, mid))
      return { inside: false, witness: mid };
  }
  return { inside: true };
}

export function segmentWithinPolygon(
  polygon: FootprintPolygon,
  a: Vec3,
  b: Vec3,
): { readonly inside: boolean; readonly witness?: Vec3 } {
  // fail closed on nonfinite segment endpoints without NaN witness
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== 3 ||
    b.length !== 3 ||
    !Number.isFinite(a[0]) ||
    !Number.isFinite(a[1]) ||
    !Number.isFinite(a[2]) ||
    !Number.isFinite(b[0]) ||
    !Number.isFinite(b[1]) ||
    !Number.isFinite(b[2])
  ) {
    return { inside: false };
  }
  const diameter = diameterXZ(polygon);
  const eps = epsForDiameter(diameter);
  const ax = a[0];
  const az = a[2];
  const bx = b[0];
  const bz = b[2];
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const segLen = Math.sqrt(len2);
  // parametric tolerance derived from world epsilon divided by segment length, bounded safely
  const rawTEps = segLen > 1e-18 ? eps / segLen : 1e-12;
  const epsT = Math.max(1e-12, Math.min(rawTEps, 1e-3));
  const dedupEps = Math.max(epsT * 0.5, 1e-12);
  // degenerate point segment
  if (len2 <= eps * eps) {
    const inside = isPointInsidePolygon(polygon, a);
    if (inside) return { inside: true };
    return { inside: false, witness: vec3(ax, 0, az) };
  }

  // collect t parameters
  const tValues: number[] = [0, 1];

  const cross = (ux: number, uz: number, vx: number, vz: number): number =>
    ux * vz - uz * vx;

  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const q1 = polygon[i]!;
    const q2 = polygon[(i + 1) % n]!;
    const q1x = q1[0],
      q1z = q1[2],
      q2x = q2[0],
      q2z = q2[2];
    const sX = q2x - q1x;
    const sZ = q2z - q1z;
    const rX = dx;
    const rZ = dz;
    const rxs = cross(rX, rZ, sX, sZ);
    const qpx = q1x - ax;
    const qpz = q1z - az;
    const epsOrient = Math.max(1e-12, diameter * diameter * 1e-12);
    if (Math.abs(rxs) <= epsOrient) {
      // parallel
      const qpr = cross(qpx, qpz, rX, rZ);
      if (Math.abs(qpr) > epsOrient) continue; // parallel non-colinear
      // colinear overlapping
      // project q1 and q2 onto segment p
      const dotRR = rX * rX + rZ * rZ;
      if (!(dotRR > 1e-18)) continue;
      const t1 = ((q1x - ax) * rX + (q1z - az) * rZ) / dotRR;
      const t2 = ((q2x - ax) * rX + (q2z - az) * rZ) / dotRR;
      const tMin = Math.min(t1, t2);
      const tMax = Math.max(t1, t2);
      const overlapMin = Math.max(0, tMin);
      const overlapMax = Math.min(1, tMax);
      if (overlapMax <= overlapMin + epsT) continue;
      // add overlap endpoints if strictly interior
      if (overlapMin > epsT && overlapMin < 1 - epsT) tValues.push(overlapMin);
      if (overlapMax > epsT && overlapMax < 1 - epsT) tValues.push(overlapMax);
      continue;
    }
    const t = cross(qpx, qpz, sX, sZ) / rxs;
    const u = cross(qpx, qpz, rX, rZ) / rxs;
    // Use inclusive with eps
    if (t >= -epsT && t <= 1 + epsT && u >= -epsT && u <= 1 + epsT) {
      const ct = Math.max(0, Math.min(1, t));
      if (ct > epsT && ct < 1 - epsT) tValues.push(ct);
      else if (ct <= epsT) {
        // endpoint, already have 0
      } else if (ct >= 1 - epsT) {
        // endpoint 1
      }
    }
  }

  tValues.sort((l, r) => l - r);
  // deduplicate using parametric epsilon derived from world scale
  const dedup: number[] = [];
  for (const t of tValues) {
    if (dedup.length === 0 || Math.abs(t - dedup[dedup.length - 1]!) > dedupEps)
      dedup.push(t);
  }

  // test endpoints inclusive (boundary is inside)
  if (!isPointInsidePolygon(polygon, a))
    return { inside: false, witness: vec3(ax, 0, az) };
  if (!isPointInsidePolygon(polygon, b))
    return { inside: false, witness: vec3(bx, 0, bz) };

  for (let i = 0; i < dedup.length - 1; i += 1) {
    const t0 = dedup[i]!;
    const t1 = dedup[i + 1]!;
    const midT = (t0 + t1) / 2;
    if (!(midT > t0 && midT < t1)) continue;
    const mx = ax + midT * dx;
    const mz = az + midT * dz;
    const mid = vec3(mx, 0, mz);
    if (!isPointInsidePolygon(polygon, mid))
      return { inside: false, witness: mid };
  }
  return { inside: true };
}
