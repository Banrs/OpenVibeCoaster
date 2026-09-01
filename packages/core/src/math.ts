export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type Quaternion = Quat;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => Object.freeze([x, y, z]);
export const vec3Add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const vec3Sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vec3Scale = (a: Vec3, scale: number): Vec3 =>
  vec3(a[0] * scale, a[1] * scale, a[2] * scale);
export const vec3Dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vec3Cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
export const vec3LengthSquared = (a: Vec3): number => vec3Dot(a, a);
export const vec3Length = (a: Vec3): number => Math.sqrt(vec3LengthSquared(a));
export const vec3Distance = (a: Vec3, b: Vec3): number =>
  vec3Length(vec3Sub(a, b));
export const vec3Normalize = (a: Vec3): Vec3 => {
  const length = vec3Length(a);
  if (length < 1e-15) throw new RangeError("Cannot normalize a zero vector");
  return vec3Scale(a, 1 / length);
};
export const vec3Lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3Add(a, vec3Scale(vec3Sub(b, a), t));

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat =>
  Object.freeze([x, y, z, w]);
export const quatIdentity = (): Quat => quat();
export const quatNormalize = (q: Quat): Quat => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length < 1e-15)
    throw new RangeError("Cannot normalize a zero quaternion");
  return quat(q[0] / length, q[1] / length, q[2] / length, q[3] / length);
};
export const quatFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const half = angle / 2;
  const s = Math.sin(half);
  const n = vec3Normalize(axis);
  return quat(n[0] * s, n[1] * s, n[2] * s, Math.cos(half));
};
export const quatMultiply = (a: Quat, b: Quat): Quat =>
  quat(
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  );
export const quatConjugate = (q: Quat): Quat => quat(-q[0], -q[1], -q[2], q[3]);
export const quatRotateVector = (qInput: Quat, v: Vec3): Vec3 => {
  const q = quatNormalize(qInput);
  const p = quat(v[0], v[1], v[2], 0);
  const rotated = quatMultiply(quatMultiply(q, p), quatConjugate(q));
  return vec3(rotated[0], rotated[1], rotated[2]);
};
export const quaternionFromAxisAngle = quatFromAxisAngle;
export const rotateVector = quatRotateVector;

export const quatDot = (a: Quat, b: Quat): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export const quatSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let dot = quatDot(a, b);
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  dot = Math.min(1, Math.max(-1, dot));
  if (dot > 0.9995) {
    const inv = 1 - t;
    const q = quat(
      a[0] * inv + bx * t,
      a[1] * inv + by * t,
      a[2] * inv + bz * t,
      a[3] * inv + bw * t,
    );
    return quatNormalize(q);
  }
  const theta0 = Math.acos(dot);
  const sinTheta0 = Math.sin(theta0);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const s0 = Math.cos(theta) - dot * (sinTheta / sinTheta0);
  const s1 = sinTheta / sinTheta0;
  const q = quat(
    a[0] * s0 + bx * s1,
    a[1] * s0 + by * s1,
    a[2] * s0 + bz * s1,
    a[3] * s0 + bw * s1,
  );
  return quatNormalize(q);
};

export const quatFromFrame = (
  tangent: Vec3,
  normal: Vec3,
  binormal: Vec3,
): Quat => {
  const m00 = tangent[0];
  const m01 = normal[0];
  const m02 = binormal[0];
  const m10 = tangent[1];
  const m11 = normal[1];
  const m12 = binormal[1];
  const m20 = tangent[2];
  const m21 = normal[2];
  const m22 = binormal[2];
  const tr = m00 + m11 + m22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
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
  return quatNormalize(quat(x, y, z, w));
};

export const frameFromQuat = (
  qInput: Quat,
): { tangent: Vec3; normal: Vec3; binormal: Vec3 } => {
  const q = quatNormalize(qInput);
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y - z * w);
  const m02 = 2 * (x * z + y * w);
  const m10 = 2 * (x * y + z * w);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - x * w);
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  const tangent = vec3(m00, m10, m20);
  const normal = vec3(m01, m11, m21);
  const binormal = vec3(m02, m12, m22);
  return {
    tangent: vec3Normalize(tangent),
    normal: vec3Normalize(normal),
    binormal: vec3Normalize(binormal),
  };
};

export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}
export type AABB = Aabb;

export const aabb = (min: Vec3, max: Vec3): Aabb =>
  Object.freeze({ min: vec3(...min), max: vec3(...max) });
export const aabbFromPoints = (points: readonly Vec3[]): Aabb => {
  if (points.length === 0)
    throw new RangeError("An AABB needs at least one point");
  const min: [number, number, number] = [...points[0]!];
  const max: [number, number, number] = [...points[0]!];
  for (const point of points.slice(1)) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, point[i]!);
      max[i] = Math.max(max[i]!, point[i]!);
    }
  }
  return aabb(vec3(...min), vec3(...max));
};
export const aabbContains = (box: Aabb, point: Vec3): boolean =>
  point.every((value, i) => value >= box.min[i]! && value <= box.max[i]!);
export const aabbIntersects = (a: Aabb, b: Aabb): boolean =>
  a.min.every((value, i) => value <= b.max[i]! && a.max[i]! >= b.min[i]!);
