import {
  compileTrack,
  vec3,
  vec3Add,
  vec3Cross,
  vec3Distance,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Sub,
  vec3Scale,
  QuinticScalarSpan,
  type Diagnostic,
  type ParametricSpan,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { buildElement, defaultPose, orthonormalizePose } from "./elements";
import type {
  CompileResult,
  HardTarget,
  Pose,
  ResidualSet,
  SeamDiagnostics,
  SeamTolerances,
  AnySemanticElement,
  ElementParameterMap,
  SolveOptions,
  SolveResult,
} from "./types";

const gravity = 9.80665;
const worldGravity = vec3(0, -gravity, 0);
const defaultTolerances: SeamTolerances = {
  positionM: 1e-4,
  tangentRad: 1e-5,
  curvaturePerM: 1e-4,
  curvatureGradientPerM2: 1e-4,
  bankRad: 1e-4,
  bankDerivativeRadPerM: 1e-4,
  specificForceJumpG: 0.05,
  sustainedForceDeviationG: 0.05,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
const zeroResiduals = (): ResidualSet => ({
  positionM: 0,
  tangentRad: 0,
  curvaturePerM: 0,
  curvatureGradientPerM2: 0,
  curvatureVectorJumpPerM: 0,
  bankRad: 0,
  bankDerivativeRadPerM: 0,
  specificForceJumpG: 0,
  sustainedForceDeviationG: 0,
});

const curvature = (span: ParametricSpan<Vec3>, u: number): number => {
  const d1 = span.derivative(u, 1);
  const d2 = span.derivative(u, 2);
  const cross = vec3Cross(d1, d2);
  const speed = vec3Length(d1);
  return speed > 1e-12 ? vec3Length(cross) / speed ** 3 : 0;
};
const curvatureVector = (span: ParametricSpan<Vec3>, u: number): Vec3 => {
  const d1 = span.derivative(u, 1);
  const d2 = span.derivative(u, 2);
  const speedSquared = vec3Dot(d1, d1);
  const projection = vec3Dot(d1, d2);
  return speedSquared > 1e-24
    ? vec3(
        (d2[0] * speedSquared - d1[0] * projection) / speedSquared ** 2,
        (d2[1] * speedSquared - d1[1] * projection) / speedSquared ** 2,
        (d2[2] * speedSquared - d1[2] * projection) / speedSquared ** 2,
      )
    : vec3(0, 0, 0);
};
const curvatureGradient = (span: ParametricSpan<Vec3>, u: number): number => {
  if ((u === 0 || u === 1) && vec3Length(span.derivative(u, 2)) < 1e-10)
    return 0;
  const epsilon = 1e-4;
  const low = Math.max(0, u - epsilon);
  const high = Math.min(1, u + epsilon);
  if (high === low) return 0;
  return (
    (curvature(span, high) - curvature(span, low)) /
    ((high - low) * vec3Length(span.derivative(u, 1)))
  );
};
const bankValue = (span: SolvedSpan, u: number): number =>
  span.bank?.position(u) ?? 0;
const bankDerivative = (span: SolvedSpan, u: number): number =>
  span.bank?.derivative(u, 1) ?? 0;

interface ForceFrame {
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly specificForce: Vec3;
}

const forceFrame = (span: SolvedSpan, u: number, speed: number): ForceFrame => {
  const tangent = vec3Normalize(span.span.derivative(u, 1));
  const curvature = curvatureVector(span.span, u);
  const curvatureMagnitude = vec3Length(curvature);
  const gravityPerpendicular = vec3Sub(
    worldGravity,
    vec3Scale(tangent, vec3Dot(worldGravity, tangent)),
  );
  const geometricNormal =
    curvatureMagnitude > 1e-12
      ? vec3Scale(
          curvature,
          (vec3Dot(curvature, vec3Scale(worldGravity, -1)) >= 0 ? 1 : -1) /
            curvatureMagnitude,
        )
      : vec3Length(gravityPerpendicular) > 1e-12
        ? vec3Scale(vec3Normalize(gravityPerpendicular), -1)
        : (() => {
            const reference =
              Math.abs(tangent[1]) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
            return vec3Normalize(
              vec3Sub(
                reference,
                vec3Scale(tangent, vec3Dot(reference, tangent)),
              ),
            );
          })();
  const geometricBinormal = vec3Normalize(vec3Cross(tangent, geometricNormal));
  const bank = bankValue(span, u);
  const normal = vec3Normalize(
    vec3Add(
      vec3Scale(geometricNormal, Math.cos(bank)),
      vec3Scale(geometricBinormal, Math.sin(bank)),
    ),
  );
  const binormal = vec3Normalize(vec3Cross(tangent, normal));
  return {
    tangent,
    normal,
    binormal,
    specificForce: vec3Sub(vec3Scale(curvature, speed ** 2), worldGravity),
  };
};

const specificForceNormalG = (
  span: SolvedSpan,
  u: number,
  speed: number,
): number => {
  const frame = forceFrame(span, u, speed);
  return vec3Dot(frame.specificForce, frame.normal) / gravity;
};
const specificForceResidualG = (
  span: SolvedSpan,
  u: number,
  speed: number,
  target: number,
): number => {
  const frame = forceFrame(span, u, speed);
  return Math.max(
    Math.abs(vec3Dot(frame.specificForce, frame.normal) / gravity - target),
    Math.abs(vec3Dot(frame.specificForce, frame.binormal) / gravity),
  );
};

export interface LeastSquaresProblem {
  readonly initial: readonly number[];
  readonly lower: readonly number[];
  readonly upper: readonly number[];
  readonly residual: (variables: readonly number[]) => readonly number[];
  readonly maxIterations?: number;
}
export interface LeastSquaresResult {
  readonly variables: readonly number[];
  readonly cost: number;
  readonly iterations: number;
}

const solveLinearSystem = (matrix: number[][], rhs: number[]): number[] => {
  for (let row = 0; row < rhs.length; row += 1) {
    let pivot = row;
    for (let candidate = row + 1; candidate < rhs.length; candidate += 1)
      if (Math.abs(matrix[candidate]![row]!) > Math.abs(matrix[pivot]![row]!))
        pivot = candidate;
    if (Math.abs(matrix[pivot]![row]!) < 1e-14) continue;
    [matrix[row], matrix[pivot]] = [matrix[pivot]!, matrix[row]!];
    [rhs[row], rhs[pivot]] = [rhs[pivot]!, rhs[row]!];
    const divisor = matrix[row]![row]!;
    for (let column = row; column < rhs.length; column += 1)
      matrix[row]![column]! /= divisor;
    rhs[row]! /= divisor;
    for (let other = 0; other < rhs.length; other += 1) {
      if (other === row) continue;
      const factor = matrix[other]![row]!;
      for (let column = row; column < rhs.length; column += 1)
        matrix[other]![column]! -= factor * matrix[row]![column]!;
      rhs[other]! -= factor * rhs[row]!;
    }
  }
  return rhs;
};

export const boundedLevenbergMarquardt = (
  problem: LeastSquaresProblem,
): LeastSquaresResult => {
  if (
    problem.initial.length !== problem.lower.length ||
    problem.initial.length !== problem.upper.length
  )
    throw new RangeError("Least-squares bounds must match variables");
  const bounded = (value: number, index: number): number =>
    clamp(value, problem.lower[index]!, problem.upper[index]!);
  const requestedIterations = problem.maxIterations ?? 24;
  const maxIterations = Number.isNaN(requestedIterations)
    ? 0
    : requestedIterations === Number.POSITIVE_INFINITY
      ? 32
      : requestedIterations === Number.NEGATIVE_INFINITY
        ? 0
        : clamp(Math.floor(requestedIterations), 0, 32);
  let variables = problem.initial.map(bounded);
  let residual = [...problem.residual(variables)];
  const costOf = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value ** 2, 0);
  let cost = costOf(residual);
  let damping = 1e-2;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    const variableCount = variables.length;
    const jacobian = residual.map(() => Array<number>(variableCount).fill(0));
    for (let column = 0; column < variableCount; column += 1) {
      const delta = 1e-6 * Math.max(1, Math.abs(variables[column]!));
      const plus = [...variables];
      const minus = [...variables];
      plus[column] = bounded(variables[column]! + delta, column);
      minus[column] = bounded(variables[column]! - delta, column);
      const plusResidual = problem.residual(plus);
      const minusResidual = problem.residual(minus);
      for (let row = 0; row < residual.length; row += 1)
        jacobian[row]![column] =
          (plusResidual[row]! - minusResidual[row]!) / (2 * delta);
    }
    const normal = Array.from({ length: variableCount }, () =>
      Array<number>(variableCount).fill(0),
    );
    const gradient = Array<number>(variableCount).fill(0);
    for (let row = 0; row < residual.length; row += 1)
      for (let a = 0; a < variableCount; a += 1) {
        gradient[a]! += jacobian[row]![a]! * residual[row]!;
        for (let b = 0; b < variableCount; b += 1)
          normal[a]![b]! += jacobian[row]![a]! * jacobian[row]![b]!;
      }
    for (let diagonal = 0; diagonal < variableCount; diagonal += 1)
      normal[diagonal]![diagonal]! += damping;
    const step = solveLinearSystem(
      normal,
      gradient.map((value) => -value),
    );
    const candidate = variables.map((value, index) =>
      bounded(value + step[index]!, index),
    );
    const candidateResidual = [...problem.residual(candidate)];
    const candidateCost = costOf(candidateResidual);
    if (candidateCost < cost) {
      variables = candidate;
      residual = candidateResidual;
      cost = candidateCost;
      damping = Math.max(1e-12, damping / 3);
      if (Math.max(...step.map(Math.abs), 0) < 1e-9) break;
    } else damping = Math.min(1e12, damping * 10);
  }
  return { variables: Object.freeze(variables), cost, iterations };
};

