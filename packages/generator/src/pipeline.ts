import {
  CoasterFileError,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  Xoshiro128ss,
  arcLength,
  compileCoasterFile,
  createCoasterFileV1,
  serializeCoasterFileV1,
  serializeSolvedSpanV1,
  reconstructSolvedSpan,
  validateDesignIntentV1,
  compileTrack,
  aabbFromPoints,
  quatRotateVector,
  vec3Distance,
  vec3Dot,
  vec3Sub,
  vec3Normalize,
  vec3Scale,
  vec3,
  transportFramesAlongPath,
  type Diagnostic,
  type DesignIntentV1,
  type EnvironmentQuery,
  type SolvedSpan,
  type ParametricSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { validateClearance } from "./clearance";
import {
  CertifiedWorkBudget,
  CertificationError,
  certifiedPolynomialBounds,
} from "./polynomial-bounds";
import { buildElement, createElement, defaultPose } from "./elements";
import { ELEMENT_KINDS } from "./types";
import * as solver from "./solver";
import type {
  AnySemanticElement,
  GenerationOptions,
  GenerationResult,
  LocalRegenerationOptions,
  LocalRegenerationResult,
  RelaxationEvidence,
  SolveOptions,
  HardTarget,
  GenerationStageTimings,
  ElementParameterMap,
} from "./types";

const now = (): number =>
  (
    globalThis as unknown as { readonly performance?: { now(): number } }
  ).performance?.now() ?? Date.now();

const defaultElements = (seed: number, candidate = 0): AnySemanticElement[] => {
  const rng = new Xoshiro128ss(seed);
  for (let index = 0; index < candidate; index += 1) rng.nextUint32();
  const variation = rng.nextRange(-2, 2);
  const prefix = [
    createElement("station", "station-000", { length: 120 }),
    createElement("launch", "launch-001", { length: 260, targetSpeed: 44 }),
    createElement("topHat", "topHat-002", { width: 220 }),
    createElement("overbankedTurn", "overbankedTurn-003", {
      radius: 75,
      angle: Math.PI * 0.75,
      bank: 0,
    }),
  ];
  const provisionalHill = createElement("airtimeHill", "airtimeHill-004", {
    length: 130 + variation,
    height: 0,
    targetForceG: 1.15,
    referenceSpeed: 44,
  });
  let hillStartPose = defaultPose();
  for (const element of prefix)
    hillStartPose = buildElement(element, hillStartPose, 44).endPose;
  const provisionalHillEnd = buildElement(
    provisionalHill,
    hillStartPose,
    44,
  ).endPose;
  const forceDrivenHeight = vec3Dot(
    vec3Sub(provisionalHillEnd.position, hillStartPose.position),
    hillStartPose.normal,
  );
  const elements = [
    ...prefix,
    createElement("airtimeHill", "airtimeHill-004", {
      length: 130 + variation,
      height: forceDrivenHeight,
      targetForceG: 1.15,
      referenceSpeed: 44,
    }),
    createElement("boost", "boost-005", { length: 220, targetSpeed: 44 }),
    createElement("zeroGRoll", "zeroGRoll-006", { length: 4, roll: 0 }),
    createElement("stall", "stall-007", { length: 100, height: 0 }),
    createElement("brake", "brake-008", { length: 220, targetSpeed: 8 }),
    createElement("brake", "magnetic-brakes-009", {
      length: 110,
      targetSpeed: 5,
    }),
    createElement("station", "station-010", { length: 160, closed: false }),
  ];
  return elements;
};
const canonicalTrackCache = new Map<string, ReturnType<typeof compileTrack>>();
const CANONICAL_TRACK_CACHE_LIMIT = 16;

export interface GenerationOperationCache {
  readonly spanLengthCache: Map<string, number>;
}

export const createGenerationOperationCache = (): GenerationOperationCache => ({
  spanLengthCache: new Map<string, number>(),
});

const asElements = (
  intent: DesignIntentV1,
  candidate: number,
): AnySemanticElement[] => {
  if (intent.mode !== "directed")
    return defaultElements(intent.seed, candidate);
  return intent.elements.map((element) => {
    const kind = (element.kind ?? element.type) as string;
    if (!ELEMENT_KINDS.includes(kind as (typeof ELEMENT_KINDS)[number]))
      throw new CoasterFileError(
        `elements.${element.id}: unknown semantic element kind ${kind}`,
      );
    return createElement(
      kind as (typeof ELEMENT_KINDS)[number],
      element.id,
      element.parameters ?? {},
    ) as AnySemanticElement;
  });
};

const childBoundaries = (span: SolvedSpan): readonly number[] => {
  if (span.kind === "topHat") return [0, 0.2, 0.35, 0.4, 0.6, 0.65, 0.8, 1];
  if (span.kind === "airtimeHill") return [0, 0.15, 0.25, 0.75, 0.85, 1];
  if (span.span instanceof SeventhOrderHermiteSpan) return [0, 1];
  return Array.from({ length: 9 }, (_, index) => index / 8);
};

const subspan = <T extends number | Vec3>(
  source: ParametricSpan<T>,
  start: number,
  end: number,
): ParametricSpan<T> => {
  const width = end - start;
  return {
    position: (u) => source.position(start + width * u),
    derivative: (u, order = 1) => {
      const value = source.derivative(start + width * u, order);
      const scale = width ** order;
      return (
        typeof value === "number"
          ? value * scale
          : vec3(value[0] * scale, value[1] * scale, value[2] * scale)
      ) as T;
    },
  };
};

const coefficientSpan = (span: SolvedSpan): SolvedSpan[] => {
  const boundaries = childBoundaries(span);
  return boundaries.slice(0, -1).map((start, childIndex) => {
    const end = boundaries[childIndex + 1]!;
    const source = subspan(span.span, start, end);
    const position = new SeventhOrderHermiteSpan({
      p0: source.position(0),
      d10: source.derivative(0, 1),
      d20: source.derivative(0, 2),
      d30: source.derivative(0, 3),
      p1: source.position(1),
      d11: source.derivative(1, 1),
      d21: source.derivative(1, 2),
      d31: source.derivative(1, 3),
    });
    const sourceBank =
      span.bank ??
      new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      });
    const bankSource = subspan(sourceBank, start, end);
    const bank = new QuinticScalarSpan({
      v0: bankSource.position(0),
      d10: bankSource.derivative(0, 1),
      d20: bankSource.derivative(0, 2),
      v1: bankSource.position(1),
      d11: bankSource.derivative(1, 1),
      d21: bankSource.derivative(1, 2),
    });
    const id = boundaries.length === 2 ? span.id : `${span.id}#${childIndex}`;
    const points = Array.from({ length: 17 }, (_, index) =>
      position.position(index / 16),
    );
    return {
      ...span,
      id,
      span: position,
      bank,
      bounds: aabbFromPoints(points),
      positionCoefficients: position.coefficients,
      rollCoefficients: bank.coefficients,
    };
  });
};

