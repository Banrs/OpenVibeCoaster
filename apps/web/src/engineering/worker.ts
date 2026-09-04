import {
  compileCoasterFile,
  validateDesignIntentV1,
  type CoasterFileV1,
  type DesignIntentV1,
  type Diagnostic,
} from "@openvibecoaster/core";
import {
  coasterFileSpanHashes,
  computeClearanceField,
  generateCoaster,
  isClosedChain,
  mapClearanceToTimeline,
  projectClearanceDiagnostics,
  regenerateCoasterFileLocal,
} from "@openvibecoaster/generator";
import {
  createDefaultSimulatorConfig,
  operationZonesFromCoasterFile,
  simulateRide,
  RideTimeline,
  validateEngineeringLimits,
} from "@openvibecoaster/simulator";
import { engineeringLimitsProfile } from "./engineering-profile.js";
import { resolveTerrainEnvironment } from "../terrain/environment.js";
import type {
  CompiledTrackTransfer,
  EngineeringWorkerFailure,
  EngineeringWorkerRequest,
  EngineeringWorkerSuccess,
  EngineeringWorkerTimings,
  RideTimelineCompactTransfer,
} from "./protocol";
import { validateEngineeringWorkerRequest } from "./protocol";
import { collectTransferables } from "./transfer";
import type { CompiledTrackData } from "@openvibecoaster/core";

function getNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function getWorkerEpochMs(): number {
  const now = getNowMs();
  const origin =
    typeof performance !== "undefined" &&
    typeof performance.timeOrigin === "number" &&
    Number.isFinite(performance.timeOrigin)
      ? performance.timeOrigin
      : Date.now() - now;
  return origin + now;
}

function createTimings(simulationMs: number): EngineeringWorkerTimings {
  return {
    simulationMs,
    workerSendEpochMs: getWorkerEpochMs(),
  };
}

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
  extra?: Partial<Pick<Diagnostic, "actual" | "limit" | "margin">>,
): Diagnostic {
  return {
    code,
    severity,
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    ...extra,
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

function resolveEnvForProfile(
  profileId: string | undefined,
): ReturnType<typeof resolveTerrainEnvironment> {
  // Throws on unknown profile – caller converts to diagnostic
  return resolveTerrainEnvironment(profileId);
}

function durationForTrack(track: CompiledTrackData): number {
  // Deterministic duration derived from track length, capped at 180s sufficient for flagship (~1843m actual default).
  // Formula: base 10s + length/12, clamped [20,180]. Fixed RK4 1/240, telemetry 1/120.
  const raw = track.totalLength / 12 + 10;
  return Math.min(180, Math.max(20, raw));
}

type HeadSelection =
  { ok: true; headDistanceM: number } | { ok: false; diagnostic: Diagnostic };

function selectHeadDistance(
  totalLength: number,
  carCount: number,
  spacing: number,
): HeadSelection {
  if (
    !Number.isFinite(totalLength) ||
    !Number.isFinite(spacing) ||
    !Number.isFinite(carCount)
  ) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        "Invalid numeric train fit inputs",
        "fatal",
        {
          actual:
            Number.isFinite(spacing) && Number.isFinite(carCount)
              ? spacing * Math.max(0, carCount - 1)
              : Number.NaN,
          limit: totalLength,
          margin:
            Number.isFinite(totalLength) &&
            Number.isFinite(spacing) &&
            Number.isFinite(carCount)
              ? totalLength - spacing * Math.max(0, carCount - 1)
              : Number.NaN,
        },
      ),
    };
  }
  if (!Number.isInteger(carCount) || carCount <= 0) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        `Invalid car count ${String(carCount)}`,
        "fatal",
        { actual: carCount, limit: 1, margin: 1 - carCount },
      ),
    };
  }
  if (spacing <= 0) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        `Invalid spacing ${String(spacing)}`,
        "fatal",
        { actual: spacing, limit: 0, margin: -spacing },
      ),
    };
  }
  if (totalLength <= 0) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        `Invalid totalLength ${String(totalLength)}`,
        "fatal",
        { actual: 0, limit: totalLength, margin: totalLength },
      ),
    };
  }
  const trainLength = spacing * (carCount - 1);
  if (trainLength > totalLength) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        `Train length ${trainLength.toFixed(2)} exceeds usable track ${totalLength.toFixed(2)}`,
        "fatal",
        {
          actual: trainLength,
          limit: totalLength,
          margin: totalLength - trainLength,
        },
      ),
    };
  }
  const minHead = trainLength + 0.5;
  let headDistanceM: number;
  if (totalLength < minHead + 1) {
    const half = Math.max(0, totalLength * 0.5);
    headDistanceM = Math.max(trainLength, Math.min(half, totalLength - 0.1));
  } else {
    headDistanceM = Math.max(trainLength, Math.min(minHead, totalLength - 1));
  }
  if (!Number.isFinite(headDistanceM)) {
    return {
      ok: false,
      diagnostic: toDiagnostic(
        "TRAIN_LENGTH_EXCEEDS_TRACK",
        "Non-finite head distance",
        "fatal",
        {
          actual: headDistanceM,
          limit: totalLength,
          margin: totalLength - headDistanceM,
        },
      ),
    };
  }
  return { ok: true, headDistanceM };
}

