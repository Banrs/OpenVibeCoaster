import {
  CANONICAL_TRACK_COMPILE_OPTIONS,
  CoasterFileError,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  TrackCompileError,
  Xoshiro128ss,
  arcLength,
  buildArcLengthLut,
  invertArcLength,
  compileCoasterFile,
  createCoasterFileV1,
  canonicalJson,
  isPointInsidePolygonStrict,
  parseDesignIntentV1,
  serializeCoasterFileV1,
  serializeDesignIntentV1,
  serializeSolvedSpanV1,
  reconstructSolvedSpan,
  signedDistanceStrictXZ,
  validateDesignIntentV1,
  compileTrack,
  aabbFromPoints,
  quatRotateVector,
  vec3Distance,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Sub,
  vec3Normalize,
  vec3Scale,
  vec3,
  transportFramesAlongPath,
  type CoasterFileV1,
  type Diagnostic,
  type DesignIntentV1,
  type EnvironmentQuery,
  type FootprintPolygon,
  type SolvedSpan,
  type ParametricSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { validateClearance } from "./clearance";
import {
  CertifiedWorkBudget,
  CertificationError,
  certifiedPolynomialBounds,
  certifyPolynomialThreshold,
} from "./polynomial-bounds";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
} from "./clearance-field.js";
import { certifyFootprintSpan } from "./footprint-certifier";
import {
  buildElement,
  createAnyElement,
  createElement,
  defaultPose,
  sustainedForceProfile,
} from "./elements";
import { ELEMENT_KINDS } from "./types";
import {
  deriveGateStartPose,
  isRequirementStyleDirectedIntent,
  selectSwitchbackScaffold,
} from "./directed-scaffold";
import * as solver from "./solver";
import type {
  AnySemanticElement,
  ElementKind,
  GenerationOptions,
  GenerationResult,
  StoredGenerationOptions,
  LocalRegenerationOptions,
  LocalRegenerationResult,
  RelaxationEvidence,
  SolveOptions,
  HardTarget,
  ElementParameterMap,
} from "./types";

const DEFAULT_PROFILE_VERSION = "project-engineering-limits-v1" as const;
const DEFAULT_RESEARCH_SNAPSHOT_IDS = Object.freeze([
  "records-2026-08-29",
] as const);

const toCompileFatalDiagnostic = (
  error: unknown,
  relatedIds: readonly string[] = [],
): Diagnostic => {
  if (error instanceof TrackCompileError) {
    const ev = error.evidence as Record<string, unknown>;
    const actualRaw =
      typeof ev.actual === "number"
        ? (ev.actual as number)
        : typeof ev.samples === "number" && typeof ev.limitSamples === "number"
          ? (ev.samples as number)
          : undefined;
    const limitRaw =
      typeof ev.limit === "number"
        ? (ev.limit as number)
        : typeof ev.limitSamples === "number"
          ? (ev.limitSamples as number)
          : undefined;
    const margin =
      actualRaw !== undefined && limitRaw !== undefined
        ? limitRaw - actualRaw
        : undefined;
    // Never fabricate location: omit unless exact global s and position are known (not available from element-local evidence)
    const elementId =
      typeof ev.elementId === "string" ? (ev.elementId as string) : undefined;
    const allRelatedIds = [
      ...new Set([...relatedIds, ...(elementId ? [elementId] : [])]),
    ];
    return {
      code: error.code,
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message: error.message,
      relatedIds: allRelatedIds,
      ...(actualRaw !== undefined ? { actual: actualRaw } : {}),
      ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
      ...(margin !== undefined ? { margin } : {}),
    };
  }
  const code = "COMPILE_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    severity: "fatal",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    relatedIds,
  };
};

export const recordHybridDefaultElements = (
  seed: number,
  candidate = 0,
): AnySemanticElement[] => {
  const rng = new Xoshiro128ss(seed);
  for (let index = 0; index < candidate; index += 1) rng.nextUint32();
  const variation = rng.nextRange(-4, 4);
  const elements: AnySemanticElement[] = [];
  let pose = defaultPose();
  const append = (element: AnySemanticElement, referenceSpeed = 44): void => {
    elements.push(element);
    pose = buildElement(element, pose, referenceSpeed).endPose;
  };
  const appendForceHill = (
    id: string,
    length: number,
    targetForceG: number,
    referenceSpeed: number,
    trimSpeed?: number,
  ): void => {
    const provisional = createElement("airtimeHill", id, {
      length,
      height: 0,
      targetForceG,
      referenceSpeed,
      bank: 0,
      ...(trimSpeed !== undefined ? { trimSpeed } : {}),
    });
    const end = buildElement(provisional, pose, referenceSpeed).endPose;
    const height = vec3Dot(vec3Sub(end.position, pose.position), pose.normal);
    append(
      createElement("airtimeHill", id, {
        length,
        height,
        targetForceG,
        referenceSpeed,
        bank: 0,
        ...(trimSpeed !== undefined ? { trimSpeed } : {}),
      }),
      referenceSpeed,
    );
  };

  append(createElement("station", "station-000", { length: 50 }));
  append(
    createElement("launch", "launch-001", {
      length: 260,
      targetSpeed: 58,
    }),
  );
  append(
    createElement("transition", "transition-002", {
      length: 170 + variation,
      rise: 60,
      pitch: 0.1,
      bank: 0,
    }),
  );
  appendForceHill("airtimeHill-003", 220 + variation, 0.9, 44);
  append(
    createElement("overbankedTurn", "overbankedTurn-004", {
      radius: 120 + variation,
      angle: 1.7,
      bank: 1.8,
    }),
  );
  append(
    createElement("overbankedTurn", "overbankedTurn-005", {
      radius: 120 - variation,
      angle: -1.7,
      bank: 1.8,
    }),
  );
  append(
    createElement("launch", "launch-006", {
      length: 420,
      targetSpeed: 60,
    }),
  );
  append(
    createElement("brake", "brake-007", {
      length: 155,
      targetSpeed: 0,
      holdSeconds: 3,
      releaseSpeed: 60,
    }),
  );
  append(
    createElement("diveDrop", "diveDrop-008", {
      dropHeight: 214,
      angleDeg: 109,
      approachRadius: 55,
      exitRadius: 205,
      bank: 0,
    }),
  );
  append(
    createElement("launch", "launch-009", {
      length: 380,
      targetSpeed: 81,
    }),
    80,
  );
  appendForceHill("airtimeHill-010", 190, 0.98, 44, 60);
  append(
    createElement("topHat", "topHat-011", {
      height: 86,
      width: 500,
      bank: 0,
    }),
  );
  append(
    createElement("immelmann", "immelmann-012", {
      height: 80,
      exitHeadingDeg: 180,
      bank: 0,
    }),
  );
  append(
    createElement("verticalLoop", "verticalLoop-013", {
      height: 65.5,
      referenceSpeed: 38,
      bank: Math.PI,
    }),
    38,
  );
  const gravityDirection = vec3(0, -1, 0);
  const gravityInTangentPlane = vec3Sub(
    gravityDirection,
    vec3Scale(pose.normal, vec3Dot(gravityDirection, pose.normal)),
  );
  let finaleTurnAngle = -2.2;
  if (vec3Length(gravityInTangentPlane) > 1e-9) {
    const desiredTangent = vec3Normalize(gravityInTangentPlane);
    const alignedAngle = -Math.atan2(
      vec3Dot(pose.normal, vec3Cross(pose.tangent, desiredTangent)),
      vec3Dot(pose.tangent, desiredTangent),
    );
    const oppositeAngle = alignedAngle - Math.PI;
    finaleTurnAngle =
      Math.abs(alignedAngle + 2.2) <= Math.abs(oppositeAngle + 2.2)
        ? alignedAngle
        : oppositeAngle;
    if (Math.abs(Math.abs(finaleTurnAngle) - Math.PI) < 1e-9)
      finaleTurnAngle = -finaleTurnAngle;
  }
  append(
    createElement("overbankedTurn", "overbankedTurn-014", {
      radius: 60,
      angle: finaleTurnAngle,
      bank: 2.8,
    }),
  );
  append(
    createElement("zeroGRoll", "zeroGRoll-015", {
      length: 280,
      roll: Math.PI * 2,
    }),
  );
  append(
    createElement("stall", "stall-016", {
      length: 300,
      height: 13.5,
      bank: Math.PI,
    }),
  );
  append(
    createElement("brake", "brake-017", {
      length: 140,
      targetSpeed: 25,
      angle: 0.25,
      bank: Math.PI,
    }),
  );
  append(
    createElement("brake", "brake-018", {
      length: 420,
      targetSpeed: 0,
      bank: 0,
    }),
  );
  append(
    createElement("station", "station-019", {
      length: 40,
      closed: false,
    }),
  );
  return elements;
};
interface GenerationOperationCache {
  readonly spanLengthCache: Map<string, number>;
}

const createGenerationOperationCache = (): GenerationOperationCache => ({
  spanLengthCache: new Map<string, number>(),
});

const canonicalIntentCopy = (intent: DesignIntentV1): DesignIntentV1 =>
  parseDesignIntentV1(serializeDesignIntentV1(intent));

// Stored options are caller-owned inputs; effective default provenance is
// embedded in the file (resolves apparent split authority).
const ownedGenerationOptions = (
  options: GenerationOptions,
): StoredGenerationOptions => ({
  // Stored generation options remain canonical adaptive; preview samples never become authoritative (fixed-32 is decoder-only)
  ...(options.name === undefined ? {} : { name: options.name }),
  ...(options.generatorVersion === undefined
    ? {}
    : { generatorVersion: options.generatorVersion }),
  ...(options.profileVersion === undefined
    ? {}
    : { profileVersion: options.profileVersion }),
  ...(options.researchSnapshotIds === undefined
    ? {}
    : { researchSnapshotIds: [...options.researchSnapshotIds] }),
  ...(options.trainEnvelopeRadius === undefined
    ? {}
    : { trainEnvelopeRadius: options.trainEnvelopeRadius }),
  ...(options.trackClearance === undefined
    ? {}
    : { trackClearance: options.trackClearance }),
});

const ownedElements = (
  elements: readonly AnySemanticElement[],
): readonly AnySemanticElement[] =>
  elements.map(
    (element) =>
      ({
        id: element.id,
        type: element.type,
        kind: element.kind,
        parameters: { ...element.parameters },
      }) as AnySemanticElement,
  );

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
};

