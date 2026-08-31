import {
  buildArcLengthLut,
  checkedArcLength,
  invertArcLength,
} from "./arc-length";
import { TrackCompileError } from "./compile-error";
import { transportFramesAlongPath } from "./frames";
import { vec3, vec3Cross, vec3Dot, vec3Length, vec3Normalize } from "./math";
import { SeventhOrderHermiteSpan } from "./spans";
import type { Frame } from "./frames";
import type { Vec3 } from "./math";
import type { ParametricSpan } from "./spans";

export interface TrackElement {
  readonly id: string;
  readonly span: ParametricSpan<Vec3>;
  readonly bank?: ParametricSpan<number> | ((u: number) => number);
  readonly zones?: readonly string[];
}
export interface CompileTrackOptions {
  readonly samples?: number;
  readonly tolerance?: number;
  /**
   * Initial unbanked normal for RMF transport. This is part of the rotated
   * physical input: supply a rotated initialNormal together with rotated
   * geometry for equivariant compilation. When omitted, compilation uses the
   * existing deterministic world-axis default.
   */
  readonly initialNormal?: Vec3;
}

export const CANONICAL_TRACK_COMPILE_OPTIONS: Readonly<CompileTrackOptions> =
  Object.freeze({});

export { TrackCompileError };

const ADAPTIVE_MIN_SAMPLES_PER_ELEMENT = 32;
const ADAPTIVE_MAX_CHORD_ERROR_M = 0.0005;
const ADAPTIVE_MAX_DEPTH = 32;
const ADAPTIVE_MAX_SAMPLES_PER_ELEMENT = 65536;
const ADAPTIVE_MAX_TOTAL_SAMPLES = 262144;

// outward-rounded helpers for chord certificate
const arcBits = new DataView(new ArrayBuffer(8));
const nextUp = (value: number): number => {
  if (Number.isNaN(value))
    throw new TrackCompileError("INTEGRATION_FAILED", "nextUp received NaN");
  if (value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  arcBits.setFloat64(0, value, false);
  let word = arcBits.getBigUint64(0, false);
  word = value > 0 ? word + 1n : word - 1n;
  arcBits.setBigUint64(0, word, false);
  return arcBits.getFloat64(0, false);
};

const binomial = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
};

const restrictPowerCoefficients = (
  coefficients: readonly number[],
  a: number,
  b: number,
): number[] => {
  const w = b - a;
  const aPowers: number[] = [1];
  for (let i = 1; i < coefficients.length; i += 1)
    aPowers.push(aPowers[i - 1]! * a);
  const result: number[] = Array(coefficients.length).fill(0);
  for (let k = 0; k < coefficients.length; k += 1) {
    let sum = 0;
    const wPow = w ** k;
    for (let i = k; i < coefficients.length; i += 1) {
      sum += coefficients[i]! * binomial(i, k) * aPowers[i - k]!;
    }
    result[k] = wPow * sum;
  }
  return result;
};

const powerToBernstein = (q: readonly number[]): number[] => {
  const n = q.length - 1;
  const b: number[] = Array(n + 1).fill(0);
  for (let k = 0; k <= n; k += 1) {
    let acc = q[k]!;
    for (let j = 0; j < k; j += 1) {
      const sign = (k - j) % 2 === 0 ? 1 : -1;
      const mij = binomial(n, j) * binomial(n - j, k - j) * sign;
      acc -= b[j]! * mij;
    }
    const diag = binomial(n, k);
    if (diag === 0)
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        "Bernstein diagonal zero",
      );
    b[k] = acc / diag;
  }
  return b;
};

const chordErrorUpperBoundSeventhOrder = (
  span: SeventhOrderHermiteSpan<Vec3>,
  start: number,
  end: number,
): number => {
  if (!(start >= 0 && end <= 1 && start < end))
    throw new TrackCompileError("INTEGRATION_FAILED", "Invalid chord interval");
  const rows = span.coefficients as readonly (readonly number[])[];
  if (rows.length !== 3 || rows.some((r) => r.length !== 8))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Seventh-order coefficients invalid",
    );
  const restrictedRows = rows.map((row) =>
    restrictPowerCoefficients(row, start, end),
  );
  const bernsteinRows = restrictedRows.map((q) => powerToBernstein(q));
  // Reconstruct 8 control points
  const controls: Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    controls.push(
      vec3(bernsteinRows[0]![i]!, bernsteinRows[1]![i]!, bernsteinRows[2]![i]!),
    );
  }
  const p0 = controls[0]!;
  const p1 = controls[7]!;
  const v: Vec3 = vec3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const vDot = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (!(vDot > 1e-24)) {
    // degenerate segment: distance to p0
    let max = 0;
    for (let i = 1; i < 7; i += 1) {
      const d = Math.hypot(
        controls[i]![0] - p0[0],
        controls[i]![1] - p0[1],
        controls[i]![2] - p0[2],
      );
      const up = nextUp(d);
      if (up > max) max = up;
    }
    return max;
  }
  let max = 0;
  for (let i = 1; i < 7; i += 1) {
    const diff: Vec3 = vec3(
      controls[i]![0] - p0[0],
      controls[i]![1] - p0[1],
      controls[i]![2] - p0[2],
    );
    const t = (diff[0] * v[0] + diff[1] * v[1] + diff[2] * v[2]) / vDot;
    const clamped = Math.max(0, Math.min(1, t));
    const closest: Vec3 = vec3(
      p0[0] + v[0] * clamped,
      p0[1] + v[1] * clamped,
      p0[2] + v[2] * clamped,
    );
    const d = Math.hypot(
      controls[i]![0] - closest[0],
      controls[i]![1] - closest[1],
      controls[i]![2] - closest[2],
    );
    const up = nextUp(d);
    if (up > max) max = up;
  }
  return max;
};

