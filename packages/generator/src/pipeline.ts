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
  vec3Normalize,
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
import { createElement } from "./elements";
import { ELEMENT_KINDS } from "./types";
import { solveSemanticChain } from "./solver";
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
} from "./types";

const now = (): number =>
  (
    globalThis as unknown as { readonly performance?: { now(): number } }
  ).performance?.now() ?? Date.now();

const defaultElements = (seed: number, candidate = 0): AnySemanticElement[] => {
  const rng = new Xoshiro128ss(seed);
  for (let index = 0; index < candidate; index += 1) rng.nextUint32();
  const variation = rng.nextRange(-2, 2);
  return [
    createElement("station", "station-000", { length: 120 }),
    createElement("launch", "launch-001", { length: 260, targetSpeed: 44 }),
    createElement("topHat", "topHat-002", { width: 220 }),
    createElement("overbankedTurn", "overbankedTurn-003", {
      radius: 75,
      angle: Math.PI * 0.75,
    }),
    createElement("airtimeHill", "airtimeHill-004", {
      length: 130 + variation,
      height: 12,
      targetForceG: 1.5,
      referenceSpeed: 44,
    }),
    createElement("boost", "boost-005", { length: 220, targetSpeed: 44 }),
    createElement("zeroGRoll", "zeroGRoll-006", { length: 90, roll: Math.PI }),
    createElement("stall", "stall-007", { length: 100, height: 24 }),
    createElement("brake", "brake-008", { length: 220, targetSpeed: 8 }),
    createElement("brake", "magnetic-brakes-009", {
      length: 110,
      targetSpeed: 5,
    }),
    createElement("station", "station-010", { length: 160, closed: false }),
  ];
};
const canonicalTrackCache = new Map<string, ReturnType<typeof compileTrack>>();
const spanLengthCache = new Map<string, number>();

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
const hardDiagnostic = (
  code: string,
  message: string,
  relatedIds?: readonly string[],
  actual?: number,
  limit?: number,
  location?: { readonly s: number; readonly position?: Vec3 },
): Diagnostic => ({
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
    const length = arcLength(span.span, 0, 1);
    for (let index = 0; index <= 128; index += 1) {
      const u = index / 128;
      points.push({
        span,
        u,
        s: distance + length * u,
        point: span.span.position(u),
      });
    }
    distance += length;
  }
  const frames = transportFramesAlongPath(
    points.map((sample) => sample.point),
    points.map((sample) =>
      vec3Normalize(sample.span.span.derivative(sample.u, 1)),
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
            `Gate ${gate.id} orientation residual is ${actual.toExponential(3)}`,
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

const constraintDiagnostics = (
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
  const samples = pathSamples(spans);
  const footprint = intent.footprint;
  if (footprint)
    for (const sample of samples) {
      const outside = sample.point.some(
        (value, index) =>
          value < footprint.min[index]! || value > footprint.max[index]!,
      );
      if (outside)
        diagnostics.push(
          hardDiagnostic(
            "FOOTPRINT",
            `Footprint exceeded by ${sample.span.id}`,
            [sample.span.id],
            1,
            0,
            { s: sample.s, position: sample.point },
          ),
        );
    }
  if (intent.heightRange)
    for (const sample of samples) {
      const y = sample.point[1];
      if (y < intent.heightRange.min || y > intent.heightRange.max)
        diagnostics.push(
          hardDiagnostic(
            "HEIGHT_RANGE",
            `Height range exceeded by ${sample.span.id}`,
            [sample.span.id],
            y,
            y < intent.heightRange.min
              ? intent.heightRange.min
              : intent.heightRange.max,
            { s: sample.s, position: sample.point },
          ),
        );
    }
  for (const constraint of intent.constraints) {
    if (constraint.kind !== "max-height" && constraint.kind !== "min-height")
      continue;
    const value = constraint.target ?? constraint.value;
    if (typeof value !== "number") continue;
    const failure = samples.find((sample) =>
      constraint.kind === "max-height"
        ? sample.point[1] > value
        : sample.point[1] < value,
    );
    if (!failure) continue;
    const hard = constraint.hard !== false;
    diagnostics.push({
      ...hardDiagnostic(
        constraint.kind === "max-height" ? "MAX_HEIGHT" : "MIN_HEIGHT",
        `${constraint.kind} constraint exceeded by ${failure.span.id}`,
        [constraint.id, failure.span.id],
        failure.point[1],
        value,
        { s: failure.s, position: failure.point },
      ),
      margin:
        constraint.kind === "min-height"
          ? failure.point[1] - value
          : value - failure.point[1],
      severity: hard ? "error" : "warning",
      provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
    });
  }
  return diagnostics;
};
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
  readonly solved: ReturnType<typeof solveSemanticChain>;
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
  const solved = solveSemanticChain(elements, {
    ...(targets && targets.length > 0 ? { targets } : {}),
    referenceSpeed: 44,
    maxIterations: intent.mode === "directed" ? 32 : 8,
  });
  const solvingMs = now() - solvingStart;
  const elementSpans = solved.solvedSpans.map(coefficientSpan);
  const spans = elementSpans.flat();
  const validationStart = now();
  const solverDiagnostics = solved.diagnostics;
  const diagnostics: Diagnostic[] = [
    ...solverDiagnostics,
    ...gateDiagnostics(spans, intent),
    ...constraintDiagnostics(elements, spans, intent, options.environment),
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
        typeof (constraint.target ?? constraint.value) === "number",
    )
    .map((constraint) => (constraint.target ?? constraint.value) as number)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  const clearance = validateClearance(spans, options.environment, {
    ...(options.trainEnvelopeRadius === undefined
      ? {}
      : { trainEnvelopeRadius: options.trainEnvelopeRadius }),
    trackClearance: Math.max(
      options.trackClearance ?? 0,
      requiredTrackClearance,
    ),
  });
  const clearanceConstraintIds = intent.constraints
    .filter((constraint) => constraint.kind === "track-clearance")
    .map((constraint) => constraint.id);
  diagnostics.push(
    ...clearance.map((item) =>
      item.code === "TRACK_CLEARANCE" && clearanceConstraintIds.length > 0
        ? {
            ...item,
            relatedIds: [...(item.relatedIds ?? []), ...clearanceConstraintIds],
          }
        : item,
    ),
  );
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
  return {
    elements,
    elementSpans,
    spans,
    solved,
    diagnostics,
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
  relaxationEvidence: readonly RelaxationEvidence[],
  searchMs: number,
  totalStart: number,
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
    let curvedLength = spanLengthCache.get(lengthKey);
    if (curvedLength === undefined) {
      curvedLength = arcLength(span.span);
      spanLengthCache.set(lengthKey, curvedLength);
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
    lmIterations: evaluation.solved.lmIterations,
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
  for (let candidate = 0; candidate < maxCandidates; candidate += 1) {
    const evaluation = evaluateCandidate(
      asElements(intent, candidate),
      intent,
      options,
      targetOptions(intent),
    );
    candidatesTested += 1;
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
  const searchMs = now() - searchStart;
  const evidence: RelaxationEvidence[] = [];
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
        (diagnostic) => diagnostic.severity === "error",
      ),
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
    const failed = rerun.diagnostics.some((diagnostic) =>
      diagnostic.relatedIds?.includes(constraint.id),
    );
    if (!failed)
      evidence.push({
        change: `Relax hard constraint ${constraint.id}`,
        rerun: true,
        feasible: !rerun.diagnostics.some(
          (diagnostic) => diagnostic.severity === "error",
        ),
        margins: relaxationMargins(constraint, rerun),
      });
  }
  return buildFileResult(
    evaluation,
    intent,
    options,
    candidatesTested,
    evidence,
    searchMs,
    totalStart,
  );
};

const generationWithSpans = (
  candidate: GenerationResult,
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
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
    serializedFile: serializeCoasterFileV1(file),
    spanBytes: spanBytesMap,
    spanHashes: spanHashesMap,
    feasible: !candidate.diagnostics.some(
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
  const changedIntent = {
    ...baseIntent,
    elements: baseIntent.elements.map((element) => {
      const patch = options.changes?.[element.id];
      if (!patch) return element;
      const parameters = Object.fromEntries(
        Object.entries({ ...element.parameters, ...patch }).filter(
          (entry) => entry[1] !== undefined,
        ),
      ) as Record<string, number | string | boolean>;
      return { ...element, parameters };
    }),
  } as unknown as DesignIntentV1;
  const candidate = generateCoaster(changedIntent, generated.options);
  if (!candidate.feasible) {
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Local regeneration of ${selectedElementId} produced infeasible boundaries`,
      [selectedElementId],
    );
    return {
      feasible: false,
      generation: generated,
      diagnostics: [...candidate.diagnostics, { ...item, severity: "fatal" }],
      changedWindow: [selectedIndex, selectedIndex],
      untouchedSpanHashes: generated.spanHashes,
      untouchedSpanBytes: generated.spanBytes,
    };
  }
  const untouchedSpanHashes: Record<string, string> = {};
  const untouchedSpanBytes: Record<string, string> = {};
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
  let localStart = Math.max(leftPinned + 1, selectedIndex - 1);
  let localEnd = Math.min(rightPinned - 1, selectedIndex + 1);
  const changedOwners = new Set(
    candidate.solvedSpans
      .filter((span) => generated.spanBytes[span.id] !== spanBytes(span))
      .map((span) => spanOwner(span.id)),
  );
  for (let index = 0; index < generated.elements.length; index += 1) {
    const id = generated.elements[index]!.id;
    if (index < localStart && changedOwners.has(id) && leftPinned >= 0)
      localStart = leftPinned + 1;
    if (
      index > localEnd &&
      changedOwners.has(id) &&
      rightPinned < generated.elements.length
    )
      localEnd = rightPinned - 1;
  }
  const mergedSpans = candidate.solvedSpans.map((span) => {
    const index = generated.elements.findIndex(
      (element) => element.id === spanOwner(span.id),
    );
    return index >= localStart && index <= localEnd
      ? span
      : (generated.solvedSpans.find((old) => old.id === span.id) ?? span);
  });
  const localGeneration = generationWithSpans(
    candidate,
    mergedSpans,
    changedIntent,
  );
  for (let index = 0; index < generated.elements.length; index += 1) {
    const id = generated.elements[index]!.id;
    if (index >= localStart && index <= localEnd) continue;
    untouchedSpanHashes[id] = generated.spanHashes[id]!;
    untouchedSpanBytes[id] = generated.spanBytes[id]!;
    const oldSpans = generated.solvedSpans.filter(
      (span) => spanOwner(span.id) === id,
    );
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
      const item = hardDiagnostic(
        "LOCAL_REGENERATION",
        `Untouched solved span ${id} changed during local regeneration`,
        [id],
      );
      return {
        feasible: false,
        generation: generated,
        diagnostics: [{ ...item, severity: "fatal" }],
        changedWindow: [localStart, localEnd],
        untouchedSpanHashes,
        untouchedSpanBytes,
      };
    }
  }
  return {
    feasible: localGeneration.feasible,
    generation: localGeneration,
    diagnostics: localGeneration.diagnostics,
    changedWindow: [localStart, localEnd],
    untouchedSpanHashes,
    untouchedSpanBytes,
  };
};

export const generate = generateCoaster;
export const localRegenerate = regenerateLocal;
export { compileCoasterFile };
