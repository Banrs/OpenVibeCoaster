import {
  compileCoasterFile,
  validateDesignIntentV1,
  type CoasterFileV1,
  type DesignIntentV1,
  type Diagnostic,
} from "@openvibecoaster/core";
import {
  generateCoaster,
  regenerateCoasterFileLocal,
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
):
  | { ok: true; timeline: RideTimeline; diagnostics: readonly Diagnostic[] }
  | { ok: false; diagnostic: Diagnostic } {
  const baseConfig = createDefaultSimulatorConfig();
  const headSelection = selectHeadDistance(
    track.totalLength,
    baseConfig.train.cars.length,
    baseConfig.train.spacingM,
  );
  if (!headSelection.ok)
    return { ok: false, diagnostic: headSelection.diagnostic };
  const config = {
    ...baseConfig,
    durationSeconds: 5,
    timelineStepSeconds: 1 / 60,
    fixedStepSeconds: 1 / 240,
    closedTrack: false as const,
  };
  const result = simulateRide(track, {
    durationSeconds: 5,
    config,
    initial: { headDistanceM: headSelection.headDistanceM, speedMps: 5 },
  });
  const diagnostics: Diagnostic[] =
    (result.diagnostics as unknown as Diagnostic[]) ?? [];
  return { ok: true, timeline: result.timeline, diagnostics };
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
  let localResult: ReturnType<typeof regenerateCoasterFileLocal>;
  try {
    localResult = regenerateCoasterFileLocal(
      fileInput as CoasterFileV1 | string | Uint8Array,
      elementId as string,
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
        const transfers = collectTransferables({
          track: response.track,
          timeline: response.timeline,
        });
        g.postMessage(response, transfers);
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