export const diagnoseSeams = (
  spans: readonly SolvedSpan[],
  options: Pick<
    SolveOptions,
    "referenceSpeed" | "softForceTargetG" | "seamTolerances" | "closed"
  > = {},
): readonly SeamDiagnostics[] => {
  const speed = options.referenceSpeed ?? 25;
  const seamPairs = spans.slice(0, -1).map((left, index) => ({
    left,
    right: spans[index + 1]!,
    seamId: `${left.id}->${spans[index + 1]!.id}`,
  }));
  if (options.closed && spans.length > 0) {
    const left = spans[spans.length - 1]!;
    const right = spans[0]!;
    seamPairs.push({ left, right, seamId: `${left.id}->${right.id}` });
  }
  return seamPairs.map(({ left, right, seamId }) => {
    const leftPosition = left.span.position(1);
    const rightPosition = right.span.position(0);
    const leftTangent = vec3Normalize(left.span.derivative(1, 1));
    const rightTangent = vec3Normalize(right.span.derivative(0, 1));
    const residual: ResidualSet = {
      positionM: vec3Distance(leftPosition, rightPosition),
      tangentRad: Math.acos(clamp(vec3Dot(leftTangent, rightTangent), -1, 1)),
      curvaturePerM: Math.abs(
        curvature(left.span, 1) - curvature(right.span, 0),
      ),
      curvatureGradientPerM2: Math.abs(
        curvatureGradient(left.span, 1) - curvatureGradient(right.span, 0),
      ),
      curvatureVectorJumpPerM: vec3Length(
        vec3Sub(curvatureVector(left.span, 1), curvatureVector(right.span, 0)),
      ),
      bankRad: Math.abs(bankValue(left, 1) - bankValue(right, 0)),
      bankDerivativeRadPerM: Math.abs(
        bankDerivative(left, 1) - bankDerivative(right, 0),
      ),
      specificForceJumpG: Math.abs(
        specificForceNormalG(left, 1, speed) -
          specificForceNormalG(right, 0, speed),
      ),
      sustainedForceDeviationG:
        options.softForceTargetG === undefined
          ? 0
          : Math.max(
              ...Array.from({ length: 9 }, (_, sample) =>
                Math.abs(
                  specificForceNormalG(right, (sample + 1) / 10, speed) -
                    options.softForceTargetG!,
                ),
              ),
            ),
    };
    const hardResiduals: ResidualSet = {
      ...residual,
      sustainedForceDeviationG: 0,
    };
    const softResiduals: ResidualSet = {
      ...zeroResiduals(),
      sustainedForceDeviationG: residual.sustainedForceDeviationG,
    };
    return {
      seamId,
      ...residual,
      hardResiduals,
      softResiduals,
    };
  });
};

