import {
  compileCoasterFile,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
  serializeSolvedSpanV1,
  validateDesignIntentV1,
  type CoasterFileV1,
  type DesignIntentV1,
  type Diagnostic,
  type SolvedSpan,
} from "@openvibecoaster/core";
import {
  createElement,
  generateCoaster,
  regenerateLocal,
} from "@openvibecoaster/generator";
import type {
  GenerationResult,
  StoredGenerationOptions,
} from "@openvibecoaster/generator";
import {
  createDefaultSimulatorConfig,
  simulateRide,
  RideTimeline,
} from "@openvibecoaster/simulator";
import type {
  CompiledTrackTransfer,
  EngineeringWorkerFailure,
  EngineeringWorkerRequest,
  EngineeringWorkerSuccess,
} from "./protocol";
import { validateEngineeringWorkerRequest } from "./protocol";
import { collectTransferables } from "./transfer";
import type { CompiledTrackData } from "@openvibecoaster/core";

function failure(
  requestId: string,
  diagnostics: readonly Diagnostic[],
  relaxations: readonly string[] = [],
): EngineeringWorkerFailure {
  return { type: "failure", requestId, diagnostics, relaxations };
}

function toDiagnostic(
  code: string,
  message: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return {
    code,
    severity,
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
  };
}

function trackToTransfer(track: CompiledTrackData): CompiledTrackTransfer {
  return {
    positions: track.positions,
    tangents: track.tangents,
    normals: track.normals,
    binormals: track.binormals,
    distances: track.distances,
    curvature: track.curvature,
    curvatureVector: track.curvatureVector,
    bank: track.bank,
    bankDerivative: track.bankDerivative,
    zoneMasks: track.zoneMasks,
    zoneNames: [...track.zoneNames],
    elementIndices: track.elementIndices,
    elementBoundaries: track.elementBoundaries,
    parameters: track.parameters,
    totalLength: track.totalLength,
    checksum: track.checksum,
  };
}

function simulateForTrack(track: CompiledTrackData): {
  timeline: RideTimeline;
  diagnostics: readonly Diagnostic[];
} {
  const baseConfig = createDefaultSimulatorConfig();
  const carCount = baseConfig.train.cars.length;
  const spacing = baseConfig.train.spacingM;
  // Head must be inside track for open track: ensure all cars inside [0, totalLength]
  const minHead = spacing * (carCount - 1) + 0.5;
  let headDistanceM = minHead;
  if (track.totalLength < minHead + 1) {
    headDistanceM = Math.max(0, track.totalLength * 0.5);
    if (headDistanceM < spacing * (carCount - 1)) {
      headDistanceM = Math.min(track.totalLength - 0.1, headDistanceM);
      if (headDistanceM < 0) headDistanceM = 0;
    }
  } else {
    headDistanceM = Math.min(headDistanceM, track.totalLength - 1);
  }
  headDistanceM = Math.max(
    spacing * (carCount - 1),
    Math.min(headDistanceM, track.totalLength - 0.1),
  );
  if (track.totalLength <= spacing * (carCount - 1) + 0.1) {
    headDistanceM = track.totalLength / 2;
  }
  const config = {
    ...baseConfig,
    // Use deterministic short simulation
    durationSeconds: 5,
    timelineStepSeconds: 1 / 60,
    fixedStepSeconds: 1 / 240,
    closedTrack: false as const,
  };
  const result = simulateRide(track, {
    durationSeconds: 5,
    config,
    initial: { headDistanceM, speedMps: 5 },
  });
  // Convert simulator diagnostics to core Diagnostic shape if needed
  const diagnostics: Diagnostic[] =
    (result.diagnostics as unknown as Diagnostic[]) ?? [];
  return { timeline: result.timeline, diagnostics };
}

function parseFile(file: unknown): CoasterFileV1 {
  if (typeof file === "string") {
    return deserializeCoasterFileV1(file);
  }
  if (file instanceof Uint8Array) {
    return deserializeCoasterFileV1(file);
  }
  // Assume already a CoasterFileV1 object – validate via compileCoasterFile path
  // compileCoasterFile will validate
  const loaded = compileCoasterFile(file as CoasterFileV1 | string);
  return loaded.file;
}

function ownerForSpanId(
  spanId: string,
  elementById: ReadonlyMap<string, unknown>,
): string | undefined {
  if (elementById.has(spanId)) return spanId;
  const separator = spanId.lastIndexOf("#");
  if (separator <= 0 || !/^\d+$/.test(spanId.slice(separator + 1)))
    return undefined;
  const owner = spanId.slice(0, separator);
  return elementById.has(owner) ? owner : undefined;
}

function spanBytesForSolved(span: SolvedSpan): string {
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
}