const buildEffectiveDirectedElements = (
  intent: DesignIntentV1,
): AnySemanticElement[] => {
  if (!isRequirementStyleDirectedIntent(intent)) {
    return intent.elements.map((element) => {
      const kind = (element.kind ?? element.type) as string;
      if (!ELEMENT_KINDS.includes(kind as ElementKind)) {
        throw new CoasterFileError(
          `elements.${element.id}: unknown semantic element kind ${kind}`,
        );
      }
      const kindTyped = kind as ElementKind;
      const params = element.parameters as Record<string, unknown>;
      return createAnyElement(kindTyped, element.id, params);
    });
  }
  const targetLength = intent.targets.find(
    (target) => target.kind === "total-length",
  )?.target as number | undefined;
  const gate = intent.gates[0];
  const sharedBudget = new CertifiedWorkBudget(1_000_000);
  const scaffold =
    selectSwitchbackScaffold(
      intent.footprint,
      targetLength,
      gate,
      sharedBudget,
    ) ?? [];
  const result: AnySemanticElement[] = [...scaffold];
  const replaced = new Set<number>();
  for (const requested of intent.elements) {
    const kind = (requested.kind ?? requested.type) as string;
    if (!ELEMENT_KINDS.includes(kind as ElementKind)) {
      throw new CoasterFileError(
        `elements.${requested.id}: unknown semantic element kind ${kind}`,
      );
    }
    let found = -1;
    for (let index = 0; index < result.length; index += 1) {
      if (!replaced.has(index) && result[index]!.kind === kind) {
        found = index;
        break;
      }
    }
    const requestedParams = requested.parameters as
      Record<string, unknown> | undefined;
    const baseParams =
      found !== -1
        ? (result[found]!.parameters as Record<string, unknown>)
        : {};
    const merged =
      requestedParams === undefined
        ? { ...baseParams }
        : { ...baseParams, ...requestedParams };
    const kindTyped = kind as ElementKind;
    if (found !== -1) {
      const created = createAnyElement(kindTyped, requested.id, merged);
      result[found] = created;
      replaced.add(found);
    } else {
      const created = createAnyElement(
        kindTyped,
        requested.id,
        requestedParams ?? {},
      );
      result.push(created);
    }
  }
  return result;
};

const asElements = (
  intent: DesignIntentV1,
  candidate: number,
): AnySemanticElement[] => {
  if (intent.mode !== "directed")
    return recordHybridDefaultElements(intent.seed, candidate);
  return buildEffectiveDirectedElements(intent);
};