const exceedsHardTolerance = (
  residual: ResidualSet,
  tolerances: SeamTolerances,
): boolean =>
  residual.positionM > tolerances.positionM ||
  residual.tangentRad > tolerances.tangentRad ||
  residual.curvaturePerM > tolerances.curvaturePerM ||
  residual.curvatureVectorJumpPerM > tolerances.curvaturePerM ||
  residual.curvatureGradientPerM2 > tolerances.curvatureGradientPerM2 ||
  residual.bankRad > tolerances.bankRad ||
  residual.bankDerivativeRadPerM > tolerances.bankDerivativeRadPerM ||
  residual.specificForceJumpG > tolerances.specificForceJumpG;

const targetResidual = (target: HardTarget, pose: Pose): number => {
  switch (target.kind) {
    case "end-x":
      return Math.abs(pose.position[0] - (target.target as number));
    case "end-y":
      return Math.abs(pose.position[1] - (target.target as number));
    case "end-z":
      return Math.abs(pose.position[2] - (target.target as number));
    case "end-bank":
      return Math.abs(pose.bank - (target.target as number));
    case "end-position":
      return vec3Distance(pose.position, target.target as Vec3);
    case "end-tangent":
      return Math.acos(
        clamp(
          vec3Dot(
            vec3Normalize(pose.tangent),
            vec3Normalize(target.target as Vec3),
          ),
          -1,
          1,
        ),
      );
  }
};

