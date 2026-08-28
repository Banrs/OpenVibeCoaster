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
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const readFiniteVec3 = (value: unknown, label: string): Vec3 => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    !isFiniteNumber(value[2])
  )
    throw new RangeError(`${label} must contain finite 3-vectors`);
  return vec3(value[0], value[1], value[2]);
};
const readTangent = (value: unknown): Vec3 => {
  const tangent = readFiniteVec3(value, "Frame tangent samples");
  if (vec3Dot(tangent, tangent) < 1e-30)
    throw new RangeError(
      "Frame tangent samples must be finite non-zero vectors",
    );
  return vec3Normalize(tangent);
};
const readParameter = (value: unknown): number => {
  if (!isFiniteNumber(value))
    throw new RangeError("Frame parameters must be finite numbers");
  return value;
};
const readBank = (value: unknown): number => {
  if (!isFiniteNumber(value))
    throw new RangeError("Frame bank samples must be finite numbers");
  return value;
};
const validateBankArray = (bankAt: ArrayLike<number>, length: number): void => {
  if (
    bankAt === null ||
    (typeof bankAt !== "object" && typeof bankAt !== "function")
  )
    throw new RangeError("Frame bank samples must be an array-like value");
  if (bankAt.length !== length)
    throw new RangeError("Frame bank samples must match tangent sample length");
  for (let index = 0; index < length; index += 1) readBank(bankAt[index]);
};
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
  if (
    !Array.isArray(tangents) ||
    !Array.isArray(parameters) ||
    tangents.length === 0 ||
    tangents.length !== parameters.length
  )
    throw new RangeError(
      "Frame samples and parameters must have equal non-zero lengths",
    );
  const normalized = Array.from(tangents, readTangent);
  const frameParameters = Array.from(parameters, readParameter);
  if (typeof bankAt !== "function") validateBankArray(bankAt, tangents.length);
  const frames: Frame[] = [];
  const initialNormalVector = initialNormal
    ? readFiniteVec3(initialNormal, "Frame initial normal")
    : undefined;
  let transportedNormal = initialNormalVector
    ? vec3Normalize(
        vec3Sub(
          initialNormalVector,
          vec3Scale(
            normalized[0]!,
            vec3Dot(initialNormalVector, normalized[0]!),
          ),
        ),
      )
    : defaultNormal(normalized[0]!);
  for (let i = 0; i < normalized.length; i += 1) {
    if (i > 0)
      transportedNormal = orthogonalize(
        rotateMinimal(transportedNormal, normalized[i - 1]!, normalized[i]!),
        normalized[i]!,
      );
    const tangent = normalized[i]!;
    const unbankedBinormal = vec3Normalize(
      vec3Cross(tangent, transportedNormal),
    );
    const bank =
      typeof bankAt === "function"
        ? readBank(bankAt(frameParameters[i]!))
        : readBank(bankAt[i]);
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
    !Array.isArray(positions) ||
    !Array.isArray(tangents) ||
    !Array.isArray(parameters) ||
    positions.length === 0 ||
    positions.length !== tangents.length ||
    positions.length !== parameters.length
  )
    throw new RangeError(
      "Path samples, tangents and parameters must have equal non-zero lengths",
    );
  const pathPositions = Array.from(positions, (position) =>
    readFiniteVec3(position, "Frame path positions"),
  );
  const normalized = Array.from(tangents, readTangent);
  const frameParameters = Array.from(parameters, readParameter);
  if (typeof bankAt !== "function") validateBankArray(bankAt, tangents.length);
  const frames: Frame[] = [];
  const initialNormalVector = initialNormal
    ? readFiniteVec3(initialNormal, "Frame initial normal")
    : undefined;
  let transportedNormal = initialNormalVector
    ? vec3Normalize(
        vec3Sub(
          initialNormalVector,
          vec3Scale(
            normalized[0]!,
            vec3Dot(initialNormalVector, normalized[0]!),
          ),
        ),
      )
    : defaultNormal(normalized[0]!);
  for (let index = 0; index < normalized.length; index += 1) {
    if (index > 0)
      transportedNormal = orthogonalize(
        doubleReflect(
          transportedNormal,
          normalized[index - 1]!,
          normalized[index]!,
          pathPositions[index - 1]!,
          pathPositions[index]!,
        ),
        normalized[index]!,
      );
    const tangent = normalized[index]!;
    const binormal = vec3Normalize(vec3Cross(tangent, transportedNormal));
    const bank =
      typeof bankAt === "function"
        ? readBank(bankAt(frameParameters[index]!))
        : readBank(bankAt[index]);
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