const spanBytes = (span: SolvedSpan): string => {
  const serial = serializeSolvedSpanV1(span);
  const coefficients = [
    ...serial.positionCoefficients.flat(),
    ...serial.rollCoefficients,
  ];
  const bytes = new Uint8Array(coefficients.length * 8);
  const view = new DataView(bytes.buffer);
  coefficients.forEach((coefficient, index) =>
    view.setFloat64(index * 8, coefficient, true),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};
const hashSpan = (span: SolvedSpan): string => {
  let hash = 0x811c9dc5;
  for (const character of spanBytes(span))
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const finiteNumber = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

const finitePosition = (value: Vec3 | undefined): Vec3 | undefined =>
  value && value.every(Number.isFinite) ? value : undefined;

const sanitizeDiagnostic = (diagnostic: Diagnostic): Diagnostic => {
  const actual = finiteNumber(diagnostic.actual);
  const limit = finiteNumber(diagnostic.limit);
  const suppliedMargin = finiteNumber(diagnostic.margin);
  const margin =
    suppliedMargin ??
    (actual !== undefined && limit !== undefined
      ? finiteNumber(limit - actual)
      : undefined);
  const locationS = finiteNumber(diagnostic.location?.s);
  const locationPosition = finitePosition(diagnostic.location?.position);
  const evidenceWasInvalid =
    (diagnostic.actual !== undefined && actual === undefined) ||
    (diagnostic.limit !== undefined && limit === undefined) ||
    (diagnostic.margin !== undefined && suppliedMargin === undefined) ||
    (diagnostic.location !== undefined && locationS === undefined) ||
    (diagnostic.location?.position !== undefined &&
      locationPosition === undefined) ||
    (actual !== undefined &&
      limit !== undefined &&
      suppliedMargin === undefined &&
      margin === undefined);
  const {
    actual: _actual,
    limit: _limit,
    margin: _margin,
    location: _location,
    ...rest
  } = diagnostic;
  return {
    ...rest,
    ...(actual === undefined ? {} : { actual }),
    ...(limit === undefined ? {} : { limit }),
    ...(margin === undefined ? {} : { margin }),
    ...(locationS === undefined
      ? {}
      : {
          location: {
            s: locationS,
            ...(locationPosition === undefined
              ? {}
              : { position: locationPosition }),
          },
        }),
    ...(evidenceWasInvalid
      ? {
          code: "NUMERIC_UNCERTIFIED",
          severity: "fatal" as const,
          message: `${diagnostic.message}; non-finite diagnostic evidence`,
        }
      : {}),
  };
};

const sanitizeDiagnostics = (
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] => diagnostics.map(sanitizeDiagnostic);

const positionGeometry = (span: SolvedSpan): SeventhOrderHermiteSpan<Vec3> => {
  const rows =
    span.positionCoefficients ??
    (span.span instanceof SeventhOrderHermiteSpan
      ? span.span.coefficients
      : undefined);
  if (!rows || rows.length !== 3 || rows.some((row) => row.length !== 8))
    throw new CertificationError(
      `Span ${span.id} has no certified degree-seven position polynomial`,
    );
  if (rows.some((row) => row.some((value) => !Number.isFinite(value))))
    throw new CertificationError(
      `Span ${span.id} has non-finite position coefficients`,
    );
  return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows);
};

const hardDiagnostic = (
  code: string,
  message: string,
  relatedIds?: readonly string[],
  actual?: number,
  limit?: number,
  location?: { readonly s: number; readonly position?: Vec3 },
): Diagnostic =>
  sanitizeDiagnostic({
    code,
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    ...(relatedIds ? { relatedIds } : {}),
    ...(actual === undefined ? {} : { actual }),
    ...(limit === undefined ? {} : { limit }),
    ...(actual === undefined || limit === undefined
      ? {}
      : { margin: limit - actual }),
    ...(location ? { location } : {}),
  });

const pathSamples = (
  spans: readonly SolvedSpan[],
): readonly {
  readonly span: SolvedSpan;
  readonly u: number;
  readonly s: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
}[] => {
  const points: { span: SolvedSpan; u: number; s: number; point: Vec3 }[] = [];
  let distance = 0;
  for (const span of spans) {
    const geometry = positionGeometry(span);
    const length = arcLength(geometry, 0, 1);
    for (let index = 0; index <= 128; index += 1) {
      const u = index / 128;
      points.push({
        span,
        u,
        s: distance + length * u,
        point: geometry.position(u),
      });
    }
    distance += length;
  }
  const frames = transportFramesAlongPath(
    points.map((sample) => sample.point),
    points.map((sample) =>
      vec3Normalize(positionGeometry(sample.span).derivative(sample.u, 1)),
    ),
    points.map((_, index) => index),
    points.map((sample) => sample.span.bank?.position(sample.u) ?? 0),
  );
  return points.map((sample, index) => ({
    ...sample,
    tangent: frames[index]!.tangent,
    normal: frames[index]!.normal,
  }));
};

const gateDiagnostics = (
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
): readonly Diagnostic[] => {
  if (intent.gates.length === 0) return [];
  const samples = pathSamples(spans);
  const diagnostics: Diagnostic[] = [];
  let start = 0;
  for (const gate of intent.gates) {
    if (!gate.position) continue;
    let best = samples[start];
    for (let index = start; index < samples.length; index += 1)
      if (
        !best ||
        vec3Distance(samples[index]!.point, gate.position!) <
          vec3Distance(best.point, gate.position!)
      )
        best = samples[index]!;
    if (!best) continue;
    start = samples.indexOf(best);
    const positionError = vec3Distance(best.point, gate.position!);
    if (positionError > 0.1)
      diagnostics.push(
        hardDiagnostic(
          "GATE_POSITION",
          `Gate ${gate.id} position residual is ${positionError.toExponential(3)}`,
          [gate.id],
          positionError,
          0.1,
          { s: best.s, position: best.point },
        ),
      );
    if (gate.orientation) {
      const targetTangent = vec3Normalize(
        quatRotateVector(gate.orientation, vec3(0, 0, 1)),
      );
      const targetNormal = vec3Normalize(
        quatRotateVector(gate.orientation, vec3(0, 1, 0)),
      );
      const tangentError = Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            vec3Dot(
              vec3Normalize(best.span.span.derivative(best.u, 1)),
              targetTangent,
            ),
          ),
        ),
      );
      const rollError = Math.acos(
        Math.max(-1, Math.min(1, vec3Dot(best.normal, targetNormal))),
      );
      const actual = Math.max(tangentError, rollError);
      if (actual > 1e-5)
        diagnostics.push(
          hardDiagnostic(
            "GATE_ORIENTATION",
            `Gate ${gate.id} orientation residual is ${actual.toExponential(3)} (tangent=${tangentError.toExponential(3)}, roll=${rollError.toExponential(3)})`,
            [gate.id],
            actual,
            1e-5,
            { s: best.s, position: best.point },
          ),
        );
    }
    start += 1;
  }
  return diagnostics;
};

