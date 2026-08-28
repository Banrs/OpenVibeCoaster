import {
  vec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Normalize,
  vec3Scale,
} from "./math";
import type { Vec3 } from "./math";

export interface Frame {
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly bank: number;
}

const vec3Sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rotateMinimal = (vector: Vec3, from: Vec3, to: Vec3): Vec3 => {
  const axis = vec3Cross(from, to);
  const cosine = Math.max(-1, Math.min(1, vec3Dot(from, to)));
  const sine = Math.sqrt(vec3Dot(axis, axis));
  if (sine < 1e-12) {
    if (cosine > 0) return vector;
    const helper = Math.abs(from[0]) < 0.8 ? vec3(1, 0, 0) : vec3(0, 1, 0);
    const oppositeAxis = vec3Normalize(vec3Cross(from, helper));
    return vec3Add(
      vec3Scale(vector, -1),
      vec3Scale(oppositeAxis, 2 * vec3Dot(oppositeAxis, vector)),
    );
  }
  const axisUnit = vec3Scale(axis, 1 / sine);
  return vec3Add(
    vec3Add(
      vec3Scale(vector, cosine),
      vec3Scale(vec3Cross(axisUnit, vector), sine),
    ),
    vec3Scale(axisUnit, vec3Dot(axisUnit, vector) * (1 - cosine)),
  );
};

const defaultNormal = (tangent: Vec3): Vec3 => {
  const reference = Math.abs(tangent[1]) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  return vec3Normalize(
    vec3Sub(reference, vec3Scale(tangent, vec3Dot(reference, tangent))),
  );
};
const orthogonalize = (normal: Vec3, tangent: Vec3): Vec3 => {
  const projected = vec3Sub(
    normal,
    vec3Scale(tangent, vec3Dot(normal, tangent)),
  );
  return vec3Dot(projected, projected) < 1e-24
    ? defaultNormal(tangent)
    : vec3Normalize(projected);
};

export const transportFrames = (
  tangents: readonly Vec3[],
  parameters: readonly number[] = tangents.map((_, index) => index),
  bankAt: ((parameter: number) => number) | ArrayLike<number> = () => 0,
  initialNormal?: Vec3,
): readonly Frame[] => {
  if (tangents.length === 0 || tangents.length !== parameters.length)
    throw new RangeError(
      "Frame samples and parameters must have equal non-zero lengths",
    );
  const normalized = tangents.map(vec3Normalize);
  const frames: Frame[] = [];
  let transportedNormal = initialNormal
    ? vec3Normalize(
        vec3Sub(
          initialNormal,
          vec3Scale(normalized[0], vec3Dot(initialNormal, normalized[0])),
        ),
      )
    : defaultNormal(normalized[0]);
  for (let i = 0; i < normalized.length; i += 1) {
    if (i > 0)
      transportedNormal = orthogonalize(
        rotateMinimal(transportedNormal, normalized[i - 1], normalized[i]),
        normalized[i],
      );
    const tangent = normalized[i];
    const unbankedBinormal = vec3Normalize(
      vec3Cross(tangent, transportedNormal),
    );
    const bank =
      typeof bankAt === "function" ? bankAt(parameters[i]) : (bankAt[i] ?? 0);
    const normalBanked = vec3Normalize(
      vec3Add(
        vec3Scale(transportedNormal, Math.cos(bank)),
        vec3Scale(unbankedBinormal, Math.sin(bank)),
      ),
    );
    frames.push(
      Object.freeze({
        tangent,
        normal: normalBanked,
        binormal: vec3Normalize(vec3Cross(tangent, normalBanked)),
        bank,
      }),
    );
  }
  return frames;
};

export const rotationMinimizingFrames = transportFrames;

const doubleReflect = (
  normal: Vec3,
  previousTangent: Vec3,
  tangent: Vec3,
  previousPosition: Vec3,
  position: Vec3,
): Vec3 => {
  const displacement = vec3Sub(position, previousPosition);
  const displacementLength = vec3Dot(displacement, displacement);
  if (displacementLength < 1e-20)
    return rotateMinimal(normal, previousTangent, tangent);
  const reflectionFactor =
    (2 * vec3Dot(displacement, previousTangent)) / displacementLength;
  const reflectedNormal = vec3Sub(
    normal,
    vec3Scale(displacement, reflectionFactor),
  );
  const reflectedTangent = vec3Sub(
    previousTangent,
    vec3Scale(displacement, reflectionFactor),
  );
  const tangentDelta = vec3Sub(tangent, reflectedTangent);
  const tangentDeltaLength = vec3Dot(tangentDelta, tangentDelta);
  if (tangentDeltaLength < 1e-20) return vec3Normalize(reflectedNormal);
  return vec3Normalize(
    vec3Sub(
      reflectedNormal,
      vec3Scale(
        tangentDelta,
        (2 * vec3Dot(tangentDelta, reflectedNormal)) / tangentDeltaLength,
      ),
    ),
  );
};

export const transportFramesAlongPath = (
  positions: readonly Vec3[],
  tangents: readonly Vec3[],
  parameters: readonly number[] = positions.map((_, index) => index),
  bankAt: ((parameter: number) => number) | ArrayLike<number> = () => 0,
  initialNormal?: Vec3,
): readonly Frame[] => {
  if (
    positions.length === 0 ||
    positions.length !== tangents.length ||
    positions.length !== parameters.length
  )
    throw new RangeError(
      "Path samples, tangents and parameters must have equal non-zero lengths",
    );
  const normalized = tangents.map(vec3Normalize);
  const frames: Frame[] = [];
  let transportedNormal = initialNormal
    ? vec3Normalize(
        vec3Sub(
          initialNormal,
          vec3Scale(normalized[0], vec3Dot(initialNormal, normalized[0])),
        ),
      )
    : defaultNormal(normalized[0]);
  for (let index = 0; index < normalized.length; index += 1) {
    if (index > 0)
      transportedNormal = orthogonalize(
        doubleReflect(
          transportedNormal,
          normalized[index - 1],
          normalized[index],
          positions[index - 1],
          positions[index],
        ),
        normalized[index],
      );
    const tangent = normalized[index];
    const binormal = vec3Normalize(vec3Cross(tangent, transportedNormal));
    const bank =
      typeof bankAt === "function"
        ? bankAt(parameters[index])
        : (bankAt[index] ?? 0);
    const normal = vec3Normalize(
      vec3Add(
        vec3Scale(transportedNormal, Math.cos(bank)),
        vec3Scale(binormal, Math.sin(bank)),
      ),
    );
    frames.push(
      Object.freeze({
        tangent,
        normal,
        binormal: vec3Normalize(vec3Cross(tangent, normal)),
        bank,
      }),
    );
  }
  return frames;
};

export const doubleReflectionFrames = transportFramesAlongPath;