const childBoundaries = (span: SolvedSpan): readonly number[] => {
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
  if (span.positionCoefficients && span.rollCoefficients) return [span];
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
  coefficients.forEach((coefficient, index) => {
    const canonical = coefficient === 0 ? 0 : coefficient;
    view.setFloat64(index * 8, canonical, true);
  });
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

const ownerForSpan = <T>(
  spanId: string,
  elementById: ReadonlyMap<string, T>,
): string | undefined => {
  if (elementById.has(spanId)) return spanId;
  let current = spanId;
  while (true) {
    const separator = current.lastIndexOf("#");
    if (separator <= 0 || !/^\d+$/.test(current.slice(separator + 1)))
      return undefined;
    current = current.slice(0, separator);
    if (elementById.has(current)) return current;
  }
};

export const coasterFileSpanHashes = (
  fileInput: CoasterFileV1 | string | Uint8Array,
): Readonly<Record<string, string>> => {
  const loaded = compileCoasterFile(
    fileInput as CoasterFileV1 | string | Uint8Array,
    { samples: 32 },
  );
  const elementById = new Map(
    loaded.file.intent.elements.map((element) => [element.id, element]),
  );
  const hashes: Record<string, string> = {};
  for (const span of loaded.solvedSpans) {
    hashes[span.id] = hashSpan(span);
  }
  for (const element of loaded.file.intent.elements) {
    const first = loaded.solvedSpans.find(
      (span) => ownerForSpan(span.id, elementById) === element.id,
    );
    if (first) hashes[element.id] = hashSpan(first);
  }
  return Object.freeze({ ...hashes });
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

interface CanonicalPathLocation {
  readonly spanIndex: number;
  readonly span: SolvedSpan;
  readonly u: number;
  readonly s: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly distanceSquared: number;
}

const closestGateLocation = (
  spans: readonly SolvedSpan[],
  target: Vec3,
  cursor: { readonly spanIndex: number; readonly u: number },
): CanonicalPathLocation => {
  const budget = new CertifiedWorkBudget(1_000_000);
  const geometries = spans.map(positionGeometry);
  const lengths = geometries.map((geometry) => arcLength(geometry));
  const offsets = lengths.map((_, index) =>
    lengths.slice(0, index).reduce((sum, length) => sum + length, 0),
  );
  const distanceSquared = (point: Vec3): number => {
    const delta = vec3Sub(point, target);
    const value = vec3Dot(delta, delta);
    if (!Number.isFinite(value))
      throw new CertificationError("Gate distance arithmetic is non-finite");
    return value;
  };
  const lowerDistanceSquared = (
    bounds: ReturnType<typeof certifiedPolynomialBounds>,
  ): number => {
    let value = 0;
    for (const axis of [0, 1, 2] as const) {
      const delta =
        target[axis] < bounds.min[axis]!
          ? bounds.min[axis]! - target[axis]
          : target[axis] > bounds.max[axis]!
            ? target[axis] - bounds.max[axis]!
            : 0;
      value += delta * delta;
    }
    if (!Number.isFinite(value))
      throw new CertificationError("Gate bound distance is non-finite");
    return value;
  };
  interface IntervalCandidate {
    readonly spanIndex: number;
    readonly start: number;
    readonly end: number;
    readonly depth: number;
    readonly lowerDistanceSquared: number;
  }
  const intervalCandidate = (
    spanIndex: number,
    start: number,
    end: number,
    depth: number,
  ): IntervalCandidate => ({
    spanIndex,
    start,
    end,
    depth,
    lowerDistanceSquared: lowerDistanceSquared(
      certifiedPolynomialBounds(
        geometries[spanIndex]!.coefficients,
        start,
        end,
        budget,
      ),
    ),
  });
  const pending: IntervalCandidate[] = [];
  let best:
    | {
        readonly spanIndex: number;
        readonly u: number;
        readonly point: Vec3;
        readonly distanceSquared: number;
      }
    | undefined;
  const consider = (spanIndex: number, u: number): void => {
    const point = geometries[spanIndex]!.position(u);
    const candidate = {
      spanIndex,
      u,
      point,
      distanceSquared: distanceSquared(point),
    };
    if (
      best === undefined ||
      candidate.distanceSquared < best.distanceSquared ||
      (candidate.distanceSquared === best.distanceSquared &&
        (candidate.spanIndex < best.spanIndex ||
          (candidate.spanIndex === best.spanIndex && candidate.u < best.u)))
    )
      best = candidate;
  };
  for (
    let spanIndex = cursor.spanIndex;
    spanIndex < spans.length;
    spanIndex += 1
  ) {
    const start = spanIndex === cursor.spanIndex ? cursor.u : 0;
    if (start > 1) continue;
    consider(spanIndex, start);
    consider(spanIndex, 1);
    consider(spanIndex, (start + 1) / 2);
    pending.push(intervalCandidate(spanIndex, start, 1, 0));
  }
  if (best === undefined)
    throw new CertificationError("Gate has no ordered canonical path interval");
  while (pending.length > 0) {
    pending.sort(
      (left, right) =>
        right.lowerDistanceSquared - left.lowerDistanceSquared ||
        right.spanIndex - left.spanIndex ||
        right.start - left.start,
    );
    const interval = pending.pop()!;
    if (interval.lowerDistanceSquared >= best.distanceSquared - 1e-12) continue;
    if (interval.depth >= 40)
      throw new CertificationError(
        `Gate closest parameter remained uncertified on ${spans[interval.spanIndex]!.id}`,
      );
    const middle = (interval.start + interval.end) / 2;
    consider(interval.spanIndex, middle);
    pending.push(
      intervalCandidate(
        interval.spanIndex,
        interval.start,
        middle,
        interval.depth + 1,
      ),
      intervalCandidate(
        interval.spanIndex,
        middle,
        interval.end,
        interval.depth + 1,
      ),
    );
  }
  const selected = best as NonNullable<typeof best>;
  const orderedSamples: Array<{
    readonly spanIndex: number;
    readonly u: number;
    readonly point: Vec3;
  }> = [];
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const parameters = new Set(
      Array.from({ length: 129 }, (_, index) => index / 128),
    );
    if (spanIndex === selected.spanIndex) parameters.add(selected.u);
    for (const u of [...parameters].sort((left, right) => left - right))
      orderedSamples.push({
        spanIndex,
        u,
        point: geometries[spanIndex]!.position(u),
      });
  }
  const frames = transportFramesAlongPath(
    orderedSamples.map((sample) => sample.point),
    orderedSamples.map((sample) =>
      vec3Normalize(geometries[sample.spanIndex]!.derivative(sample.u, 1)),
    ),
    orderedSamples.map((_, index) => index),
    orderedSamples.map(
      (sample) => spans[sample.spanIndex]!.bank?.position(sample.u) ?? 0,
    ),
  );
  const selectedIndex = orderedSamples.findIndex(
    (sample) =>
      sample.spanIndex === selected.spanIndex && sample.u === selected.u,
  );
  const frame = frames[selectedIndex]!;
  return {
    ...selected,
    span: spans[selected.spanIndex]!,
    s:
      offsets[selected.spanIndex]! +
      arcLength(geometries[selected.spanIndex]!, 0, selected.u),
    tangent: frame.tangent,
    normal: frame.normal,
  };
};

const gateDiagnostics = (
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
): readonly Diagnostic[] => {
  if (intent.gates.length === 0) return [];
  const diagnostics: Diagnostic[] = [];
  let cursor = { spanIndex: 0, u: 0 };
  const requiredFootprintId = intent.constraints.find(
    (c) => c.kind === "required-footprint",
  )?.id;
  for (const gate of intent.gates) {
    const gatePosition = finitePosition(gate.position);
    if (!gatePosition) {
      diagnostics.push({
        code: "GATE_POSITION_REQUIRED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${gate.id} requires a finite position for generation`,
        relatedIds: [gate.id],
      });
      continue;
    }
    if (intent.footprint !== undefined) {
      const inside = isPointInsidePolygonStrict(
        intent.footprint as FootprintPolygon,
        gatePosition,
      );
      if (!inside) {
        const sd = signedDistanceStrictXZ(
          intent.footprint as FootprintPolygon,
          gatePosition,
        );
        if (Number.isFinite(sd) && sd > 0) {
          const relatedIds = requiredFootprintId
            ? [gate.id, requiredFootprintId]
            : [gate.id];
          diagnostics.push(
            sanitizeDiagnostic({
              code: "FOOTPRINT",
              severity: "error",
              provenance: "PROJECT_ENGINEERING_LIMIT",
              message: `Gate ${gate.id} outside footprint`,
              relatedIds,
              actual: sd,
              limit: 0,
              margin: -sd,
              location: { s: 0, position: gatePosition },
            }),
          );
        } else if (!Number.isFinite(sd)) {
          diagnostics.push({
            code: "FOOTPRINT_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Gate ${gate.id} footprint classification is non-finite`,
            relatedIds: requiredFootprintId
              ? [gate.id, requiredFootprintId]
              : [gate.id],
          });
        }
      }
    }
    let best: CanonicalPathLocation;
    try {
      best = closestGateLocation(spans, gatePosition, cursor);
    } catch (error) {
      diagnostics.push({
        code: "GATE_POSITION_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: error instanceof Error ? error.message : String(error),
        relatedIds: [gate.id],
      });
      continue;
    }
    cursor = { spanIndex: best.spanIndex, u: best.u };
    const positionError = Math.sqrt(best.distanceSquared);
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
      const orientationLength = Math.hypot(...gate.orientation);
      if (!Number.isFinite(orientationLength) || orientationLength < 1e-15) {
        diagnostics.push({
          code: "GATE_ORIENTATION_INVALID",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Gate ${gate.id} requires a finite nonzero orientation quaternion`,
          relatedIds: [gate.id],
        });
        continue;
      }
      const targetTangent = vec3Normalize(
        quatRotateVector(gate.orientation, vec3(0, 0, 1)),
      );
      const targetNormal = vec3Normalize(
        quatRotateVector(gate.orientation, vec3(0, 1, 0)),
      );
      const canonicalTangentError = Math.acos(
        Math.max(-1, Math.min(1, vec3Dot(best.tangent, targetTangent))),
      );
      const rollError = Math.acos(
        Math.max(-1, Math.min(1, vec3Dot(best.normal, targetNormal))),
      );
      const actual = Math.max(canonicalTangentError, rollError);
      if (actual > 1e-5)
        diagnostics.push(
          hardDiagnostic(
            "GATE_ORIENTATION",
            `Gate ${gate.id} orientation residual is ${actual.toExponential(3)} (tangent=${canonicalTangentError.toExponential(3)}, roll=${rollError.toExponential(3)})`,
            [gate.id],
            actual,
            1e-5,
            { s: best.s, position: best.point },
          ),
        );
    }
  }
  return diagnostics;
};

const validateGenerationConstraints = (
  elements: readonly AnySemanticElement[],
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  environment: EnvironmentQuery | undefined,
  failedHardRequirementIds?: Set<string>,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const constraint of intent.constraints) {
    const diagnosticStart = diagnostics.length;
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
      if (hard) {
        diagnostics.push(
          hardDiagnostic(
            "UNSUPPORTED_HARD_CONSTRAINT",
            `Unsupported hard constraint kind ${constraint.kind}`,
            [constraint.id],
          ),
        );
        failedHardRequirementIds?.add(constraint.id);
      }
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
    if (
      hard &&
      diagnostics
        .slice(diagnosticStart)
        .some(
          (diagnostic) =>
            diagnostic.severity === "error" || diagnostic.severity === "fatal",
        )
    )
      failedHardRequirementIds?.add(constraint.id);
  }
  const heightConstraints = intent.constraints.filter(
    (constraint) =>
      constraint.kind === "max-height" || constraint.kind === "min-height",
  );
  if (
    intent.footprint === undefined &&
    intent.heightRange === undefined &&
    heightConstraints.length === 0
  )
    return sanitizeDiagnostics(diagnostics);
  const boundBudget = new CertifiedWorkBudget(1_000_000);
  const thresholdAt = (
    geometry: SeventhOrderHermiteSpan<Vec3>,
    axis: 0 | 1 | 2,
    limit: number,
    direction: "maximum" | "minimum",
  ) =>
    certifyPolynomialThreshold(
      geometry.coefficients[axis]!,
      0,
      1,
      limit,
      direction,
      boundBudget,
    );
  const uncertified = (
    code: string,
    relatedIds: readonly string[],
    error: unknown,
  ): Diagnostic => ({
    code: `${code}_UNCERTIFIED`,
    severity: "fatal",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message: error instanceof Error ? error.message : String(error),
    relatedIds,
  });
  let station = 0;
  const footprint = intent.footprint as FootprintPolygon | undefined;
  const requiredFootprintId = intent.constraints.find(
    (constraint) => constraint.kind === "required-footprint",
  )?.id;
  for (const span of spans) {
    let geometry: SeventhOrderHermiteSpan<Vec3>;
    try {
      geometry = positionGeometry(span);
    } catch (error) {
      diagnostics.push(uncertified("BOUNDS", [span.id], error));
      continue;
    }
    let certifiedBounds:
      ReturnType<typeof certifiedPolynomialBounds> | undefined;
    try {
      certifiedBounds = certifiedPolynomialBounds(
        geometry.coefficients,
        0,
        1,
        boundBudget,
      );
    } catch (error) {
      diagnostics.push(uncertified("BOUNDS", [span.id], error));
      station += arcLength(geometry);
      continue;
    }
    const check = (
      code: "FOOTPRINT" | "HEIGHT_RANGE",
      axis: 0 | 1 | 2,
      limit: number,
      direction: "maximum" | "minimum",
      message: string,
    ): void => {
      try {
        const certified = thresholdAt(geometry, axis, limit, direction);
        if (certified.status !== "violated") return;
        const { u, value } = certified.witness;
        diagnostics.push(
          sanitizeDiagnostic({
            ...hardDiagnostic(code, message, [span.id], value, limit, {
              s: station + arcLength(geometry, 0, u),
              position: geometry.position(u),
            }),
            margin: direction === "minimum" ? value - limit : limit - value,
          }),
        );
      } catch (error) {
        diagnostics.push(uncertified(code, [span.id], error));
      }
    };
    if (footprint) {
      const footprintResult = certifyFootprintSpan(span, footprint, {
        station,
        budget: boundBudget,
        maxDepth: 32,
      });
      if (footprintResult.status === "outside") {
        const sd = footprintResult.witness.signedDistance;
        const relatedIds = requiredFootprintId
          ? [span.id, requiredFootprintId]
          : [span.id];
        diagnostics.push(
          sanitizeDiagnostic({
            code: "FOOTPRINT",
            severity: "error",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Footprint exceeded by ${span.id}`,
            relatedIds,
            actual: sd,
            limit: 0,
            margin: -sd,
            location: {
              s: footprintResult.witness.s,
              position: footprintResult.witness.position,
            },
          }),
        );
      } else if (footprintResult.status === "uncertified") {
        const relatedIds = requiredFootprintId
          ? [span.id, requiredFootprintId]
          : [span.id];
        diagnostics.push({
          code: "FOOTPRINT_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: footprintResult.reason,
          relatedIds,
        });
      }
    }
    if (intent.heightRange) {
      const minLimit = intent.heightRange.min;
      const maxLimit = intent.heightRange.max;
      const needsMin = certifiedBounds.min[1]! < minLimit;
      const needsMax = certifiedBounds.max[1]! > maxLimit;
      if (needsMin)
        check(
          "HEIGHT_RANGE",
          1,
          minLimit,
          "minimum",
          `Height range minimum exceeded by ${span.id}`,
        );
      if (needsMax)
        check(
          "HEIGHT_RANGE",
          1,
          maxLimit,
          "maximum",
          `Height range maximum exceeded by ${span.id}`,
        );
    }
    station += arcLength(geometry);
  }
  for (const constraint of heightConstraints) {
    const diagnosticStart = diagnostics.length;
    const hard = constraint.hard !== false;
    const value = constraint.target ?? constraint.value;
    if (typeof value !== "number") continue;
    let failure:
      | {
          readonly span: SolvedSpan;
          readonly actual: number;
          readonly s: number;
          readonly position: Vec3;
        }
      | undefined;
    let distance = 0;
    for (const span of spans) {
      try {
        const geometry = positionGeometry(span);
        const certified = thresholdAt(
          geometry,
          1,
          value,
          constraint.kind === "max-height" ? "maximum" : "minimum",
        );
        if (certified.status === "violated") {
          const { u, value: actual } = certified.witness;
          failure = {
            span,
            actual,
            s: distance + arcLength(geometry, 0, u),
            position: geometry.position(u),
          };
          break;
        }
      } catch (error) {
        diagnostics.push(
          uncertified(
            constraint.kind === "max-height" ? "MAX_HEIGHT" : "MIN_HEIGHT",
            [constraint.id, span.id],
            error,
          ),
        );
        break;
      }
      distance += arcLength(positionGeometry(span));
    }
    if (!failure) {
      if (
        hard &&
        diagnostics
          .slice(diagnosticStart)
          .some(
            (diagnostic) =>
              diagnostic.severity === "error" ||
              diagnostic.severity === "fatal",
          )
      )
        failedHardRequirementIds?.add(constraint.id);
      continue;
    }
    diagnostics.push(
      sanitizeDiagnostic({
        ...hardDiagnostic(
          constraint.kind === "max-height" ? "MAX_HEIGHT" : "MIN_HEIGHT",
          `${constraint.kind} constraint exceeded by ${failure.span.id}`,
          [constraint.id, failure.span.id],
          failure.actual,
          value,
          { s: failure.s, position: failure.position },
        ),
        margin:
          constraint.kind === "min-height"
            ? failure.actual - value
            : value - failure.actual,
        severity: hard ? "error" : "warning",
        provenance: hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
      }),
    );
    if (hard) failedHardRequirementIds?.add(constraint.id);
  }
  return sanitizeDiagnostics(diagnostics);
};
export const isClosedChain = (
  elements: readonly {
    readonly type: string;
    readonly parameters: Record<string, unknown>;
  }[],
): boolean => {
  const first = elements[0] as unknown as AnySemanticElement | undefined;
  if (!first) return false;
  if (first.type !== "station") return false;
  const params = first.parameters as ElementParameterMap["station"];
  return params.closed === true;
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

const finiteMargins = (
  margins: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.entries(margins).filter((entry) => Number.isFinite(entry[1])),
  );

interface CandidateEvaluation {
  readonly elements: readonly AnySemanticElement[];
  readonly elementSpans: readonly (readonly SolvedSpan[])[];
  readonly spans: readonly SolvedSpan[];
  readonly solved: ReturnType<typeof solver.solveSemanticChain>;
  readonly diagnostics: readonly Diagnostic[];
  readonly failedHardRequirementIds: ReadonlySet<string>;
  readonly track?: ReturnType<typeof compileTrack>;
  readonly clearanceField?: import("./clearance-field.js").ClearanceField;
}

export type GenerationBenchmarkEvent =
  | "total:start"
  | "total:end"
  | "search:start"
  | "search:end"
  | "solving:start"
  | "solving:end"
  | "compilation:start"
  | "compilation:end"
  | "validation:start"
  | "validation:end"
  | "clearance:start"
  | "clearance:end";

type GenerationBenchmarkObserver = (event: GenerationBenchmarkEvent) => void;

const flagshipBankProfile = (
  spans: readonly SolvedSpan[],
  elements: readonly AnySemanticElement[],
  automatic: boolean,
): readonly SolvedSpan[] => {
  if (!automatic) return spans;
  const overbanks = new Map(
    elements
      .filter((element) => element.type === "overbankedTurn")
      .map(
        (element) =>
          [
            element.id,
            (element.parameters as { readonly bank: number }).bank,
          ] as const,
      ),
  );
  return spans.flatMap((span) => {
    const amplitude = overbanks.get(span.id);
    if (amplitude === undefined) return [span];
    const base = span.bank
      ? new QuinticScalarSpan({
          v0: span.bank.position(0),
          d10: span.bank.derivative(0, 1),
          d20: span.bank.derivative(0, 2),
          v1: span.bank.position(1),
          d11: span.bank.derivative(1, 1),
          d21: span.bank.derivative(1, 2),
        })
      : QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0]);
    const startBank = base.position(0);
    const bumpAmplitude = amplitude - base.position(0.5);
    const peakBank = startBank + bumpAmplitude;
    const leftBank = new QuinticScalarSpan({
      v0: startBank,
      d10: 0,
      d20: 0,
      v1: peakBank,
      d11: 0,
      d21: 0,
    });
    const rightBank = new QuinticScalarSpan({
      v0: peakBank,
      d10: 0,
      d20: 0,
      v1: startBank,
      d11: 0,
      d21: 0,
    });
    const leftGeometry = subspan(span.span, 0, 0.5);
    const rightGeometry = subspan(span.span, 0.5, 1);
    const leftPoints = Array.from({ length: 17 }, (_, index) =>
      leftGeometry.position(index / 16),
    );
    const rightPoints = Array.from({ length: 17 }, (_, index) =>
      rightGeometry.position(index / 16),
    );
    const leftSpan: SolvedSpan = {
      ...span,
      id: `${span.id}#0`,
      span: leftGeometry,
      bank: leftBank,
      rollCoefficients: leftBank.coefficients,
      bounds: aabbFromPoints(leftPoints),
    };
    const rightSpan: SolvedSpan = {
      ...span,
      id: `${span.id}#1`,
      span: rightGeometry,
      bank: rightBank,
      rollCoefficients: rightBank.coefficients,
      bounds: aabbFromPoints(rightPoints),
    };
    return [leftSpan, rightSpan];
  });
};