const validateGenerationConstraints = (
  elements: readonly AnySemanticElement[],
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  environment: EnvironmentQuery | undefined,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const constraint of intent.constraints) {
    const value = constraint.target ?? constraint.value;
    const hard = constraint.hard !== false;
    const severity = hard ? "error" : "warning";
    if (
      ![
        "required-element",
        "required-stall",
        "required-footprint",
        "required-height-range",
        "terrain-profile",
        "max-height",
        "min-height",
        "track-clearance",
      ].includes(constraint.kind)
    ) {
      if (hard)
        diagnostics.push(
          hardDiagnostic(
            "UNSUPPORTED_HARD_CONSTRAINT",
            `Unsupported hard constraint kind ${constraint.kind}`,
            [constraint.id],
          ),
        );
      continue;
    }
    if (
      (constraint.kind === "required-element" &&
        typeof value === "string" &&
        !elements.some((element) => element.type === value)) ||
      (constraint.kind === "required-stall" &&
        !elements.some((element) => element.type === "stall"))
    )
      diagnostics.push({
        ...hardDiagnostic(
          "REQUIRED_ELEMENT",
          `Required element ${typeof value === "string" ? value : "stall"} is missing`,
          [constraint.id],
        ),
        severity,
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      });
    if (
      constraint.kind === "required-footprint" &&
      intent.footprint === undefined
    )
      diagnostics.push({
        ...hardDiagnostic(
          "REQUIRED_FOOTPRINT",
          "A footprint is required but none was supplied",
          [constraint.id],
        ),
        severity,
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      });
    if (
      constraint.kind === "required-height-range" &&
      intent.heightRange === undefined
    )
      diagnostics.push({
        ...hardDiagnostic(
          "REQUIRED_HEIGHT_RANGE",
          "A height range is required but none was supplied",
          [constraint.id],
        ),
        severity,
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      });
    if (constraint.kind === "terrain-profile" && environment === undefined)
      diagnostics.push({
        ...hardDiagnostic(
          "REQUIRED_TERRAIN",
          "A terrain environment is required but none was supplied",
          [constraint.id],
        ),
        severity,
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      });
    if (
      constraint.kind === "terrain-profile" &&
      environment !== undefined &&
      typeof value === "string" &&
      intent.terrainProfileId !== value
    )
      diagnostics.push({
        ...hardDiagnostic(
          "TERRAIN_PROFILE",
          `Terrain profile ${value} was not selected`,
          [constraint.id],
        ),
        severity,
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      });
  }
  const boundBudget = new CertifiedWorkBudget(1_000_000);
  const boundsAt = (span: SolvedSpan) => {
    const rows =
      span.positionCoefficients ??
      (span.span instanceof SeventhOrderHermiteSpan
        ? span.span.coefficients
        : undefined);
    if (!rows)
      throw new CertificationError(
        `Span ${span.id} has no position polynomial`,
      );
    return certifiedPolynomialBounds(rows, 0, 1, boundBudget);
  };
  let station = 0;
  const footprint = intent.footprint;
  for (const span of spans) {
    let bounds;
    try {
      bounds = boundsAt(span);
    } catch (error) {
      diagnostics.push({
        code: "CLEARANCE_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: error instanceof Error ? error.message : String(error),
        relatedIds: [span.id],
      });
      continue;
    }
    const spanStart = station;
    const location = { s: spanStart, position: span.span.position(0) };
    if (footprint)
      for (const axis of [0, 1, 2] as const) {
        if (bounds.min[axis]! < footprint.min[axis]!)
          diagnostics.push(
            sanitizeDiagnostic({
              ...hardDiagnostic(
                "FOOTPRINT",
                `Footprint minimum exceeded by ${span.id}`,
                [span.id],
                bounds.min[axis],
                footprint.min[axis],
                location,
              ),
              margin: bounds.min[axis]! - footprint.min[axis]!,
            }),
          );
        if (bounds.max[axis]! > footprint.max[axis]!)
          diagnostics.push(
            sanitizeDiagnostic({
              ...hardDiagnostic(
                "FOOTPRINT",
                `Footprint maximum exceeded by ${span.id}`,
                [span.id],
                bounds.max[axis],
                footprint.max[axis],
                location,
              ),
              margin: footprint.max[axis]! - bounds.max[axis]!,
            }),
          );
      }
    if (intent.heightRange) {
      if (bounds.min[1]! < intent.heightRange.min)
        diagnostics.push(
          sanitizeDiagnostic({
            ...hardDiagnostic(
              "HEIGHT_RANGE",
              `Height range minimum exceeded by ${span.id}`,
              [span.id],
              bounds.min[1],
              intent.heightRange.min,
              location,
            ),
            margin: bounds.min[1]! - intent.heightRange.min,
          }),
        );
      if (bounds.max[1]! > intent.heightRange.max)
        diagnostics.push(
          sanitizeDiagnostic({
            ...hardDiagnostic(
              "HEIGHT_RANGE",
              `Height range maximum exceeded by ${span.id}`,
              [span.id],
              bounds.max[1],
              intent.heightRange.max,
              location,
            ),
            margin: intent.heightRange.max - bounds.max[1]!,
          }),
        );
    }
    station += arcLength(span.span);
  }
  for (const constraint of intent.constraints) {
    if (constraint.kind !== "max-height" && constraint.kind !== "min-height")
      continue;
    const value = constraint.target ?? constraint.value;
    if (typeof value !== "number") continue;
    let failure:
      | {
          readonly span: SolvedSpan;
          readonly actual: number;
          readonly s: number;
        }
      | undefined;
    let distance = 0;
    for (const span of spans) {
      try {
        const bounds = boundsAt(span);
        const actual =
          constraint.kind === "max-height" ? bounds.max[1] : bounds.min[1];
        const exceeded =
          constraint.kind === "max-height" ? actual > value : actual < value;
        if (exceeded && !failure) failure = { span, actual, s: distance };
      } catch {
        failure = undefined;
        break;
      }
      distance += arcLength(span.span);
    }
    if (!failure) continue;
    const hard = constraint.hard !== false;
    diagnostics.push(
      sanitizeDiagnostic({
        ...hardDiagnostic(
          constraint.kind === "max-height" ? "MAX_HEIGHT" : "MIN_HEIGHT",
          `${constraint.kind} constraint exceeded by ${failure.span.id}`,
          [constraint.id, failure.span.id],
          failure.actual,
          value,
          { s: failure.s, position: failure.span.span.position(0) },
        ),
        margin:
          constraint.kind === "min-height"
            ? failure.actual - value
            : value - failure.actual,
        severity: hard ? "error" : "warning",
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      }),
    );
  }
  return sanitizeDiagnostics(diagnostics);
};
const isClosedChain = (elements: readonly AnySemanticElement[]): boolean =>
  elements[0]?.type === "station" &&
  (elements[0].parameters as ElementParameterMap["station"]).closed === true;
