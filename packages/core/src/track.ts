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
export interface CompiledTrackData {
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
  readonly totalLength: number;
  readonly checksum: string;
}

const readVec3 = (array: Float64Array, index: number): Vec3 =>
  vec3(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
const writeVec3 = (array: Float64Array, index: number, value: Vec3): void => {
  array[index * 3] = value[0];
  array[index * 3 + 1] = value[1];
  array[index * 3 + 2] = value[2];
};
const hashBytes = (bytes: Uint8Array): string => {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const checksum = (data: Omit<CompiledTrackData, "checksum">): string => {
  const chunks = [
    data.positions,
    data.tangents,
    data.normals,
    data.binormals,
    data.distances,
    data.curvature,
    data.bank,
    data.bankDerivative,
    data.zoneMasks,
    data.elementIndices,
    data.elementBoundaries,
  ];
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      offset,
    );
    offset += chunk.byteLength;
  }
  return hashBytes(bytes);
};
const bankValue = (element: TrackElement, u: number): number =>
  typeof element.bank === "function"
    ? element.bank(u)
    : (element.bank?.position(u) ?? 0);
const bankDerivative = (element: TrackElement, u: number): number =>
  typeof element.bank === "function"
    ? (element.bank(u + 1e-5) - element.bank(u - 1e-5)) / 2e-5
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
      writeVec3(positions, index, element.span.position(u));
      writeVec3(tangents, index, vec3Normalize(element.span.derivative(u, 1)));
      elementIndices[index] = elementIndex;
      banks[index] = bankValue(element, u);
      bankDerivatives[index] = bankDerivative(element, u);
    }
  }
  const frameInputs = Array.from({ length: count }, (_, index) =>
    readVec3(tangents, index),
  );
  const parameters = Array.from(
    { length: count },
    (_, index) => index / (count - 1),
  );
  const pathPositions = Array.from({ length: count }, (_, index) =>
    readVec3(positions, index),
  );
  const frames: readonly Frame[] = transportFramesAlongPath(
    pathPositions,
    frameInputs,
    parameters,
    (parameter) =>
      banks[
        Math.min(count - 1, Math.max(0, Math.round(parameter * (count - 1))))
      ],
  );
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const distances = new Float64Array(count);
  const curvature = new Float64Array(count);
  const zoneMasks = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    writeVec3(normals, index, frames[index].normal);
    writeVec3(binormals, index, frames[index].binormal);
    const elementStart = elementIndices[index] * (perElement - 1);
    const sampleFraction = (index - elementStart) / (perElement - 1);
    distances[index] =
      offsets[elementIndices[index]] +
      luts[elementIndices[index]].totalLength * sampleFraction;
    const element = elements[elementIndices[index]];
    const u =
      (index - elementIndices[index] * (perElement - 1)) / (perElement - 1);
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
  const partial: Omit<CompiledTrackData, "checksum"> = {
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
    totalLength: offsets[elements.length],
  };
  return Object.freeze({ ...partial, checksum: checksum(partial) });
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
  const interpolate = (array: Float64Array): number =>
    array[low] * (1 - fraction) + array[high] * fraction;
  return {
    position: vec3(
      data.positions[low * 3] * (1 - fraction) +
        data.positions[high * 3] * fraction,
      data.positions[low * 3 + 1] * (1 - fraction) +
        data.positions[high * 3 + 1] * fraction,
      data.positions[low * 3 + 2] * (1 - fraction) +
        data.positions[high * 3 + 2] * fraction,
    ),
    tangent: vec3Normalize(
      vec3(
        data.tangents[low * 3] * (1 - fraction) +
          data.tangents[high * 3] * fraction,
        data.tangents[low * 3 + 1] * (1 - fraction) +
          data.tangents[high * 3 + 1] * fraction,
        data.tangents[low * 3 + 2] * (1 - fraction) +
          data.tangents[high * 3 + 2] * fraction,
      ),
    ),
    normal: readVec3(data.normals, low),
    binormal: readVec3(data.binormals, low),
    distance: data.totalLength * t,
    curvature: interpolate(data.curvature),
    bank: interpolate(data.bank),
    bankDerivative: interpolate(data.bankDerivative),
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