function simulateForTrack(
  track: CompiledTrackData,
  file: CoasterFileV1,
):
  | {
      ok: true;
      timeline: RideTimeline;
      frames: readonly import("@openvibecoaster/simulator").SimulationFrame[];
      diagnostics: readonly Diagnostic[];
      simulationMs: number;
    }
  | { ok: false; diagnostic: Diagnostic } {
  const baseConfig = createDefaultSimulatorConfig();
  const headSelection = selectHeadDistance(
    track.totalLength,
    baseConfig.train.cars.length,
    baseConfig.train.spacingM,
  );
  if (!headSelection.ok)
    return { ok: false, diagnostic: headSelection.diagnostic };
  const zones = operationZonesFromCoasterFile(file, track.totalLength);
  const durationSeconds = durationForTrack(track);
  const config = {
    ...baseConfig,
    zones,
    durationSeconds,
    timelineStepSeconds: 1 / 120,
    fixedStepSeconds: 1 / 240,
    closedTrack: false as const,
  };
  const start = getNowMs();
  const result = simulateRide(track, {
    durationSeconds,
    config,
    initial: { headDistanceM: headSelection.headDistanceM, speedMps: 5 },
    compactTimeline: true,
  });
  const end = getNowMs();
  const simulationMs = Math.max(0, end - start);
  const diagnostics: Diagnostic[] =
    (result.diagnostics as unknown as Diagnostic[]) ?? [];
  return {
    ok: true,
    timeline: result.timeline,
    frames: result.frames,
    diagnostics,
    simulationMs,
  };
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
  const typedIntent = intent as DesignIntentV1;
  let env: ReturnType<typeof resolveTerrainEnvironment>;
  try {
    env = resolveEnvForProfile(typedIntent.terrainProfileId);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "TERRAIN_PROFILE_UNKNOWN",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  let generation: ReturnType<typeof generateCoaster>;
  try {
    generation = generateCoaster(typedIntent, env ? { environment: env } : {});
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
  const track = generation.track;
  const sim = simulateForTrack(track, generation.file);
  if (!sim.ok) return failure(requestId, [sim.diagnostic]);
  if (
    sim.diagnostics.some(
      (d) =>
        (d as Diagnostic).severity === "error" ||
        (d as Diagnostic).severity === "fatal",
    )
  ) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
      ],
      [...generation.relaxations],
    );
  }
  const spanIds = generation.file.solvedSpans.map((s) => s.id);
  const limitDiags = validateEngineeringLimits(
    sim.frames,
    track,
    engineeringLimitsProfile,
    spanIds,
  );
  const hasFatal = limitDiags.some((d) => d.severity === "fatal");
  if (hasFatal) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
        ...limitDiags,
      ],
      [...generation.relaxations],
    );
  }
  if (
    !generation.spanHashes ||
    Object.keys(generation.spanHashes).length === 0
  ) {
    return failure(requestId, [
      toDiagnostic("SPAN_HASH_ERROR", "Missing spanHashes", "fatal"),
    ]);
  }
  // Required finite Float64Array clearanceM derived from owned field and actual train offsets (no default hidden offsets)
  let clearanceM: Float64Array;
  try {
    const cfg = createDefaultSimulatorConfig();
    const offsets = cfg.train.cars.map((_, i) => i * cfg.train.spacingM);
    for (const o of offsets)
      if (!Number.isFinite(o) || o < 0)
        throw new RangeError("train offset must be finite non-negative");
    if (!generation.clearanceField)
      throw new RangeError("clearanceField missing for feasible generation");
    clearanceM = mapClearanceToTimeline(
      generation.clearanceField!,
      sim.timeline.headDistanceM,
      offsets,
    );
    if (clearanceM.length !== sim.timeline.length)
      throw new RangeError("clearanceM length must match timeline length");
    for (let i = 0; i < clearanceM.length; i++)
      if (!Number.isFinite(clearanceM[i]!))
        throw new RangeError(`clearanceM[${i}] must be finite`);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "CLEARANCE_UNCERTIFIED",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  return {
    type: "success",
    requestId,
    file: generation.file,
    track: trackToTransfer(track),
    timeline:
      sim.timeline.toTransferable() as unknown as RideTimelineCompactTransfer,
    diagnostics: [
      ...(generation.diagnostics as Diagnostic[]),
      ...(sim.diagnostics as Diagnostic[]),
      ...limitDiags,
    ],
    relaxations: [...generation.relaxations],
    spanHashes: generation.spanHashes,
    timings: createTimings(sim.simulationMs),
    clearanceM,
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
  // Resolve environment from file's intent if present; also check file load for terrain
  let env: ReturnType<typeof resolveTerrainEnvironment>;
  try {
    const provisional = compileCoasterFile(
      fileInput as CoasterFileV1 | string | Uint8Array,
    );
    env = resolveEnvForProfile(provisional.file.intent.terrainProfileId);
  } catch (err) {
    // If compile fails, localResult will handle; but unknown profile should fail explicitly
    if (
      err instanceof Error &&
      err.message.includes("Unknown terrain profile")
    ) {
      return failure(requestId, [
        toDiagnostic("TERRAIN_PROFILE_UNKNOWN", err.message, "fatal"),
      ]);
    }
    // otherwise defer to localRegenerate error handling
    env = undefined;
  }
  let localResult: ReturnType<typeof regenerateCoasterFileLocal>;
  try {
    localResult = regenerateCoasterFileLocal(
      fileInput as CoasterFileV1 | string | Uint8Array,
      elementId as string,
      {
        ...(env ? { environment: env } : {}),
        seams: engineeringLimitsProfile.seams,
        referenceSpeed: 44,
      },
    );
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_FILE",
        err instanceof Error ? err.message : String(err),
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
  const track = generation.track;
  const sim = simulateForTrack(track, generation.file);
  if (!sim.ok) return failure(requestId, [sim.diagnostic]);
  if (sim.diagnostics.some((d) => (d as Diagnostic).severity === "error")) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
      ],
      [...generation.relaxations],
    );
  }
  const spanIdsReg = generation.file.solvedSpans.map((s) => s.id);
  const limitDiagsReg = validateEngineeringLimits(
    sim.frames,
    track,
    engineeringLimitsProfile,
    spanIdsReg,
  );
  const hasFatalReg = limitDiagsReg.some((d) => d.severity === "fatal");
  if (hasFatalReg) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
        ...limitDiagsReg,
      ],
      [...generation.relaxations],
    );
  }
  if (
    !generation.spanHashes ||
    Object.keys(generation.spanHashes).length === 0
  ) {
    return failure(requestId, [
      toDiagnostic("SPAN_HASH_ERROR", "Missing spanHashes", "fatal"),
    ]);
  }
  let clearanceMReg: Float64Array;
  try {
    const cfg = createDefaultSimulatorConfig();
    const offsets = cfg.train.cars.map((_, i) => i * cfg.train.spacingM);
    for (const o of offsets)
      if (!Number.isFinite(o) || o < 0)
        throw new RangeError("train offset must be finite non-negative");
    if (!generation.clearanceField)
      throw new RangeError("clearanceField missing for feasible regeneration");
    clearanceMReg = mapClearanceToTimeline(
      generation.clearanceField!,
      sim.timeline.headDistanceM,
      offsets,
    );
    if (clearanceMReg.length !== sim.timeline.length)
      throw new RangeError("clearanceM length must match timeline length");
    for (let i = 0; i < clearanceMReg.length; i++)
      if (!Number.isFinite(clearanceMReg[i]!))
        throw new RangeError(`clearanceM[${i}] must be finite`);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "CLEARANCE_UNCERTIFIED",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  return {
    type: "success",
    requestId,
    file: generation.file,
    track: trackToTransfer(track),
    timeline:
      sim.timeline.toTransferable() as unknown as RideTimelineCompactTransfer,
    diagnostics: [
      ...(generation.diagnostics as Diagnostic[]),
      ...(sim.diagnostics as Diagnostic[]),
      ...limitDiagsReg,
    ],
    relaxations: [...generation.relaxations],
    spanHashes: generation.spanHashes,
    timings: createTimings(sim.simulationMs),
    clearanceM: clearanceMReg,
  };
}