const targetError = (
  target: DesignIntentV1["targets"][number],
  position: Vec3,
  tangent: Vec3,
  bank: number,
): number => {
  if (target.kind === "end-x")
    return Math.abs(position[0] - (target.target as number));
  if (target.kind === "end-y")
    return Math.abs(position[1] - (target.target as number));
  if (target.kind === "end-z")
    return Math.abs(position[2] - (target.target as number));
  if (target.kind === "end-bank")
    return Math.abs(bank - (target.target as number));
  if (target.kind === "end-position")
    return vec3Distance(position, target.target as Vec3);
  return Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        vec3Dot(vec3Normalize(tangent), vec3Normalize(target.target as Vec3)),
      ),
    ),
  );
};

const relaxationMargins = (
  constraint: DesignIntentV1["constraints"][number],
  evaluation: CandidateEvaluation,
): Readonly<Record<string, number>> => {
  const samples = pathSamples(evaluation.spans);
  const value = constraint.target ?? constraint.value;
  if (
    (constraint.kind === "max-height" || constraint.kind === "min-height") &&
    typeof value === "number" &&
    samples.length > 0
  ) {
    const heights = samples.map((sample) => sample.point[1]);
    const actual =
      constraint.kind === "max-height"
        ? Math.max(...heights)
        : Math.min(...heights);
    return {
      [constraint.kind]:
        constraint.kind === "max-height" ? value - actual : actual - value,
    };
  }
  if (constraint.kind === "track-clearance") {
    const trackFailures = evaluation.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TRACK_CLEARANCE",
    );
    return {
      [constraint.kind]:
        trackFailures.length === 0
          ? 0
          : Math.min(
              ...trackFailures.map((diagnostic) => diagnostic.margin ?? 0),
            ),
    };
  }
  return {
    [constraint.kind]: evaluation.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    )
      ? -1
      : 0,
  };
};

interface CandidateEvaluation {
  readonly elements: readonly AnySemanticElement[];
  readonly elementSpans: readonly (readonly SolvedSpan[])[];
  readonly spans: readonly SolvedSpan[];
  readonly solved: ReturnType<typeof solver.solveSemanticChain>;
  readonly diagnostics: readonly Diagnostic[];
  readonly track?: ReturnType<typeof compileTrack>;
  readonly solvingMs: number;
  readonly validationMs: number;
}

const evaluateCandidate = (
  elements: readonly AnySemanticElement[],
  intent: DesignIntentV1,
  options: GenerationOptions,
  targets: SolveOptions["targets"],
): CandidateEvaluation => {
  const solvingStart = now();
  const solved = solver.solveSemanticChain(elements, {
    ...(targets && targets.length > 0 ? { targets } : {}),
    referenceSpeed: 44,
    maxIterations:
      intent.mode === "directed"
        ? 32
        : intent.targets.length === 0 && intent.constraints.length === 0
          ? 0
          : 8,
  });
  const solvingMs = now() - solvingStart;
  const elementSpans = solved.solvedSpans.map(coefficientSpan);
  const spans = elementSpans.flat();
  const validationStart = now();
  const solverDiagnostics = solved.diagnostics;
  const diagnostics: Diagnostic[] = [
    ...solverDiagnostics,
    ...gateDiagnostics(spans, intent),
    ...validateGenerationConstraints(
      elements,
      spans,
      intent,
      options.environment,
    ),
  ];
  const targetLocationS = spans.reduce(
    (sum, span) => sum + arcLength(span.span),
    0,
  );
  for (const target of intent.targets)
    if (target.kind !== "total-length") {
      const actual = targetError(
        target,
        solved.endPose.position,
        solved.endPose.tangent,
        solved.endPose.bank,
      );
      const limit =
        target.kind === "end-bank" || target.kind === "end-tangent"
          ? 1e-5
          : 1e-4;
      if (actual > limit)
        diagnostics.push({
          ...hardDiagnostic(
            "TARGET",
            `Target ${target.id} ${target.kind} residual is ${actual.toExponential(3)}`,
            [target.id],
            actual,
            limit,
            { s: targetLocationS, position: solved.endPose.position },
          ),
          severity: target.hard === false ? "warning" : "error",
        });
    }
  const requiredTrackClearance = intent.constraints
    .filter(
      (constraint) =>
        constraint.kind === "track-clearance" &&
        constraint.hard !== false &&
        typeof (constraint.target ?? constraint.value) === "number",
    )
    .map((constraint) => (constraint.target ?? constraint.value) as number)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  const track = intent.targets.some((target) => target.kind === "total-length")
    ? compileTrack(spans, { samples: options.samples ?? 128 })
    : undefined;
  for (const target of intent.targets) {
    if (target.kind === "total-length") {
      const actual = track!.totalLength;
      const limit = typeof target.target === "number" ? target.target : 0;
      const error = Math.abs(actual - limit);
      if (error > 1e-4)
        diagnostics.push({
          ...hardDiagnostic(
            "TARGET",
            `Target ${target.id} total-length residual is ${error.toExponential(3)}`,
            [target.id],
            error,
            1e-4,
          ),
          severity: target.hard ? "error" : "warning",
        });
    }
  }
  const hasHardFailure = diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "fatal",
  );
  if (!hasHardFailure) {
    const clearance = validateClearance(spans, options.environment, {
      ...(options.trainEnvelopeRadius === undefined
        ? {}
        : { trainEnvelopeRadius: options.trainEnvelopeRadius }),
      trackClearance: Math.max(
        options.trackClearance ?? 0,
        requiredTrackClearance,
      ),
      closed: isClosedChain(elements),
    });
    const clearanceConstraintIds = intent.constraints
      .filter((constraint) => constraint.kind === "track-clearance")
      .map((constraint) => constraint.id);
    diagnostics.push(
      ...clearance.map((item) =>
        item.code === "TRACK_CLEARANCE" && clearanceConstraintIds.length > 0
          ? {
              ...item,
              relatedIds: [
                ...(item.relatedIds ?? []),
                ...clearanceConstraintIds,
              ],
            }
          : item,
      ),
    );
  }
  return {
    elements,
    elementSpans,
    spans,
    solved,
    diagnostics: sanitizeDiagnostics(diagnostics),
    ...(track ? { track } : {}),
    solvingMs,
    validationMs: now() - validationStart,
  };
};

