import {
  compileTrack,
  vec3,
  vec3Cross,
  vec3Distance,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Sub,
  type Diagnostic,
  type ParametricSpan,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { buildElement, defaultPose } from "./elements";
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
  const cross = vec3Cross(d1, span.derivative(u, 2));
  const speed = vec3Length(d1);
  return speed > 1e-12
    ? vec3(cross[0] / speed ** 3, cross[1] / speed ** 3, cross[2] / speed ** 3)
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
const forceG = (span: ParametricSpan<Vec3>, u: number, speed: number): number =>
  (speed ** 2 * curvature(span, u)) / gravity;
const bankValue = (span: SolvedSpan, u: number): number =>
  span.bank?.position(u) ?? 0;
const bankDerivative = (span: SolvedSpan, u: number): number =>
  span.bank?.derivative(u, 1) ?? 0;

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
  let variables = problem.initial.map(bounded);
  let residual = [...problem.residual(variables)];
  const costOf = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value ** 2, 0);
  let cost = costOf(residual);
  let damping = 1e-2;
  let iterations = 0;
  for (
    ;
    iterations < Math.max(0, Math.floor(problem.maxIterations ?? 24));
    iterations += 1
  ) {
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
    "referenceSpeed" | "softForceTargetG" | "seamTolerances"
  > = {},
): readonly SeamDiagnostics[] => {
  const speed = options.referenceSpeed ?? 25;
  return spans.slice(0, -1).map((left, index) => {
    const right = spans[index + 1]!;
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
        forceG(left.span, 1, speed) - forceG(right.span, 0, speed),
      ),
      sustainedForceDeviationG:
        options.softForceTargetG === undefined
          ? 0
          : Math.max(
              ...Array.from({ length: 9 }, (_, sample) =>
                Math.abs(
                  forceG(right.span, (sample + 1) / 10, speed) -
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
      seamId: `${left.id}->${right.id}`,
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
  message: `Conflicting hard constraints (${ids.join(", ")}): ${detail}`,
  suggestedRelaxation:
    "Relax endPose.position, the closed station pose, or one named hard target",
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

export const solveSemanticChain = (
  elements: readonly AnySemanticElement[],
  options: SolveOptions = {},
): SolveResult => {
  const startPose = options.startPose ?? defaultPose();
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id))
      throw new RangeError(`Duplicate element id: ${element.id}`);
    seen.add(element.id);
  }
  if (elements.length === 0)
    throw new RangeError("A semantic chain needs at least one element");
  const solvedSpans: SolvedSpan[] = [];
  let pose = startPose;
  for (const element of elements) {
    const built = buildElement(element, pose);
    solvedSpans.push({ ...built.solvedSpan, id: element.id });
    pose = built.endPose;
  }

  const seamDiagnostics = diagnoseSeams(solvedSpans, options);
  const tolerances = { ...defaultTolerances, ...options.seamTolerances };
  const diagnostics: Diagnostic[] = [];
  for (const seam of seamDiagnostics) {
    if (exceedsHardTolerance(seam.hardResiduals, tolerances)) {
      diagnostics.push({
        code: "SEAM_HARD_RESIDUAL",
        severity: "error",
        message: `Hard seam residual at ${seam.seamId}: position ${seam.positionM.toExponential(3)} m, tangent ${seam.tangentRad.toExponential(3)} rad`,
        suggestedRelaxation:
          "Relax the named seam tolerance only after reviewing the element endpoint constraints",
      });
    }
    if (
      seam.softResiduals.sustainedForceDeviationG >
      tolerances.sustainedForceDeviationG
    )
      diagnostics.push({
        code: "SOFT_FORCE_RESIDUAL",
        severity: "warning",
        message: `Soft sustained-force deviation at ${seam.seamId}: ${seam.softResiduals.sustainedForceDeviationG.toFixed(3)} G`,
      });
  }

  const targets = options.targets ?? [];
  const hardIds: string[] = [];
  const relaxations: string[] = [];
  for (const target of targets) {
    const error = targetResidual(target, pose);
    if (target.hard !== false && error > targetTolerance(target, tolerances)) {
      hardIds.push(target.id);
      diagnostics.push(
        hardConflict(
          [target.id],
          `${target.kind} residual is ${error.toExponential(3)}`,
        ),
      );
      if (relaxations.length < 3)
        relaxations.push(`Relax hard target ${target.id}`);
    } else if (
      target.hard === false &&
      error > targetTolerance(target, tolerances)
    ) {
      diagnostics.push({
        code: "SOFT_TARGET_RESIDUAL",
        severity: "warning",
        message: `Soft target ${target.id} differs by ${error.toExponential(3)}`,
      });
    }
  }

  const firstElement = elements[0];
  const firstIsClosedStation =
    firstElement?.type === "station" &&
    (firstElement.parameters as ElementParameterMap["station"]).closed;
  if (options.closed || firstIsClosedStation) {
    const desired = options.endPose ?? startPose;
    const positionError = vec3Distance(pose.position, desired.position);
    const tangentError = Math.acos(
      clamp(
        vec3Dot(vec3Normalize(pose.tangent), vec3Normalize(desired.tangent)),
        -1,
        1,
      ),
    );
    const normalError = Math.acos(
      clamp(
        vec3Dot(vec3Normalize(pose.normal), vec3Normalize(desired.normal)),
        -1,
        1,
      ),
    );
    const bankError = Math.abs(pose.bank - desired.bank);
    if (
      positionError > tolerances.positionM ||
      tangentError > tolerances.tangentRad ||
      normalError > tolerances.tangentRad ||
      bankError > tolerances.bankRad
    ) {
      const ids = ["closed station pose"];
      if (options.endPose) ids.push("endPose");
      diagnostics.push(
        hardConflict(
          ids,
          `position ${positionError.toExponential(3)} m, tangent ${tangentError.toExponential(3)} rad, normal ${normalError.toExponential(3)} rad, bank ${bankError.toExponential(3)} rad`,
        ),
      );
      for (const relaxation of [
        "Relax endPose.position",
        "Relax closed station pose tangent",
        "Relax closed station bank",
      ])
        if (relaxations.length < 3) relaxations.push(relaxation);
    }
  }

  if (hardIds.length > 1)
    diagnostics.push(
      hardConflict(
        hardIds,
        "multiple hard endpoint targets cannot be satisfied simultaneously",
      ),
    );
  return {
    feasible: !diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    ),
    solvedSpans: Object.freeze(solvedSpans),
    diagnostics: Object.freeze(diagnostics),
    seamDiagnostics: Object.freeze(seamDiagnostics),
    relaxations: Object.freeze(relaxations.slice(0, 3)),
    startPose,
    endPose: pose,
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