const chordErrorUpperBound = (
  span: ParametricSpan<Vec3>,
  start: number,
  end: number,
  elementId: string,
): number => {
  if (span instanceof SeventhOrderHermiteSpan) {
    return chordErrorUpperBoundSeventhOrder(
      span as SeventhOrderHermiteSpan<Vec3>,
      start,
      end,
    );
  }
  const maybe = span as unknown as {
    chordErrorUpperBound?: (a: number, b: number) => number;
  };
  if (typeof maybe.chordErrorUpperBound === "function") {
    const value = maybe.chordErrorUpperBound(start, end);
    if (!Number.isFinite(value) || value < 0)
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        `Chord error certifier returned non-finite for ${elementId}`,
      );
    // outward round
    return nextUp(value);
  }
  throw new TrackCompileError(
    "UNBOUNDED_SPAN",
    `Span ${elementId} has no chord error certificate`,
  );
};

const checkedSpeedLocal = (span: ParametricSpan<Vec3>, u: number): number => {
  let d: Vec3;
  try {
    d = span.derivative(u, 1);
  } catch (error) {
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Span derivative must be finite 3-vector",
    );
  const v = Math.hypot(d[0], d[1], d[2]);
  if (!Number.isFinite(v) || !(v > 1e-12))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "A span derivative must be finite and non-zero",
    );
  return v;
};

const buildCheckedLut = (
  span: ParametricSpan<Vec3>,
  segments = 32,
): {
  parameters: Float64Array;
  distances: Float64Array;
  totalLength: number;
} => {
  if (!Number.isInteger(segments) || segments < 1)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "LUT segments must be positive integer",
    );
  const parameters = new Float64Array(segments + 1);
  const distances = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i += 1) {
    parameters[i] = i / segments;
    if (i > 0) {
      const segLen = checkedArcLength(
        span,
        parameters[i - 1]!,
        parameters[i]!,
        1e-9,
      );
      distances[i] = distances[i - 1]! + segLen;
    }
  }
  return { parameters, distances, totalLength: distances[segments]! };
};

const checkedInvertWithLut = (
  span: ParametricSpan<Vec3>,
  target: number,
  lut: {
    parameters: Float64Array;
    distances: Float64Array;
    totalLength: number;
  },
  tolerance = 1e-10,
): number => {
  if (!Number.isFinite(target))
    throw new TrackCompileError(
      "INVERSION_FAILED",
      "Target distance must be finite",
    );
  if (target <= 0) return 0;
  if (target >= lut.totalLength) return 1;
  // binary search for bracket
  let lowIdx = 0;
  let highIdx = lut.distances.length - 1;
  while (lowIdx + 1 < highIdx) {
    const mid = Math.floor((lowIdx + highIdx) / 2);
    if (lut.distances[mid]! <= target) lowIdx = mid;
    else highIdx = mid;
  }
  let low = lut.parameters[lowIdx]!;
  let high = lut.parameters[lowIdx + 1]!;
  let lowDist = lut.distances[lowIdx]!;
  let highDist = lut.distances[lowIdx + 1]!;
  let u = low + ((target - lowDist) / (highDist - lowDist)) * (high - low);
  if (!Number.isFinite(u)) u = (low + high) / 2;
  u = Math.max(low, Math.min(high, u));
  for (let iter = 0; iter < 30; iter += 1) {
    const travelled = lowDist + checkedArcLength(span, low, u, 1e-11);
    const error = travelled - target;
    if (!Number.isFinite(error))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion error non-finite",
      );
    if (Math.abs(error) <= tolerance * Math.max(1, lut.totalLength)) return u;
    if (error > 0) {
      high = u;
      highDist = travelled;
    } else {
      low = u;
      lowDist = travelled;
    }
    if (!(high > low))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion bracket collapsed",
      );
    if (high - low < 1e-14)
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion reached parameter resolution",
      );
    let speed: number;
    try {
      speed = checkedSpeedLocal(span, u);
    } catch {
      speed = Number.NaN;
    }
    const candidate =
      Number.isFinite(speed) && Math.abs(speed) > 1e-10
        ? u - error / speed
        : Number.NaN;
    if (Number.isFinite(candidate) && candidate > low && candidate < high)
      u = candidate;
    else u = (low + high) / 2;
    if (!Number.isFinite(u))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion candidate non-finite",
      );
  }
  throw new TrackCompileError(
    "INVERSION_FAILED",
    "Arc length inversion failed to converge",
  );
};
export interface CompiledTrackDataInput {
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly distances: Float64Array;
  readonly curvature: Float64Array;
  readonly curvatureVector: Float64Array;
  readonly bank: Float64Array;
  readonly bankDerivative: Float64Array;
  readonly zoneMasks: Uint32Array;
  readonly zoneNames: readonly string[];
  readonly elementIndices: Uint32Array;
  readonly elementBoundaries: Uint32Array;
  readonly parameters: Float64Array;
  readonly totalLength: number;
}
type CompiledTrackStorage = Omit<
  CompiledTrackDataInput,
  "zoneNames" | "totalLength"
>;