const buildFileResult = (
  evaluation: CandidateEvaluation,
  intent: DesignIntentV1,
  options: GenerationOptions,
  candidatesTested: number,
  candidateLmIterations: readonly number[],
  relaxationLmIterations: readonly number[],
  relaxationEvidence: readonly RelaxationEvidence[],
  searchMs: number,
  totalStart: number,
  operationCache: GenerationOperationCache,
): GenerationResult => {
  const compilationStart = now();
  const elementById = new Map(
    evaluation.elements.map((element) => [element.id, element]),
  );
  const ownerId = (id: string): string => id.split("#", 1)[0]!;
  const serializedSpans = evaluation.spans.map((span) => {
    const element = elementById.get(ownerId(span.id));
    if (!element) throw new Error(`Missing semantic owner for span ${span.id}`);
    const parameters = element.parameters as unknown as Record<string, unknown>;
    const lengthKey = spanBytes(span);
    let curvedLength = operationCache.spanLengthCache.get(lengthKey);
    if (curvedLength === undefined) {
      curvedLength = arcLength(span.span);
      operationCache.spanLengthCache.set(lengthKey, curvedLength);
    }
    const length =
      typeof parameters.length === "number"
        ? parameters.length
        : (span.length ?? curvedLength);
    return serializeSolvedSpanV1(span, element.type, length);
  });
  const canonicalSpans = serializedSpans.map(reconstructSolvedSpan);
  const trackKey = canonicalSpans.map(spanBytes).join("|");
  let canonicalTrack = canonicalTrackCache.get(trackKey);
  if (!canonicalTrack) {
    canonicalTrack = compileTrack(canonicalSpans, { samples: 32 });
    canonicalTrackCache.set(trackKey, canonicalTrack);
    if (canonicalTrackCache.size > CANONICAL_TRACK_CACHE_LIMIT)
      canonicalTrackCache.delete(canonicalTrackCache.keys().next().value!);
  }
  const effectiveIntent: DesignIntentV1 =
    intent.mode === "directed"
      ? intent
      : {
          ...intent,
          elements: evaluation.elements.map((element) => ({
            id: element.id,
            kind: element.type,
            type: element.type,
            parameters: element.parameters,
          })),
        };
  const file = createCoasterFileV1({
    name: options.name ?? "OpenVibeCoaster",
    intent: effectiveIntent,
    solvedSpans: serializedSpans,
    seed: intent.seed,
    generatorVersion: options.generatorVersion ?? intent.generatorVersion,
    profileVersion: options.profileVersion ?? "profile-v1",
    researchSnapshotIds: options.researchSnapshotIds ?? [],
    compiledDataChecksum: canonicalTrack.checksum,
  });
  const serializedFile = serializeCoasterFileV1(file);
  const bytes = Object.fromEntries(
    evaluation.spans.map((span) => [span.id, spanBytes(span)]),
  ) as Record<string, string>;
  const hashes = Object.fromEntries(
    evaluation.spans.map((span) => [span.id, hashSpan(span)]),
  ) as Record<string, string>;
  for (const element of evaluation.elements) {
    const first = evaluation.spans.find(
      (span) => ownerId(span.id) === element.id,
    );
    if (first) {
      bytes[element.id] = spanBytes(first);
      hashes[element.id] = hashSpan(first);
    }
  }
  const track =
    options.samples === undefined || options.samples === 32
      ? canonicalTrack
      : compileTrack(canonicalSpans, { samples: options.samples });
  const stageTimings: GenerationStageTimings = {
    searchMs,
    solvingMs: evaluation.solvingMs,
    compilationMs: now() - compilationStart,
    validationMs: evaluation.validationMs,
    totalMs: now() - totalStart,
  };
  return {
    feasible: !evaluation.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
    intent: effectiveIntent,
    elements: evaluation.elements,
    solvedSpans: Object.freeze(canonicalSpans),
    track,
    file,
    serializedFile,
    diagnostics: Object.freeze(evaluation.diagnostics),
    relaxations: Object.freeze(relaxationEvidence.map((item) => item.change)),
    relaxationEvidence: Object.freeze(relaxationEvidence),
    candidatesTested,
    selectedLmIterations: evaluation.solved.lmIterations,
    candidateLmIterations: Object.freeze([...candidateLmIterations]),
    candidateLmWork: candidateLmIterations.reduce(
      (sum, iterations) => sum + iterations,
      0,
    ),
    relaxationLmIterations: Object.freeze([...relaxationLmIterations]),
    relaxationLmWork: relaxationLmIterations.reduce(
      (sum, iterations) => sum + iterations,
      0,
    ),
    lmIterations:
      candidateLmIterations.reduce((sum, iterations) => sum + iterations, 0) +
      relaxationLmIterations.reduce((sum, iterations) => sum + iterations, 0),
    spanHashes: hashes,
    spanBytes: bytes,
    options,
    stageTimings,
  };
};

const targetOptions = (intent: DesignIntentV1): SolveOptions["targets"] =>
  intent.targets
    .filter((target) => target.kind !== "total-length")
    .map((target) => ({
      id: target.id,
      kind: target.kind as HardTarget["kind"],
      target: target.target,
      hard: target.hard,
    }));

