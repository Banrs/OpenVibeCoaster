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