const readVec3 = (array: Float64Array, index: number): Vec3 =>
  vec3(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
const writeVec3 = (array: Float64Array, index: number, value: Vec3): void => {
  array[index * 3] = value[0];
  array[index * 3 + 1] = value[1];
  array[index * 3 + 2] = value[2];
};
const encodeUtf8 = (text: string): Uint8Array => {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(bytes);
};
const hashText = (text: string): string => {
  const bytes = encodeUtf8(text);
  const hash = bytes.reduce(
    (value, byte) => Math.imul(value ^ byte, 0x01000193),
    0x811c9dc5,
  );
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const spanSpeed = (span: ParametricSpan<Vec3>, u: number): number => {
  const derivative = span.derivative(u, 1);
  return Math.hypot(derivative[0], derivative[1], derivative[2]);
};
const requireValidSpeed = (value: number): number => {
  if (!Number.isFinite(value) || !(value > 1e-12))
    throw new RangeError("A span derivative must be finite and non-zero");
  return value;
};
const validSpanSpeed = (span: ParametricSpan<Vec3>, u: number): number => {
  return requireValidSpeed(spanSpeed(span, u));
};
const invalidCompiledTrackData = (reason: string): never => {
  throw new RangeError(`Invalid compiled track data: ${reason}`);
};
const requireFloat64Array = (
  input: Record<string, unknown>,
  name: string,
): Float64Array => {
  const value = input[name];
  if (!(value instanceof Float64Array))
    invalidCompiledTrackData(`${name} must be a Float64Array`);
  return value as Float64Array;
};
const requireUint32Array = (
  input: Record<string, unknown>,
  name: string,
): Uint32Array => {
  const value = input[name];
  if (!(value instanceof Uint32Array))
    invalidCompiledTrackData(`${name} must be a Uint32Array`);
  return value as Uint32Array;
};
const validateFiniteArray = (array: Float64Array, name: string): void => {
  for (let index = 0; index < array.length; index += 1)
    if (!Number.isFinite(array[index]))
      invalidCompiledTrackData(`${name}[${index}] must be finite`);
};
const minimumInterpolatedTangentLength = (left: Vec3, right: Vec3): number => {
  const delta = [
    right[0] - left[0],
    right[1] - left[1],
    right[2] - left[2],
  ] as const;
  const denominator = vec3Dot(delta, delta);
  const parameter =
    denominator > 0
      ? Math.max(0, Math.min(1, -vec3Dot(left, delta) / denominator))
      : 0;
  return Math.hypot(
    left[0] + delta[0] * parameter,
    left[1] + delta[1] * parameter,
    left[2] + delta[2] * parameter,
  );
};
const validateCompiledTrackDataInput: (
  value: unknown,
) => asserts value is CompiledTrackDataInput = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidCompiledTrackData("input must be an object");
  const input = value as Record<string, unknown>;
  const positions = requireFloat64Array(input, "positions");
  const tangents = requireFloat64Array(input, "tangents");
  const normals = requireFloat64Array(input, "normals");
  const binormals = requireFloat64Array(input, "binormals");
  const distances = requireFloat64Array(input, "distances");
  const curvature = requireFloat64Array(input, "curvature");
  const curvatureVector = requireFloat64Array(input, "curvatureVector");
  const bank = requireFloat64Array(input, "bank");
  const bankDerivative = requireFloat64Array(input, "bankDerivative");
  const zoneMasks = requireUint32Array(input, "zoneMasks");
  const elementIndices = requireUint32Array(input, "elementIndices");
  const elementBoundaries = requireUint32Array(input, "elementBoundaries");
  const parameters = requireFloat64Array(input, "parameters");
  const zoneNames = input.zoneNames;
  if (!Array.isArray(zoneNames) || zoneNames.length > 32)
    invalidCompiledTrackData(
      "zoneNames must be an array with at most 32 names",
    );
  const names = zoneNames as unknown[];
  const uniqueNames = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== "string" || uniqueNames.has(name))
      invalidCompiledTrackData(`zoneNames[${index}] must be a unique string`);
    uniqueNames.add(name as string);
  }
  if (positions.length === 0 || positions.length % 3 !== 0)
    invalidCompiledTrackData("positions must contain at least one 3-vector");
  const count = positions.length / 3;
  if (count < 2) invalidCompiledTrackData("at least two samples are required");
  const vectorArrays: readonly (readonly [string, Float64Array])[] = [
    ["positions", positions],
    ["tangents", tangents],
    ["normals", normals],
    ["binormals", binormals],
    ["curvatureVector", curvatureVector],
  ];
  for (const [name, array] of vectorArrays) {
    if (array.length !== count * 3)
      invalidCompiledTrackData(`${name} length must be 3 * sample count`);
    validateFiniteArray(array, name);
  }
  const scalarArrays: readonly (readonly [string, Float64Array])[] = [
    ["distances", distances],
    ["curvature", curvature],
    ["bank", bank],
    ["bankDerivative", bankDerivative],
    ["parameters", parameters],
  ];
  for (const [name, array] of scalarArrays) {
    if (array.length !== count)
      invalidCompiledTrackData(`${name} length must equal sample count`);
    validateFiniteArray(array, name);
  }
  for (let index = 0; index < curvature.length; index += 1)
    if (curvature[index]! < 0)
      invalidCompiledTrackData(`curvature[${index}] must be non-negative`);
  if (zoneMasks.length !== count || elementIndices.length !== count)
    invalidCompiledTrackData("per-sample index and mask lengths must match");
  if (
    !(typeof input.totalLength === "number") ||
    !Number.isFinite(input.totalLength)
  )
    invalidCompiledTrackData("totalLength must be finite");
  const totalLength = input.totalLength as number;
  if (!(totalLength > 0))
    invalidCompiledTrackData("totalLength must be positive");
  if (distances[0] !== 0)
    invalidCompiledTrackData("distances must start at zero");
  for (let index = 1; index < distances.length; index += 1)
    if (!(distances[index]! > distances[index - 1]!))
      invalidCompiledTrackData("distances must be strictly increasing");
  if (
    Math.abs(distances[count - 1]! - totalLength) >
    1e-9 * Math.max(1, Math.abs(totalLength))
  )
    invalidCompiledTrackData("last distance must equal totalLength");
  for (let index = 0; index < parameters.length; index += 1)
    if (parameters[index]! < 0 || parameters[index]! > 1)
      invalidCompiledTrackData(`parameters[${index}] must be in [0, 1]`);
  if (elementBoundaries.length === 0 || elementBoundaries.length % 2 !== 0)
    invalidCompiledTrackData("elementBoundaries must contain start/end pairs");
  const elementCount = elementBoundaries.length / 2;
  if (elementCount === 0 || elementBoundaries[0] !== 0)
    invalidCompiledTrackData("elementBoundaries must start at sample zero");
  if (elementBoundaries[elementBoundaries.length - 1] !== count - 1)
    invalidCompiledTrackData("elementBoundaries must end at the last sample");
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const start = elementBoundaries[elementIndex * 2]!;
    const end = elementBoundaries[elementIndex * 2 + 1]!;
    if (start >= end || end >= count)
      invalidCompiledTrackData(`elementBoundaries[${elementIndex}] is invalid`);
    if (elementIndex > 0 && start !== elementBoundaries[elementIndex * 2 - 1])
      invalidCompiledTrackData("elementBoundaries must be contiguous");
  }
  for (let index = 0; index < elementIndices.length; index += 1) {
    const elementIndex = elementIndices[index]!;
    if (elementIndex >= elementCount)
      invalidCompiledTrackData(`elementIndices[${index}] is out of range`);
    const start = elementBoundaries[elementIndex * 2]!;
    const end = elementBoundaries[elementIndex * 2 + 1]!;
    const firstOwnedSample = elementIndex === 0 ? start : start + 1;
    if (index < firstOwnedSample || index > end)
      invalidCompiledTrackData(
        `elementIndices[${index}] disagrees with boundaries`,
      );
  }
  for (let index = 0; index < zoneMasks.length; index += 1)
    if (names.length < 32 && zoneMasks[index]! >>> names.length !== 0)
      invalidCompiledTrackData(`zoneMasks[${index}] contains unknown zones`);
  for (let index = 1; index < count; index += 1) {
    const previous = readVec3(tangents, index - 1);
    const current = readVec3(tangents, index);
    if (minimumInterpolatedTangentLength(previous, current) < 1e-12)
      invalidCompiledTrackData(
        `adjacent tangent interpolation must remain non-zero between samples ${index - 1} and ${index}`,
      );
  }
  for (let index = 0; index < count; index += 1) {
    const tangent = readVec3(tangents, index);
    const normal = readVec3(normals, index);
    const binormal = readVec3(binormals, index);
    if (
      Math.abs(vec3Length(tangent) - 1) > 1e-8 ||
      Math.abs(vec3Length(normal) - 1) > 1e-8 ||
      Math.abs(vec3Length(binormal) - 1) > 1e-8 ||
      Math.abs(vec3Dot(tangent, normal)) > 1e-8 ||
      Math.abs(vec3Dot(tangent, binormal)) > 1e-8 ||
      Math.abs(vec3Dot(normal, binormal)) > 1e-8 ||
      Math.abs(vec3Dot(vec3Cross(tangent, normal), binormal) - 1) > 1e-8
    )
      invalidCompiledTrackData(`frame at sample ${index} is not orthonormal`);
  }
};
const checksum = (data: CompiledTrackDataInput): string => {
  const canonical = JSON.stringify({
    positions: Array.from(data.positions),
    tangents: Array.from(data.tangents),
    normals: Array.from(data.normals),
    binormals: Array.from(data.binormals),
    distances: Array.from(data.distances),
    curvature: Array.from(data.curvature),
    curvatureVector: Array.from(data.curvatureVector),
    bank: Array.from(data.bank),
    bankDerivative: Array.from(data.bankDerivative),
    zoneMasks: Array.from(data.zoneMasks),
    zoneNames: [...data.zoneNames],
    elementIndices: Array.from(data.elementIndices),
    elementBoundaries: Array.from(data.elementBoundaries),
    parameters: Array.from(data.parameters),
    totalLength: data.totalLength,
  });
  return hashText(canonical);
};