export const generateCoaster = (
  intent: DesignIntentV1,
  options: GenerationOptions = {},
): GenerationResult => {
  const totalStart = now();
  const searchStart = now();
  validateDesignIntentV1(intent);
  const maxCandidates =
    intent.mode === "directed" ||
    (intent.targets.length === 0 && intent.constraints.length === 0)
      ? 1
      : 48;
  let selected: CandidateEvaluation | undefined;
  let last: CandidateEvaluation | undefined;
  let candidatesTested = 0;
  const candidateLmIterations: number[] = [];
  const operationCache = createGenerationOperationCache();
  for (let candidate = 0; candidate < maxCandidates; candidate += 1) {
    const evaluation = evaluateCandidate(
      asElements(intent, candidate),
      intent,
      options,
      targetOptions(intent),
    );
    candidatesTested += 1;
    candidateLmIterations.push(evaluation.solved.lmIterations);
    last = evaluation;
    if (
      evaluation.diagnostics.every(
        (diagnostic) =>
          diagnostic.severity !== "error" && diagnostic.severity !== "fatal",
      )
    ) {
      selected = evaluation;
      break;
    }
  }
  const evaluation = selected ?? last!;
  const evidence: RelaxationEvidence[] = [];
  const relaxationLmIterations: number[] = [];
  for (const target of intent.targets) {
    if (evidence.length >= 3 || target.hard === false) continue;
    const relaxedIntent = {
      ...intent,
      targets: intent.targets.filter((item) => item.id !== target.id),
    };
    const rerun = evaluateCandidate(
      evaluation.elements,
      relaxedIntent,
      options,
      targetOptions(relaxedIntent),
    );
    relaxationLmIterations.push(rerun.solved.lmIterations);
    if (
      rerun.diagnostics.some((diagnostic) =>
        diagnostic.relatedIds?.includes(target.id),
      )
    )
      continue;
    const actual =
      target.kind === "total-length"
        ? (rerun.track?.totalLength ??
          compileTrack(rerun.spans, { samples: 32 }).totalLength)
        : targetError(
            target,
            rerun.solved.endPose.position,
            rerun.solved.endPose.tangent,
            rerun.solved.endPose.bank,
          );
    const limit =
      target.kind === "end-bank" || target.kind === "end-tangent" ? 1e-5 : 1e-4;
    evidence.push({
      change: `Relax hard target ${target.id}`,
      rerun: true,
      feasible: !rerun.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" || diagnostic.severity === "fatal",
      ),
      lmIterations: rerun.solved.lmIterations,
      margins: { [target.kind]: limit - actual },
    });
  }
  for (const constraint of intent.constraints) {
    if (evidence.length >= 3 || constraint.hard === false) continue;
    const relaxedIntent = {
      ...intent,
      constraints: intent.constraints.filter(
        (item) => item.id !== constraint.id,
      ),
    };
    const rerun = evaluateCandidate(
      evaluation.elements,
      relaxedIntent,
      options,
      targetOptions(relaxedIntent),
    );
    relaxationLmIterations.push(rerun.solved.lmIterations);
    const failed = rerun.diagnostics.some((diagnostic) =>
      diagnostic.relatedIds?.includes(constraint.id),
    );
    if (!failed)
      evidence.push({
        change: `Relax hard constraint ${constraint.id}`,
        rerun: true,
        feasible: !rerun.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" || diagnostic.severity === "fatal",
        ),
        lmIterations: rerun.solved.lmIterations,
        margins: relaxationMargins(constraint, rerun),
      });
  }
  const searchMs = now() - searchStart;
  return buildFileResult(
    evaluation,
    intent,
    options,
    candidatesTested,
    candidateLmIterations,
    relaxationLmIterations,
    evidence,
    searchMs,
    totalStart,
    operationCache,
  );
};

const generationWithSpans = (
  candidate: GenerationResult,
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  diagnostics: readonly Diagnostic[] = candidate.diagnostics,
): GenerationResult => {
  const elementById = new Map(
    candidate.elements.map((element) => [element.id, element]),
  );
  const ownerId = (id: string): string => id.split("#", 1)[0]!;
  const serializedSpans = spans.map((span) => {
    const element = elementById.get(ownerId(span.id));
    if (!element) throw new Error(`Missing semantic owner for span ${span.id}`);
    const parameters = element.parameters as Record<string, unknown>;
    const length =
      typeof parameters.length === "number"
        ? parameters.length
        : (span.length ?? arcLength(span.span));
    return serializeSolvedSpanV1(span, element.type, length);
  });
  const canonicalSpans = serializedSpans.map(reconstructSolvedSpan);
  const canonicalTrack = compileTrack(canonicalSpans, { samples: 32 });
  const file = createCoasterFileV1({
    name: candidate.file.name,
    intent,
    solvedSpans: serializedSpans,
    seed: intent.seed,
    generatorVersion: candidate.file.generatorVersion,
    profileVersion: candidate.file.profileVersion,
    researchSnapshotIds: candidate.file.researchSnapshotIds,
    compiledDataChecksum: canonicalTrack.checksum,
  });
  const serializedFile = serializeCoasterFileV1(file);
  const recompiled = compileCoasterFile(serializedFile).track;
  if (recompiled.checksum !== canonicalTrack.checksum)
    throw new Error("Merged local regeneration checksum validation failed");
  const spanBytesMap = Object.fromEntries(
    canonicalSpans.map((span) => [span.id, spanBytes(span)]),
  ) as Record<string, string>;
  const spanHashesMap = Object.fromEntries(
    canonicalSpans.map((span) => [span.id, hashSpan(span)]),
  ) as Record<string, string>;
  for (const element of candidate.elements) {
    const first = canonicalSpans.find(
      (span) => ownerId(span.id) === element.id,
    );
    if (first) {
      spanBytesMap[element.id] = spanBytes(first);
      spanHashesMap[element.id] = hashSpan(first);
    }
  }
  const track =
    candidate.options.samples === undefined || candidate.options.samples === 32
      ? canonicalTrack
      : compileTrack(canonicalSpans, { samples: candidate.options.samples });
  return {
    ...candidate,
    intent,
    solvedSpans: Object.freeze(canonicalSpans),
    track,
    file,
    serializedFile,
    spanBytes: spanBytesMap,
    spanHashes: spanHashesMap,
    diagnostics: Object.freeze(diagnostics),
    feasible: !diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
  };
};

const spanOwner = (id: string): string => id.split("#", 1)[0]!;
const selectedIndexOrMinusOne = (
  generated: GenerationResult,
  id: string,
): number => generated.elements.findIndex((element) => element.id === id);

const coefficientBoundaryPose = (
  generated: GenerationResult,
  semanticBoundary: number,
): import("./types").Pose => {
  const owner = generated.elements[semanticBoundary - 1]?.id;
  const first = generated.elements[semanticBoundary]?.id;
  const ownerSpans = owner
    ? generated.solvedSpans.filter((span) => spanOwner(span.id) === owner)
    : [];
  const firstSpans = first
    ? generated.solvedSpans.filter((span) => spanOwner(span.id) === first)
    : [];
  const source = owner ? ownerSpans.at(-1) : firstSpans[0];
  if (!source) return defaultPose();
  const atEnd = owner !== undefined;
  const u = atEnd ? 1 : 0;
  const sourceIndex = generated.solvedSpans.findIndex(
    (span) => span.id === source.id,
  );
  if (sourceIndex < 0) return defaultPose();
  const boundaryIndex = atEnd
    ? generated.track.elementBoundaries[sourceIndex * 2 + 1]!
    : generated.track.elementBoundaries[sourceIndex * 2]!;
  const tangent = vec3(
    generated.track.tangents[boundaryIndex * 3]!,
    generated.track.tangents[boundaryIndex * 3 + 1]!,
    generated.track.tangents[boundaryIndex * 3 + 2]!,
  );
  const position = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
    source.positionCoefficients!,
  );
  const bankSpan = source.rollCoefficients
    ? QuinticScalarSpan.fromCoefficients(source.rollCoefficients)
    : source.bank;
  const bank = bankSpan?.position(u) ?? 0;
  const rolledNormal = vec3(
    generated.track.normals[boundaryIndex * 3]!,
    generated.track.normals[boundaryIndex * 3 + 1]!,
    generated.track.normals[boundaryIndex * 3 + 2]!,
  );
  const compiledBinormal = vec3(
    generated.track.binormals[boundaryIndex * 3]!,
    generated.track.binormals[boundaryIndex * 3 + 1]!,
    generated.track.binormals[boundaryIndex * 3 + 2]!,
  );
  const normal = vec3Normalize(
    vec3Sub(
      vec3Scale(rolledNormal, Math.cos(bank)),
      vec3Scale(compiledBinormal, Math.sin(bank)),
    ),
  );
  return {
    position: position.position(u),
    tangent,
    normal,
    bank,
  };
};

