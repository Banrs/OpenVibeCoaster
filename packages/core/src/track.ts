import {
  buildArcLengthLut,
  buildCheckedLutNoCert,
  certifySpeedInterval,
  checkedInvertWithLutNoCert,
  invertArcLength,
} from "./arc-length";
import { TrackCompileError } from "./compile-error";
import { transportFramesAlongPath } from "./frames";
import { vec3, vec3Cross, vec3Dot, vec3Length, vec3Normalize } from "./math";
import { SeventhOrderHermiteSpan } from "./spans";
import {
  intervalAdd,
  intervalExact,
  intervalMid,
  intervalMul,
  intervalSub,
  nextUp,
  powerToBernsteinInterval,
  restrictPowerCoefficientsInterval,
  type Interval,
} from "./interval";
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

export const ADAPTIVE_MIN_SAMPLES_PER_ELEMENT = 32;
export const ADAPTIVE_MAX_CHORD_ERROR_M = 0.0005;
export const ADAPTIVE_MAX_DEPTH = 32;
export const ADAPTIVE_MAX_SAMPLES_PER_ELEMENT = 65536;
export const ADAPTIVE_MAX_TOTAL_SAMPLES = 262144;
// Fixed work caps independent of element count: binary subdivision visits <2*leaves
export const ADAPTIVE_MAX_NODES_PER_ELEMENT =
  2 * ADAPTIVE_MAX_SAMPLES_PER_ELEMENT;
export const ADAPTIVE_MAX_TOTAL_NODES =
  2 * ADAPTIVE_MAX_TOTAL_SAMPLES + ADAPTIVE_MIN_SAMPLES_PER_ELEMENT * 4;

const checkGlobalSampleBudget = (
  totalAccepted: number,
  currentLen: number,
  elemIdx: number,
  elements: readonly TrackElement[],
  extra: number,
  element: TrackElement,
  cur: { aU: number; bU: number; aS: number; bS: number },
  globalNodes: number,
  nodes: number,
): void => {
  const remainingElements = elements.length - elemIdx - 1;
  const projectedTotal =
    totalAccepted +
    (currentLen + extra) +
    remainingElements * ADAPTIVE_MIN_SAMPLES_PER_ELEMENT -
    (elements.length - 1);
  if (projectedTotal > ADAPTIVE_MAX_TOTAL_SAMPLES)
    throw new TrackCompileError(
      "SAMPLE_BUDGET_EXCEEDED",
      `Track would exceed total ${ADAPTIVE_MAX_TOTAL_SAMPLES} on ${extra === 1 ? "leaf" : "subdivision"} of ${element.id}`,
      {
        elementId: element.id,
        stage: "samples",
        uInterval: [cur.aU, cur.bU],
        sInterval: [cur.aS, cur.bS],
        samples: projectedTotal,
        limitSamples: ADAPTIVE_MAX_TOTAL_SAMPLES,
        work: globalNodes + nodes,
      },
    );
};