const hardConflict = (ids: readonly string[], detail: string): Diagnostic => ({
  code: "INFEASIBLE_HARD_CONSTRAINTS",
  severity: "error",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  message: `Conflicting hard constraints (${ids.join(", ")}): ${detail}`,
  suggestedRelaxation: `Relax ${ids.join(", ")} or one named hard target`,
});
const targetTolerance = (
  target: HardTarget,
  tolerances: SeamTolerances,
): number => {
  switch (target.kind) {
    case "end-bank":
      return tolerances.bankRad;
    case "end-tangent":
      return tolerances.tangentRad;
    default:
      return tolerances.positionM;
  }
};

interface SemanticVariable {
  readonly elementIndex: number;
  readonly key: string;
  readonly initial: number;
  readonly lower: number;
  readonly upper: number;
}

interface ChainState {
  readonly elements: readonly AnySemanticElement[];
  readonly solvedSpans: readonly SolvedSpan[];
  readonly endPose: Pose;
  readonly hardGeometryFailures: readonly GeometryFailure[];
}

interface GeometryFailure {
  readonly elementId: string;
  readonly kind: "height" | "orientation" | "force";
  readonly actual: number;
  readonly target: number;
}

const variableBounds = (
  value: number,
  minimum: number,
  maximum: number,
): readonly [number, number] => [
  Math.max(minimum, Math.min(maximum, value * 0.5)),
  Math.min(maximum, Math.max(minimum, value * 1.5)),
];

const semanticVariables = (
  elements: readonly AnySemanticElement[],
  adjustForceTargets: boolean,
): readonly SemanticVariable[] => {
  const variables: SemanticVariable[] = [];
  const add = (
    elementIndex: number,
    key: string,
    initial: number,
    lower: number,
    upper: number,
  ): void => {
    variables.push({
      elementIndex,
      key,
      initial,
      lower: Math.min(lower, upper),
      upper: Math.max(lower, upper),
    });
  };
  for (
    let elementIndex = 0;
    elementIndex < elements.length;
    elementIndex += 1
  ) {
    const element = elements[elementIndex]!;
    const parameters = element.parameters as Record<string, number | boolean>;
    const length = parameters.length;
    if (typeof length === "number") {
      const [lower, upper] = variableBounds(length, 2, 500);
      add(elementIndex, "length", length, lower, upper);
    }
    if (element.type === "topHat") {
      const [lower, upper] = variableBounds(
        parameters.width as number,
        10,
        300,
      );
      add(elementIndex, "width", parameters.width as number, lower, upper);
    }
    if (element.type === "overbankedTurn") {
      const [lower, upper] = variableBounds(
        parameters.radius as number,
        5,
        200,
      );
      add(elementIndex, "radius", parameters.radius as number, lower, upper);
    }
    if (element.type === "transition") {
      const rise = parameters.rise as number;
      add(elementIndex, "rise", rise, rise - 200, rise + 200);
      const pitch = parameters.pitch as number;
      add(elementIndex, "pitch", pitch, -Math.PI * 4, Math.PI * 4);
    }
    if (element.type === "airtimeHill" && adjustForceTargets)
      add(
        elementIndex,
        "targetForceG",
        parameters.targetForceG as number,
        -1.2,
        5,
      );
    if (element.type === "zeroGRoll")
      add(
        elementIndex,
        "roll",
        parameters.roll as number,
        -Math.PI * 4,
        Math.PI * 4,
      );
    if (typeof parameters.bank === "number")
      add(elementIndex, "bank", parameters.bank, -Math.PI, Math.PI);
  }
  return variables;
};

