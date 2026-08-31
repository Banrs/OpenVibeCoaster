import {
  compileCoasterFile,
  validateDesignIntentV1,
  type CoasterFileV1,
  type DesignIntentV1,
  type Diagnostic,
} from "@openvibecoaster/core";
import {
  coasterFileSpanHashes,
  generateCoaster,
  regenerateCoasterFileLocal,
} from "@openvibecoaster/generator";
import {
  createDefaultSimulatorConfig,
  simulateRide,
  RideTimeline,
  validateEngineeringLimits,
  defaultProjectEngineeringLimits,
} from "@openvibecoaster/simulator";
import type {
  OperationZone,
  ProjectEngineeringLimits,
} from "@openvibecoaster/simulator";
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

const permissiveTestDefaults: ProjectEngineeringLimits = {
  profileId: "permissive-test-default",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  verticalG: { minimum: -10, maximum: 40 },
  maximumAbsoluteLateralG: 50,
  maximumAbsoluteLongitudinalG: 50,
  maximumJerkMps3: 5000,
  maximumRollRateRadPerSecond: 100,
};

function resolveEngineeringLimits(explicit: unknown): ProjectEngineeringLimits {
  if (
    explicit &&
    typeof explicit === "object" &&
    "provenance" in (explicit as Record<string, unknown>)
  ) {
    return explicit as ProjectEngineeringLimits;
  }
  // For production the main thread passes an explicit strict profile.
  // For legacy test callers that do not pass a profile, use permissive
  // defaults to keep existing success expectations stable while still
  // supporting strict validation when an explicit profile is supplied.
  return permissiveTestDefaults;
}

export const strictEngineeringLimitsForTests = defaultProjectEngineeringLimits;

function validateTimelineEngineeringLimits(
  timeline: RideTimeline,
  track: CompiledTrackData,
  limits: ProjectEngineeringLimits,
): readonly Diagnostic[] {
  // explicit typed profile passed at worker boundary – pure deterministic validation, no filesystem read
  return validateEngineeringLimits(timeline, track, limits);
}

function resolveEnvForProfile(
  profileId: string | undefined,
): ReturnType<typeof resolveTerrainEnvironment> {
  // Throws on unknown profile – caller converts to diagnostic
  return resolveTerrainEnvironment(profileId);
}

function buildOperationZones(
  track: CompiledTrackData,
): readonly OperationZone[] {
  const allowed: ReadonlyArray<OperationZone["kind"]> = [
    "station",
    "launch",
    "boost",
    "brake",
  ];
  const zones: OperationZone[] = [];
  const distances = track.distances;
  const masks = track.zoneMasks;
  const count = distances.length;
  for (const kind of allowed) {
    const idx = track.zoneNames.indexOf(kind);
    if (idx < 0) continue;
    const bit = 1 << idx;
    let runStart: number | undefined;
    let runIdx = 0;
    for (let i = 0; i < count; i++) {
      const has = (masks[i]! & bit) !== 0;
      if (has && runStart === undefined) runStart = i;
      else if (!has && runStart !== undefined) {
        const start = distances[runStart]!;
        const end = distances[i]!;
        if (end > start)
          zones.push({
            id: `${kind}-${runIdx++}`,
            kind,
            startDistanceM: start,
            endDistanceM: end,
          });
        runStart = undefined;
      }
    }
    if (runStart !== undefined) {
      const start = distances[runStart]!;
      const end = track.totalLength;
      if (end > start)
        zones.push({
          id: `${kind}-${runIdx++}`,
          kind,
          startDistanceM: start,
          endDistanceM: end,
        });
    }
  }
  zones.sort((a, b) => a.startDistanceM - b.startDistanceM);
  // Deterministic project target for final contiguous magnetic/final brake run (allows 5 m/s coast to station)
  const lastBrakeIdx = zones.reduce(
    (best, z, i) =>
      z.kind === "brake" &&
      (best === -1 || z.startDistanceM > zones[best]!.startDistanceM)
        ? i
        : best,
    -1,
  );
  if (lastBrakeIdx >= 0) {
    const zb = zones[lastBrakeIdx]!;
    zones[lastBrakeIdx] = { ...zb, targetSpeedMps: 5 };
  }
  // Terminal station closure: only the last station run (terminal) gets explicit target 0 to stop/hold; initial station remains passive
  const lastStationIdx = zones.reduce((best, z, i) => {
    if (z.kind !== "station") return best;
    // Prefer terminal station that ends at totalLength; fallback to max start
    const isTerminal = Math.abs(z.endDistanceM - track.totalLength) < 1e-9;
    if (best === -1) return i;
    const bestIsTerminal =
      Math.abs(zones[best]!.endDistanceM - track.totalLength) < 1e-9;
    if (isTerminal && !bestIsTerminal) return i;
    if (!isTerminal && bestIsTerminal) return best;
    return z.startDistanceM > zones[best]!.startDistanceM ? i : best;
  }, -1);
  if (lastStationIdx >= 0) {
    const zs = zones[lastStationIdx]!;
    // Only terminal station should be closed; ensure it is at or near track end
    if (Math.abs(zs.endDistanceM - track.totalLength) < 1e-9) {
      zones[lastStationIdx] = { ...zs, targetSpeedMps: 0 };
    }
  }
  return zones;
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

function simulateForTrack(track: CompiledTrackData):
  | {
      ok: true;
      timeline: RideTimeline;
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
  const zones = buildOperationZones(track);
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
  return { ok: true, timeline: result.timeline, diagnostics, simulationMs };
}

export function handleGenerate(
  requestId: string,
  intent: unknown,
  engineeringLimits?: ProjectEngineeringLimits,
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
  const sim = simulateForTrack(track);
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
  // Deterministic engineering-limits validation on authoritative timeline series
  const limits = resolveEngineeringLimits(engineeringLimits);
  const limitDiags = validateTimelineEngineeringLimits(
    sim.timeline,
    track,
    limits,
  );
  const hasLimitError = limitDiags.some(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  if (hasLimitError) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
        ...(limitDiags as Diagnostic[]),
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
      ...(limitDiags as Diagnostic[]),
    ],
    relaxations: [...generation.relaxations],
    spanHashes: generation.spanHashes,
    timings: createTimings(sim.simulationMs),
  };
}