export const chordErrorUpperBoundSeventhOrder = (
  span: SeventhOrderHermiteSpan<Vec3>,
  start: number,
  end: number,
): number => {
  if (!(start >= 0 && end <= 1 && start < end))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Invalid chord interval",
      { stage: "chord", uInterval: [start, end] },
    );
  const rows = span.coefficients as readonly (readonly number[])[];
  if (rows.length !== 3 || rows.some((r) => r.length !== 8))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Seventh-order coefficients invalid",
      { stage: "chord" },
    );
  // Translation invariant: remove constant coefficient before restriction (chord error is translation invariant)
  const translatedRows: Interval[][] = rows.map((row) => {
    const intervals = row.map((v, idx) =>
      idx === 0 ? intervalExact(0, "chord") : intervalExact(v, "chord"),
    );
    return intervals;
  });
  const restrictedRows = translatedRows.map((row) =>
    restrictPowerCoefficientsInterval(row, start, end, "chord"),
  );
  const bernsteinRows = restrictedRows.map((q) =>
    powerToBernsteinInterval(q, "chord"),
  );
  // 8 control intervals
  const controls: Array<{ x: Interval; y: Interval; z: Interval }> = [];
  for (let i = 0; i < 8; i += 1) {
    controls.push({
      x: bernsteinRows[0]![i]!,
      y: bernsteinRows[1]![i]!,
      z: bernsteinRows[2]![i]!,
    });
  }
  const p0 = controls[0]!;
  const p1 = controls[7]!;
  // If p0-p1 degenerate (interval width), still handle via t method
  // Compute midpoints for nominal t selection
  const midP0 = vec3(intervalMid(p0.x), intervalMid(p0.y), intervalMid(p0.z));
  const midP1 = vec3(intervalMid(p1.x), intervalMid(p1.y), intervalMid(p1.z));
  const vMid: Vec3 = vec3(
    midP1[0] - midP0[0],
    midP1[1] - midP0[1],
    midP1[2] - midP0[2],
  );
  const vMidDot = vMid[0] * vMid[0] + vMid[1] * vMid[1] + vMid[2] * vMid[2];
  let maxUpper = 0;
  for (let i = 0; i < 8; i += 1) {
    const ci = controls[i]!;
    // nominal t from midpoints
    let t: number;
    if (!(vMidDot > 1e-30)) {
      t = 0;
    } else {
      const midCi = vec3(
        intervalMid(ci.x),
        intervalMid(ci.y),
        intervalMid(ci.z),
      );
      const diffMid: Vec3 = vec3(
        midCi[0] - midP0[0],
        midCi[1] - midP0[1],
        midCi[2] - midP0[2],
      );
      const dot =
        diffMid[0] * vMid[0] + diffMid[1] * vMid[1] + diffMid[2] * vMid[2];
      t = dot / vMidDot;
      if (!Number.isFinite(t)) t = 0;
      t = Math.max(0, Math.min(1, t));
    }
    // segment point at t: p0 + t*(p1-p0) as intervals (outward, contains a real point on chord)
    const segX = intervalAdd(
      p0.x,
      intervalMul(
        intervalSub(p1.x, p0.x, "chord"),
        intervalExact(t, "chord"),
        "chord",
      ),
      "chord",
    );
    const segY = intervalAdd(
      p0.y,
      intervalMul(
        intervalSub(p1.y, p0.y, "chord"),
        intervalExact(t, "chord"),
        "chord",
      ),
      "chord",
    );
    const segZ = intervalAdd(
      p0.z,
      intervalMul(
        intervalSub(p1.z, p0.z, "chord"),
        intervalExact(t, "chord"),
        "chord",
      ),
      "chord",
    );
    const dx = intervalSub(ci.x, segX, "chord");
    const dy = intervalSub(ci.y, segY, "chord");
    const dz = intervalSub(ci.z, segZ, "chord");
    const maxAbsX = Math.max(Math.abs(dx.lo), Math.abs(dx.hi));
    const maxAbsY = Math.max(Math.abs(dy.lo), Math.abs(dy.hi));
    const maxAbsZ = Math.max(Math.abs(dz.lo), Math.abs(dz.hi));
    const upX = nextUp(maxAbsX, "chord");
    const upY = nextUp(maxAbsY, "chord");
    const upZ = nextUp(maxAbsZ, "chord");
    const sqX = nextUp(upX * upX, "chord");
    const sqY = nextUp(upY * upY, "chord");
    const sqZ = nextUp(upZ * upZ, "chord");
    const sum = nextUp(nextUp(sqX + sqY, "chord") + sqZ, "chord");
    const normUpper = nextUp(Math.sqrt(sum), "chord");
    if (!Number.isFinite(normUpper))
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        "Chord bound norm non-finite",
        { stage: "chord", uInterval: [start, end] },
      );
    if (normUpper > maxUpper) maxUpper = normUpper;
  }
  // For translation-invariant bound, the max distance among controls bounds the true curve
  return maxUpper;
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
  // Streaming output-compatible checksum without boxing large arrays: feed exact same canonical JSON token sequence into FNV hash
  let hash = 0x811c9dc5;
  const feed = (s: string): void => {
    const bytes = encodeUtf8(s);
    for (const b of bytes) hash = Math.imul(hash ^ b, 0x01000193);
  };
  const feedNumberArray = (arr: Float64Array | Uint32Array): void => {
    feed("[");
    for (let i = 0; i < arr.length; i += 1) {
      if (i > 0) feed(",");
      feed(JSON.stringify(arr[i] as number));
    }
    feed("]");
  };
  const feedZoneNames = (arr: readonly string[]): void => {
    feed("[");
    for (let i = 0; i < arr.length; i += 1) {
      if (i > 0) feed(",");
      feed(JSON.stringify(arr[i]));
    }
    feed("]");
  };
  feed('{"positions":');
  feedNumberArray(data.positions);
  feed(',"tangents":');
  feedNumberArray(data.tangents);
  feed(',"normals":');
  feedNumberArray(data.normals);
  feed(',"binormals":');
  feedNumberArray(data.binormals);
  feed(',"distances":');
  feedNumberArray(data.distances);
  feed(',"curvature":');
  feedNumberArray(data.curvature);
  feed(',"curvatureVector":');
  feedNumberArray(data.curvatureVector);
  feed(',"bank":');
  feedNumberArray(data.bank);
  feed(',"bankDerivative":');
  feedNumberArray(data.bankDerivative);
  feed(',"zoneMasks":');
  feedNumberArray(data.zoneMasks);
  feed(',"zoneNames":');
  feedZoneNames([...data.zoneNames]);
  feed(',"elementIndices":');
  feedNumberArray(data.elementIndices);
  feed(',"elementBoundaries":');
  feedNumberArray(data.elementBoundaries);
  feed(',"parameters":');
  feedNumberArray(data.parameters);
  feed(',"totalLength":');
  feed(JSON.stringify(data.totalLength));
  feed("}");
  return (hash >>> 0).toString(16).padStart(8, "0");
};
export const _checksumForTest = checksum;

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
  const raw = options.samples!;
  if (!Number.isFinite(raw)) throw new RangeError("samples must be finite");
  const perElement = Math.max(2, Math.floor(raw));
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
      "SAMPLE_BUDGET_EXCEEDED",
      `Track minimum ${minTotal} exceeds total ${ADAPTIVE_MAX_TOTAL_SAMPLES}`,
      {
        stage: "samples",
        samples: minTotal,
        limitSamples: ADAPTIVE_MAX_TOTAL_SAMPLES,
      },
    );
  // First pass: determine variable sample layouts via checked adaptive subdivision
  const perElementUs: number[][] = [];
  const perElementSs: number[][] = [];
  const perElementLengths: number[] = [];
  for (const element of elements) {
    try {
      validSpanSpeed(element.span, 0);
      validSpanSpeed(element.span, 1);
    } catch (error) {
      if (error instanceof TrackCompileError && error.evidence.elementId)
        throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new TrackCompileError(
        "SPEED_CERTIFICATION_FAILED",
        `Element ${element.id}: ${msg}`,
        { elementId: element.id, stage: "speed", uInterval: [0, 1] },
      );
    }
  }
  let globalNodes = 0;
  let totalAccepted = 0;
  const sharedCertWork = { count: 0 };
  for (let elemIdx = 0; elemIdx < elements.length; elemIdx += 1) {
    const element = elements[elemIdx]!;
    try {
      certifySpeedInterval(element.span, 0, 1, 0, sharedCertWork);
    } catch (error) {
      if (error instanceof TrackCompileError) {
        if (error.evidence.elementId) throw error;
        throw new TrackCompileError(error.code, error.message, {
          ...error.evidence,
          elementId: element.id,
        });
      }
      throw new TrackCompileError(
        "SPEED_CERTIFICATION_FAILED",
        error instanceof Error ? error.message : String(error),
        { elementId: element.id, stage: "speed", uInterval: [0, 1] },
      );
    }
    let lut: ReturnType<typeof buildCheckedLutNoCert>;
    try {
      lut = buildCheckedLutNoCert(element.span, 32);
    } catch (error) {
      if (error instanceof TrackCompileError) {
        if (error.evidence.elementId) throw error;
        throw new TrackCompileError(error.code, error.message, {
          ...error.evidence,
          elementId: element.id,
        });
      }
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        error instanceof Error ? error.message : String(error),
        { elementId: element.id, stage: "integration" },
      );
    }
    const L = lut.totalLength;
    if (!Number.isFinite(L) || !(L > 0))
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        `Element ${element.id} has non-positive length`,
        { elementId: element.id, stage: "integration" },
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
        let u: number;
        try {
          u = checkedInvertWithLutNoCert(element.span, s, lut, 1e-10);
        } catch (error) {
          if (error instanceof TrackCompileError && error.evidence.elementId)
            throw error;
          const msg = error instanceof Error ? error.message : String(error);
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Element ${element.id}: ${msg}`,
            {
              elementId: element.id,
              stage: "inversion",
              uInterval: [seedUs[k - 1]!, 1],
              sInterval: [seedSs[k - 1]!, s],
            },
          );
        }
        if (!(u > seedUs[k - 1]! && u < 1))
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Inversion bracketing failed on ${element.id}`,
            {
              elementId: element.id,
              stage: "inversion",
              uInterval: [seedUs[k - 1]!, 1],
              sInterval: [seedSs[k - 1]!, s],
            },
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

    // Left-first DFS that emits into bounded arrays via mutable counter, checking caps before push/subdivision
    const resultUs: number[] = [seedUs[0]!];
    const resultSs: number[] = [seedSs[0]!];
    let nodes = 0;
    for (let i = 0; i < seedCount - 1; i += 1) {
      const stack: Array<{
        aU: number;
        bU: number;
        aS: number;
        bS: number;
        depth: number;
      }> = [
        {
          aU: seedUs[i]!,
          bU: seedUs[i + 1]!,
          aS: seedSs[i]!,
          bS: seedSs[i + 1]!,
          depth: 0,
        },
      ];
      while (stack.length > 0) {
        if (
          nodes >= ADAPTIVE_MAX_NODES_PER_ELEMENT ||
          globalNodes >= ADAPTIVE_MAX_TOTAL_NODES
        )
          throw new TrackCompileError(
            "SAMPLE_BUDGET_EXCEEDED",
            `Element ${element.id} exceeded node budget`,
            {
              elementId: element.id,
              stage: "subdivision",
              depth: stack[stack.length - 1]!.depth,
              samples: resultUs.length,
              limit: ADAPTIVE_MAX_SAMPLES_PER_ELEMENT,
              work: globalNodes + nodes,
            },
          );
        const cur = stack.pop()!;
        let err: number;
        try {
          err = chordErrorUpperBound(element.span, cur.aU, cur.bU, element.id);
        } catch (error) {
          if (error instanceof TrackCompileError) {
            if (error.evidence.elementId) throw error;
            throw new TrackCompileError(error.code, error.message, {
              ...error.evidence,
              elementId: element.id,
              uInterval: error.evidence.uInterval ?? [cur.aU, cur.bU],
              sInterval: error.evidence.sInterval ?? [cur.aS, cur.bS],
            });
          }
          const msg = error instanceof Error ? error.message : String(error);
          throw new TrackCompileError(
            "CHORD_CERTIFICATION_FAILED",
            `Element ${element.id}: ${msg}`,
            {
              elementId: element.id,
              stage: "chord",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
            },
          );
        }
        if (err <= ADAPTIVE_MAX_CHORD_ERROR_M) {
          if (resultUs.length >= ADAPTIVE_MAX_SAMPLES_PER_ELEMENT)
            throw new TrackCompileError(
              "SAMPLE_BUDGET_EXCEEDED",
              `Element ${element.id} exceeded ${ADAPTIVE_MAX_SAMPLES_PER_ELEMENT} samples`,
              {
                elementId: element.id,
                stage: "samples",
                uInterval: [cur.aU, cur.bU],
                sInterval: [cur.aS, cur.bS],
                actual: err,
                limit: ADAPTIVE_MAX_CHORD_ERROR_M,
                depth: cur.depth,
                samples: resultUs.length,
                limitSamples: ADAPTIVE_MAX_SAMPLES_PER_ELEMENT,
              },
            );
          checkGlobalSampleBudget(
            totalAccepted,
            resultUs.length,
            elemIdx,
            elements,
            1,
            element,
            cur,
            globalNodes,
            nodes,
          );
          resultUs.push(cur.bU);
          resultSs.push(cur.bS);
          nodes++;
          globalNodes++;
          continue;
        }
        if (cur.depth >= ADAPTIVE_MAX_DEPTH)
          throw new TrackCompileError(
            "SAMPLE_BUDGET_EXCEEDED",
            `Element ${element.id} exceeded adaptive depth ${ADAPTIVE_MAX_DEPTH}`,
            {
              elementId: element.id,
              stage: "depth",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
              actual: err,
              limit: ADAPTIVE_MAX_CHORD_ERROR_M,
              depth: cur.depth,
            },
          );
        if (resultUs.length + 1 >= ADAPTIVE_MAX_SAMPLES_PER_ELEMENT)
          throw new TrackCompileError(
            "SAMPLE_BUDGET_EXCEEDED",
            `Element ${element.id} would exceed ${ADAPTIVE_MAX_SAMPLES_PER_ELEMENT} samples`,
            {
              elementId: element.id,
              stage: "samples",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
              actual: err,
              limit: ADAPTIVE_MAX_CHORD_ERROR_M,
              depth: cur.depth,
              samples: resultUs.length,
            },
          );
        checkGlobalSampleBudget(
          totalAccepted,
          resultUs.length,
          elemIdx,
          elements,
          2,
          element,
          cur,
          globalNodes,
          nodes,
        );
        const sMid = (cur.aS + cur.bS) / 2;
        if (sMid === cur.aS || sMid === cur.bS)
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Arc length resolution on ${element.id}`,
            {
              elementId: element.id,
              stage: "inversion",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
            },
          );
        let midU: number;
        try {
          midU = checkedInvertWithLutNoCert(element.span, sMid, lut, 1e-10);
        } catch (error) {
          if (error instanceof TrackCompileError && error.evidence.elementId)
            throw error;
          const msg = error instanceof Error ? error.message : String(error);
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Element ${element.id}: ${msg}`,
            {
              elementId: element.id,
              stage: "inversion",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
              depth: cur.depth,
            },
          );
        }
        if (!(midU > cur.aU && midU < cur.bU))
          throw new TrackCompileError(
            "INVERSION_FAILED",
            `Inversion bracketing failed on ${element.id} at depth ${cur.depth}`,
            {
              elementId: element.id,
              stage: "inversion",
              uInterval: [cur.aU, cur.bU],
              sInterval: [cur.aS, cur.bS],
              depth: cur.depth,
            },
          );
        // Push right then left for left-first DFS
        stack.push({
          aU: midU,
          bU: cur.bU,
          aS: sMid,
          bS: cur.bS,
          depth: cur.depth + 1,
        });
        stack.push({
          aU: cur.aU,
          bU: midU,
          aS: cur.aS,
          bS: sMid,
          depth: cur.depth + 1,
        });
        nodes++;
        globalNodes++;
      }
    }
    if (resultUs.length < ADAPTIVE_MIN_SAMPLES_PER_ELEMENT)
      throw new TrackCompileError(
        "SAMPLE_BUDGET_EXCEEDED",
        `Element ${element.id} below minimum samples`,
        {
          elementId: element.id,
          stage: "samples",
          samples: resultUs.length,
          limit: ADAPTIVE_MIN_SAMPLES_PER_ELEMENT,
        },
      );
    if (resultUs.length > ADAPTIVE_MAX_SAMPLES_PER_ELEMENT)
      throw new TrackCompileError(
        "SAMPLE_BUDGET_EXCEEDED",
        `Element ${element.id} exceeded ${ADAPTIVE_MAX_SAMPLES_PER_ELEMENT} samples`,
        {
          elementId: element.id,
          stage: "samples",
          samples: resultUs.length,
          limit: ADAPTIVE_MAX_SAMPLES_PER_ELEMENT,
        },
      );
    perElementUs.push(resultUs);
    perElementSs.push(resultSs);
    totalAccepted += resultUs.length;
  }

  const totalSamples = totalAccepted - (elements.length - 1);
  if (totalSamples > ADAPTIVE_MAX_TOTAL_SAMPLES)
    throw new TrackCompileError(
      "SAMPLE_BUDGET_EXCEEDED",
      `Track exceeded total ${ADAPTIVE_MAX_TOTAL_SAMPLES} samples`,
    );
  if (totalSamples < 2)
    throw new TrackCompileError(
      "SAMPLE_BUDGET_EXCEEDED",
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
    // Preserve previous public fixed-sampling edge behavior: floor fractional and clamp below 2
    // Finite integers retain exact counts; non-finite becomes 2
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