const localSeamDiagnostics = (
  spans: readonly SolvedSpan[],
  closed: boolean,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const seam of solver.diagnoseSeams(spans, { closed })) {
    const [leftId, rightId] = seam.seamId.split("->");
    if (spanOwner(leftId!) === spanOwner(rightId!)) continue;
    const failure =
      seam.positionM > 1e-4 ||
      seam.tangentRad > 1e-5 ||
      seam.curvaturePerM > 1e-4 ||
      seam.curvatureVectorJumpPerM > 1e-4 ||
      seam.curvatureGradientPerM2 > 1e-4 ||
      seam.bankRad > 1e-4 ||
      seam.bankDerivativeRadPerM > 1e-4 ||
      seam.specificForceJumpG > 0.05;
    if (failure)
      diagnostics.push(
        hardDiagnostic(
          "LOCAL_REGENERATION",
          `Merged seam ${seam.seamId} remains outside hard tolerances`,
          [leftId!, rightId!],
          Math.max(
            seam.positionM,
            seam.tangentRad,
            seam.curvaturePerM,
            seam.curvatureVectorJumpPerM,
            seam.curvatureGradientPerM2,
            seam.bankRad,
            seam.bankDerivativeRadPerM,
            seam.specificForceJumpG,
          ),
          1e-4,
          {
            s: spans
              .slice(0, spans.findIndex((span) => span.id === leftId) + 1)
              .reduce((sum, span) => sum + arcLength(span.span), 0),
            position: spans
              .find((span) => span.id === leftId)!
              .span.position(1),
          },
        ),
      );
  }
  return sanitizeDiagnostics(diagnostics);
};

const mergedDiagnostics = (
  elements: readonly AnySemanticElement[],
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  options: GenerationOptions,
  localDiagnostics: readonly Diagnostic[],
): readonly Diagnostic[] => {
  const diagnostics = [
    ...localDiagnostics,
    ...localSeamDiagnostics(spans, isClosedChain(elements)),
    ...gateDiagnostics(spans, intent),
    ...validateGenerationConstraints(
      elements,
      spans,
      intent,
      options.environment,
    ),
  ];
  const end = spans[spans.length - 1]!;
  const endPose = {
    position: end.span.position(1),
    tangent: vec3Normalize(end.span.derivative(1, 1)),
    normal: vec3(0, 1, 0),
    bank: end.bank?.position(1) ?? 0,
  };
  const endS = spans.reduce((sum, span) => sum + arcLength(span.span), 0);
  for (const target of intent.targets) {
    if (target.kind === "total-length") {
      const actual = compileTrack(spans, {
        samples: options.samples ?? 128,
      }).totalLength;
      const limit = typeof target.target === "number" ? target.target : 0;
      const error = Math.abs(actual - limit);
      if (error > 1e-4)
        diagnostics.push(
          hardDiagnostic(
            "TARGET",
            `Target ${target.id} total-length residual is ${error.toExponential(3)}`,
            [target.id],
            error,
            1e-4,
            { s: actual, position: endPose.position },
          ),
        );
      continue;
    }
    const error = targetError(
      target,
      endPose.position,
      endPose.tangent,
      endPose.bank,
    );
    const limit =
      target.kind === "end-bank" || target.kind === "end-tangent" ? 1e-5 : 1e-4;
    if (error > limit)
      diagnostics.push(
        hardDiagnostic(
          "TARGET",
          `Target ${target.id} ${target.kind} residual is ${error.toExponential(3)}`,
          [target.id],
          error,
          limit,
          { s: endS, position: endPose.position },
        ),
      );
  }
  const hardTrackClearance = intent.constraints
    .filter(
      (constraint) =>
        constraint.kind === "track-clearance" &&
        constraint.hard !== false &&
        typeof (constraint.target ?? constraint.value) === "number",
    )
    .map((constraint) => (constraint.target ?? constraint.value) as number)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  const hasHardFailure = diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "fatal",
  );
  if (!hasHardFailure) {
    const clearance = validateClearance(spans, options.environment, {
      ...(options.trainEnvelopeRadius === undefined
        ? {}
        : { trainEnvelopeRadius: options.trainEnvelopeRadius }),
      trackClearance: Math.max(options.trackClearance ?? 0, hardTrackClearance),
      closed: isClosedChain(elements),
    });
    const clearanceIds = intent.constraints
      .filter((constraint) => constraint.kind === "track-clearance")
      .map((constraint) => constraint.id);
    diagnostics.push(
      ...clearance.map((item) =>
        item.code === "TRACK_CLEARANCE" && clearanceIds.length > 0
          ? {
              ...item,
              relatedIds: [...(item.relatedIds ?? []), ...clearanceIds],
            }
          : item,
      ),
    );
  }
  return sanitizeDiagnostics(diagnostics);
};