const elementsAt = (
  elements: readonly AnySemanticElement[],
  bindings: readonly SemanticVariable[],
  values: readonly number[],
): readonly AnySemanticElement[] => {
  const patches = new Map<number, Record<string, number>>();
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const patch = patches.get(binding.elementIndex) ?? {};
    patch[binding.key] = values[index]!;
    patches.set(binding.elementIndex, patch);
  }
  return elements.map((element, index) => {
    const patch = patches.get(index);
    return patch
      ? ({
          ...element,
          parameters: { ...element.parameters, ...patch },
        } as AnySemanticElement)
      : element;
  });
};

const buildChain = (
  elements: readonly AnySemanticElement[],
  startPose: Pose,
  referenceSpeed: number,
): ChainState => {
  const solvedSpans: SolvedSpan[] = [];
  const hardGeometryFailures: GeometryFailure[] = [];
  let pose = startPose;
  for (const element of elements) {
    const built = buildElement(element, pose, referenceSpeed);
    const solvedSpan = { ...built.solvedSpan, id: element.id };
    solvedSpans.push(solvedSpan);
    if (element.type === "airtimeHill") {
      const target = element.parameters.height;
      const actual = vec3Dot(
        vec3Sub(built.endPose.position, pose.position),
        pose.normal,
      );
      if (Math.abs(actual - target) > 1e-4)
        hardGeometryFailures.push({
          elementId: element.id,
          kind: "height",
          actual,
          target,
        });
      const forceTarget = element.parameters.targetForceG;
      const forceResidual = Math.max(
        ...[0.25, 0.5, 0.75].map((u) =>
          specificForceResidualG(solvedSpan, u, referenceSpeed, forceTarget),
        ),
      );
      if (forceResidual > 0.05)
        hardGeometryFailures.push({
          elementId: element.id,
          kind: "force",
          actual: forceResidual,
          target: forceTarget,
        });
    }
    if (element.type === "zeroGRoll") {
      const binormal = vec3Normalize(vec3Cross(pose.tangent, pose.normal));
      const gravityBinormal = Math.abs(vec3Dot(worldGravity, binormal));
      if (gravityBinormal > gravity * 1e-10)
        hardGeometryFailures.push({
          elementId: element.id,
          kind: "orientation",
          actual: gravityBinormal / gravity,
          target: 0,
        });
    }
    pose = built.endPose;
  }
  return { elements, solvedSpans, endPose: pose, hardGeometryFailures };
};

const applyAuthoredStartFrame = (
  state: ChainState,
  startPose: Pose,
): ChainState => {
  const first = state.solvedSpans[0];
  if (!first?.bank) return state;
  const tangent = vec3Normalize(first.span.derivative(0, 1));
  const reference = Math.abs(tangent[1]) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const projected = vec3Sub(
    reference,
    vec3Scale(tangent, vec3Dot(reference, tangent)),
  );
  const defaultNormal = vec3Normalize(projected);
  const bankAtStart = first.bank.position(0);
  const currentNormal = vec3Normalize(
    vec3Add(
      vec3Scale(defaultNormal, Math.cos(bankAtStart)),
      vec3Scale(vec3Cross(tangent, defaultNormal), Math.sin(bankAtStart)),
    ),
  );
  const correction = Math.atan2(
    vec3Dot(tangent, vec3Cross(currentNormal, startPose.normal)),
    vec3Dot(currentNormal, startPose.normal),
  );
  if (Math.abs(correction) < 1e-12) return state;
  const correctionSpan = new QuinticScalarSpan({
    v0: correction,
    d10: 0,
    d20: 0,
    v1: 0,
    d11: 0,
    d21: 0,
  });
  const solvedSpans = state.solvedSpans.map((span, index) =>
    index === 0
      ? {
          ...span,
          bank: {
            position: (u: number) =>
              span.bank!.position(u) + correctionSpan.position(u),
            derivative: (u: number, order = 1) =>
              span.bank!.derivative(u, order) +
              correctionSpan.derivative(u, order),
          },
        }
      : span,
  );
  return { ...state, solvedSpans };
};

