import {
  CoasterFileError,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  compileCoasterFile,
  createCoasterFileV1,
  serializeCoasterFileV1,
  serializeSolvedSpanV1,
  validateDesignIntentV1,
  compileTrack,
  arcLength,
  quatRotateVector,
  vec3Dot,
  vec3Normalize,
  vec3,
  type Diagnostic,
  type DesignIntentV1,
  type SolvedSpan,
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
} from "./types";

const defaultElements = (seed: number): AnySemanticElement[] => {
  const variation = seed % 5;
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

const asElements = (intent: DesignIntentV1): AnySemanticElement[] => {
  if (intent.mode !== "directed") return defaultElements(intent.seed);
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
  }) as AnySemanticElement[];
};

const coefficientSpan = (span: SolvedSpan): SolvedSpan => {
  const position =
    span.span instanceof SeventhOrderHermiteSpan
      ? span.span
      : new SeventhOrderHermiteSpan({
          p0: span.span.position(0),
          d10: span.span.derivative(0, 1),
          d20: span.span.derivative(0, 2),
          d30: span.span.derivative(0, 3),
          p1: span.span.position(1),
          d11: span.span.derivative(1, 1),
          d21: span.span.derivative(1, 2),
          d31: span.span.derivative(1, 3),
        });
  const bank =
    span.bank instanceof QuinticScalarSpan
      ? span.bank
      : new QuinticScalarSpan({
          v0: span.bank?.position(0) ?? 0,
          d10: span.bank?.derivative(0, 1) ?? 0,
          d20: span.bank?.derivative(0, 2) ?? 0,
          v1: span.bank?.position(1) ?? 0,
          d11: span.bank?.derivative(1, 1) ?? 0,
          d21: span.bank?.derivative(1, 2) ?? 0,
        });
  return {
    ...span,
    span: position,
    bank,
    positionCoefficients: position.coefficients,
    rollCoefficients: bank.coefficients,
  };
};
const hashSpan = (span: SolvedSpan): string => {
  const serial = serializeSolvedSpanV1(span);
  const text = JSON.stringify(serial);
  let hash = 0x811c9dc5;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const bytes =
      code < 0x80
        ? [code]
        : code < 0x800
          ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
          : [
              0xe0 | (code >> 12),
              0x80 | ((code >> 6) & 0x3f),
              0x80 | (code & 0x3f),
            ];
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const diagnostic = (
  message: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic => ({
  code: "INFEASIBLE_HARD_CONSTRAINTS",
  severity,
  provenance:
    severity === "warning" ? "DESIGN_ASSUMPTION" : "PROJECT_ENGINEERING_LIMIT",
  message,
});
const poseTarget = (intent: DesignIntentV1): readonly Vec3[] =>
  intent.gates.map((gate) => gate.position as Vec3);
const elementLength = (
  element: AnySemanticElement,
  span: SolvedSpan,
): number => {
  const parameters = element.parameters as unknown as Record<string, unknown>;
  return typeof parameters.length === "number"
    ? parameters.length
    : arcLength(span.span, 0, 1);
};

export const generateCoaster = (
  intent: DesignIntentV1,
  options: GenerationOptions = {},
): GenerationResult => {
  validateDesignIntentV1(intent);
  const elements = asElements(intent);
  const effectiveIntent: DesignIntentV1 =
    intent.mode === "directed"
      ? intent
      : {
          ...intent,
          elements: elements.map((element) => ({
            id: element.id,
            kind: element.type,
            type: element.type,
            parameters: element.parameters,
          })),
        };
  const targets = poseTarget(intent).map((target, index) => ({
    id: `gate-${index}`,
    kind: "end-position" as const,
    target,
    hard: true,
  }));
  const solved = solveSemanticChain(elements, {
    ...(targets.length > 0 ? { targets } : {}),
    referenceSpeed: 44,
    maxIterations: intent.mode === "directed" ? 32 : 0,
  });
  const spans = solved.solvedSpans.map(coefficientSpan);
  const diagnostics: Diagnostic[] = [...solved.diagnostics];
  const relaxations = [...solved.relaxations];
  const addConstraintFailure = (
    item: Diagnostic,
    constraintId: string,
  ): void => {
    diagnostics.push(item);
    if (item.severity === "error" && relaxations.length < 3)
      relaxations.push(
        `Tested relaxation of ${constraintId}: candidate remained infeasible`,
      );
  };
  for (const constraint of intent.constraints) {
    const value = constraint.target ?? constraint.value;
    const severity = constraint.hard === false ? "warning" : "error";
    if (
      constraint.kind === "required-element" &&
      typeof value === "string" &&
      !elements.some((element) => element.type === value)
    )
      addConstraintFailure(
        {
          ...diagnostic(
            `Required ${constraint.hard === false ? "soft" : "hard"} element kind ${value} is missing`,
            severity,
          ),
          relatedIds: [constraint.id],
        },
        constraint.id,
      );
    if (
      constraint.kind === "required-stall" &&
      !elements.some((element) => element.type === "stall")
    )
      addConstraintFailure(
        {
          ...diagnostic(
            `Required ${constraint.hard === false ? "soft" : "hard"} element kind stall is missing`,
            severity,
          ),
          relatedIds: [constraint.id],
        },
        constraint.id,
      );
  }
  for (const [index, gate] of intent.gates.entries()) {
    if (!gate.orientation) continue;
    const targetTangent = quatRotateVector(gate.orientation, vec3(0, 0, 1));
    const tangentError = Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          vec3Dot(
            vec3Normalize(solved.endPose.tangent),
            vec3Normalize(targetTangent),
          ),
        ),
      ),
    );
    if (tangentError > 1e-5)
      addConstraintFailure(
        {
          ...diagnostic(
            `Gate ${gate.id} orientation residual is ${tangentError.toExponential(3)}`,
          ),
          relatedIds: [gate.id],
          actual: tangentError,
          limit: 1e-5,
          margin: 1e-5 - tangentError,
        },
        `gate-${index}:orientation`,
      );
  }
  if (intent.footprint) {
    for (const span of spans)
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const point = span.span.position(u);
        if (
          point.some(
            (value, index) =>
              value < intent.footprint!.min[index]! ||
              value > intent.footprint!.max[index]!,
          )
        )
          diagnostics.push(
            diagnostic(
              `Footprint hard constraint exceeded by ${span.id} at u=${u}`,
            ),
          );
      }
  }
  if (intent.heightRange) {
    for (const span of spans)
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const y = span.span.position(u)[1];
        if (y < intent.heightRange.min || y > intent.heightRange.max)
          diagnostics.push(
            diagnostic(
              `Height hard constraint exceeded by ${span.id} at u=${u}`,
            ),
          );
      }
  }
  const clearance = validateClearance(
    spans,
    options.environment,
    options.trainEnvelopeRadius === undefined
      ? {}
      : { trainEnvelopeRadius: options.trainEnvelopeRadius },
  );
  diagnostics.push(...clearance);
  const track = compileTrack(spans, { samples: options.samples ?? 128 });
  const file = createCoasterFileV1({
    name: options.name ?? "OpenVibeCoaster",
    intent: effectiveIntent,
    solvedSpans: spans.map((span, index) =>
      serializeSolvedSpanV1(
        span,
        elements[index]!.type,
        elementLength(elements[index]!, span),
      ),
    ),
    seed: intent.seed,
    generatorVersion: options.generatorVersion ?? intent.generatorVersion,
    profileVersion: options.profileVersion ?? "profile-v1",
    researchSnapshotIds: options.researchSnapshotIds ?? [],
    compiledDataChecksum: track.checksum,
  });
  const serializedFile = serializeCoasterFileV1(file);
  const spanHashes = Object.fromEntries(
    spans.map((span) => [span.id, hashSpan(span)]),
  );
  return {
    feasible:
      solved.feasible &&
      !diagnostics.some(
        (item) => item.severity === "error" || item.severity === "fatal",
      ),
    intent: effectiveIntent,
    elements,
    solvedSpans: Object.freeze(spans),
    track,
    file,
    serializedFile,
    diagnostics: Object.freeze(diagnostics),
    relaxations: Object.freeze(relaxations.slice(0, 3)),
    candidatesTested: 1,
    lmIterations: 32,
    spanHashes,
  };
};