export function handleCompileSimulate(
  requestId: string,
  fileInput: unknown,
): EngineeringWorkerSuccess | EngineeringWorkerFailure {
  let loaded: ReturnType<typeof compileCoasterFile>;
  try {
    loaded = compileCoasterFile(
      fileInput as CoasterFileV1 | string | Uint8Array,
    );
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "INVALID_FILE",
        err instanceof Error ? err.message : String(err),
      ),
    ]);
  }
  // Resolve terrain profile on all paths (compile-simulate)
  let envCs: ReturnType<typeof resolveTerrainEnvironment>;
  try {
    envCs = resolveEnvForProfile(loaded.file.intent.terrainProfileId);
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "TERRAIN_PROFILE_UNKNOWN",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  // Compile-simulate recompiles only; does not re-solve. Validate file checksum via compile, then simulate.
  const track = loaded.track;
  const sim = simulateForTrack(track, loaded.file);
  if (!sim.ok) return failure(requestId, [sim.diagnostic]);
  if (
    sim.diagnostics.some(
      (d) =>
        (d as Diagnostic).severity === "error" ||
        (d as Diagnostic).severity === "fatal",
    )
  ) {
    return failure(requestId, sim.diagnostics as Diagnostic[], []);
  }
  const spanIdsCs = loaded.file.solvedSpans.map((s) => s.id);
  const limitDiagsCs = validateEngineeringLimits(
    sim.frames,
    track,
    engineeringLimitsProfile,
    spanIdsCs,
  );
  const hasFatalCs = limitDiagsCs.some((d) => d.severity === "fatal");
  if (hasFatalCs) {
    return failure(
      requestId,
      [...(sim.diagnostics as Diagnostic[]), ...limitDiagsCs],
      [],
    );
  }
  let spanHashes: Readonly<Record<string, string>>;
  try {
    spanHashes = coasterFileSpanHashes(loaded.file);
    if (!spanHashes || Object.keys(spanHashes).length === 0) {
      throw new Error("Empty spanHashes");
    }
  } catch (err) {
    return failure(requestId, [
      toDiagnostic(
        "SPAN_HASH_ERROR",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  // Compute clearance field once because CoasterFile does not persist it – must call projectClearanceDiagnostics with structured file constraints
  let clearanceMCS: Float64Array;
  let clearanceDiagnostics: readonly Diagnostic[] = [];
  try {
    const explicitValues: number[] = [];
    const hardValues: number[] = [];
    const softValues: number[] = [];
    const constraintDescriptors: {
      id: string;
      hard: boolean;
      threshold: number;
    }[] = [];
    for (const c of loaded.file.intent.constraints) {
      if (c.kind !== "track-clearance") continue;
      const v = (c.target ?? c.value) as unknown;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return failure(requestId, [
          toDiagnostic(
            "TRACK_CLEARANCE",
            `track-clearance ${c.id} has invalid threshold ${String(v)}`,
            "fatal",
          ),
        ]);
      }
      explicitValues.push(v as number);
      const isHard = c.hard !== false;
      if (isHard) hardValues.push(v as number);
      else softValues.push(v as number);
      constraintDescriptors.push({
        id: c.id,
        hard: isHard,
        threshold: v as number,
      });
    }
    const displayCap = Math.max(10, 0.5, ...explicitValues);
    const isClosed = isClosedChain(
      loaded.file.intent.elements as unknown as readonly {
        type: string;
        parameters: Record<string, unknown>;
      }[],
    );
    const segmentIds = loaded.file.solvedSpans.map((s) => s.id);
    const field = computeClearanceField(track, {
      environment: envCs,
      closed: isClosed,
      hardClearanceM: 0.5,
      explicitThresholds: hardValues,
      softThresholds: softValues,
      displayCapM: displayCap,
      segmentIds,
    });
    const projected = projectClearanceDiagnostics(field, constraintDescriptors);
    clearanceDiagnostics = [...field.diagnostics, ...projected];
    const hasHardFatal = clearanceDiagnostics.some(
      (d) => d.severity === "error" || d.severity === "fatal",
    );
    if (hasHardFatal) {
      return failure(
        requestId,
        [
          ...(sim.diagnostics as Diagnostic[]),
          ...limitDiagsCs,
          ...clearanceDiagnostics,
        ],
        [],
      );
    }
    const cfg = createDefaultSimulatorConfig();
    const offsets = cfg.train.cars.map((_, i) => i * cfg.train.spacingM);
    for (const o of offsets)
      if (!Number.isFinite(o) || o < 0)
        throw new RangeError("train offset must be finite non-negative");
    clearanceMCS = mapClearanceToTimeline(
      field,
      sim.timeline.headDistanceM,
      offsets,
    );
    if (clearanceMCS.length !== sim.timeline.length)
      throw new RangeError("clearanceM length must match timeline length");
    for (let i = 0; i < clearanceMCS.length; i++)
      if (!Number.isFinite(clearanceMCS[i]!))
        throw new RangeError(`clearanceM[${i}] must be finite`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("track-clearance")) {
      return failure(requestId, [
        toDiagnostic("TRACK_CLEARANCE", err.message, "fatal"),
      ]);
    }
    return failure(requestId, [
      toDiagnostic(
        "CLEARANCE_UNCERTIFIED",
        err instanceof Error ? err.message : String(err),
        "fatal",
      ),
    ]);
  }
  return {
    type: "success",
    requestId,
    file: loaded.file,
    track: trackToTransfer(track),
    timeline:
      sim.timeline.toTransferable() as unknown as RideTimelineCompactTransfer,
    diagnostics: [
      ...(sim.diagnostics as Diagnostic[]),
      ...limitDiagsCs,
      ...clearanceDiagnostics,
    ],
    relaxations: [],
    spanHashes,
    timings: createTimings(sim.simulationMs),
    clearanceM: clearanceMCS,
  };
}

// Worker global handling — only register when running as actual Worker
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (
  typeof g.importScripts !== "undefined" ||
  typeof g.postMessage === "function"
) {
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
        // Build transfer list first so the send-epoch timestamp is captured
        // in the immediately-next step before the actual postMessage, as
        // required by the User Timing contract. Must include clearanceM buffer exactly once.
        const transfers = collectTransferables(response);
        const refreshed: EngineeringWorkerSuccess = {
          ...response,
          timings: {
            simulationMs: response.timings.simulationMs,
            workerSendEpochMs: getWorkerEpochMs(),
          },
        };
        g.postMessage(refreshed, transfers);
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

  g.addEventListener?.("error", () => {});
  try {
    g.addEventListener?.("messageerror", () => {});
  } catch {}
}