export const regenerateLocal = (
  generated: GenerationResult,
  selectedElementId: string,
  options: LocalRegenerationOptions = {},
): LocalRegenerationResult => {
  const baseIntent = options.intent ?? generated.intent;
  const pinned = new Set([
    ...(generated.intent.pinnedElementIds ?? []),
    ...(baseIntent.pinnedElementIds ?? []),
    ...(options.pinnedElementIds ?? []),
  ]);
  if (pinned.has(selectedElementId)) {
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Pinned element ${selectedElementId} cannot be regenerated`,
      [selectedElementId],
    );
    return {
      feasible: false,
      generation: generated,
      diagnostics: [{ ...item, severity: "fatal" }],
      changedWindow: [
        selectedIndexOrMinusOne(generated, selectedElementId),
        selectedIndexOrMinusOne(generated, selectedElementId),
      ],
      untouchedSpanHashes: generated.spanHashes,
      untouchedSpanBytes: generated.spanBytes,
    };
  }
  const selectedIndex = generated.elements.findIndex(
    (element) => element.id === selectedElementId,
  );
  if (selectedIndex < 0) {
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Unknown local regeneration element ${selectedElementId}`,
      [selectedElementId],
    );
    return {
      feasible: false,
      generation: generated,
      diagnostics: [{ ...item, severity: "fatal" }],
      changedWindow: [-1, -1],
      untouchedSpanHashes: generated.spanHashes,
      untouchedSpanBytes: generated.spanBytes,
    };
  }
  const sourceElements: AnySemanticElement[] = options.intent
    ? baseIntent.elements.map((element) => {
        const kind = (element.kind ??
          element.type) as (typeof ELEMENT_KINDS)[number];
        return createElement(
          kind,
          element.id,
          element.parameters ?? {},
        ) as AnySemanticElement;
      })
    : [...generated.elements];
  const changedElements: AnySemanticElement[] = sourceElements.map(
    (element) => {
      const patch = options.changes?.[element.id];
      if (!patch) return element;
      const parameters = Object.fromEntries(
        Object.entries({ ...element.parameters, ...patch }).filter(
          (entry) => entry[1] !== undefined,
        ),
      ) as Record<string, number | string | boolean>;
      return createElement(
        element.type,
        element.id,
        parameters as never,
      ) as AnySemanticElement;
    },
  );
  const changedIntent = {
    ...baseIntent,
    elements: changedElements.map((element) => ({
      id: element.id,
      kind: element.type,
      type: element.type,
      parameters: element.parameters,
    })),
  } as unknown as DesignIntentV1;
  for (const id of pinned)
    if (options.changes?.[id]) {
      const item = hardDiagnostic(
        "LOCAL_REGENERATION",
        `Pinned element ${id} cannot be changed during local regeneration`,
        [id],
      );
      return {
        feasible: false,
        generation: generated,
        diagnostics: [{ ...item, severity: "fatal" }],
        changedWindow: [selectedIndex, selectedIndex],
        untouchedSpanHashes: generated.spanHashes,
        untouchedSpanBytes: generated.spanBytes,
      };
    }
  const leftPinned = Math.max(
    -1,
    ...[...pinned]
      .map((id) => generated.elements.findIndex((element) => element.id === id))
      .filter((index) => index >= 0 && index < selectedIndex),
  );
  const rightPinnedCandidates = [...pinned]
    .map((id) => generated.elements.findIndex((element) => element.id === id))
    .filter((index) => index > selectedIndex);
  const rightPinned =
    rightPinnedCandidates.length === 0
      ? generated.elements.length
      : Math.min(...rightPinnedCandidates);
  const minimumStart = leftPinned + 1;
  const maximumEnd = rightPinned - 1;
  const initialWindow: readonly [number, number] = [
    Math.max(minimumStart, selectedIndex - 1),
    Math.min(maximumEnd, selectedIndex + 1),
  ];
  const queue: Array<readonly [number, number]> = [initialWindow];
  const visited = new Set<string>();
  let lastDiagnostics: readonly Diagnostic[] = [];
  while (queue.length > 0) {
    const [localStart, localEnd] = queue.shift()!;
    const key = `${localStart}:${localEnd}`;
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const localSolved = solver.solveSemanticChain(
        changedElements.slice(localStart, localEnd + 1),
        {
          ...(localStart === 0
            ? {}
            : { startPose: coefficientBoundaryPose(generated, localStart) }),
          ...(localEnd === generated.elements.length - 1
            ? {}
            : { endPose: coefficientBoundaryPose(generated, localEnd + 1) }),
          referenceSpeed: 44,
          maxIterations: 32,
        },
      );
      const localSpans = localSolved.solvedSpans.flatMap(coefficientSpan);
      const oldByOwner = new Map<string, SolvedSpan[]>();
      for (const span of generated.solvedSpans) {
        const group = oldByOwner.get(spanOwner(span.id)) ?? [];
        group.push(span);
        oldByOwner.set(spanOwner(span.id), group);
      }
      const localByOwner = new Map<string, SolvedSpan[]>();
      for (const span of localSpans) {
        const group = localByOwner.get(spanOwner(span.id)) ?? [];
        group.push(span);
        localByOwner.set(spanOwner(span.id), group);
      }
      const mergedSpans: SolvedSpan[] = [];
      for (let index = 0; index < generated.elements.length; index += 1) {
        const id = generated.elements[index]!.id;
        mergedSpans.push(
          ...(index >= localStart && index <= localEnd
            ? (localByOwner.get(id) ?? [])
            : (oldByOwner.get(id) ?? [])),
        );
      }
      const diagnostics = mergedDiagnostics(
        changedElements,
        mergedSpans,
        changedIntent,
        generated.options,
        localSolved.diagnostics,
      );
      lastDiagnostics = diagnostics;
      const candidate = {
        ...generated,
        elements: changedElements,
      };
      const localGeneration = generationWithSpans(
        candidate,
        mergedSpans,
        changedIntent,
        diagnostics,
      );
      if (
        !diagnostics.some(
          (item) => item.severity === "error" || item.severity === "fatal",
        )
      ) {
        const untouchedSpanHashes: Record<string, string> = {};
        const untouchedSpanBytes: Record<string, string> = {};
        for (let index = 0; index < generated.elements.length; index += 1) {
          const id = generated.elements[index]!.id;
          if (index >= localStart && index <= localEnd) continue;
          untouchedSpanHashes[id] = generated.spanHashes[id]!;
          untouchedSpanBytes[id] = generated.spanBytes[id]!;
          const oldSpans = oldByOwner.get(id) ?? [];
          const newSpans = localGeneration.solvedSpans.filter(
            (span) => spanOwner(span.id) === id,
          );
          if (
            oldSpans.length !== newSpans.length ||
            oldSpans.some(
              (span, spanIndex) =>
                spanBytes(span) !== spanBytes(newSpans[spanIndex]!),
            )
          ) {
            lastDiagnostics = [
              hardDiagnostic(
                "LOCAL_REGENERATION",
                `Untouched solved span ${id} changed during local regeneration`,
                [id],
              ),
            ];
            break;
          }
        }
        if (lastDiagnostics === diagnostics)
          return {
            feasible: true,
            generation: localGeneration,
            diagnostics,
            changedWindow: [localStart, localEnd],
            untouchedSpanHashes,
            untouchedSpanBytes,
          };
      }
    } catch (error) {
      lastDiagnostics = [
        {
          ...hardDiagnostic(
            "LOCAL_REGENERATION",
            error instanceof Error ? error.message : String(error),
            [selectedElementId],
          ),
          severity: "fatal",
        },
      ];
    }
    if (localStart > minimumStart) queue.push([localStart - 1, localEnd]);
    if (localEnd < maximumEnd) queue.push([localStart, localEnd + 1]);
  }
  const item = hardDiagnostic(
    "LOCAL_REGENERATION",
    `No allowed local regeneration window is feasible for ${selectedElementId}`,
    [selectedElementId],
  );
  return {
    feasible: false,
    generation: generated,
    diagnostics: [...lastDiagnostics, { ...item, severity: "fatal" }],
    changedWindow: initialWindow,
    untouchedSpanHashes: generated.spanHashes,
    untouchedSpanBytes: generated.spanBytes,
  };
};

export const generate = generateCoaster;
export const localRegenerate = regenerateLocal;
export { compileCoasterFile };