export const regenerateLocal = (
  generated: GenerationResult,
  selectedElementId: string,
  options: LocalRegenerationOptions = {},
): LocalRegenerationResult => {
  const pinned = new Set([
    ...generated.intent.pinnedElementIds,
    ...(options.pinnedElementIds ?? []),
  ]);
  if (pinned.has(selectedElementId)) {
    const item = diagnostic(
      `Pinned element ${selectedElementId} cannot be regenerated`,
      "fatal",
    );
    return {
      feasible: false,
      generation: generated,
      diagnostics: [item],
      untouchedSpanHashes: generated.spanHashes,
    };
  }
  const selectedIndex = generated.elements.findIndex(
    (element) => element.id === selectedElementId,
  );
  if (selectedIndex < 0) {
    const item = diagnostic(
      `Unknown local regeneration element ${selectedElementId}`,
      "fatal",
    );
    return {
      feasible: false,
      generation: generated,
      diagnostics: [item],
      untouchedSpanHashes: generated.spanHashes,
    };
  }
  const changedIntent =
    options.intent ??
    (options.changes
      ? {
          ...generated.intent,
          elements: generated.intent.elements.map((element) => {
            const patch = options.changes?.[element.id];
            if (!patch) return element;
            const parameters = Object.fromEntries(
              Object.entries({ ...element.parameters, ...patch }).filter(
                (entry) => entry[1] !== undefined,
              ),
            ) as Record<string, number | string | boolean>;
            return { ...element, parameters };
          }),
        }
      : undefined);
  const candidate = changedIntent ? generateCoaster(changedIntent) : generated;
  const untouchedSpanHashes: Record<string, string> = {};
  for (let index = 0; index < generated.elements.length; index += 1) {
    const id = generated.elements[index]!.id;
    if (index !== selectedIndex && (index < selectedIndex || pinned.has(id))) {
      if (candidate.spanHashes[id] !== generated.spanHashes[id]) {
        const item = diagnostic(
          `Untouched solved span ${id} changed during local regeneration`,
          "fatal",
        );
        return {
          feasible: false,
          generation: generated,
          diagnostics: [item],
          untouchedSpanHashes,
        };
      }
      untouchedSpanHashes[id] = generated.spanHashes[id]!;
    }
  }
  return {
    feasible: candidate.feasible,
    generation: candidate,
    diagnostics: candidate.diagnostics,
    untouchedSpanHashes,
  };
};

export const generate = generateCoaster;
export const localRegenerate = regenerateLocal;
export { compileCoasterFile };
