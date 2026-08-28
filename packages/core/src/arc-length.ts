import type { ParametricSpan } from "./spans";
import { vec3Length } from "./math";
import type { Vec3 } from "./math";

const nodes = [
  0.0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664,
  0.906179845938664,
];
const weights = [
  0.5688888888888889, 0.47862867049936647, 0.47862867049936647,
  0.23692688505618908, 0.23692688505618908,
];

export type PositionSpan = ParametricSpan<Vec3>;
const speed = (span: PositionSpan, u: number): number =>
  vec3Length(span.derivative(u, 1));
const gauss5 = (span: PositionSpan, a: number, b: number): number => {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  return (
    half *
    nodes.reduce(
      (sum, node, index) =>
        sum + weights[index] * speed(span, mid + half * node),
      0,
    )
  );
};

const adaptive = (
  span: PositionSpan,
  a: number,
  b: number,
  tolerance: number,
  whole: number,
  depth: number,
): number => {
  const mid = (a + b) / 2;
  const left = gauss5(span, a, mid);
  const right = gauss5(span, mid, b);
  if (
    depth <= 0 ||
    Math.abs(left + right - whole) <= tolerance * (1 + Math.abs(left + right))
  )
    return left + right;
  return (
    adaptive(span, a, mid, tolerance / 2, left, depth - 1) +
    adaptive(span, mid, b, tolerance / 2, right, depth - 1)
  );
};

export const arcLength = (
  span: PositionSpan,
  a = 0,
  b = 1,
  tolerance = 1e-9,
): number => {
  if (b < a) return arcLength(span, b, a, tolerance);
  if (a === b) return 0;
  return adaptive(
    span,
    a,
    b,
    Math.max(tolerance, 1e-14),
    gauss5(span, a, b),
    18,
  );
};

export interface ArcLengthLut {
  readonly parameters: Float64Array;
  readonly distances: Float64Array;
  readonly totalLength: number;
}

export const buildArcLengthLut = (
  span: PositionSpan,
  segments = 128,
  tolerance = 1e-8,
): ArcLengthLut => {
  if (!Number.isInteger(segments) || segments < 1)
    throw new RangeError("LUT segments must be a positive integer");
  const parameters = new Float64Array(segments + 1);
  const distances = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i += 1) {
    parameters[i] = i / segments;
    if (i > 0)
      distances[i] =
        distances[i - 1] +
        arcLength(span, parameters[i - 1], parameters[i], tolerance / segments);
  }
  return Object.freeze({
    parameters,
    distances,
    totalLength: distances[segments],
  });
};

const invert = (
  span: PositionSpan,
  lut: ArcLengthLut,
  distance: number,
): number => {
  if (distance <= 0) return 0;
  if (distance >= lut.totalLength) return 1;
  let lowIndex = 0;
  while (
    lowIndex + 1 < lut.distances.length &&
    lut.distances[lowIndex + 1] < distance
  )
    lowIndex += 1;
  let low = lut.parameters[lowIndex];
  let high = lut.parameters[lowIndex + 1];
  let u =
    low +
    ((distance - lut.distances[lowIndex]) /
      (lut.distances[lowIndex + 1] - lut.distances[lowIndex])) *
      (high - low);
  const base = lut.distances[lowIndex];
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const travelled = base + arcLength(span, low, u, 1e-11);
    const error = travelled - distance;
    if (Math.abs(error) < 1e-10 * Math.max(1, lut.totalLength)) return u;
    if (error > 0) high = u;
    else low = u;
    const derivative = speed(span, u);
    const candidate = derivative > 1e-12 ? u - error / derivative : Number.NaN;
    u =
      Number.isFinite(candidate) && candidate > low && candidate < high
        ? candidate
        : (low + high) / 2;
  }
  return u;
};

export function invertArcLength(
  span: PositionSpan,
  lut: ArcLengthLut,
  distance: number,
): number;
export function invertArcLength(
  lut: ArcLengthLut,
  distance: number,
  span: PositionSpan,
): number;
export function invertArcLength(
  first: PositionSpan | ArcLengthLut,
  second: ArcLengthLut | number,
  third: number | PositionSpan,
): number {
  if ("position" in first)
    return invert(first, second as ArcLengthLut, third as number);
  return invert(third as PositionSpan, first, second as number);
}

export const arcLengthToParameter = invertArcLength;
export const integrateArcLength = arcLength;
export const buildArcLengthLUT = buildArcLengthLut;