const compiledTrackStorage = new WeakMap<
  CompiledTrackData,
  CompiledTrackStorage
>();

export class CompiledTrackData {
  readonly #positions: Float64Array;
  readonly #tangents: Float64Array;
  readonly #normals: Float64Array;
  readonly #binormals: Float64Array;
  readonly #distances: Float64Array;
  readonly #curvature: Float64Array;
  readonly #curvatureVector: Float64Array;
  readonly #bank: Float64Array;
  readonly #bankDerivative: Float64Array;
  readonly #zoneMasks: Uint32Array;
  readonly #zoneNames: readonly string[];
  readonly #elementIndices: Uint32Array;
  readonly #elementBoundaries: Uint32Array;
  readonly #parameters: Float64Array;
  public readonly totalLength: number;
  public readonly checksum: string;

  public constructor(input: CompiledTrackDataInput) {
    validateCompiledTrackDataInput(input);
    this.#positions = new Float64Array(input.positions);
    this.#tangents = new Float64Array(input.tangents);
    this.#normals = new Float64Array(input.normals);
    this.#binormals = new Float64Array(input.binormals);
    this.#distances = new Float64Array(input.distances);
    this.#curvature = new Float64Array(input.curvature);
    this.#curvatureVector = new Float64Array(input.curvatureVector);
    this.#bank = new Float64Array(input.bank);
    this.#bankDerivative = new Float64Array(input.bankDerivative);
    this.#zoneMasks = new Uint32Array(input.zoneMasks);
    this.#zoneNames = Object.freeze([...input.zoneNames]);
    this.#elementIndices = new Uint32Array(input.elementIndices);
    this.#elementBoundaries = new Uint32Array(input.elementBoundaries);
    this.#parameters = new Float64Array(input.parameters);
    this.totalLength = input.totalLength;
    this.checksum = checksum({
      positions: this.#positions,
      tangents: this.#tangents,
      normals: this.#normals,
      binormals: this.#binormals,
      distances: this.#distances,
      curvature: this.#curvature,
      curvatureVector: this.#curvatureVector,
      bank: this.#bank,
      bankDerivative: this.#bankDerivative,
      zoneMasks: this.#zoneMasks,
      zoneNames: this.#zoneNames,
      elementIndices: this.#elementIndices,
      elementBoundaries: this.#elementBoundaries,
      parameters: this.#parameters,
      totalLength: this.totalLength,
    });
    compiledTrackStorage.set(this, {
      positions: this.#positions,
      tangents: this.#tangents,
      normals: this.#normals,
      binormals: this.#binormals,
      distances: this.#distances,
      curvature: this.#curvature,
      curvatureVector: this.#curvatureVector,
      bank: this.#bank,
      bankDerivative: this.#bankDerivative,
      zoneMasks: this.#zoneMasks,
      elementIndices: this.#elementIndices,
      elementBoundaries: this.#elementBoundaries,
      parameters: this.#parameters,
    });
    Object.freeze(this);
  }

