import type { ParametricSpan } from "./spans";
import { vec3Length } from "./math";
import type { Vec3 } from "./math";

const nodes: readonly [number, number, number, number, number] = [
  0.0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664,
  0.906179845938664,
];
const weights: readonly [number, number, number, number, number] = [
  0.5688888888888889, 0.47862867049936647, 0.47862867049936647,
  0.23692688505618908, 0.23692688505618908,
];

export type PositionSpan = ParametricSpan<Vec3>;
const MIN_SPEED = 1e-12;
const REGULARITY_SEARCH_STEPS = 8;
const REGULARITY_ROOT_ITERATIONS = 50;
const MIN_NEWTON_SPEED = 1e-10;

const speed = (span: PositionSpan, u: number): number => {
  const value = vec3Length(span.derivative(u, 1));
  if (!Number.isFinite(value) || !(value > MIN_SPEED))
    throw new RangeError("A span derivative must be finite and non-zero");
  return value;
};
const speedSlope = (span: PositionSpan, u: number): number => {
  const first = span.derivative(u, 1);
  const value = vec3Length(first);
  if (!Number.isFinite(value) || !(value > MIN_SPEED))
    throw new RangeError("A span derivative must be finite and non-zero");
  const second = span.derivative(u, 2);
  const slope =
    first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  if (!Number.isFinite(slope))
    throw new RangeError("A span derivative must be finite and non-zero");
  return slope;
};
const hasOppositeSigns = (left: number, right: number): boolean =>
  (left < 0 && right > 0) || (left > 0 && right < 0);
const validateSpeedRegularity = (
  span: PositionSpan,
  start: number,
  end: number,
): void => {
  // This is a bounded search for the smooth analytic spans supported here;
  // opaque callbacks can still change between any two evaluated parameters.
  let previous = start;
  let previousSlope = speedSlope(span, previous);
  for (let step = 1; step <= REGULARITY_SEARCH_STEPS; step += 1) {
    const current = start + ((end - start) * step) / REGULARITY_SEARCH_STEPS;
    const currentSlope = speedSlope(span, current);
    if (previousSlope === 0) speed(span, previous);
    if (currentSlope === 0) speed(span, current);
    if (hasOppositeSigns(previousSlope, currentSlope)) {
      let low = previous;
      let high = current;
      let lowSlope = previousSlope;
      let root = (low + high) / 2;
      for (
        let iteration = 0;
        iteration < REGULARITY_ROOT_ITERATIONS;
        iteration += 1
      ) {
        root = (low + high) / 2;
        const rootSlope = speedSlope(span, root);
        if (rootSlope === 0) break;
        if (hasOppositeSigns(lowSlope, rootSlope)) high = root;
        else {
          low = root;
          lowSlope = rootSlope;
        }
      }
      speed(span, root);
    }
    previous = current;
    previousSlope = currentSlope;
  }
};
const gauss5 = (span: PositionSpan, a: number, b: number): number => {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  return (
    half *
    nodes.reduce(
      (sum, node, index) =>
        sum + weights[index]! * speed(span, mid + half * node),
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
    if (i > 0) {
      validateSpeedRegularity(span, parameters[i - 1]!, parameters[i]!);
      distances[i] =
        distances[i - 1]! +
        arcLength(
          span,
          parameters[i - 1]!,
          parameters[i]!,
          tolerance / segments,
        );
    }
  }
  return Object.freeze({
    parameters,
    distances,
    totalLength: distances[segments]!,
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
    lut.distances[lowIndex + 1]! < distance
  )
    lowIndex += 1;
  let low = lut.parameters[lowIndex]!;
  let high = lut.parameters[lowIndex + 1]!;
  let u =
    low +
    ((distance - lut.distances[lowIndex]!) /
      (lut.distances[lowIndex + 1]! - lut.distances[lowIndex]!)) *
      (high - low);
  const base = lut.distances[lowIndex]!;
  const baseParameter = lut.parameters[lowIndex]!;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const travelled = base + arcLength(span, baseParameter, u, 1e-11);
    const error = travelled - distance;
    if (Math.abs(error) < 1e-10 * Math.max(1, lut.totalLength)) return u;
    if (error > 0) high = u;
    else low = u;
    const derivative = speed(span, u);
    const candidate =
      Math.abs(derivative) > MIN_NEWTON_SPEED
        ? u - error / derivative
        : Number.NaN;
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