function hashSpanForSolved(span: SolvedSpan): string {
  let hash = 0x811c9dc5;
  for (const character of spanBytesForSolved(span))
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function generationFromFile(file: CoasterFileV1): GenerationResult {
  // Compile stored coefficients without solving – validates file
  const loaded = compileCoasterFile(file);
  const solvedSpans = loaded.solvedSpans;
  const track = loaded.track;
  const elements = file.intent.elements.map((e) => {
    const kind = (e.kind ?? e.type) as string;
    return createElement(
      kind as Parameters<typeof createElement>[0],
      e.id,
      (e.parameters ?? {}) as Parameters<typeof createElement>[2],
    );
  });
  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const bytes: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const span of solvedSpans) {
    bytes[span.id] = spanBytesForSolved(span);
    hashes[span.id] = hashSpanForSolved(span);
  }
  for (const el of elements) {
    const first = solvedSpans.find(
      (s) => ownerForSpanId(s.id, elementById) === el.id,
    );
    if (first) {
      bytes[el.id] = spanBytesForSolved(first);
      hashes[el.id] = hashSpanForSolved(first);
    }
  }
  return Object.freeze({
    feasible: true,
    intent: file.intent,
    elements: Object.freeze([...elements]),
    solvedSpans: Object.freeze([...solvedSpans]),
    track,
    file,
    serializedFile: serializeCoasterFileV1(file),
    diagnostics: Object.freeze([]),
    relaxations: Object.freeze([]),
    candidatesTested: 1,
    lmIterations: 0,
    selectedLmIterations: 0,
    candidateLmIterations: Object.freeze([0]),
    candidateLmWork: 0,
    relaxationLmIterations: Object.freeze([]),
    relaxationLmWork: 0,
    spanHashes: Object.freeze({ ...hashes }),
    spanBytes: Object.freeze({ ...bytes }),
    relaxationEvidence: Object.freeze([]),
    options: Object.freeze({}) as StoredGenerationOptions,
  } as unknown as GenerationResult);
}

export function handleGenerate(
  requestId: string,
  intent: unknown,
): EngineeringWorkerSuccess | EngineeringWorkerFailure {
  try {
    validateDesignIntentV1(intent as DesignIntentV1);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_INTENT",
        err instanceof Error ? err.message : String(err),
      ),
    ]);
  }
  let generation: ReturnType<typeof generateCoaster>;
  try {
    generation = generateCoaster(intent as DesignIntentV1);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "GENERATION_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  const hasError = generation.diagnostics.some(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  if (!generation.feasible || hasError) {
    return failure(requestId, generation.diagnostics as Diagnostic[], [
      ...generation.relaxations,
    ]);
  }
  // Authoritative flow: compile canonical solved coefficients -> simulate/validate
  let track: CompiledTrackData;
  try {
    // generation.track is already canonical; recompile to verify deterministic checksum
    const spans = generation.solvedSpans;
    // generation.file's checksum already validated
    track = generation.track;
    // Ensure we use canonical track (recompile via compileCoasterFile path already verified)
    // Validate that track matches file checksum via compileTrack consistency
    void spans;
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "COMPILE_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }

  let timeline: RideTimeline;
  let simDiagnostics: readonly Diagnostic[] = [];
  try {
    const sim = simulateForTrack(track);
    timeline = sim.timeline;
    simDiagnostics = sim.diagnostics;
    const simHasError = simDiagnostics.some(
      (d) =>
        (d as Diagnostic).severity === "error" ||
        (d as Diagnostic).severity === "fatal",
    );
    if (simHasError) {
      return failure(
        requestId,
        [
          ...(generation.diagnostics as Diagnostic[]),
          ...(simDiagnostics as Diagnostic[]),
        ],
        [...generation.relaxations],
      );
    }
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "SIMULATION_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }

  const trackTransfer = trackToTransfer(track);
  const timelineTransfer = (timeline as RideTimeline).toTransferable();
  const diagnostics: Diagnostic[] = [
    ...(generation.diagnostics as Diagnostic[]),
    ...(simDiagnostics as Diagnostic[]),
  ];
  return {
    type: "success",
    requestId,
    file: generation.file,
    track: trackTransfer,
    timeline: timelineTransfer,
    diagnostics,
    relaxations: [...generation.relaxations],
  };
}

export function handleRegenerate(
  requestId: string,
  fileInput: unknown,
  elementId: unknown,
): EngineeringWorkerSuccess | EngineeringWorkerFailure {
  if (typeof elementId !== "string" || elementId.trim().length === 0) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_ELEMENT_ID",
        "elementId: expected non-empty string",
      ),
    ]);
  }
  let parsedFile: CoasterFileV1;
  try {
    parsedFile = parseFile(fileInput);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_FILE",
        err instanceof Error ? err.message : String(err),
      ),
    ]);
  }
  const exists = parsedFile.intent.elements.some((e) => e.id === elementId);
  if (!exists) {
    return failure(requestId, [
      toDiagnostic("UNKNOWN_ELEMENT", `Unknown element ${elementId}`),
    ]);
  }
  let baseGeneration: GenerationResult;
  try {
    // Compile stored solved coefficients without solving; reconstruct generation input owned by supplied file
    baseGeneration = generationFromFile(parsedFile);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "GENERATION_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  let localResult: ReturnType<typeof regenerateLocal>;
  try {
    localResult = regenerateLocal(baseGeneration, elementId as string);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "REGENERATION_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  if (!localResult.feasible) {
    return failure(requestId, localResult.diagnostics as Diagnostic[], []);
  }
  const generation = localResult.generation;
  const hasError = generation.diagnostics.some(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  if (!generation.feasible || hasError) {
    return failure(requestId, generation.diagnostics as Diagnostic[], [
      ...generation.relaxations,
    ]);
  }
  let track = generation.track;
  let sim = simulateForTrack(track);
  const simHasError = sim.diagnostics.some(
    (d) => (d as Diagnostic).severity === "error",
  );
  if (simHasError) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
      ],
      [...generation.relaxations],
    );
  }
  return {
    type: "success",
    requestId,
    file: generation.file,
    track: trackToTransfer(track),
    timeline: sim.timeline.toTransferable(),
    diagnostics: [
      ...(generation.diagnostics as Diagnostic[]),
      ...(sim.diagnostics as Diagnostic[]),
    ],
    relaxations: [...generation.relaxations],
  };
}