  public get positions(): Float64Array {
    return new Float64Array(this.#positions);
  }
  public get tangents(): Float64Array {
    return new Float64Array(this.#tangents);
  }
  public get normals(): Float64Array {
    return new Float64Array(this.#normals);
  }
  public get binormals(): Float64Array {
    return new Float64Array(this.#binormals);
  }
  public get distances(): Float64Array {
    return new Float64Array(this.#distances);
  }
  public get curvature(): Float64Array {
    return new Float64Array(this.#curvature);
  }
  public get curvatureVector(): Float64Array {
    return new Float64Array(this.#curvatureVector);
  }
  public get bank(): Float64Array {
    return new Float64Array(this.#bank);
  }
  public get bankDerivative(): Float64Array {
    return new Float64Array(this.#bankDerivative);
  }
  public get zoneMasks(): Uint32Array {
    return new Uint32Array(this.#zoneMasks);
  }
  public get zoneNames(): readonly string[] {
    return [...this.#zoneNames];
  }
  public get elementIndices(): Uint32Array {
    return new Uint32Array(this.#elementIndices);
  }
  public get elementBoundaries(): Uint32Array {
    return new Uint32Array(this.#elementBoundaries);
  }
  public get parameters(): Float64Array {
    return new Float64Array(this.#parameters);
  }
}
const bankValue = (element: TrackElement, u: number): number =>
  typeof element.bank === "function"
    ? element.bank(u)
    : (element.bank?.position(u) ?? 0);
const bankDerivative = (element: TrackElement, u: number): number =>
  typeof element.bank === "function"
    ? (() => {
        const low = Math.max(0, u - 1e-5);
        const high = Math.min(1, u + 1e-5);
        return (element.bank(high) - element.bank(low)) / (high - low);
      })()
    : (element.bank?.derivative(u, 1) ?? 0);

const compileTrackFixed = (
  elements: readonly TrackElement[],
  options: CompileTrackOptions,
): CompiledTrackData => {
  const perElement = Math.max(2, Math.floor(options.samples!));
  const count = elements.length * (perElement - 1) + 1;
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  const elementIndices = new Uint32Array(count);
  const elementBoundaries = new Uint32Array(elements.length * 2);
  const parameters = new Float64Array(count);
  const localDistances = new Float64Array(count);
  const speeds = new Float64Array(count);
  const banks = new Float64Array(count);
  const bankDerivatives = new Float64Array(count);
  const zoneSets = new Set<string>();
  for (const element of elements)
    for (const zone of element.zones ?? []) zoneSets.add(zone);
  const zoneNames = [...zoneSets];
  const luts = elements.map((element) => {
    validSpanSpeed(element.span, 0);
    validSpanSpeed(element.span, 1);
    return buildArcLengthLut(
      element.span,
      Math.max(32, Math.min(64, perElement)),
      options.tolerance ?? 1e-8,
    );
  });
  const offsets = new Float64Array(elements.length + 1);
  for (let index = 0; index < elements.length; index += 1)
    offsets[index + 1] = offsets[index]! + luts[index]!.totalLength;
  for (
    let elementIndex = 0;
    elementIndex < elements.length;
    elementIndex += 1
  ) {
    const element = elements[elementIndex]!;
    const lut = luts[elementIndex]!;
    const startIndex = elementIndex * (perElement - 1);
    elementBoundaries[elementIndex * 2] = startIndex;
    elementBoundaries[elementIndex * 2 + 1] = startIndex + perElement - 1;
    for (let sample = 0; sample < perElement; sample += 1) {
      if (elementIndex > 0 && sample === 0) continue;
      const index = startIndex + sample;
      const u =
        sample === 0 || sample === perElement - 1
          ? sample / (perElement - 1)
          : invertArcLength(
              element.span,
              lut,
              (lut.totalLength * sample) / (perElement - 1),
            );
      localDistances[index] = (lut.totalLength * sample) / (perElement - 1);
      writeVec3(positions, index, element.span.position(u));
      const d1 = element.span.derivative(u, 1);
      speeds[index] = requireValidSpeed(Math.hypot(d1[0], d1[1], d1[2]));
      writeVec3(tangents, index, vec3Normalize(d1));
      parameters[index] = u;
      elementIndices[index] = elementIndex;
      banks[index] = bankValue(element, u);
    }
  }
  const frameInputs = Array.from({ length: count }, (_, index) =>
    readVec3(tangents, index),
  );
  const frameParameters = Array.from(
    { length: count },
    (_, index) => index / (count - 1),
  );
  const pathPositions = Array.from({ length: count }, (_, index) =>
    readVec3(positions, index),
  );
  const frames: readonly Frame[] = transportFramesAlongPath(
    pathPositions,
    frameInputs,
    frameParameters,
    banks,
    options.initialNormal,
  );
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const distances = new Float64Array(count);
  const curvature = new Float64Array(count);
  const curvatureVector = new Float64Array(count * 3);
  const zoneMasks = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const frame = frames[index]!;
    writeVec3(normals, index, frame.normal);
    writeVec3(binormals, index, frame.binormal);
    const elementIndex = elementIndices[index]!;
    distances[index] = offsets[elementIndex]! + localDistances[index]!;
    const element = elements[elementIndex]!;
    const u = parameters[index]!;
    const d1 = element.span.derivative(u, 1);
    const d2 = element.span.derivative(u, 2);
    const speed = speeds[index]!;
    const speedSquared = speed ** 2;
    const tangentSpeedDerivative =
      (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / speed;
    const vector = vec3(
      d2[0] / speedSquared - (d1[0] * tangentSpeedDerivative) / speed ** 3,
      d2[1] / speedSquared - (d1[1] * tangentSpeedDerivative) / speed ** 3,
      d2[2] / speedSquared - (d1[2] * tangentSpeedDerivative) / speed ** 3,
    );
    writeVec3(curvatureVector, index, vector);
    curvature[index] = Math.hypot(vector[0], vector[1], vector[2]);
    bankDerivatives[index] = bankDerivative(element, u) / speeds[index]!;
    for (const zone of element.zones ?? [])
      zoneMasks[index] = zoneMasks[index]! | (1 << zoneNames.indexOf(zone));
  }
  return new CompiledTrackData({
    positions,
    tangents,
    normals,
    binormals,
    distances,
    curvature,
    curvatureVector,
    bank: banks,
    bankDerivative: bankDerivatives,
    zoneMasks,
    zoneNames: Object.freeze(zoneNames),
    elementIndices,
    elementBoundaries,
    parameters,
    totalLength: offsets[elements.length]!,
  });
};

const compileTrackAdaptive = (
  elements: readonly TrackElement[],
  options: CompileTrackOptions,
): CompiledTrackData => {
  // Early total budget check using minimum samples (avoids heavy work for huge element counts)
  const minTotal =
    elements.length * ADAPTIVE_MIN_SAMPLES_PER_ELEMENT - (elements.length - 1);
  if (minTotal > ADAPTIVE_MAX_TOTAL_SAMPLES)
    throw new TrackCompileError(
      "BUDGET_EXCEEDED",
      `Track minimum ${minTotal} exceeds total ${ADAPTIVE_MAX_TOTAL_SAMPLES}`,
    );
  // First pass: determine variable sample layouts via checked adaptive subdivision
  const perElementUs: number[][] = [];
  const perElementSs: number[][] = [];
  const perElementLengths: number[] = [];
  for (const element of elements) {
    validSpanSpeed(element.span, 0);
    validSpanSpeed(element.span, 1);
  }
  for (const element of elements) {
    const lut = buildCheckedLut(element.span, 32);
    const L = lut.totalLength;
    if (!Number.isFinite(L) || !(L > 0))
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        `Element ${element.id} has non-positive length`,
      );
    perElementLengths.push(L);
    const seedCount = ADAPTIVE_MIN_SAMPLES_PER_ELEMENT;
    const seedUs: number[] = Array.from({ length: seedCount }) as number[];
    const seedSs: number[] = Array.from({ length: seedCount }) as number[];
    for (let k = 0; k < seedCount; k += 1) {
      const s = (L * k) / (seedCount - 1);
      seedSs[k] = s;
      if (k === 0) seedUs[k] = 0;
      else if (k === seedCount - 1) seedUs[k] = 1;
      else {
        const u = checkedInvertWithLut(element.span, s, lut, 1e-10);
        if (!(u > seedUs[k - 1]! && u < 1))
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Inversion bracketing failed on ${element.id}`,
          );
        seedUs[k] = u;
      }
    }
    // Validate monotonic
    for (let k = 1; k < seedCount; k += 1)
      if (!(seedUs[k]! > seedUs[k - 1]!))
        throw new TrackCompileError(
          "INVERSION_FAILED",
          `Seed monotonicity failed on ${element.id}`,
        );

    const expand = (
      aU: number,
      bU: number,
      aS: number,
      bS: number,
      depth: number,
    ): Array<{ u: number; s: number }> => {
      const err = chordErrorUpperBound(element.span, aU, bU, element.id);
      if (err <= ADAPTIVE_MAX_CHORD_ERROR_M) return [{ u: bU, s: bS }];
      if (depth >= ADAPTIVE_MAX_DEPTH)
        throw new TrackCompileError(
          "BUDGET_EXCEEDED",
          `Element ${element.id} exceeded adaptive depth ${ADAPTIVE_MAX_DEPTH}`,
        );
      const sMid = (aS + bS) / 2;
      if (sMid === aS || sMid === bS)
        throw new TrackCompileError(
          "INVERSION_FAILED",
          `Arc length resolution on ${element.id}`,
        );
      const midU = checkedInvertWithLut(element.span, sMid, lut, 1e-10);
      if (!(midU > aU && midU < bU))
        throw new TrackCompileError(
          "INVERSION_FAILED",
          `Inversion bracketing failed on ${element.id} at depth ${depth}`,
        );
      const left = expand(aU, midU, aS, sMid, depth + 1);
      const right = expand(midU, bU, sMid, bS, depth + 1);
      // left already contains points after aU up to midU, right after midU up to bU
      return [...left, ...right];
    };

    const resultUs: number[] = [seedUs[0]!];
    const resultSs: number[] = [seedSs[0]!];
    for (let i = 0; i < seedCount - 1; i += 1) {
      const aU = seedUs[i]!;
      const bU = seedUs[i + 1]!;
      const aS = seedSs[i]!;
      const bS = seedSs[i + 1]!;
      const expanded = expand(aU, bU, aS, bS, 0);
      for (const pt of expanded) {
        resultUs.push(pt.u);
        resultSs.push(pt.s);
        if (resultUs.length > ADAPTIVE_MAX_SAMPLES_PER_ELEMENT)
          throw new TrackCompileError(
            "BUDGET_EXCEEDED",
            `Element ${element.id} exceeded ${ADAPTIVE_MAX_SAMPLES_PER_ELEMENT} samples`,
          );
      }
    }
    if (resultUs.length < ADAPTIVE_MIN_SAMPLES_PER_ELEMENT)
      throw new TrackCompileError(
        "BUDGET_EXCEEDED",
        `Element ${element.id} below minimum samples`,
      );
    if (resultUs.length > ADAPTIVE_MAX_SAMPLES_PER_ELEMENT)
      throw new TrackCompileError(
        "BUDGET_EXCEEDED",
        `Element ${element.id} exceeded ${ADAPTIVE_MAX_SAMPLES_PER_ELEMENT} samples`,
      );
    perElementUs.push(resultUs);
    perElementSs.push(resultSs);
  }

  const totalSamples =
    perElementUs.reduce((sum, us) => sum + us.length, 0) -
    (elements.length - 1);
  if (totalSamples > ADAPTIVE_MAX_TOTAL_SAMPLES)
    throw new TrackCompileError(
      "BUDGET_EXCEEDED",
      `Track exceeded total ${ADAPTIVE_MAX_TOTAL_SAMPLES} samples`,
    );
  if (totalSamples < 2)
    throw new TrackCompileError(
      "BUDGET_EXCEEDED",
      "Track needs at least two samples",
    );

  // Second pass: allocate once and share seams (preceding ownership) – two-pass variable layout
  const count = totalSamples;
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  const elementIndices = new Uint32Array(count);
  const elementBoundaries = new Uint32Array(elements.length * 2);
  const parameters = new Float64Array(count);
  const localDistances = new Float64Array(count);
  const speeds = new Float64Array(count);
  const banks = new Float64Array(count);
  const bankDerivatives = new Float64Array(count);
  const zoneSets = new Set<string>();
  for (const element of elements)
    for (const zone of element.zones ?? []) zoneSets.add(zone);
  const zoneNames = [...zoneSets];

  const offsets = new Float64Array(elements.length + 1);
  for (let i = 0; i < elements.length; i += 1)
    offsets[i + 1] = offsets[i]! + perElementLengths[i]!;

  // Compute boundaries contiguously sharing seams
  let accBoundary = 0;
  for (let ei = 0; ei < elements.length; ei += 1) {
    const us = perElementUs[ei]!;
    elementBoundaries[ei * 2] = accBoundary;
    elementBoundaries[ei * 2 + 1] = accBoundary + us.length - 1;
    accBoundary += us.length - 1;
  }

  // Fill arrays deterministically left-before-right, preceding ownership for seams
  for (let ei = 0; ei < elements.length; ei += 1) {
    const us = perElementUs[ei]!;
    const ss = perElementSs[ei]!;
    const element = elements[ei]!;
    const start = elementBoundaries[ei * 2]!;
    for (let j = 0; j < us.length; j += 1) {
      if (ei > 0 && j === 0) continue; // seam shared, keep preceding element's values
      const g = start + j;
      const u = us[j]!;
      const s = ss[j]!;
      localDistances[g] = s;
      writeVec3(positions, g, element.span.position(u));
      const d1 = element.span.derivative(u, 1);
      speeds[g] = requireValidSpeed(Math.hypot(d1[0], d1[1], d1[2]));
      writeVec3(tangents, g, vec3Normalize(d1));
      parameters[g] = u;
      elementIndices[g] = ei;
      banks[g] = bankValue(element, u);
    }
  }

  const frameInputs = Array.from({ length: count }, (_, index) =>
    readVec3(tangents, index),
  );
  const frameParameters = Array.from(
    { length: count },
    (_, index) => index / (count - 1),
  );
  const pathPositions = Array.from({ length: count }, (_, index) =>
    readVec3(positions, index),
  );
  const frames: readonly Frame[] = transportFramesAlongPath(
    pathPositions,
    frameInputs,
    frameParameters,
    banks,
    options.initialNormal,
  );
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const distances = new Float64Array(count);
  const curvature = new Float64Array(count);
  const curvatureVector = new Float64Array(count * 3);
  const zoneMasks = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const frame = frames[index]!;
    writeVec3(normals, index, frame.normal);
    writeVec3(binormals, index, frame.binormal);
    const elementIndex = elementIndices[index]!;
    distances[index] = offsets[elementIndex]! + localDistances[index]!;
    const element = elements[elementIndex]!;
    const u = parameters[index]!;
    const d1 = element.span.derivative(u, 1);
    const d2 = element.span.derivative(u, 2);
    const speed = speeds[index]!;
    const speedSquared = speed ** 2;
    const tangentSpeedDerivative =
      (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / speed;
    const vector = vec3(
      d2[0] / speedSquared - (d1[0] * tangentSpeedDerivative) / speed ** 3,
      d2[1] / speedSquared - (d1[1] * tangentSpeedDerivative) / speed ** 3,
      d2[2] / speedSquared - (d1[2] * tangentSpeedDerivative) / speed ** 3,
    );
    writeVec3(curvatureVector, index, vector);
    curvature[index] = Math.hypot(vector[0], vector[1], vector[2]);
    bankDerivatives[index] = bankDerivative(element, u) / speeds[index]!;
    for (const zone of element.zones ?? [])
      zoneMasks[index] = zoneMasks[index]! | (1 << zoneNames.indexOf(zone));
  }
  return new CompiledTrackData({
    positions,
    tangents,
    normals,
    binormals,
    distances,
    curvature,
    curvatureVector,
    bank: banks,
    bankDerivative: bankDerivatives,
    zoneMasks,
    zoneNames: Object.freeze(zoneNames),
    elementIndices,
    elementBoundaries,
    parameters,
    totalLength: offsets[elements.length]!,
  });
};

export const compileTrack = (
  elements: readonly TrackElement[],
  options: CompileTrackOptions = {},
): CompiledTrackData => {
  if (elements.length === 0)
    throw new RangeError("A track needs at least one element");
  if (options.samples !== undefined) {
    if (!Number.isInteger(options.samples) || options.samples < 2)
      throw new RangeError("samples must be an integer >= 2");
    return compileTrackFixed(elements, options);
  }
  return compileTrackAdaptive(elements, options);
};

export interface TrackSample {
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly distance: number;
  readonly curvature: number;
  readonly curvatureVector: Vec3;
  readonly bank: number;
  readonly bankDerivative: number;
}
export const sampleCompiledTrack = (
  data: CompiledTrackData,
  normalizedDistance: number,
): TrackSample => {
  const storage = compiledTrackStorage.get(data);
  if (!storage) throw new TypeError("Unknown compiled track data");
  const t = Math.max(0, Math.min(1, normalizedDistance));
  if (!Number.isFinite(normalizedDistance))
    throw new RangeError("Normalized distance must be finite");
  const targetDistance = t * data.totalLength;
  let low = 0;
  let high = storage.distances.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (storage.distances[middle]! <= targetDistance) low = middle;
    else high = middle;
  }
  const fraction =
    low === high
      ? 0
      : (targetDistance - storage.distances[low]!) /
        (storage.distances[high]! - storage.distances[low]!);
  const { positions, tangents, normals, binormals } = storage;
  const { curvature: curvatures, bank: banks } = storage;
  const { curvatureVector: curvatureVectors } = storage;
  const { bankDerivative: bankDerivatives } = storage;
  const interpolate = (array: Float64Array): number =>
    array[low]! * (1 - fraction) + array[high]! * fraction;
  const tangent = vec3Normalize(
    vec3(
      tangents[low * 3]! * (1 - fraction) + tangents[high * 3]! * fraction,
      tangents[low * 3 + 1]! * (1 - fraction) +
        tangents[high * 3 + 1]! * fraction,
      tangents[low * 3 + 2]! * (1 - fraction) +
        tangents[high * 3 + 2]! * fraction,
    ),
  );
  const rawNormal = vec3(
    normals[low * 3]! * (1 - fraction) + normals[high * 3]! * fraction,
    normals[low * 3 + 1]! * (1 - fraction) + normals[high * 3 + 1]! * fraction,
    normals[low * 3 + 2]! * (1 - fraction) + normals[high * 3 + 2]! * fraction,
  );
  const projectedNormal = vec3(
    rawNormal[0] -
      tangent[0] *
        (tangent[0] * rawNormal[0] +
          tangent[1] * rawNormal[1] +
          tangent[2] * rawNormal[2]),
    rawNormal[1] -
      tangent[1] *
        (tangent[0] * rawNormal[0] +
          tangent[1] * rawNormal[1] +
          tangent[2] * rawNormal[2]),
    rawNormal[2] -
      tangent[2] *
        (tangent[0] * rawNormal[0] +
          tangent[1] * rawNormal[1] +
          tangent[2] * rawNormal[2]),
  );
  const rawBinormal = vec3(
    binormals[low * 3]! * (1 - fraction) + binormals[high * 3]! * fraction,
    binormals[low * 3 + 1]! * (1 - fraction) +
      binormals[high * 3 + 1]! * fraction,
    binormals[low * 3 + 2]! * (1 - fraction) +
      binormals[high * 3 + 2]! * fraction,
  );
  const normal =
    projectedNormal[0] ** 2 +
      projectedNormal[1] ** 2 +
      projectedNormal[2] ** 2 >
    1e-24
      ? vec3Normalize(projectedNormal)
      : vec3Normalize(
          vec3(
            rawBinormal[1] * tangent[2] - rawBinormal[2] * tangent[1],
            rawBinormal[2] * tangent[0] - rawBinormal[0] * tangent[2],
            rawBinormal[0] * tangent[1] - rawBinormal[1] * tangent[0],
          ),
        );
  const binormal = vec3Normalize(
    vec3(
      tangent[1] * normal[2] - tangent[2] * normal[1],
      tangent[2] * normal[0] - tangent[0] * normal[2],
      tangent[0] * normal[1] - tangent[1] * normal[0],
    ),
  );
  const curvatureVector = vec3(
    curvatureVectors[low * 3]! * (1 - fraction) +
      curvatureVectors[high * 3]! * fraction,
    curvatureVectors[low * 3 + 1]! * (1 - fraction) +
      curvatureVectors[high * 3 + 1]! * fraction,
    curvatureVectors[low * 3 + 2]! * (1 - fraction) +
      curvatureVectors[high * 3 + 2]! * fraction,
  );
  return {
    position: vec3(
      positions[low * 3]! * (1 - fraction) + positions[high * 3]! * fraction,
      positions[low * 3 + 1]! * (1 - fraction) +
        positions[high * 3 + 1]! * fraction,
      positions[low * 3 + 2]! * (1 - fraction) +
        positions[high * 3 + 2]! * fraction,
    ),
    tangent,
    normal,
    binormal,
    distance: data.totalLength * t,
    curvature: interpolate(curvatures),
    curvatureVector,
    bank: interpolate(banks),
    bankDerivative: interpolate(bankDerivatives),
  };
};
export const sampleTrackAtDistance = (
  data: CompiledTrackData,
  distance: number,
): TrackSample =>
  sampleCompiledTrack(
    data,
    data.totalLength === 0 ? 0 : distance / data.totalLength,
  );
export const sampleAtDistance = sampleTrackAtDistance;
export const trackChecksum = (data: CompiledTrackData): string => data.checksum;
export const compileTrackData = compileTrack;
