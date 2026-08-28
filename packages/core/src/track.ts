import { buildArcLengthLut, invertArcLength } from "./arc-length";
import { transportFramesAlongPath } from "./frames";
import { vec3, vec3Normalize } from "./math";
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
}
interface CompiledTrackDataInput {
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly distances: Float64Array;
  readonly curvature: Float64Array;
  readonly bank: Float64Array;
  readonly bankDerivative: Float64Array;
  readonly zoneMasks: Uint32Array;
  readonly zoneNames: readonly string[];
  readonly elementIndices: Uint32Array;
  readonly elementBoundaries: Uint32Array;
  readonly parameters: Float64Array;
  readonly totalLength: number;
}

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
const checksum = (data: CompiledTrackDataInput): string => {
  const canonical = JSON.stringify({
    positions: Array.from(data.positions),
    tangents: Array.from(data.tangents),
    normals: Array.from(data.normals),
    binormals: Array.from(data.binormals),
    distances: Array.from(data.distances),
    curvature: Array.from(data.curvature),
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

export class CompiledTrackData {
  readonly #positions: Float64Array;
  readonly #tangents: Float64Array;
  readonly #normals: Float64Array;
  readonly #binormals: Float64Array;
  readonly #distances: Float64Array;
  readonly #curvature: Float64Array;
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
    this.#positions = new Float64Array(input.positions);
    this.#tangents = new Float64Array(input.tangents);
    this.#normals = new Float64Array(input.normals);
    this.#binormals = new Float64Array(input.binormals);
    this.#distances = new Float64Array(input.distances);
    this.#curvature = new Float64Array(input.curvature);
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
      bank: this.#bank,
      bankDerivative: this.#bankDerivative,
      zoneMasks: this.#zoneMasks,
      zoneNames: this.#zoneNames,
      elementIndices: this.#elementIndices,
      elementBoundaries: this.#elementBoundaries,
      parameters: this.#parameters,
      totalLength: this.totalLength,
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

export const compileTrack = (
  elements: readonly TrackElement[],
  options: CompileTrackOptions = {},
): CompiledTrackData => {
  if (elements.length === 0)
    throw new RangeError("A track needs at least one element");
  const perElement = Math.max(2, Math.floor(options.samples ?? 128));
  const count = elements.length * (perElement - 1) + 1;
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  const elementIndices = new Uint32Array(count);
  const elementBoundaries = new Uint32Array(elements.length * 2);
  const parameters = new Float64Array(count);
  const localDistances = new Float64Array(count);
  const banks = new Float64Array(count);
  const bankDerivatives = new Float64Array(count);
  const zoneSets = new Set<string>();
  for (const element of elements)
    for (const zone of element.zones ?? []) zoneSets.add(zone);
  const zoneNames = [...zoneSets];
  const luts = elements.map((element) =>
    buildArcLengthLut(
      element.span,
      Math.max(32, perElement),
      options.tolerance ?? 1e-8,
    ),
  );
  const offsets = new Float64Array(elements.length + 1);
  for (let index = 0; index < elements.length; index += 1)
    offsets[index + 1] = offsets[index] + luts[index].totalLength;
  for (
    let elementIndex = 0;
    elementIndex < elements.length;
    elementIndex += 1
  ) {
    const element = elements[elementIndex];
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
              luts[elementIndex],
              (luts[elementIndex].totalLength * sample) / (perElement - 1),
            );
      localDistances[index] =
        (luts[elementIndex].totalLength * sample) / (perElement - 1);
      writeVec3(positions, index, element.span.position(u));
      writeVec3(tangents, index, vec3Normalize(element.span.derivative(u, 1)));
      parameters[index] = u;
      elementIndices[index] = elementIndex;
      banks[index] = bankValue(element, u);
      bankDerivatives[index] = bankDerivative(element, u);
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
  );
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const distances = new Float64Array(count);
  const curvature = new Float64Array(count);
  const zoneMasks = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    writeVec3(normals, index, frames[index].normal);
    writeVec3(binormals, index, frames[index].binormal);
    distances[index] = offsets[elementIndices[index]] + localDistances[index];
    const element = elements[elementIndices[index]];
    const u = parameters[index];
    const d1 = element.span.derivative(u, 1);
    const d2 = element.span.derivative(u, 2);
    const cross = vec3(
      d1[1] * d2[2] - d1[2] * d2[1],
      d1[2] * d2[0] - d1[0] * d2[2],
      d1[0] * d2[1] - d1[1] * d2[0],
    );
    const speed = Math.hypot(d1[0], d1[1], d1[2]);
    curvature[index] =
      speed > 1e-12 ? Math.hypot(cross[0], cross[1], cross[2]) / speed ** 3 : 0;
    for (const zone of element.zones ?? [])
      zoneMasks[index] |= 1 << zoneNames.indexOf(zone);
  }
  return new CompiledTrackData({
    positions,
    tangents,
    normals,
    binormals,
    distances,
    curvature,
    bank: banks,
    bankDerivative: bankDerivatives,
    zoneMasks,
    zoneNames: Object.freeze(zoneNames),
    elementIndices,
    elementBoundaries,
    parameters,
    totalLength: offsets[elements.length],
  });
};

export interface TrackSample {
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly distance: number;
  readonly curvature: number;
  readonly bank: number;
  readonly bankDerivative: number;
}
export const sampleCompiledTrack = (
  data: CompiledTrackData,
  normalizedDistance: number,
): TrackSample => {
  const t = Math.max(0, Math.min(1, normalizedDistance));
  const floating = t * (data.distances.length - 1);
  const low = Math.floor(floating);
  const high = Math.min(data.distances.length - 1, low + 1);
  const fraction = floating - low;
  const positions = data.positions;
  const tangents = data.tangents;
  const normals = data.normals;
  const binormals = data.binormals;
  const curvatures = data.curvature;
  const banks = data.bank;
  const bankDerivatives = data.bankDerivative;
  const interpolate = (array: Float64Array): number =>
    array[low] * (1 - fraction) + array[high] * fraction;
  const tangent = vec3Normalize(
    vec3(
      tangents[low * 3] * (1 - fraction) + tangents[high * 3] * fraction,
      tangents[low * 3 + 1] * (1 - fraction) +
        tangents[high * 3 + 1] * fraction,
      tangents[low * 3 + 2] * (1 - fraction) +
        tangents[high * 3 + 2] * fraction,
    ),
  );
  const rawNormal = vec3(
    normals[low * 3] * (1 - fraction) + normals[high * 3] * fraction,
    normals[low * 3 + 1] * (1 - fraction) + normals[high * 3 + 1] * fraction,
    normals[low * 3 + 2] * (1 - fraction) + normals[high * 3 + 2] * fraction,
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
    binormals[low * 3] * (1 - fraction) + binormals[high * 3] * fraction,
    binormals[low * 3 + 1] * (1 - fraction) +
      binormals[high * 3 + 1] * fraction,
    binormals[low * 3 + 2] * (1 - fraction) +
      binormals[high * 3 + 2] * fraction,
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
  return {
    position: vec3(
      positions[low * 3] * (1 - fraction) + positions[high * 3] * fraction,
      positions[low * 3 + 1] * (1 - fraction) +
        positions[high * 3 + 1] * fraction,
      positions[low * 3 + 2] * (1 - fraction) +
        positions[high * 3 + 2] * fraction,
    ),
    tangent,
    normal,
    binormal,
    distance: data.totalLength * t,
    curvature: interpolate(curvatures),
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
