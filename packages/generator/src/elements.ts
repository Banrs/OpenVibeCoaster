import {
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  aabbFromPoints,
  vec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  type ParametricSpan,
  type Vec3,
} from "@openvibecoaster/core";
import {
  ELEMENT_KINDS,
  type AirtimeHillParameters,
  type AnySemanticElement,
  type ElementKind,
  type ElementParameterMap,
  type ElementParameters,
  type ElementBuildResult,
  type Pose,
  type SemanticElement,
} from "./types";

const gravity = 9.80665;
const worldGravity = vec3(0, -gravity, 0);

const defaults: ElementParameterMap = {
  station: { length: 12, bank: 0, closed: false },
  launch: { length: 30, targetSpeed: 25, bank: 0 },
  boost: { length: 30, targetSpeed: 25, bank: 0 },
  brake: { length: 20, targetSpeed: 8, bank: 0 },
  transition: { length: 20, rise: 0, pitch: 0, bank: 0 },
  topHat: { height: 80, width: 40, bank: 0 },
  airtimeHill: {
    length: 35,
    height: 8,
    targetForceG: 1.5,
    referenceSpeed: 24,
    bank: 0,
  },
  overbankedTurn: { radius: 28, angle: Math.PI / 2, bank: 0.6 },
  zeroGRoll: { length: 28, roll: Math.PI * 2 },
  stall: { length: 32, height: 18, bank: 0 },
};

const finite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
};
const range = (name: string, value: number, min: number, max: number): void => {
  finite(name, value);
  if (value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max} m`);
};
const angle = (
  name: string,
  value: number,
  min = -Math.PI * 4,
  max = Math.PI * 4,
): void => {
  finite(name, value);
  if (value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max} rad`);
};