const appendEndpointResiduals = (
  residual: number[],
  pose: Pose,
  target: Pose,
  tolerances: SeamTolerances,
): void => {
  residual.push(
    (pose.position[0] - target.position[0]) / tolerances.positionM,
    (pose.position[1] - target.position[1]) / tolerances.positionM,
    (pose.position[2] - target.position[2]) / tolerances.positionM,
    (1 - vec3Dot(vec3Normalize(pose.tangent), vec3Normalize(target.tangent))) /
      tolerances.tangentRad,
    (1 - vec3Dot(vec3Normalize(pose.normal), vec3Normalize(target.normal))) /
      tolerances.tangentRad,
    (pose.bank - target.bank) / tolerances.bankRad,
  );
};

const diagnosticResiduals = (
  state: ChainState,
  options: SolveOptions,
  tolerances: SeamTolerances,
  startPose: Pose,
): readonly number[] => {
  const seams = diagnoseSeams(state.solvedSpans, options);
  const residual: number[] = [];
  for (const seam of seams) {
    residual.push(
      seam.positionM / tolerances.positionM,
      seam.tangentRad / tolerances.tangentRad,
      seam.curvaturePerM / tolerances.curvaturePerM,
      seam.curvatureVectorJumpPerM / tolerances.curvaturePerM,
      seam.curvatureGradientPerM2 / tolerances.curvatureGradientPerM2,
      seam.bankRad / tolerances.bankRad,
      seam.bankDerivativeRadPerM / tolerances.bankDerivativeRadPerM,
      seam.specificForceJumpG / tolerances.specificForceJumpG,
    );
    if (options.softForceTargetG !== undefined)
      residual.push(
        seam.softResiduals.sustainedForceDeviationG /
          tolerances.sustainedForceDeviationG,
      );
  }
  if (options.softForceTargetG !== undefined) {
    const speed = options.referenceSpeed ?? 25;
    for (const span of state.solvedSpans)
      for (const sample of [0.25, 0.5, 0.75])
        residual.push(
          (specificForceNormalG(span, sample, speed) -
            options.softForceTargetG) /
            tolerances.sustainedForceDeviationG,
        );
  }
  for (const target of options.targets ?? [])
    residual.push(
      targetResidual(target, state.endPose) /
        targetTolerance(target, tolerances),
    );
  if (options.endPose)
    appendEndpointResiduals(
      residual,
      state.endPose,
      options.endPose,
      tolerances,
    );
  if (options.closed)
    appendEndpointResiduals(residual, state.endPose, startPose, tolerances);
  return residual;
};