const evaluateCandidate = (
  elements: readonly AnySemanticElement[],
  intent: DesignIntentV1,
  options: GenerationOptions,
  targets: SolveOptions["targets"],
  observer?: GenerationBenchmarkObserver,
): CandidateEvaluation => {
  observer?.("solving:start");
  const solveElements =
    intent.mode === "directed"
      ? elements
      : elements.map((element) =>
          element.type === "overbankedTurn" &&
          Math.abs(element.parameters.bank) <= Math.PI / 2
            ? ({
                ...element,
                parameters: { ...element.parameters, bank: 0 },
              } as AnySemanticElement)
            : element,
        );
  const gateStartPose = isRequirementStyleDirectedIntent(intent)
    ? deriveGateStartPose(intent)
    : undefined;
  const rawSolved = solver.solveSemanticChain(solveElements, {
    ...(targets && targets.length > 0 ? { targets } : {}),
    ...(gateStartPose ? { startPose: gateStartPose } : {}),
    referenceSpeed: 44,
    maxIterations:
      intent.mode === "directed"
        ? 32
        : intent.targets.length === 0 && intent.constraints.length === 0
          ? 1
          : 8,
  });
  const solvedSpans = flagshipBankProfile(
    rawSolved.solvedSpans,
    elements,
    intent.mode !== "directed",
  );
  const solved = { ...rawSolved, solvedSpans };
  observer?.("solving:end");
  observer?.("validation:start");
  const elementSpans = solved.solvedSpans.map(coefficientSpan);
  const spans = elementSpans.flat();
  const solverDiagnostics = solved.diagnostics;
  const failedHardRequirementIds = new Set<string>();
  const diagnostics: Diagnostic[] = [
    ...solverDiagnostics,
    ...gateDiagnostics(spans, intent),
    ...validateGenerationConstraints(
      elements,
      spans,
      intent,
      options.environment,
      failedHardRequirementIds,
    ),
  ];
  const targetLocationS = spans.reduce((sum, span) => {
    try {
      return sum + arcLength(span.span);
    } catch (error) {
      throw new RangeError(
        `Failed to measure solved span ${span.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }, 0);
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
      if (actual > limit) {
        if (target.hard !== false) failedHardRequirementIds.add(target.id);
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
    }
  // Serialize to canonical spans so evaluation track exactly matches returned canonical track (no duplicate field)
  const elementByIdForCandidate = new Map(
    elements.map((e) => [e.id, e] as const),
  );
  const serializedForCandidate = spans.map((span) => {
    const owner = ownerForSpan(span.id, elementByIdForCandidate);
    const el = owner ? elementByIdForCandidate.get(owner) : undefined;
    if (!el) throw new Error(`Missing semantic owner for span ${span.id}`);
    const len = arcLength(span.span);
    return serializeSolvedSpanV1(span, el.type, len);
  });
  const canonicalSpansForCandidate = serializedForCandidate.map(
    reconstructSolvedSpan,
  );
  let track: ReturnType<typeof compileTrack> | undefined;
  try {
    if (options.samples !== undefined)
      track = compileTrack(canonicalSpansForCandidate, {
        samples: options.samples,
      });
    else
      track = compileTrack(
        canonicalSpansForCandidate,
        CANONICAL_TRACK_COMPILE_OPTIONS,
      );
  } catch (error) {
    diagnostics.push(toCompileFatalDiagnostic(error));
    failedHardRequirementIds.add("track-compile");
    track = undefined;
  }
  for (const target of intent.targets) {
    if (target.kind === "total-length" && track) {
      const actual = track.totalLength;
      const limit = typeof target.target === "number" ? target.target : 0;
      const error = Math.abs(actual - limit);
      if (error > 1e-4) {
        if (target.hard !== false) failedHardRequirementIds.add(target.id);
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
  }
  // Authoritative clearance validation per candidate (before selection)
  let clearanceField: import("./clearance-field.js").ClearanceField | undefined;
  {
    const explicitConstraintDescriptors: import("./clearance-field.js").ClearanceConstraintDescriptor[] =
      [];
    const explicitValues: number[] = [];
    const hardValues: number[] = [];
    const softValues: number[] = [];
    const validationDiagnostics: Diagnostic[] = [];
    for (const c of intent.constraints) {
      if (c.kind !== "track-clearance") continue;
      const v = (c.target ?? c.value) as unknown;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        validationDiagnostics.push({
          code: "TRACK_CLEARANCE",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `track-clearance ${c.id} has invalid threshold ${String(v)}`,
          relatedIds: [c.id],
        });
        if (c.hard !== false) failedHardRequirementIds.add(c.id);
        continue;
      }
      explicitValues.push(v as number);
      const isHard = c.hard !== false;
      if (isHard) hardValues.push(v as number);
      else softValues.push(v as number);
      explicitConstraintDescriptors.push({
        id: c.id,
        hard: isHard,
        threshold: v as number,
      });
    }
    if (validationDiagnostics.length > 0) {
      diagnostics.push(...validationDiagnostics);
    }
    if (track && validationDiagnostics.length === 0) {
      const displayCap = Math.max(10, 0.5, ...explicitValues);
      const closed = isClosedChain(elements);
      const segmentIds = canonicalSpansForCandidate.map((s) => s.id);
      try {
        observer?.("clearance:start");
        const field = computeClearanceField(track, {
          environment: options.environment,
          closed,
          hardClearanceM: 0.5,
          explicitThresholds: hardValues,
          softThresholds: softValues,
          displayCapM: displayCap,
          segmentIds,
        });
        observer?.("clearance:end");
        clearanceField = field;
        const projected = projectClearanceDiagnostics(
          field,
          explicitConstraintDescriptors,
        );
        diagnostics.push(...field.diagnostics, ...projected);
        for (const desc of explicitConstraintDescriptors) {
          if (!desc.hard) continue;
          const hasFailure = projected.some(
            (d) =>
              d.relatedIds?.includes(desc.id) &&
              (d.severity === "error" || d.severity === "fatal"),
          );
          if (hasFailure) failedHardRequirementIds.add(desc.id);
        }
      } catch (e) {
        observer?.("clearance:end");
        const msg = e instanceof Error ? e.message : String(e);
        diagnostics.push({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: msg,
          relatedIds: [],
        });
        failedHardRequirementIds.add("clearance-compute");
      }
    } else if (!track) {
      // trackCompileFailed fail-closed: no valid track exists to certify
    }
  }
  const evaluation = {
    elements,
    elementSpans,
    spans,
    solved,
    diagnostics: sanitizeDiagnostics(diagnostics),
    failedHardRequirementIds,
    ...(track ? { track } : {}),
    ...(clearanceField ? { clearanceField } : {}),
  };
  observer?.("validation:end");
  return evaluation;
};

const buildFileResult = (
  evaluation: CandidateEvaluation,
  intent: DesignIntentV1,
  options: GenerationOptions,
  candidatesTested: number,
  candidateLmIterations: readonly number[],
  relaxationLmIterations: readonly number[],
  relaxationEvidence: readonly RelaxationEvidence[],
  operationCache: GenerationOperationCache,
  observer?: GenerationBenchmarkObserver,
): GenerationResult => {
  observer?.("compilation:start");
  const elementById = new Map(
    evaluation.elements.map((element) => [element.id, element]),
  );
  const serializedSpans = evaluation.spans.map((span) => {
    const owner = ownerForSpan(span.id, elementById);
    const element = owner === undefined ? undefined : elementById.get(owner);
    if (!element) throw new Error(`Missing semantic owner for span ${span.id}`);
    const lengthKey = spanBytes(span);
    let length = operationCache.spanLengthCache.get(lengthKey);
    if (length === undefined) {
      length = arcLength(span.span);
      operationCache.spanLengthCache.set(lengthKey, length);
    }
    return serializeSolvedSpanV1(span, element.type, length);
  });
  const canonicalSpans = serializedSpans.map(reconstructSolvedSpan);
  let canonicalTrack: ReturnType<typeof compileTrack>;
  try {
    canonicalTrack = compileTrack(
      canonicalSpans,
      CANONICAL_TRACK_COMPILE_OPTIONS,
    );
  } catch (error) {
    if (error instanceof TrackCompileError) throw error;
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      error instanceof Error ? error.message : String(error),
      { stage: "compilation" },
    );
  }
  const isRequirementIntent = isRequirementStyleDirectedIntent(intent);
  const effectiveIntent: DesignIntentV1 =
    isRequirementIntent || intent.mode !== "directed"
      ? {
          ...intent,
          elements: evaluation.elements.map((element) => ({
            id: element.id,
            kind: element.type,
            type: element.type,
            parameters: element.parameters,
          })),
        }
      : intent;
  const ownedIntent = canonicalIntentCopy(effectiveIntent);
  const resultElements = ownedElements(evaluation.elements);
  const file = createCoasterFileV1({
    name: options.name ?? "OpenVibeCoaster",
    intent: ownedIntent,
    solvedSpans: serializedSpans,
    seed: intent.seed,
    generatorVersion: options.generatorVersion ?? intent.generatorVersion,
    profileVersion: options.profileVersion ?? DEFAULT_PROFILE_VERSION,
    researchSnapshotIds: [
      ...(options.researchSnapshotIds ?? DEFAULT_RESEARCH_SNAPSHOT_IDS),
    ],
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
      (span) => ownerForSpan(span.id, elementById) === element.id,
    );
    if (first) {
      bytes[element.id] = spanBytes(first);
      hashes[element.id] = hashSpan(first);
    }
  }
  let track: ReturnType<typeof compileTrack>;
  let compileDiagnostics: readonly Diagnostic[] = evaluation.diagnostics;
  let trackCompileFailed = false;
  const reuseTrack = evaluation.track as
    ReturnType<typeof compileTrack> | undefined;
  const reuseField = evaluation.clearanceField as
    import("./clearance-field.js").ClearanceField | undefined;
  const canReuseTrack =
    reuseTrack !== undefined &&
    reuseField !== undefined &&
    reuseField.track.checksum === reuseTrack.checksum &&
    (options.samples === undefined
      ? reuseTrack.checksum === canonicalTrack.checksum
      : reuseTrack.checksum !== canonicalTrack.checksum);
  // Reuse already-selected authoritative track if available; compile canonical once for checksum when needed
  if (canReuseTrack) {
    track = reuseTrack;
  } else {
    try {
      track =
        options.samples === undefined
          ? canonicalTrack
          : compileTrack(canonicalSpans, { samples: options.samples });
    } catch (error) {
      const diagnostic = toCompileFatalDiagnostic(error);
      compileDiagnostics = Object.freeze([
        ...evaluation.diagnostics,
        diagnostic,
      ]);
      trackCompileFailed = true;
      track = canonicalTrack;
    }
  }
  observer?.("compilation:end");
  // Exactly one clearance field per final generation (owned runtime result)
  let clearanceField: import("./clearance-field.js").ClearanceField | undefined;
  let fieldDiagnostics: readonly Diagnostic[] = [];
  const explicitConstraintDescriptors: import("./clearance-field.js").ClearanceConstraintDescriptor[] =
    [];
  const explicitValues: number[] = [];
  const hardValues: number[] = [];
  const softValues: number[] = [];
  const validationDiagnostics: Diagnostic[] = [];
  for (const c of intent.constraints) {
    if (c.kind !== "track-clearance") continue;
    const v = (c.target ?? c.value) as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      validationDiagnostics.push({
        code: "TRACK_CLEARANCE",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `track-clearance ${c.id} has invalid threshold ${String(v)}`,
        relatedIds: [c.id],
      });
      continue;
    }
    explicitValues.push(v);
    const isHard = c.hard !== false;
    if (isHard) hardValues.push(v as number);
    else softValues.push(v as number);
    explicitConstraintDescriptors.push({
      id: c.id,
      hard: isHard,
      threshold: v as number,
    });
  }
  const displayCap = Math.max(10, 0.5, ...explicitValues);
  // Build real span ids for honest diagnostics (stable, not surrogate element-N)
  const segmentIds = canonicalSpans.map((s) => s.id);
  const hasFatalNoField =
    trackCompileFailed ||
    validationDiagnostics.some((d) => d.severity === "fatal");
  if (!hasFatalNoField) {
    const canReuseField =
      reuseField !== undefined &&
      reuseTrack !== undefined &&
      reuseTrack.checksum === track.checksum &&
      reuseField.track.checksum === reuseTrack.checksum;
    if (canReuseField) {
      clearanceField = reuseField;
      fieldDiagnostics = Object.freeze([...validationDiagnostics]);
    } else {
      observer?.("clearance:start");
      try {
        clearanceField = computeClearanceField(track, {
          environment: options.environment,
          closed: isClosedChain(evaluation.elements),
          hardClearanceM: 0.5,
          explicitThresholds: hardValues,
          softThresholds: softValues,
          displayCapM: displayCap,
          segmentIds,
        });
      } catch (e) {
        observer?.("clearance:end");
        throw e;
      }
      observer?.("clearance:end");
      const projected = projectClearanceDiagnostics(
        clearanceField,
        explicitConstraintDescriptors,
      );
      fieldDiagnostics = Object.freeze([
        ...clearanceField.diagnostics,
        ...projected,
        ...validationDiagnostics,
      ]);
    }
  } else {
    // Keep already-owned failed field whenever compilation succeeded, with exact evidence
    if (reuseField !== undefined && !trackCompileFailed) {
      clearanceField = reuseField;
      fieldDiagnostics = Object.freeze([...validationDiagnostics]);
    } else {
      fieldDiagnostics = Object.freeze([...validationDiagnostics]);
      clearanceField = undefined;
    }
  }
  const mergedDiagnostics = Object.freeze([
    ...compileDiagnostics,
    ...fieldDiagnostics,
  ]);
  const result: GenerationResult = {
    feasible: !mergedDiagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
    intent: ownedIntent,
    elements: resultElements,
    solvedSpans: Object.freeze(canonicalSpans),
    track,
    file,
    serializedFile,
    diagnostics: mergedDiagnostics,
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
    options: ownedGenerationOptions(options),
    ...(clearanceField ? { clearanceField } : {}),
  } as GenerationResult;
  return deepFreeze(result);
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

const generateCoasterInternal = (
  intent: DesignIntentV1,
  options: GenerationOptions = {},
  observer?: GenerationBenchmarkObserver,
): GenerationResult => {
  observer?.("total:start");
  observer?.("search:start");
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
      observer,
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
  let relaxationReruns = 0;
  for (const target of intent.targets) {
    if (
      relaxationReruns >= 3 ||
      target.hard === false ||
      !evaluation.failedHardRequirementIds.has(target.id)
    )
      continue;
    const relaxedIntent = {
      ...intent,
      targets: intent.targets.filter((item) => item.id !== target.id),
    };
    relaxationReruns += 1;
    const rerun = evaluateCandidate(
      evaluation.elements,
      relaxedIntent,
      options,
      targetOptions(relaxedIntent),
      observer,
    );
    relaxationLmIterations.push(rerun.solved.lmIterations);
    const actual =
      target.kind === "total-length"
        ? (rerun.track?.totalLength ??
          compileTrack(rerun.spans, CANONICAL_TRACK_COMPILE_OPTIONS)
            .totalLength)
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
      margins: finiteMargins({ [target.kind]: limit - actual }),
    });
  }
  for (const constraint of intent.constraints) {
    if (
      relaxationReruns >= 3 ||
      constraint.hard === false ||
      !evaluation.failedHardRequirementIds.has(constraint.id)
    )
      continue;
    const relaxedIntent = {
      ...intent,
      constraints: intent.constraints.filter(
        (item) => item.id !== constraint.id,
      ),
    };
    relaxationReruns += 1;
    const rerun = evaluateCandidate(
      evaluation.elements,
      relaxedIntent,
      options,
      targetOptions(relaxedIntent),
      observer,
    );
    relaxationLmIterations.push(rerun.solved.lmIterations);
    evidence.push({
      change: `Relax hard constraint ${constraint.id}`,
      rerun: true,
      feasible: !rerun.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" || diagnostic.severity === "fatal",
      ),
      lmIterations: rerun.solved.lmIterations,
      margins: finiteMargins(relaxationMargins(constraint, rerun)),
    });
  }
  observer?.("search:end");
  const result = buildFileResult(
    evaluation,
    intent,
    options,
    candidatesTested,
    candidateLmIterations,
    relaxationLmIterations,
    evidence,
    operationCache,
    observer,
  );
  observer?.("total:end");
  return result;
};

export const generateCoaster = (
  intent: DesignIntentV1,
  options: GenerationOptions = {},
): GenerationResult => generateCoasterInternal(intent, options);

export const generateCoasterForBenchmark = (
  intent: DesignIntentV1,
  options: GenerationOptions,
  observer: GenerationBenchmarkObserver,
): GenerationResult => generateCoasterInternal(intent, options, observer);

const generationWithSpans = (
  candidate: GenerationResult,
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  diagnostics: readonly Diagnostic[] = candidate.diagnostics,
  environment?: EnvironmentQuery,
): GenerationResult => {
  const elementById = new Map(
    candidate.elements.map((element) => [element.id, element]),
  );
  const serializedSpans = spans.map((span) => {
    const owner = ownerForSpan(span.id, elementById);
    const element = owner === undefined ? undefined : elementById.get(owner);
    if (!element) throw new Error(`Missing semantic owner for span ${span.id}`);
    const length = arcLength(span.span);
    return serializeSolvedSpanV1(span, element.type, length);
  });
  const canonicalSpans = serializedSpans.map(reconstructSolvedSpan);
  let canonicalTrack: ReturnType<typeof compileTrack>;
  try {
    canonicalTrack = compileTrack(
      canonicalSpans,
      CANONICAL_TRACK_COMPILE_OPTIONS,
    );
  } catch (error) {
    throw new CoasterFileError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const ownedIntent = canonicalIntentCopy(intent);
  const resultElements = ownedElements(candidate.elements);
  const file = createCoasterFileV1({
    name: candidate.file.name,
    intent: ownedIntent,
    solvedSpans: serializedSpans,
    seed: ownedIntent.seed,
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
      (span) => ownerForSpan(span.id, elementById) === element.id,
    );
    if (first) {
      spanBytesMap[element.id] = spanBytes(first);
      spanHashesMap[element.id] = hashSpan(first);
    }
  }
  const track =
    candidate.options.samples === undefined
      ? canonicalTrack
      : compileTrack(canonicalSpans, { samples: candidate.options.samples });
  // recompute clearance field once for new track (owned runtime result)
  const explicitConstraintDescriptors: import("./clearance-field.js").ClearanceConstraintDescriptor[] =
    [];
  const explicitValues: number[] = [];
  const hardValues2: number[] = [];
  const softValues2: number[] = [];
  const validationDiagnostics: Diagnostic[] = [];
  for (const c of intent.constraints) {
    if (c.kind !== "track-clearance") continue;
    const v = (c.target ?? c.value) as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      validationDiagnostics.push({
        code: "TRACK_CLEARANCE",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `track-clearance ${c.id} has invalid threshold ${String(v)}`,
        relatedIds: [c.id],
      });
      continue;
    }
    explicitValues.push(v as number);
    const isHard = c.hard !== false;
    if (isHard) hardValues2.push(v as number);
    else softValues2.push(v as number);
    explicitConstraintDescriptors.push({
      id: c.id,
      hard: isHard,
      threshold: v as number,
    });
  }
  const displayCap = Math.max(10, 0.5, ...explicitValues);
  const segmentIdsForField = canonicalSpans.map((s) => s.id);
  const hasHardEarlier =
    diagnostics.some((d) => d.severity === "error" || d.severity === "fatal") ||
    validationDiagnostics.some((d) => d.severity === "fatal");
  let clearanceField: import("./clearance-field.js").ClearanceField | undefined;
  let fieldDiagnostics: readonly import("@openvibecoaster/core").Diagnostic[] =
    Object.freeze([...validationDiagnostics]);
  if (!hasHardEarlier) {
    clearanceField = computeClearanceField(track, {
      environment,
      closed: isClosedChain(resultElements),
      hardClearanceM: 0.5,
      explicitThresholds: hardValues2,
      softThresholds: softValues2,
      displayCapM: displayCap,
      segmentIds: segmentIdsForField,
    });
    const projected = projectClearanceDiagnostics(
      clearanceField,
      explicitConstraintDescriptors,
    );
    fieldDiagnostics = Object.freeze([
      ...clearanceField.diagnostics,
      ...projected,
      ...validationDiagnostics,
    ]);
  }
  const mergedDiagnostics = Object.freeze([
    ...diagnostics,
    ...fieldDiagnostics,
  ]);
  const result: GenerationResult = {
    ...candidate,
    intent: ownedIntent,
    elements: resultElements,
    solvedSpans: Object.freeze(canonicalSpans),
    track,
    file,
    serializedFile,
    spanBytes: spanBytesMap,
    spanHashes: spanHashesMap,
    diagnostics: mergedDiagnostics,
    options: ownedGenerationOptions(candidate.options),
    ...(clearanceField ? { clearanceField } : {}),
    feasible: !mergedDiagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
  } as GenerationResult;
  return deepFreeze(result);
};

const generationOwner = (
  generated: GenerationResult,
  spanId: string,
): string | undefined =>
  ownerForSpan(
    spanId,
    new Map(generated.elements.map((element) => [element.id, element])),
  );
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
    ? generated.solvedSpans.filter(
        (span) => generationOwner(generated, span.id) === owner,
      )
    : [];
  const firstSpans = first
    ? generated.solvedSpans.filter(
        (span) => generationOwner(generated, span.id) === first,
      )
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

type SeamMetricDef = {
  readonly name: string;
  readonly key: keyof import("./types").ResidualSet;
  readonly limitKey: keyof import("./types").SeamTolerances;
};

const SEAM_METRIC_TABLE: readonly SeamMetricDef[] = [
  { name: "POSITION", key: "positionM", limitKey: "positionM" },
  { name: "TANGENT", key: "tangentRad", limitKey: "tangentRad" },
  { name: "CURVATURE", key: "curvaturePerM", limitKey: "curvaturePerM" },
  {
    name: "CURVATURE_VECTOR",
    key: "curvatureVectorJumpPerM",
    limitKey: "curvatureVectorJumpPerM",
  },
  {
    name: "CURVATURE_GRADIENT",
    key: "curvatureGradientPerM2",
    limitKey: "curvatureGradientPerM2",
  },
  { name: "BANK", key: "bankRad", limitKey: "bankRad" },
  {
    name: "BANK_DERIVATIVE",
    key: "bankDerivativeRadPerM",
    limitKey: "bankDerivativeRadPerM",
  },
  {
    name: "BANK_SECOND_DERIVATIVE",
    key: "bankSecondDerivativeRadPerM2",
    limitKey: "bankSecondDerivativeRadPerM2",
  },
  {
    name: "SPECIFIC_FORCE_JUMP",
    key: "specificForceJumpG",
    limitKey: "specificForceJumpG",
  },
  {
    name: "SUSTAINED_FORCE_DEVIATION",
    key: "sustainedForceDeviationG",
    limitKey: "sustainedForceDeviationG",
  },
] as const;

const REQUIRED_SEAM_KEYS = [
  "positionM",
  "tangentRad",
  "curvaturePerM",
  "curvatureVectorJumpPerM",
  "curvatureGradientPerM2",
  "bankRad",
  "bankDerivativeRadPerM",
  "bankSecondDerivativeRadPerM2",
  "specificForceJumpG",
  "sustainedForceDeviationG",
] as const;

const validateSeamsForLocal = (
  seams: unknown,
):
  | { ok: true; value: import("./types").SeamTolerances }
  | { ok: false; diagnostic: Diagnostic } => {
  if (typeof seams !== "object" || seams === null || Array.isArray(seams)) {
    return {
      ok: false,
      diagnostic: {
        code: "SEAM_LIMITS_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: "seams: expected object with exact 10 seam fields",
        relatedIds: [],
      },
    };
  }
  const obj = seams as Record<string, unknown>;
  if (Object.keys(obj).length !== REQUIRED_SEAM_KEYS.length) {
    return {
      ok: false,
      diagnostic: {
        code: "SEAM_LIMITS_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `seams: expected exact ${REQUIRED_SEAM_KEYS.length} fields, got ${Object.keys(obj).length}`,
        relatedIds: [],
      },
    };
  }
  for (const k of REQUIRED_SEAM_KEYS) {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        ok: false,
        diagnostic: {
          code: "SEAM_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `seams.${k}: expected non-negative finite number`,
          relatedIds: [],
        },
      };
    }
  }
  for (const k of Object.keys(obj)) {
    if (!(REQUIRED_SEAM_KEYS as readonly string[]).includes(k)) {
      return {
        ok: false,
        diagnostic: {
          code: "SEAM_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `seams.${k}: unexpected field`,
          relatedIds: [],
        },
      };
    }
  }
  return {
    ok: true,
    value: obj as unknown as import("./types").SeamTolerances,
  };
};

const expectedGForSample = (
  element: AnySemanticElement | undefined,
  t: number,
): number | undefined => {
  if (!element) return undefined;
  if (t < 0.25 || t > 0.75) return undefined;
  if (element.type === "airtimeHill") {
    const p =
      element.parameters as import("./types").ElementParameterMap["airtimeHill"];
    return 1 + (p.targetForceG - 1) * sustainedForceProfile(t);
  }
  if (element.type === "zeroGRoll") {
    return 1 - sustainedForceProfile(t);
  }
  return undefined;
};

const deriveSustainedTarget = (
  element: AnySemanticElement | undefined,
  chainReferenceSpeed: number,
):
  | { expectedForT: (t: number) => number | undefined; referenceSpeed: number }
  | undefined => {
  if (!element) return undefined;
  if (element.type === "airtimeHill") {
    const p =
      element.parameters as import("./types").ElementParameterMap["airtimeHill"];
    return {
      expectedForT: (t: number) => expectedGForSample(element, t),
      referenceSpeed: p.referenceSpeed,
    };
  }
  if (element.type === "zeroGRoll") {
    return {
      expectedForT: (t: number) => expectedGForSample(element, t),
      referenceSpeed: chainReferenceSpeed,
    };
  }
  return undefined;
};

const lutCache = new WeakMap<
  ParametricSpan<Vec3>,
  ReturnType<typeof buildArcLengthLut>
>();
const locateSpanAtS = (
  spans: readonly SolvedSpan[],
  cumulative: readonly number[],
  targetS: number,
): { span: SolvedSpan; u: number; index: number } => {
  for (let i = 0; i < spans.length; i += 1) {
    const start = i === 0 ? 0 : cumulative[i - 1]!;
    const end = cumulative[i]!;
    if (targetS >= start - 1e-9 && targetS <= end + 1e-9) {
      const span = spans[i]!;
      const localS = Math.max(0, Math.min(end - start, targetS - start));
      const totalLen = end - start;
      if (totalLen <= 1e-12) return { span, u: 0, index: i };
      let lut = lutCache.get(span.span);
      if (!lut) {
        lut = buildArcLengthLut(span.span);
        lutCache.set(span.span, lut);
      }
      const u = invertArcLength(span.span, lut, localS);
      return { span, u: Math.max(0, Math.min(1, u)), index: i };
    }
  }
  const last = spans[spans.length - 1]!;
  return { span: last, u: 1, index: spans.length - 1 };
};

const elementGlobalT = (
  sampleS: number,
  owningElementId: string,
  spans: readonly SolvedSpan[],
  cumulative: readonly number[],
  elementById: ReadonlyMap<string, AnySemanticElement>,
): number => {
  const ownedIndices: number[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    if (ownerForSpan(spans[i]!.id, elementById) === owningElementId)
      ownedIndices.push(i);
  }
  if (ownedIndices.length === 0) return 0;
  const firstIdx = ownedIndices[0]!;
  const lastIdx = ownedIndices[ownedIndices.length - 1]!;
  const elementStartS = firstIdx === 0 ? 0 : cumulative[firstIdx - 1]!;
  const elementEndS = cumulative[lastIdx]!;
  const elementLen = elementEndS - elementStartS;
  if (elementLen <= 1e-12) return 0;
  return Math.max(0, Math.min(1, (sampleS - elementStartS) / elementLen));
};

const evaluateSustainedForSeam = (
  spans: readonly SolvedSpan[],
  cumulative: readonly number[],
  totalLength: number,
  seamS: number,
  leftOwner: string | undefined,
  rightOwner: string | undefined,
  elementById: ReadonlyMap<string, AnySemanticElement>,
  closed: boolean,
  chainReferenceSpeed: number,
): { actual: number; location: { s: number; position: Vec3 } } | undefined => {
  const leftElement = leftOwner ? elementById.get(leftOwner) : undefined;
  const rightElement = rightOwner ? elementById.get(rightOwner) : undefined;
  const leftDerived = deriveSustainedTarget(leftElement, chainReferenceSpeed);
  const rightDerived = deriveSustainedTarget(rightElement, chainReferenceSpeed);
  if (!leftDerived && !rightDerived) return undefined;
  let worstActual = -Infinity;
  let worstLocation: { s: number; position: Vec3 } | undefined;
  const considerForT = (
    canonicalS: number,
    derived: {
      expectedForT: (t: number) => number | undefined;
      referenceSpeed: number;
    },
    owner: string,
  ): void => {
    const located = locateSpanAtS(spans, cumulative, canonicalS);
    const t = elementGlobalT(canonicalS, owner, spans, cumulative, elementById);
    const expected = derived.expectedForT(t);
    if (expected === undefined) return;
    const actualForce = solver.specificForceNormalG(
      located.span,
      located.u,
      derived.referenceSpeed,
    );
    const dev = Math.abs(actualForce - expected);
    if (dev > worstActual) {
      worstActual = dev;
      worstLocation = {
        s: canonicalS,
        position: located.span.span.position(located.u),
      };
    }
  };
  const steps = 10;
  if (leftDerived) {
    if (closed) {
      for (let i = 0; i <= steps; i += 1) {
        const offset = (5 * i) / steps;
        const raw = seamS - offset;
        const canonical = ((raw % totalLength) + totalLength) % totalLength;
        considerForT(canonical, leftDerived, leftOwner!);
      }
    } else {
      const startS = Math.max(0, seamS - 5);
      for (let i = 0; i <= steps; i += 1) {
        const s = startS + ((seamS - startS) * i) / steps;
        considerForT(s, leftDerived, leftOwner!);
      }
    }
  }
  if (rightDerived) {
    if (closed) {
      for (let i = 0; i <= steps; i += 1) {
        const offset = (5 * i) / steps;
        const raw = seamS + offset;
        const canonical = raw % totalLength;
        considerForT(canonical, rightDerived, rightOwner!);
      }
    } else {
      const endS = Math.min(totalLength, seamS + 5);
      for (let i = 1; i <= steps; i += 1) {
        const s = seamS + ((endS - seamS) * i) / steps;
        considerForT(s, rightDerived, rightOwner!);
      }
      // also include seam itself for right side if left not already (to avoid duplicate at seam)
      if (!leftDerived) {
        considerForT(seamS, rightDerived, rightOwner!);
      }
    }
  }
  if (worstLocation === undefined) return undefined;
  return { actual: worstActual, location: worstLocation };
};

export const localSeamDiagnostics = (
  spans: readonly SolvedSpan[],
  elements: readonly AnySemanticElement[],
  closed: boolean,
  seams: unknown,
  chainReferenceSpeed: number,
): readonly Diagnostic[] => {
  const validated = validateSeamsForLocal(seams);
  if (!validated.ok) {
    return [sanitizeDiagnostic({ ...validated.diagnostic, relatedIds: [] })];
  }
  const tolerances = validated.value;
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const cumulative: number[] = [];
  let acc = 0;
  for (const span of spans) {
    acc += arcLength(span.span);
    cumulative.push(acc);
  }
  const totalLength = acc;
  const spanIndexById = new Map(spans.map((s, i) => [s.id, i] as const));
  const diagnostics: Diagnostic[] = [];
  for (const seam of solver.diagnoseSeams(spans, {
    closed,
    referenceSpeed: chainReferenceSpeed,
  })) {
    const [leftId, rightId] = seam.seamId.split("->");
    const leftOwner = ownerForSpan(leftId!, elementById);
    const rightOwner = ownerForSpan(rightId!, elementById);
    if (leftOwner !== undefined && leftOwner === rightOwner) continue;
    const relatedIds: readonly string[] = [
      leftOwner ?? leftId!,
      rightOwner ?? rightId!,
    ];
    const leftIndex = spanIndexById.get(leftId!) ?? -1;
    const seamS = leftIndex >= 0 ? cumulative[leftIndex]! : 0;
    for (const metric of SEAM_METRIC_TABLE) {
      if (metric.name === "SUSTAINED_FORCE_DEVIATION") continue;
      const actual = seam[metric.key] as number;
      const limit = tolerances[metric.limitKey] as number;
      if (actual > limit) {
        diagnostics.push(
          hardDiagnostic(
            `LOCAL_REGENERATION_SEAM_${metric.name}`,
            `Merged seam ${seam.seamId} ${metric.name.toLowerCase()} ${actual.toExponential(3)} exceeds ${limit.toExponential(3)}`,
            relatedIds,
            actual,
            limit,
            { s: seamS, position: spans[leftIndex]!.span.position(1) },
          ),
        );
      }
    }
    const evaluated = evaluateSustainedForSeam(
      spans,
      cumulative,
      totalLength,
      seamS,
      leftOwner,
      rightOwner,
      elementById,
      closed,
      chainReferenceSpeed,
    );
    if (evaluated) {
      const limit = tolerances.sustainedForceDeviationG as number;
      if (evaluated.actual > limit) {
        diagnostics.push(
          hardDiagnostic(
            `LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION`,
            `Merged seam ${seam.seamId} sustained-force deviation ${evaluated.actual.toExponential(3)} exceeds ${limit.toExponential(3)}`,
            relatedIds,
            evaluated.actual,
            limit,
            evaluated.location,
          ),
        );
      }
    }
  }
  diagnostics.sort((a, b) => {
    const order = (code: string): number => {
      const suffix = code.replace("LOCAL_REGENERATION_SEAM_", "");
      const idx = SEAM_METRIC_TABLE.findIndex((m) => m.name === suffix);
      return idx < 0 ? 999 : idx;
    };
    const oa = order(a.code);
    const ob = order(b.code);
    if (oa !== ob) return oa - ob;
    if (a.relatedIds?.[0] !== b.relatedIds?.[0])
      return (a.relatedIds?.[0] ?? "").localeCompare(b.relatedIds?.[0] ?? "");
    return a.code.localeCompare(b.code);
  });
  return sanitizeDiagnostics(diagnostics);
};

const mergedDiagnostics = (
  elements: readonly AnySemanticElement[],
  spans: readonly SolvedSpan[],
  intent: DesignIntentV1,
  options: StoredGenerationOptions,
  environment: EnvironmentQuery | undefined,
  localDiagnostics: readonly Diagnostic[],
  seams: unknown,
  chainReferenceSpeed: number,
): readonly Diagnostic[] => {
  const diagnostics = [
    ...localDiagnostics,
    ...localSeamDiagnostics(
      spans,
      elements,
      isClosedChain(elements),
      seams,
      chainReferenceSpeed,
    ),
    ...gateDiagnostics(spans, intent),
    ...validateGenerationConstraints(elements, spans, intent, environment),
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
        diagnostics.push({
          ...hardDiagnostic(
            "TARGET",
            `Target ${target.id} total-length residual is ${error.toExponential(3)}`,
            [target.id],
            error,
            1e-4,
            { s: actual, position: endPose.position },
          ),
          severity: target.hard === false ? "warning" : "error",
          provenance:
            target.hard === false
              ? "DESIGN_ASSUMPTION"
              : "PROJECT_ENGINEERING_LIMIT",
        });
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
      diagnostics.push({
        ...hardDiagnostic(
          "TARGET",
          `Target ${target.id} ${target.kind} residual is ${error.toExponential(3)}`,
          [target.id],
          error,
          limit,
          { s: endS, position: endPose.position },
        ),
        severity: target.hard === false ? "warning" : "error",
        provenance:
          target.hard === false
            ? "DESIGN_ASSUMPTION"
            : "PROJECT_ENGINEERING_LIMIT",
      });
  }
  const hasHardFailure = diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "fatal",
  );
  // Skip cheap clearance when hard failure already present; final field is authoritative.
  if (!hasHardFailure) {
    const clearance = validateClearance(spans, environment, {
      trainEnvelopeRadius: 0,
      trackClearance: 0,
      closed: isClosedChain(elements),
    });
    diagnostics.push(...clearance);
  }
  return sanitizeDiagnostics(diagnostics);
};

export const regenerateLocal = (
  generated: GenerationResult,
  selectedElementId: string,
  options: LocalRegenerationOptions = {},
): LocalRegenerationResult => {
  const seams = options.seams;
  const chainReferenceSpeed = options.referenceSpeed ?? 44;
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
  validateDesignIntentV1(baseIntent);
  const topologyFailureIds = new Set<string>();
  const topologyLength = Math.max(
    generated.elements.length,
    baseIntent.elements.length,
  );
  for (let index = 0; index < topologyLength; index += 1) {
    const source = generated.elements[index];
    const replacement = baseIntent.elements[index];
    const replacementKind = replacement?.kind ?? replacement?.type;
    if (
      source === undefined ||
      replacement === undefined ||
      source.id !== replacement.id ||
      source.type !== replacementKind
    ) {
      if (source) topologyFailureIds.add(source.id);
      if (replacement) topologyFailureIds.add(replacement.id);
    }
  }
  if (topologyFailureIds.size > 0) {
    const ids = [...topologyFailureIds];
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Replacement intent topology must preserve source element order, IDs, and kinds: ${ids.join(", ")}`,
      ids,
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
  const sourceElements: AnySemanticElement[] = baseIntent.elements.map(
    (element) => {
      const kind = (element.kind ??
        element.type) as (typeof ELEMENT_KINDS)[number];
      return createElement(
        kind,
        element.id,
        element.parameters ?? {},
      ) as AnySemanticElement;
    },
  );
  const patchIds = Object.keys(options.changes ?? {});
  const patchIndices = patchIds.map((id) => ({
    id,
    index: generated.elements.findIndex((element) => element.id === id),
    replacementIndex: sourceElements.findIndex((element) => element.id === id),
  }));
  const unknownPatchIds = patchIndices
    .filter(({ index, replacementIndex }) => index < 0 || replacementIndex < 0)
    .map(({ id }) => id);
  if (unknownPatchIds.length > 0) {
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Unknown local regeneration patch owners: ${unknownPatchIds.join(", ")}`,
      unknownPatchIds,
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
  const parameterChangedOwnerIds = new Set<string>();
  for (const [index, element] of changedElements.entries())
    if (
      canonicalJson(element.parameters) !==
      canonicalJson(generated.elements[index]!.parameters)
    )
      parameterChangedOwnerIds.add(element.id);
  const regeneratedOwnerIds = new Set([
    ...patchIds,
    ...parameterChangedOwnerIds,
  ]);
  const changedIntent: DesignIntentV1 = {
    ...baseIntent,
    elements: changedElements.map((element) => ({
      id: element.id,
      kind: element.type,
      type: element.type,
      parameters: element.parameters,
    })),
  };
  for (const id of pinned)
    if (parameterChangedOwnerIds.has(id)) {
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
  const changedOwnerIndices = [...regeneratedOwnerIds].map((id) => ({
    id,
    index: generated.elements.findIndex((element) => element.id === id),
  }));
  const blockedChangeIds = changedOwnerIndices
    .filter(({ index }) => index < minimumStart || index > maximumEnd)
    .map(({ id }) => id);
  if (blockedChangeIds.length > 0) {
    const item = hardDiagnostic(
      "LOCAL_REGENERATION",
      `Pinned boundary blocks local regeneration changes: ${blockedChangeIds.join(", ")}`,
      blockedChangeIds,
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
  const includedChangeIndices = changedOwnerIndices.map(({ index }) => index);
  const initialWindow: readonly [number, number] = [
    Math.min(
      Math.max(minimumStart, selectedIndex - 1),
      ...includedChangeIndices,
    ),
    Math.max(Math.min(maximumEnd, selectedIndex + 1), ...includedChangeIndices),
  ];
  const queue: Array<readonly [number, number]> = [initialWindow];
  const visited = new Set<string>();
  const requestedOwnerIds = new Set([
    selectedElementId,
    ...regeneratedOwnerIds,
  ]);
  let lastDiagnostics: readonly Diagnostic[] = [];
  let lastAttemptedGeneration: GenerationResult | undefined;
  while (queue.length > 0) {
    const [localStart, localEnd] = queue.shift()!;
    const key = `${localStart}:${localEnd}`;
    if (visited.has(key)) continue;
    visited.add(key);
    let failureIds: readonly string[] = [selectedElementId];
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
          referenceSpeed: chainReferenceSpeed,
          maxIterations: 32,
        },
      );
      const localSpans = localSolved.solvedSpans.flatMap(coefficientSpan);
      const oldByOwner = new Map<string, SolvedSpan[]>();
      for (const span of generated.solvedSpans) {
        const owner = generationOwner(generated, span.id);
        if (owner === undefined)
          throw new Error(`Missing semantic owner for span ${span.id}`);
        const group = oldByOwner.get(owner) ?? [];
        group.push(span);
        oldByOwner.set(owner, group);
      }
      const localByOwner = new Map<string, SolvedSpan[]>();
      const changedElementById = new Map(
        changedElements.map((element) => [element.id, element] as const),
      );
      for (const span of localSpans) {
        const owner = ownerForSpan(span.id, changedElementById);
        if (owner === undefined)
          throw new Error(`Missing semantic owner for local span ${span.id}`);
        const group = localByOwner.get(owner) ?? [];
        group.push(span);
        localByOwner.set(owner, group);
      }
      const missingSourceOwnerIds = [...requestedOwnerIds].filter(
        (id) => !oldByOwner.has(id),
      );
      if (missingSourceOwnerIds.length > 0) {
        failureIds = missingSourceOwnerIds;
        throw new Error(
          `Source generation is missing requested owners: ${missingSourceOwnerIds.join(", ")}`,
        );
      }
      const missingRegeneratedOwnerIds = [...requestedOwnerIds].filter(
        (id) => !localByOwner.has(id),
      );
      if (missingRegeneratedOwnerIds.length > 0) {
        failureIds = missingRegeneratedOwnerIds;
        throw new Error(
          `Regenerated result is missing requested owners: ${missingRegeneratedOwnerIds.join(", ")}`,
        );
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
        options.environment,
        localSolved.diagnostics,
        seams,
        chainReferenceSpeed,
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
        options.environment,
      );
      lastAttemptedGeneration = localGeneration;
      if (!localGeneration.feasible) {
        lastDiagnostics = localGeneration.diagnostics;
      } else {
        const untouchedSpanHashes: Record<string, string> = {};
        const untouchedSpanBytes: Record<string, string> = {};
        let hashMismatchId: string | undefined;
        for (let index = 0; index < generated.elements.length; index += 1) {
          const id = generated.elements[index]!.id;
          if (index >= localStart && index <= localEnd) continue;
          const gHash = generated.spanHashes[id];
          const gBytes = generated.spanBytes[id];
          if (gHash === undefined || gBytes === undefined) {
            hashMismatchId = id;
            break;
          }
          untouchedSpanHashes[id] = gHash;
          untouchedSpanBytes[id] = gBytes;
          const oldSpans = oldByOwner.get(id) ?? [];
          const newSpans = localGeneration.solvedSpans.filter(
            (span) => generationOwner(localGeneration, span.id) === id,
          );
          if (
            oldSpans.length !== newSpans.length ||
            oldSpans.some((span, spanIndex) => {
              const ns = newSpans[spanIndex];
              return ns === undefined || spanBytes(span) !== spanBytes(ns);
            })
          ) {
            hashMismatchId = id;
            break;
          }
        }
        if (hashMismatchId) {
          lastDiagnostics = [
            hardDiagnostic(
              "LOCAL_REGENERATION",
              `Untouched solved span ${hashMismatchId} changed during local regeneration`,
              [hashMismatchId],
            ),
          ];
        } else {
          const hashesEqual = Object.entries(untouchedSpanHashes).every(
            ([id, hash]) => localGeneration.spanHashes[id] === hash,
          );
          const bytesEqual = Object.entries(untouchedSpanBytes).every(
            ([id, b]) => localGeneration.spanBytes[id] === b,
          );
          if (!hashesEqual || !bytesEqual) {
            lastDiagnostics = [
              hardDiagnostic(
                "LOCAL_REGENERATION",
                `Untouched span hashes/bytes mismatch during local regeneration`,
                Object.keys(untouchedSpanHashes),
              ),
            ];
          } else {
            return {
              feasible: true,
              generation: localGeneration,
              diagnostics: localGeneration.diagnostics,
              changedWindow: [localStart, localEnd],
              untouchedSpanHashes,
              untouchedSpanBytes,
            };
          }
        }
      }
    } catch (error) {
      lastDiagnostics = [
        {
          ...hardDiagnostic(
            "LOCAL_REGENERATION",
            error instanceof Error ? error.message : String(error),
            failureIds,
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
  const failedGeneration = lastAttemptedGeneration ?? generated;
  const failedDiagnostics =
    lastAttemptedGeneration !== undefined
      ? [...lastDiagnostics, { ...item, severity: "fatal" as const }]
      : [...lastDiagnostics, { ...item, severity: "fatal" as const }];
  return {
    feasible: false,
    generation: failedGeneration,
    diagnostics: failedDiagnostics,
    changedWindow: initialWindow,
    untouchedSpanHashes: generated.spanHashes,
    untouchedSpanBytes: generated.spanBytes,
  };
};

export function regenerateCoasterFileLocal(
  fileInput: CoasterFileV1 | string | Uint8Array,
  elementId: string,
  options: LocalRegenerationOptions = {},
): LocalRegenerationResult {
  // Validate/compile supplied file without global solve – canonical adaptive compilation
  const loaded = compileCoasterFile(
    fileInput as CoasterFileV1 | string | Uint8Array,
  );
  const file = loaded.file;
  const solvedSpans = loaded.solvedSpans;
  const track = loaded.track;
  const elements = file.intent.elements.map((e) => {
    const kind = (e.kind ?? e.type) as string;
    return createElement(
      kind as (typeof ELEMENT_KINDS)[number],
      e.id,
      (e.parameters ?? {}) as never,
    ) as AnySemanticElement;
  });
  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const bytes: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const span of solvedSpans) {
    bytes[span.id] = spanBytes(span);
    hashes[span.id] = hashSpan(span);
  }
  for (const el of elements) {
    const first = solvedSpans.find(
      (s) => ownerForSpan(s.id, elementById) === el.id,
    );
    if (first) {
      bytes[el.id] = spanBytes(first);
      hashes[el.id] = hashSpan(first);
    }
  }
  // Loaded file has no candidate-search history; represent honestly – stored generation options remain adaptive (no fixed samples)
  // Do not compute an adapter field that is immediately discarded – internal field remains absent until generationWithSpans computes final changed track
  const adapter = {
    feasible: true,
    intent: file.intent,
    elements: Object.freeze([...elements]),
    solvedSpans: Object.freeze([...solvedSpans]),
    track,
    file,
    serializedFile: serializeCoasterFileV1(file),
    diagnostics: Object.freeze([] as Diagnostic[]),
    relaxations: Object.freeze([] as string[]),
    candidatesTested: 0,
    lmIterations: 0,
    selectedLmIterations: 0,
    candidateLmIterations: Object.freeze([] as number[]),
    candidateLmWork: 0,
    relaxationLmIterations: Object.freeze([] as number[]),
    relaxationLmWork: 0,
    spanHashes: Object.freeze({ ...hashes }),
    spanBytes: Object.freeze({ ...bytes }),
    relaxationEvidence: Object.freeze([] as RelaxationEvidence[]),
    options: Object.freeze({} satisfies StoredGenerationOptions),
  } as GenerationResult;
  return regenerateLocal(adapter as GenerationResult, elementId, options);
}

export const generate = generateCoaster;
export const localRegenerate = regenerateLocal;
export { compileCoasterFile };
