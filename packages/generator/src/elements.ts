import {
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  aabbFromPoints,
  vec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
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
      range("height", p.height, 80, 200);
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

interface Basis {
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
}
const basisFor = (pose: Pose): Basis => {
  const tangent = vec3Normalize(pose.tangent);
  const projected = vec3Add(
    pose.normal,
    vec3Scale(tangent, -vec3Dot(pose.normal, tangent)),
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
    endPose: {
      position: span.position(1),
      tangent,
      normal: basis.normal,
      bank: pose.bank,
    },
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
    endPose: {
      position: span.position(1),
      tangent: vec3Normalize(span.derivative(1, 1)),
      normal: basis.normal,
      bank: pose.bank,
    },
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
  const endPose: Pose = {
    position: span.position(1),
    tangent: basis.tangent,
    normal: basis.normal,
    bank: endBank,
  };
  return { span, bank, endPose, solvedSpan: { id: "", span, bank } };
};

export const buildElement = (
  element: AnySemanticElement,
  pose: Pose,
): ElementBuildResult => {
  let span: ParametricSpan<Vec3>;
  let endPose: Pose;
  let endBank = pose.bank;
  switch (element.type) {
    case "station": {
      const p = element.parameters as ElementParameterMap["station"];
      const curve = p.closed
        ? circularSpan(pose, p.length / (2 * Math.PI), 1, 1)
        : undefined;
      if (curve) {
        span = curve.span;
        endPose = { ...curve.endPose, bank: p.bank };
      } else {
        const line = lineSpan(pose, p.length, p.bank);
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
      const line = lineSpan(pose, p.length, p.bank);
      span = line.span;
      endPose = line.endPose;
      endBank = p.bank;
      break;
    }
    case "transition": {
      const p = element.parameters as ElementParameterMap["transition"];
      const basis = basisFor(pose);
      const target = worldPoint(pose, basis, vec3(p.length, p.rise, 0));
      const endTangent = vec3Normalize(
        vec3Add(basis.tangent, vec3Scale(basis.normal, p.pitch)),
      );
      span = new SeventhOrderHermiteSpan({
        p0: pose.position,
        d10: vec3Scale(basis.tangent, p.length),
        d20: vec3(0, 0, 0),
        d30: vec3(0, 0, 0),
        p1: target,
        d11: vec3Scale(endTangent, p.length),
        d21: vec3(0, 0, 0),
        d31: vec3(0, 0, 0),
      });
      endPose = {
        position: span.position(1),
        tangent: endTangent,
        normal: basis.normal,
        bank: p.bank,
      };
      endBank = p.bank;
      break;
    }
    case "topHat": {
      const p = element.parameters as ElementParameterMap["topHat"];
      const profile = profileSpan(pose, p.width, p.height);
      span = profile.span;
      endPose = { ...profile.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
    case "airtimeHill": {
      const p = element.parameters as ElementParameterMap["airtimeHill"];
      const height =
        p.height === 0
          ? (p.targetForceG * p.referenceSpeed ** 2) / (2 * gravity)
          : p.height;
      const profile = profileSpan(pose, p.length, height);
      span = profile.span;
      endPose = { ...profile.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
    case "overbankedTurn": {
      const p = element.parameters as ElementParameterMap["overbankedTurn"];
      const curve = circularSpan(
        pose,
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
      const line = lineSpan(pose, p.length, pose.bank + p.roll);
      span = line.span;
      endPose = line.endPose;
      endBank = pose.bank + p.roll;
      break;
    }
    case "stall": {
      const p = element.parameters as ElementParameterMap["stall"];
      const profile = profileSpan(pose, p.length, p.height);
      span = profile.span;
      endPose = { ...profile.endPose, bank: p.bank };
      endBank = p.bank;
      break;
    }
  }
  const bank = bankLaw(pose.bank, endBank);
  const points = Array.from({ length: 33 }, (_, i) => span.position(i / 32));
  return {
    span,
    bank,
    endPose,
    solvedSpan: {
      id: element.id,
      span,
      bank,
      zones: [element.type],
      bounds: aabbFromPoints(points),
    },
  };
};
