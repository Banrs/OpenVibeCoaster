import {
  CANONICAL_TRACK_COMPILE_OPTIONS,
  CoasterFileError,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  TrackCompileError,
  Xoshiro128ss,
  arcLength,
  compileCoasterFile,
  createCoasterFileV1,
  canonicalJson,
  parseDesignIntentV1,
  serializeCoasterFileV1,
  serializeDesignIntentV1,
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
  type CoasterFileV1,
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
  certifyPolynomialThreshold,
} from "./polynomial-bounds";
import {
  buildElement,
  createAnyElement,
  createElement,
  defaultPose,
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
      bank: Math.PI * 0.6,
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
    createElement("zeroGRoll", "zeroGRoll-006", {
      length: 28,
      roll: Math.PI * 2,
    }),
    createElement("stall", "stall-007", { length: 100, height: 18 }),
    createElement("brake", "brake-008", { length: 220, targetSpeed: 8 }),
    createElement("brake", "magnetic-brakes-009", {
      length: 110,
      targetSpeed: 5,
    }),
    createElement("station", "station-010", { length: 160, closed: false }),
  ];
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
    return defaultElements(intent.seed, candidate);
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
  const footprint = intent.footprint;
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
      for (const axis of [0, 1, 2] as const) {
        const minLimit = footprint.min[axis]!;
        const maxLimit = footprint.max[axis]!;
        const needsMinCheck = certifiedBounds.min[axis]! < minLimit;
        const needsMaxCheck = certifiedBounds.max[axis]! > maxLimit;
        if (needsMinCheck)
          check(
            "FOOTPRINT",
            axis,
            minLimit,
            "minimum",
            `Footprint minimum exceeded by ${span.id}`,
          );
        if (needsMaxCheck)
          check(
            "FOOTPRINT",
            axis,
            maxLimit,
            "maximum",
            `Footprint maximum exceeded by ${span.id}`,
          );
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
  | "validation:end";

type GenerationBenchmarkObserver = (event: GenerationBenchmarkEvent) => void;

const flagshipBankProfile = (
  spans: readonly SolvedSpan[],
  elements: readonly AnySemanticElement[],
  automatic: boolean,
): readonly SolvedSpan[] => {
  if (!automatic) return spans;
  const overbank = elements.find(
    (element) => element.type === "overbankedTurn",
  );
  if (!overbank) return spans;
  const amplitude = (overbank.parameters as { readonly bank: number }).bank;
  return spans.flatMap((span) => {
    if (span.id !== overbank.id) return [span];
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
          element.type === "overbankedTurn"
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
  const requiredTrackClearance = intent.constraints
    .filter(
      (constraint) =>
        constraint.kind === "track-clearance" &&
        constraint.hard !== false &&
        typeof (constraint.target ?? constraint.value) === "number",
    )
    .map((constraint) => (constraint.target ?? constraint.value) as number)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  let track: ReturnType<typeof compileTrack> | undefined;
  if (intent.targets.some((target) => target.kind === "total-length")) {
    try {
      track = compileTrack(spans, { samples: options.samples ?? 128 });
    } catch (error) {
      diagnostics.push(toCompileFatalDiagnostic(error));
      failedHardRequirementIds.add("track-compile");
      track = undefined;
    }
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
    for (const constraint of intent.constraints) {
      const required = constraint.target ?? constraint.value;
      if (
        constraint.kind === "track-clearance" &&
        constraint.hard !== false &&
        typeof required === "number" &&
        clearance.some(
          (item) =>
            item.code === "TRACK_CLEARANCE" &&
            (item.actual === undefined || item.actual < required),
        )
      )
        failedHardRequirementIds.add(constraint.id);
    }
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
  const evaluation = {
    elements,
    elementSpans,
    spans,
    solved,
    diagnostics: sanitizeDiagnostics(diagnostics),
    failedHardRequirementIds,
    ...(track ? { track } : {}),
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
    const parameters = element.parameters as Record<string, unknown>;
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
      (span) => ownerForSpan(span.id, elementById) === element.id,
    );
    if (first) {
      bytes[element.id] = spanBytes(first);
      hashes[element.id] = hashSpan(first);
    }
  }
  let track: ReturnType<typeof compileTrack>;
  let compileDiagnostics: readonly Diagnostic[] = evaluation.diagnostics;
  try {
    track =
      options.samples === undefined
        ? canonicalTrack
        : compileTrack(canonicalSpans, { samples: options.samples });
  } catch (error) {
    const diagnostic = toCompileFatalDiagnostic(error);
    compileDiagnostics = Object.freeze([...evaluation.diagnostics, diagnostic]);
    track = canonicalTrack;
  }
  const result: GenerationResult = {
    feasible: !compileDiagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
    intent: ownedIntent,
    elements: resultElements,
    solvedSpans: Object.freeze(canonicalSpans),
    track,
    file,
    serializedFile,
    diagnostics: Object.freeze(compileDiagnostics),
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
  };
  observer?.("compilation:end");
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
): GenerationResult => {
  const elementById = new Map(
    candidate.elements.map((element) => [element.id, element]),
  );
  const serializedSpans = spans.map((span) => {
    const owner = ownerForSpan(span.id, elementById);
    const element = owner === undefined ? undefined : elementById.get(owner);
    if (!element) throw new Error(`Missing semantic owner for span ${span.id}`);
    const parameters = element.parameters as Record<string, unknown>;
    const length =
      typeof parameters.length === "number"
        ? parameters.length
        : (span.length ?? arcLength(span.span));
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
    diagnostics: Object.freeze(diagnostics),
    options: ownedGenerationOptions(candidate.options),
    feasible: !diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    ),
  };
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

const localSeamDiagnostics = (
  spans: readonly SolvedSpan[],
  elements: readonly AnySemanticElement[],
  closed: boolean,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const elementById = new Map(elements.map((element) => [element.id, element]));
  for (const seam of solver.diagnoseSeams(spans, { closed })) {
    const [leftId, rightId] = seam.seamId.split("->");
    if (
      ownerForSpan(leftId!, elementById) === ownerForSpan(rightId!, elementById)
    )
      continue;
    const failure =
      seam.positionM > 1e-4 ||
      seam.tangentRad > 1e-5 ||
      seam.curvaturePerM > 1e-4 ||
      seam.curvatureVectorJumpPerM > 1e-4 ||
      seam.curvatureGradientPerM2 > 1e-4 ||
      seam.bankRad > 1e-4 ||
      seam.bankDerivativeRadPerM > 1e-4 ||
      seam.bankSecondDerivativeRadPerM2 > 1e-4 ||
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
            seam.bankSecondDerivativeRadPerM2,
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
  options: StoredGenerationOptions,
  environment: EnvironmentQuery | undefined,
  localDiagnostics: readonly Diagnostic[],
): readonly Diagnostic[] => {
  const diagnostics = [
    ...localDiagnostics,
    ...localSeamDiagnostics(spans, elements, isClosedChain(elements)),
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
    const clearance = validateClearance(spans, environment, {
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
          referenceSpeed: 44,
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
        changedElements.map((element) => [element.id, element]),
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
            (span) => generationOwner(localGeneration, span.id) === id,
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
  return {
    feasible: false,
    generation: generated,
    diagnostics: [...lastDiagnostics, { ...item, severity: "fatal" }],
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
  } satisfies GenerationResult;
  return regenerateLocal(adapter, elementId, options);
}

export const generate = generateCoaster;
export const localRegenerate = regenerateLocal;
export { compileCoasterFile };