const validateParameters = <K extends ElementKind>(
  kind: K,
  parameters: ElementParameters<K>,
): void => {
  switch (kind) {
    case "station": {
      const p = parameters as ElementParameterMap["station"];
      range("length", p.length, 2, 500);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "launch":
    case "boost":
    case "brake": {
      const p = parameters as ElementParameterMap["launch"];
      range("length", p.length, 2, 500);
      range("targetSpeed", p.targetSpeed, 0, 120);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "transition": {
      const p = parameters as ElementParameterMap["transition"];
      range("length", p.length, 2, 500);
      finite("rise", p.rise);
      finite("pitch", p.pitch);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "topHat": {
      const p = parameters as ElementParameterMap["topHat"];
      finite("height", p.height);
      if (p.height !== 80) throw new RangeError("height must be exactly 80 m");
      range("width", p.width, 10, 300);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "airtimeHill": {
      const p = parameters as ElementParameterMap["airtimeHill"];
      range("length", p.length, 4, 500);
      finite("height", p.height);
      range("targetForceG", p.targetForceG, -1.2, 5);
      range("referenceSpeed", p.referenceSpeed, 0.1, 120);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "overbankedTurn": {
      const p = parameters as ElementParameterMap["overbankedTurn"];
      range("radius", p.radius, 5, 200);
      angle("angle", p.angle, -Math.PI * 4, Math.PI * 4);
      if (p.angle === 0) throw new RangeError("angle must not be zero");
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
    case "zeroGRoll": {
      const p = parameters as ElementParameterMap["zeroGRoll"];
      range("length", p.length, 4, 500);
      angle("roll", p.roll);
      break;
    }
    case "stall": {
      const p = parameters as ElementParameterMap["stall"];
      range("length", p.length, 4, 500);
      finite("height", p.height);
      angle("bank", p.bank, -Math.PI, Math.PI);
      break;
    }
  }
};

export const stableElementId = (kind: ElementKind, index: number): string => {
  if (!Number.isInteger(index) || index < 0)
    throw new RangeError("Element index must be a non-negative integer");
  return `${kind}-${index.toString().padStart(3, "0")}`;
};

export const createElement = <K extends ElementKind>(
  kind: K,
  id: string,
  parameters: Partial<ElementParameters<K>> = {},
): SemanticElement<K> => {
  if (!ELEMENT_KINDS.includes(kind))
    throw new RangeError(`Unknown element kind: ${kind}`);
  if (id.trim().length === 0)
    throw new RangeError("Element id must not be empty");
  const merged = { ...defaults[kind], ...parameters } as ElementParameters<K>;
  if (
    kind === "airtimeHill" &&
    (parameters as Partial<AirtimeHillParameters>).height === undefined &&
    (parameters as Partial<AirtimeHillParameters>).targetForceG !== undefined
  ) {
    const p = merged as ElementParameterMap["airtimeHill"];
    (merged as { height: number }).height =
      (p.targetForceG * p.referenceSpeed ** 2) / (2 * gravity);
  }
  validateParameters(kind, merged);
  return Object.freeze({
    id,
    type: kind,
    kind,
    parameters: Object.freeze(merged),
  });
};

export const validateElement = (
  element: AnySemanticElement,
): readonly string[] => {
  try {
    if (!ELEMENT_KINDS.includes(element.type))
      return [`Unknown element kind: ${element.type}`];
    validateParameters(element.type, element.parameters as never);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

export const defaultPose = (): Pose => ({
  position: vec3(0, 0, 0),
  tangent: vec3(0, 0, 1),
  normal: vec3(0, 1, 0),
  bank: 0,
});

export const orthonormalizePose = (pose: Pose): Pose => {
  const tangent = vec3Normalize(pose.tangent);
  const projected = vec3Add(
    pose.normal,
    vec3Scale(tangent, -vec3Dot(pose.normal, tangent)),
  );
  const normal =
    vec3Length(projected) > 1e-12
      ? vec3Normalize(projected)
      : vec3Normalize(
          Math.abs(tangent[1]) < 0.9
            ? vec3(
                -tangent[1] * tangent[0],
                1 - tangent[1] ** 2,
                -tangent[1] * tangent[2],
              )
            : vec3(
                1 - tangent[0] ** 2,
                -tangent[0] * tangent[1],
                -tangent[0] * tangent[2],
              ),
        );
  return { ...pose, tangent, normal };
};

interface Basis {
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
}
const basisFor = (pose: Pose): Basis => {
  const normalizedPose = orthonormalizePose(pose);
  const tangent = normalizedPose.tangent;
  const projected = vec3Add(
    normalizedPose.normal,
    vec3Scale(tangent, -vec3Dot(normalizedPose.normal, tangent)),
  );
  const normal = vec3Normalize(projected);
  return {
    tangent,
    normal,
    binormal: vec3Normalize(vec3Cross(tangent, normal)),
  };
};
const localToWorld = (basis: Basis, local: Vec3): Vec3 =>
  vec3Add(
    vec3Add(
      vec3Scale(basis.tangent, local[0]),
      vec3Scale(basis.normal, local[1]),
    ),
    vec3Scale(basis.binormal, local[2]),
  );
const worldPoint = (pose: Pose, basis: Basis, local: Vec3): Vec3 =>
  vec3Add(pose.position, localToWorld(basis, local));
const worldVector = (basis: Basis, local: Vec3): Vec3 =>
  localToWorld(basis, local);

const polynomialDerivative = (
  coefficients: readonly number[],
  u: number,
  order: number,
): number => {
  let value = 0;
  for (let power = order; power < coefficients.length; power += 1) {
    let factor = 1;
    for (let i = 0; i < order; i += 1) factor *= power - i;
    value += coefficients[power]! * factor * u ** (power - order);
  }
  return value;
};
const bumpCoefficients = [0, 0, 0, 0, 256, -1024, 1536, -1024, 256] as const;
const smoothRampCoefficients = [0, 0, 0, 0, 35, -84, 70, -20] as const;
const quinticRampCoefficients = [0, 0, 0, 10, -15, 6] as const;

const plateau = (u: number, order = 0): number => {
  const ramp = (value: number, derivativeOrder: number): number =>
    polynomialDerivative(smoothRampCoefficients, value, derivativeOrder);
  if (u < 0.2 || u > 0.8) return 0;
  if (u < 0.35) return ramp((u - 0.2) / 0.15, order) / 0.15 ** order;
  if (u <= 0.65) return order === 0 ? 1 : 0;
  return (order === 0 ? 1 : -ramp((u - 0.65) / 0.15, order)) / 0.15 ** order;
};

const sustainedForceProfile = (u: number, order = 0): number => {
  const ramp = (value: number, derivativeOrder: number): number =>
    polynomialDerivative(smoothRampCoefficients, value, derivativeOrder);
  if (u <= 0.15 || u >= 0.85) return 0;
  if (u < 0.25) return ramp((u - 0.15) / 0.1, order) / 0.1 ** order;
  if (u <= 0.75) return order === 0 ? 1 : 0;
  return order === 0
    ? 1 - ramp((u - 0.75) / 0.1, 0)
    : -ramp((u - 0.75) / 0.1, order) / 0.1 ** order;
};
const profileSpan = (
  pose: Pose,
  length: number,
  vertical: number,
): { span: ParametricSpan<Vec3>; endPose: Pose } => {
  const basis = basisFor(pose);
  const localDerivative = (u: number, order: number): Vec3 =>
    vec3(
      order === 1 ? length : 0,
      vertical * polynomialDerivative(bumpCoefficients, u, order),
      0,
    );
  const span: ParametricSpan<Vec3> = {
    position: (u) =>
      worldPoint(
        pose,
        basis,
        vec3(
          length * u,
          vertical * polynomialDerivative(bumpCoefficients, u, 0),
          0,
        ),
      ),
    derivative: (u, order = 1) => worldVector(basis, localDerivative(u, order)),
  };
  const tangent = vec3Normalize(span.derivative(1, 1));
  return {
    span,
    endPose: orthonormalizePose({
      position: span.position(1),
      tangent,
      normal: basis.normal,
      bank: pose.bank,
    }),
  };
};

const forceProfileSpan = (
  pose: Pose,
  length: number,
  targetForceG: number,
  referenceSpeed: number,
): { span: ParametricSpan<Vec3>; endPose: Pose } => {
  const basis = basisFor(pose);
  const gravityTangent = vec3Dot(worldGravity, basis.tangent);
  const gravityNormal = vec3Dot(worldGravity, basis.normal);
  const targetNormalForce = (u: number): number =>
    1 + (targetForceG - 1) * sustainedForceProfile(u);
  const headingRate = (u: number, heading: number): number => {
    const normalGravity =
      -gravityTangent * Math.sin(heading) + gravityNormal * Math.cos(heading);
    return (
      (length / referenceSpeed ** 2) *
      (targetNormalForce(u) * gravity + normalGravity)
    );
  };
  const integrateStep = (
    state: readonly [number, number, number],
    u: number,
    step: number,
  ): readonly [number, number, number] => {
    const [heading, horizontal, vertical] = state;
    const half = step / 2;
    const k1Heading = headingRate(u, heading);
    const k1Horizontal = length * Math.cos(heading);
    const k1Vertical = length * Math.sin(heading);
    const heading2 = heading + half * k1Heading;
    const k2Heading = headingRate(u + half, heading2);
    const k2Horizontal = length * Math.cos(heading2);
    const k2Vertical = length * Math.sin(heading2);
    const heading3 = heading + half * k2Heading;
    const k3Heading = headingRate(u + half, heading3);
    const k3Horizontal = length * Math.cos(heading3);
    const k3Vertical = length * Math.sin(heading3);
    const heading4 = heading + half * k3Heading;
    const k4Heading = headingRate(u + step, heading4);
    const k4Horizontal = length * Math.cos(heading4);
    const k4Vertical = length * Math.sin(heading4);
    return [
      heading +
        (step / 6) * (k1Heading + 2 * k2Heading + 2 * k3Heading + k4Heading),
      horizontal +
        (step / 6) *
          (k1Horizontal + 2 * k2Horizontal + 2 * k3Horizontal + k4Horizontal),
      vertical +
        (step / 6) *
          (k1Vertical + 2 * k2Vertical + 2 * k3Vertical + k4Vertical),
    ];
  };
  const integrationResolution = 128;
  const integrationTable: readonly (readonly [number, number, number])[] =
    (() => {
      const table: Array<readonly [number, number, number]> = [[0, 0, 0]];
      const step = 1 / integrationResolution;
      for (let index = 0; index < integrationResolution; index += 1)
        table.push(integrateStep(table[index]!, index * step, step));
      return table;
    })();
  const integrateState = (upper: number): readonly [number, number, number] => {
    const clamped = Math.max(0, Math.min(1, upper));
    const scaled = clamped * integrationResolution;
    const lowerIndex = Math.min(integrationResolution - 1, Math.floor(scaled));
    const fraction = scaled - lowerIndex;
    const lower = integrationTable[lowerIndex]!;
    const upperState = integrationTable[lowerIndex + 1]!;
    return [
      lower[0] + (upperState[0] - lower[0]) * fraction,
      lower[1] + (upperState[1] - lower[1]) * fraction,
      lower[2] + (upperState[2] - lower[2]) * fraction,
    ];
  };
  const localDerivative = (u: number, order: number): Vec3 => {
    const [heading] = integrateState(u);
    const tangent = vec3(Math.cos(heading), Math.sin(heading), 0);
    const normal = vec3(-Math.sin(heading), Math.cos(heading), 0);
    const thetaPrime = headingRate(u, heading);
    const thetaSecond =
      (length / referenceSpeed ** 2) *
      (gravity * (targetForceG - 1) * sustainedForceProfile(u, 1) +
        (-gravityTangent * Math.cos(heading) -
          gravityNormal * Math.sin(heading)) *
          thetaPrime);
    if (order === 1) return vec3Scale(tangent, length);
    if (order === 2) return vec3Scale(normal, length * thetaPrime);
    if (order === 3)
      return vec3Add(
        vec3Scale(normal, length * thetaSecond),
        vec3Scale(tangent, -length * thetaPrime ** 2),
      );
    return vec3(0, 0, 0);
  };
  const span: ParametricSpan<Vec3> = {
    position: (u) => {
      const [, horizontal, vertical] = integrateState(u);
      return worldPoint(pose, basis, vec3(horizontal, vertical, 0));
    },
    derivative: (u, order = 1) => worldVector(basis, localDerivative(u, order)),
  };
  const tangent = vec3Normalize(span.derivative(1, 1));
  return {
    span,
    endPose: orthonormalizePose({
      position: span.position(1),
      tangent,
      normal: basis.normal,
      bank: pose.bank,
    }),
  };
};

const topHatSpan = (
  pose: Pose,
  width: number,
  endBank: number,
): {
  span: ParametricSpan<Vec3>;
  positionCoefficients: readonly (readonly number[])[];
  rollCoefficients: readonly number[];
  endPose: Pose;
  bank: ParametricSpan<number>;
} => {
  const basis = basisFor(pose);
  // Keep the authored analytic view for solver diagnostics, and carry a
  // canonical coefficient view for serialization/runtime compilation.
  const heightCoefficients = [
    0,
    0,
    0,
    64 * 80,
    -192 * 80,
    192 * 80,
    -64 * 80,
    0,
  ];
  const positionCoefficients = [0, 1, 2].map((component) =>
    Array.from(
      { length: 8 },
      (_, power) =>
        (power === 0 ? pose.position[component]! : 0) +
        basis.tangent[component]! * (power === 1 ? width : 0) +
        basis.normal[component]! * (heightCoefficients[power] ?? 0),
    ),
  );
  const localDerivative = (u: number, order: number): Vec3 =>
    order === 0
      ? vec3(width * u, 80 * plateau(u), 0)
      : order === 1
        ? vec3(width, 80 * plateau(u, 1), 0)
        : order === 2
          ? vec3(0, 80 * plateau(u, 2), 0)
          : order === 3
            ? vec3(0, 80 * plateau(u, 3), 0)
            : vec3(0, 0, 0);
  const span: ParametricSpan<Vec3> = {
    position: (u) => worldPoint(pose, basis, localDerivative(u, 0)),
    derivative: (u, order = 1) => worldVector(basis, localDerivative(u, order)),
  };
  const bump = [0, 0, 16 * Math.PI, -32 * Math.PI, 16 * Math.PI, 0];
  const base = new QuinticScalarSpan({
    v0: pose.bank,
    d10: 0,
    d20: 0,
    v1: endBank,
    d11: 0,
    d21: 0,
  }).coefficients;
  const canonicalBank = QuinticScalarSpan.fromCoefficients(
    base.map((value, index) => value + (bump[index] ?? 0)),
  );
  const invertedBank = pose.bank + Math.PI;
  const bank: ParametricSpan<number> = {
    position: (u) => {
      if (u < 0.2) return pose.bank;
      if (u < 0.4)
        return (
          pose.bank +
          (invertedBank - pose.bank) *
            polynomialDerivative(quinticRampCoefficients, (u - 0.2) / 0.2, 0)
        );
      if (u <= 0.6) return invertedBank;
      if (u < 0.8)
        return (
          invertedBank +
          (endBank - invertedBank) *
            polynomialDerivative(quinticRampCoefficients, (u - 0.6) / 0.2, 0)
        );
      return endBank;
    },
    derivative: (u, order = 1) => {
      if (u <= 0.2 || u >= 0.8 || (u >= 0.4 && u <= 0.6)) return 0;
      const rising = u < 0.4;
      const t = rising ? (u - 0.2) / 0.2 : (u - 0.6) / 0.2;
      const delta = rising ? invertedBank - pose.bank : endBank - invertedBank;
      return (
        (delta * polynomialDerivative(quinticRampCoefficients, t, order)) /
        0.2 ** order
      );
    },
  };
  return {
    span,
    positionCoefficients,
    rollCoefficients: canonicalBank.coefficients,
    bank,
    endPose: orthonormalizePose({
      position: span.position(1),
      tangent: vec3Normalize(span.derivative(1, 1)),
      normal: basis.normal,
      bank: endBank,
    }),
  };
};

const circularSpan = (
  pose: Pose,
  radius: number,
  turns: number,
  signed: number,
): { span: ParametricSpan<Vec3>; endPose: Pose } => {
  const basis = basisFor(pose);
  const theta = turns * 2 * Math.PI;
  const local = (u: number, order: number): Vec3 => {
    const a = theta * u;
    if (order === 0)
      return vec3(radius * Math.sin(a), 0, signed * radius * (1 - Math.cos(a)));
    if (order === 1)
      return vec3(
        radius * theta * Math.cos(a),
        0,
        signed * radius * theta * Math.sin(a),
      );
    if (order === 2)
      return vec3(
        -radius * theta ** 2 * Math.sin(a),
        0,
        signed * radius * theta ** 2 * Math.cos(a),
      );
    return vec3(
      -radius * theta ** 3 * Math.cos(a),
      0,
      -signed * radius * theta ** 3 * Math.sin(a),
    );
  };
  const span: ParametricSpan<Vec3> = {
    position: (u) => worldPoint(pose, basis, local(u, 0)),
    derivative: (u, order = 1) => worldVector(basis, local(u, order)),
  };
  return {
    span,
    endPose: orthonormalizePose({
      position: span.position(1),
      tangent: vec3Normalize(span.derivative(1, 1)),
      normal: basis.normal,
      bank: pose.bank,
    }),
  };
};

const bankLaw = (from: number, to: number): ParametricSpan<number> =>
  new QuinticScalarSpan({ v0: from, d10: 0, d20: 0, v1: to, d11: 0, d21: 0 });
const lineSpan = (
  pose: Pose,
  length: number,
  endBank: number,
): ElementBuildResult => {
  const basis = basisFor(pose);
  const span = SeventhOrderHermiteSpan.line(
    pose.position,
    worldPoint(pose, basis, vec3(length, 0, 0)),
  );
  const bank = bankLaw(pose.bank, endBank);
  const endPose = orthonormalizePose({
    position: span.position(1),
    tangent: basis.tangent,
    normal: basis.normal,
    bank: endBank,
  });
  return { span, bank, endPose, solvedSpan: { id: "", span, bank } };
};

export const buildElement = (
  element: AnySemanticElement,
  pose: Pose,
  referenceSpeed = 25,
): ElementBuildResult => {
  const normalizedPose = orthonormalizePose(pose);
  let span: ParametricSpan<Vec3>;
  let endPose: Pose;
  let endBank = normalizedPose.bank;
  let bank: ParametricSpan<number> | undefined;
  let positionCoefficients: readonly (readonly number[])[] | undefined;
  let rollCoefficients: readonly number[] | undefined;
  switch (element.type) {
    case "station": {
      const p = element.parameters as ElementParameterMap["station"];
      const curve = p.closed
        ? circularSpan(normalizedPose, p.length / (2 * Math.PI), 1, 1)
        : undefined;
      if (curve) {
        span = curve.span;
        endPose = { ...curve.endPose, bank: p.bank };
      } else {
        const line = lineSpan(normalizedPose, p.length, p.bank);
        span = line.span;
        endPose = line.endPose;
      }
      endBank = p.bank;
      break;
    }
    case "launch":
    case "boost":
    case "brake": {
      const p = element.parameters as ElementParameterMap["launch"];
      const line = lineSpan(normalizedPose, p.length, p.bank);
      span = line.span;
      endPose = line.endPose;
      endBank = p.bank;
      break;
    }
    case "transition": {
      const p = element.parameters as ElementParameterMap["transition"];
      const basis = basisFor(normalizedPose);
      const target = worldPoint(
        normalizedPose,
        basis,
        vec3(p.length, p.rise, 0),
      );
      const endTangent = vec3Normalize(
        vec3Add(basis.tangent, vec3Scale(basis.normal, p.pitch)),
      );
      span = new SeventhOrderHermiteSpan({
        p0: normalizedPose.position,
        d10: vec3Scale(basis.tangent, p.length),
        d20: vec3(0, 0, 0),
        d30: vec3(0, 0, 0),
        p1: target,
        d11: vec3Scale(endTangent, p.length),
        d21: vec3(0, 0, 0),
        d31: vec3(0, 0, 0),
      });
      endPose = orthonormalizePose({
        position: span.position(1),
        tangent: endTangent,
        normal: basis.normal,
        bank: p.bank,
      });
      endBank = p.bank;
      break;
    }
    case "topHat": {
      const p = element.parameters as ElementParameterMap["topHat"];
      const profile = topHatSpan(normalizedPose, p.width, p.bank);
      span = profile.span;
      positionCoefficients = profile.positionCoefficients;
      rollCoefficients = profile.rollCoefficients;
      endPose = { ...profile.endPose, bank: p.bank };
      bank = profile.bank;
      endBank = p.bank;
      break;
    }
    case "airtimeHill": {
      const p = element.parameters as ElementParameterMap["airtimeHill"];
      const profile = forceProfileSpan(
        normalizedPose,
        p.length,
        p.targetForceG,
        p.referenceSpeed,
      );
      span = profile.span;
      endPose = { ...profile.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
    case "overbankedTurn": {
      const p = element.parameters as ElementParameterMap["overbankedTurn"];
      const curve = circularSpan(
        normalizedPose,
        p.radius,
        Math.abs(p.angle) / (2 * Math.PI),
        Math.sign(p.angle) || 1,
      );
      span = curve.span;
      endPose = { ...curve.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
    case "zeroGRoll": {
      const p = element.parameters as ElementParameterMap["zeroGRoll"];
      const profile = forceProfileSpan(
        normalizedPose,
        p.length,
        0,
        referenceSpeed,
      );
      span = profile.span;
      endPose = orthonormalizePose({
        ...profile.endPose,
        bank: normalizedPose.bank + p.roll,
      });
      endBank = normalizedPose.bank + p.roll;
      break;
    }
    case "stall": {
      const p = element.parameters as ElementParameterMap["stall"];
      const profile = profileSpan(normalizedPose, p.length, p.height);
      span = profile.span;
      endPose = { ...profile.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
  }
  bank ??= bankLaw(normalizedPose.bank, endBank);
  const points = Array.from({ length: 33 }, (_, i) => span.position(i / 32));
  return {
    span,
    bank,
    endPose,
    solvedSpan: {
      id: element.id,
      kind: element.type,
      span,
      bank,
      zones: [element.type],
      bounds: aabbFromPoints(points),
      ...(positionCoefficients ? { positionCoefficients } : {}),
      ...(rollCoefficients ? { rollCoefficients } : {}),
    },
  };
};