export const solveSemanticChain = (
  elements: readonly AnySemanticElement[],
  options: SolveOptions = {},
): SolveResult => {
  const startPose = orthonormalizePose(options.startPose ?? defaultPose());
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id))
      throw new RangeError(`Duplicate element id: ${element.id}`);
    seen.add(element.id);
  }
  if (elements.length === 0)
    throw new RangeError("A semantic chain needs at least one element");
  const firstElement = elements[0];
  const firstIsClosedStation =
    firstElement?.type === "station" &&
    (firstElement.parameters as ElementParameterMap["station"]).closed;
  const closureEnabled = options.closed === true || firstIsClosedStation;
  const solveOptions = closureEnabled ? { ...options, closed: true } : options;
  const tolerances = { ...defaultTolerances, ...options.seamTolerances };
  const bindings = semanticVariables(
    elements,
    options.softForceTargetG !== undefined,
  );
  const initial = bindings.map((binding) => binding.initial);
  const referenceSpeed = options.referenceSpeed ?? 25;
  const stateFor = (values: readonly number[]): ChainState =>
    applyAuthoredStartFrame(
      buildChain(
        elementsAt(elements, bindings, values),
        startPose,
        referenceSpeed,
      ),
      startPose,
    );
  const initialState = stateFor(initial);
  const residualAt = (values: readonly number[]): readonly number[] => [
    ...diagnosticResiduals(
      stateFor(values),
      solveOptions,
      tolerances,
      startPose,
    ),
    ...values.map(
      (value, index) =>
        (1e-3 * (value - initial[index]!)) /
        Math.max(1, bindings[index]!.upper - bindings[index]!.lower),
    ),
  ];
  const initialResidual = residualAt(initial);
  const optimized = initialResidual.every((value) => Math.abs(value) <= 1)
    ? { variables: initial, iterations: 0 }
    : boundedLevenbergMarquardt({
        initial,
        lower: bindings.map((binding) => binding.lower),
        upper: bindings.map((binding) => binding.upper),
        ...(options.maxIterations === undefined
          ? {}
          : { maxIterations: options.maxIterations }),
        residual: residualAt,
      });
  const state = stateFor(optimized.variables);
  const solvedSpans = [...state.solvedSpans];
  const seamDiagnostics = diagnoseSeams(state.solvedSpans, solveOptions);
  const diagnostics: Diagnostic[] = [];
  const relaxations: string[] = [];
  for (const seam of seamDiagnostics) {
    if (exceedsHardTolerance(seam.hardResiduals, tolerances)) {
      const failures = [
        seam.positionM > tolerances.positionM ? "position" : undefined,
        seam.tangentRad > tolerances.tangentRad ? "tangent" : undefined,
        seam.curvaturePerM > tolerances.curvaturePerM ? "curvature" : undefined,
        seam.curvatureVectorJumpPerM > tolerances.curvaturePerM
          ? "curvature vector"
          : undefined,
        seam.curvatureGradientPerM2 > tolerances.curvatureGradientPerM2
          ? "curvature gradient"
          : undefined,
        seam.bankRad > tolerances.bankRad ? "bank" : undefined,
        seam.bankDerivativeRadPerM > tolerances.bankDerivativeRadPerM
          ? "bank derivative"
          : undefined,
        seam.specificForceJumpG > tolerances.specificForceJumpG
          ? "specific-force jump"
          : undefined,
      ].filter((failure): failure is string => failure !== undefined);
      const isClosureSeam =
        closureEnabled && seam.seamId.endsWith(`->${firstElement?.id}`);
      diagnostics.push(
        hardConflict(
          isClosureSeam
            ? ["closed-loop pose/closure constraints", seam.seamId]
            : [seam.seamId],
          `${failures.join(", ")} residual remains after bounded solve`,
        ),
      );
    }
    if (
      seam.softResiduals.sustainedForceDeviationG >
      tolerances.sustainedForceDeviationG
    )
      diagnostics.push({
        code: "SOFT_FORCE_RESIDUAL",
        severity: "warning",
        provenance: "DESIGN_ASSUMPTION",
        message: `Soft sustained-force deviation at ${seam.seamId}: ${seam.softResiduals.sustainedForceDeviationG.toFixed(3)} G`,
      });
  }

  for (const failure of state.hardGeometryFailures) {
    const constraintId = `${failure.elementId}:${failure.kind}`;
    const detail =
      failure.kind === "height"
        ? `infeasible force geometry: requested ${failure.target.toFixed(6)} m, physically force-constrained result ${failure.actual.toFixed(6)} m`
        : failure.kind === "orientation"
          ? `infeasible force geometry: planar zero-G path leaves ${failure.actual.toFixed(6)} G in the gravity binormal component`
          : `infeasible force geometry: banked force target residual is ${failure.actual.toFixed(6)} G`;
    diagnostics.push(hardConflict([constraintId], detail));
  }

  const targets = options.targets ?? [];
  const hardIds: string[] = [];
  for (const target of targets) {
    const error = targetResidual(target, state.endPose);
    if (target.hard !== false && error > targetTolerance(target, tolerances)) {
      hardIds.push(target.id);
      diagnostics.push(
        hardConflict(
          [target.id],
          `${target.kind} residual is ${error.toExponential(3)}`,
        ),
      );
    } else if (
      target.hard === false &&
      error > targetTolerance(target, tolerances)
    ) {
      diagnostics.push({
        code: "SOFT_TARGET_RESIDUAL",
        severity: "warning",
        provenance: "DESIGN_ASSUMPTION",
        message: `Soft target ${target.id} differs by ${error.toExponential(3)}`,
      });
    }
  }

  if (options.endPose && !closureEnabled) {
    const desired = options.endPose;
    const positionError = vec3Distance(
      state.endPose.position,
      desired.position,
    );
    const tangentError = Math.acos(
      clamp(
        vec3Dot(
          vec3Normalize(state.endPose.tangent),
          vec3Normalize(desired.tangent),
        ),
        -1,
        1,
      ),
    );
    const normalError = Math.acos(
      clamp(
        vec3Dot(
          vec3Normalize(state.endPose.normal),
          vec3Normalize(desired.normal),
        ),
        -1,
        1,
      ),
    );
    const bankError = Math.abs(state.endPose.bank - desired.bank);
    const failures = [
      positionError > tolerances.positionM ? "endPose.position" : undefined,
      tangentError > tolerances.tangentRad ? "endPose.tangent" : undefined,
      normalError > tolerances.tangentRad ? "endPose.normal" : undefined,
      bankError > tolerances.bankRad ? "endPose.bank" : undefined,
    ].filter((failure): failure is string => failure !== undefined);
    if (failures.length > 0) {
      diagnostics.push(
        hardConflict(
          failures,
          `position ${positionError.toExponential(3)} m, tangent ${tangentError.toExponential(3)} rad, normal ${normalError.toExponential(3)} rad, bank ${bankError.toExponential(3)} rad remain after bounded solve`,
        ),
      );
    }
  }

  if (closureEnabled) {
    const desired = options.endPose ?? startPose;
    const positionError = vec3Distance(
      state.endPose.position,
      desired.position,
    );
    const tangentError = Math.acos(
      clamp(
        vec3Dot(
          vec3Normalize(state.endPose.tangent),
          vec3Normalize(desired.tangent),
        ),
        -1,
        1,
      ),
    );
    const normalError = Math.acos(
      clamp(
        vec3Dot(
          vec3Normalize(state.endPose.normal),
          vec3Normalize(desired.normal),
        ),
        -1,
        1,
      ),
    );
    const bankError = Math.abs(state.endPose.bank - desired.bank);
    const poseFailures = [
      positionError > tolerances.positionM ? "endPose.position" : undefined,
      tangentError > tolerances.tangentRad ? "endPose.tangent" : undefined,
      normalError > tolerances.tangentRad ? "endPose.normal" : undefined,
      bankError > tolerances.bankRad ? "endPose.bank" : undefined,
    ].filter((failure): failure is string => failure !== undefined);
    if (poseFailures.length > 0) {
      const ids = ["closed-loop pose/closure constraints"];
      if (options.endPose) ids.push(...poseFailures);
      const closure = seamDiagnostics[seamDiagnostics.length - 1];
      if (closure?.seamId.endsWith(`->${firstElement?.id}`))
        ids.push(closure.seamId);
      diagnostics.push(
        hardConflict(
          ids,
          `position ${positionError.toExponential(3)} m, tangent ${tangentError.toExponential(3)} rad, normal ${normalError.toExponential(3)} rad, bank ${bankError.toExponential(3)} rad`,
        ),
      );
    }
  }

  if (hardIds.length > 1)
    diagnostics.push(
      hardConflict(
        hardIds,
        "multiple hard endpoint targets cannot be satisfied simultaneously",
      ),
    );
  if (initialState.solvedSpans.length !== solvedSpans.length)
    throw new Error("Semantic solve changed element count");
  return {
    feasible: !diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    ),
    solvedSpans: Object.freeze(solvedSpans),
    diagnostics: Object.freeze(diagnostics),
    seamDiagnostics: Object.freeze(seamDiagnostics),
    relaxations: Object.freeze(relaxations.slice(0, 3)),
    startPose,
    endPose: state.endPose,
    lmIterations: optimized.iterations,
  };
};

export const compileSemanticChain = (
  elements: readonly AnySemanticElement[],
  options: SolveOptions & {
    readonly samples?: number;
    readonly tolerance?: number;
  } = {},
): CompileResult => {
  const result = solveSemanticChain(elements, options);
  if (!result.feasible) return result;
  const compileOptions = {
    ...(options.samples === undefined ? {} : { samples: options.samples }),
    ...(options.tolerance === undefined
      ? {}
      : { tolerance: options.tolerance }),
  };
  return {
    ...result,
    track: compileTrack(result.solvedSpans, compileOptions),
  };
};

export const solveTrack = solveSemanticChain;
export const compileElements = compileSemanticChain;