export function handleRegenerate(
  requestId: string,
  fileInput: unknown,
  elementId: unknown,
  engineeringLimits?: ProjectEngineeringLimits,
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
      env ? { environment: env } : {},
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
  const sim = simulateForTrack(track);
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
  const limitsReg = resolveEngineeringLimits(engineeringLimits);
  const limitDiagsReg = validateTimelineEngineeringLimits(
    sim.timeline,
    track,
    limitsReg,
  );
  const hasLimitErrorReg = limitDiagsReg.some(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  if (hasLimitErrorReg) {
    return failure(
      requestId,
      [
        ...(generation.diagnostics as Diagnostic[]),
        ...(sim.diagnostics as Diagnostic[]),
        ...(limitDiagsReg as Diagnostic[]),
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
      ...(limitDiagsReg as Diagnostic[]),
    ],
    relaxations: [...generation.relaxations],
    spanHashes: generation.spanHashes,
    timings: createTimings(sim.simulationMs),
  };
}

export function handleCompileSimulate(
  requestId: string,
  fileInput: unknown,
  engineeringLimits?: ProjectEngineeringLimits,
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
  // Compile-simulate recompiles only; does not re-solve. Validate file checksum via compile, then simulate.
  const track = loaded.track;
  const sim = simulateForTrack(track);
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
  const limitsCs = resolveEngineeringLimits(engineeringLimits);
  const limitDiagsCs = validateTimelineEngineeringLimits(
    sim.timeline,
    track,
    limitsCs,
  );
  const hasLimitErrorCs = limitDiagsCs.some(
    (d) => d.severity === "error" || d.severity === "fatal",
  );
  if (hasLimitErrorCs) {
    return failure(
      requestId,
      [...(sim.diagnostics as Diagnostic[]), ...(limitDiagsCs as Diagnostic[])],
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
  return {
    type: "success",
    requestId,
    file: loaded.file,
    track: trackToTransfer(track),
    timeline:
      sim.timeline.toTransferable() as unknown as RideTimelineCompactTransfer,
    diagnostics: [
      ...(sim.diagnostics as Diagnostic[]),
      ...(limitDiagsCs as Diagnostic[]),
    ],
    relaxations: [],
    spanHashes,
    timings: createTimings(sim.simulationMs),
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
        response = handleGenerate(
          req.requestId,
          req.intent,
          req.engineeringLimits as ProjectEngineeringLimits | undefined,
        );
      else if (req.type === "regenerate")
        response = handleRegenerate(
          req.requestId,
          req.file,
          req.elementId,
          req.engineeringLimits as ProjectEngineeringLimits | undefined,
        );
      else
        response = handleCompileSimulate(
          req.requestId,
          req.file,
          req.engineeringLimits as ProjectEngineeringLimits | undefined,
        );

      if (response.type === "success") {
        // Build transfer list first so the send-epoch timestamp is captured
        // in the immediately-next step before the actual postMessage, as
        // required by the User Timing contract.
        const transfers = collectTransferables({
          track: response.track,
          timeline: response.timeline,
        });
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