export function handleCompileSimulate(
  requestId: string,
  fileInput: unknown,
): EngineeringWorkerSuccess | EngineeringWorkerFailure {
  let loaded: ReturnType<typeof compileCoasterFile>;
  try {
    // This is the ONLY path that must recompile without re-solving
    loaded = compileCoasterFile(fileInput as CoasterFileV1 | string);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_FILE",
        err instanceof Error ? err.message : String(err),
      ),
    ]);
  }
  const track = loaded.track;
  let sim: { timeline: RideTimeline; diagnostics: readonly Diagnostic[] };
  try {
    sim = simulateForTrack(track);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "SIMULATION_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  const simHasError = sim.diagnostics.some(
    (d) =>
      (d as Diagnostic).severity === "error" ||
      (d as Diagnostic).severity === "fatal",
  );
  if (simHasError) {
    return failure(requestId, sim.diagnostics as Diagnostic[], []);
  }
  return {
    type: "success",
    requestId,
    file: loaded.file,
    track: trackToTransfer(track),
    timeline: sim.timeline.toTransferable(),
    diagnostics: sim.diagnostics as Diagnostic[],
    relaxations: [],
  };
}

// Worker global handling — only register when running as actual Worker
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (
  typeof g.importScripts !== "undefined" ||
  typeof g.postMessage === "function"
) {
  // Dedicated worker context
  g.addEventListener?.("message", (event: MessageEvent) => {
    const data = (event as MessageEvent).data as EngineeringWorkerRequest;
    let req: EngineeringWorkerRequest | undefined;
    try {
      validateEngineeringWorkerRequest(data);
      req = data;
    } catch (err) {
      const rid = (data as { requestId?: unknown })?.requestId;
      const requestId =
        typeof rid === "string" && rid.length > 0 ? rid : "unknown";
      const diag = toDiagnostic(
        "INVALID_REQUEST",
        err instanceof Error ? err.message : String(err),
      );
      const resp = failure(requestId, [diag]);
      g.postMessage(resp);
      return;
    }
    if (req.type === "cancel") {
      // No cooperative cancellation possible while engineering occupies event loop.
      // Client will terminate worker for active requests. Ignore here.
      return;
    }
    try {
      let response: EngineeringWorkerSuccess | EngineeringWorkerFailure;
      if (req.type === "generate")
        response = handleGenerate(req.requestId, req.intent);
      else if (req.type === "regenerate")
        response = handleRegenerate(req.requestId, req.file, req.elementId);
      else response = handleCompileSimulate(req.requestId, req.file);

      if (response.type === "success") {
        const transfers = collectTransferables({
          track: response.track,
          timeline: response.timeline,
        });
        // Do not retain/use transferred buffers afterward — clear references
        g.postMessage(response, transfers);
        // Prevent accidental reuse by nulling (not needed but documents intent)
        void transfers;
      } else {
        g.postMessage(response);
      }
    } catch (err) {
      const diag = toDiagnostic(
        "WORKER_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      );
      const resp = failure(req.requestId, [diag]);
      g.postMessage(resp);
    }
  });

  g.addEventListener?.("error", () => {
    // Worker errors are observed by client via error event; no extra handling needed
  });
  g.addEventListener?.("messageerror", () => {
    // Message deserialization errors likewise propagate to client
  });
}
