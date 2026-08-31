import {
  compileCoasterFile,
  deserializeCoasterFileV1,
  validateDesignIntentV1,
} from "@openvibecoaster/core";
import type {
  CoasterFileV1,
  DesignIntentV1,
  Diagnostic,
} from "@openvibecoaster/core";
import {
  TIMELINE_CURRENT_BUFFER_COUNT,
  TIMELINE_LEGACY_BUFFER_COUNT,
  validateRideTimelineTransfer,
  type RideTimelineTransfer,
} from "@openvibecoaster/simulator";

export interface CompiledTrackTransfer {
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly distances: Float64Array;
  readonly curvature: Float64Array;
  readonly curvatureVector: Float64Array;
  readonly bank: Float64Array;
  readonly bankDerivative: Float64Array;
  readonly zoneMasks: Uint32Array;
  readonly zoneNames: readonly string[];
  readonly elementIndices: Uint32Array;
  readonly elementBoundaries: Uint32Array;
  readonly parameters: Float64Array;
  readonly totalLength: number;
  readonly checksum: string;
}

export type EngineeringWorkerRequest =
  | {
      readonly type: "generate";
      readonly requestId: string;
      readonly intent: DesignIntentV1;
    }
  | {
      readonly type: "regenerate";
      readonly requestId: string;
      readonly file: unknown;
      readonly elementId: string;
    }
  | {
      readonly type: "compile-simulate";
      readonly requestId: string;
      readonly file: unknown;
    }
  | { readonly type: "cancel"; readonly requestId: string };

export type EngineeringWorkerTimings = {
  readonly simulationMs: number;
  readonly workerSendEpochMs: number;
};

export type EngineeringWorkerSuccess = {
  readonly type: "success";
  readonly requestId: string;
  readonly file: CoasterFileV1;
  readonly track: CompiledTrackTransfer;
  readonly timeline: RideTimelineTransfer;
  readonly diagnostics: readonly Diagnostic[];
  readonly relaxations: readonly string[];
  readonly spanHashes: Readonly<Record<string, string>>;
  readonly timings: EngineeringWorkerTimings;
};

export type EngineeringWorkerFailure = {
  readonly type: "failure";
  readonly requestId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly relaxations: readonly string[];
};

export type EngineeringWorkerCancelled = {
  readonly type: "cancelled";
  readonly requestId: string;
};

export type EngineeringWorkerResponse =
  | EngineeringWorkerSuccess
  | EngineeringWorkerFailure
  | EngineeringWorkerCancelled;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (path: string, reason: string): never => {
  throw new Error(`${path}: expected ${reason}`);
};

const stringNonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(path, "non-empty string");
  return value as string;
};

const validateRequestId = (value: unknown, path: string): string =>
  stringNonEmpty(value, path);

export function validateEngineeringWorkerRequest(
  value: unknown,
): asserts value is EngineeringWorkerRequest {
  if (!isRecord(value)) fail("request", "object");
  const rec = value as Record<string, unknown>;
  const type = rec.type as string;
  if (
    type !== "generate" &&
    type !== "regenerate" &&
    type !== "compile-simulate" &&
    type !== "cancel"
  )
    fail("request.type", "generate | regenerate | compile-simulate | cancel");
  validateRequestId(rec.requestId, "request.requestId");
  if (type === "generate") {
    const allowed = new Set(["type", "requestId", "intent"]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`request.${key}`, "no extra field");
    if (!isRecord(rec.intent)) fail("request.intent", "object");
    try {
      validateDesignIntentV1(rec.intent);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  } else if (type === "regenerate") {
    const allowed = new Set(["type", "requestId", "file", "elementId"]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`request.${key}`, "no extra field");
    stringNonEmpty(rec.elementId, "request.elementId");
    if (rec.file === undefined) fail("request.file", "file value");
    try {
      const fileVal = rec.file;
      if (typeof fileVal === "string" || fileVal instanceof Uint8Array) {
        deserializeCoasterFileV1(fileVal as string | Uint8Array);
      } else if (isRecord(fileVal)) {
        compileCoasterFile(fileVal as unknown as CoasterFileV1);
      } else {
        fail("request.file", "CoasterFileV1 object, string or Uint8Array");
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  } else if (type === "compile-simulate") {
    const allowed = new Set(["type", "requestId", "file"]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`request.${key}`, "no extra field");
    if (rec.file === undefined) fail("request.file", "file value");
    try {
      const fileVal = rec.file;
      if (typeof fileVal === "string" || fileVal instanceof Uint8Array) {
        deserializeCoasterFileV1(fileVal as string | Uint8Array);
      } else if (isRecord(fileVal)) {
        compileCoasterFile(fileVal as unknown as CoasterFileV1);
      } else {
        fail("request.file", "CoasterFileV1 object, string or Uint8Array");
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  } else {
    const allowed = new Set(["type", "requestId"]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`request.${key}`, "no extra field");
  }
}

export function isEngineeringWorkerRequest(
  value: unknown,
): value is EngineeringWorkerRequest {
  try {
    validateEngineeringWorkerRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function validateEngineeringWorkerResponse(
  value: unknown,
): asserts value is EngineeringWorkerResponse {
  if (!isRecord(value)) fail("response", "object");
  const rec = value as Record<string, unknown>;
  const type = rec.type as string;
  if (type !== "success" && type !== "failure" && type !== "cancelled")
    fail("response.type", "success | failure | cancelled");
  validateRequestId(rec.requestId, "response.requestId");
  if (type === "success") {
    if (!isRecord(rec.file)) fail("response.file", "object");
    if (!isRecord(rec.track)) fail("response.track", "object");
    if (!isRecord(rec.timeline)) fail("response.timeline", "object");
    if (!Array.isArray(rec.diagnostics)) fail("response.diagnostics", "array");
    if (!Array.isArray(rec.relaxations)) fail("response.relaxations", "array");
    if (!isRecord(rec.spanHashes)) fail("response.spanHashes", "object");
    const spanHashesRecord = rec.spanHashes as Record<string, unknown>;
    if (Object.keys(spanHashesRecord).length === 0)
      fail("response.spanHashes", "non-empty object");
    for (const [key, value] of Object.entries(spanHashesRecord)) {
      if (typeof key !== "string" || key.trim().length === 0)
        fail("response.spanHashes key", "non-empty string");
      if (typeof value !== "string" || !/^[0-9a-f]{8}$/i.test(value))
        fail(`response.spanHashes[${key}]`, "8-char hex");
    }
    if (!isRecord(rec.timings)) fail("response.timings", "object");
    const timings = rec.timings as Record<string, unknown>;
    const allowedTimings = new Set(["simulationMs", "workerSendEpochMs"]);
    for (const key of Object.keys(timings))
      if (!allowedTimings.has(key))
        fail(`response.timings.${key}`, "no extra field");
    if (
      typeof timings.simulationMs !== "number" ||
      !Number.isFinite(timings.simulationMs) ||
      timings.simulationMs < 0
    )
      fail("response.timings.simulationMs", "finite non-negative number");
    if (
      typeof timings.workerSendEpochMs !== "number" ||
      !Number.isFinite(timings.workerSendEpochMs) ||
      timings.workerSendEpochMs < 0
    )
      fail("response.timings.workerSendEpochMs", "finite non-negative number");
    // strict: no extra fields
    const allowed = new Set([
      "type",
      "requestId",
      "file",
      "track",
      "timeline",
      "diagnostics",
      "relaxations",
      "spanHashes",
      "timings",
    ]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`response.${key}`, "no extra field");
    // Validate file and track inner strictness via compile
    try {
      const fileVal = rec.file as unknown;
      if (typeof fileVal === "string" || fileVal instanceof Uint8Array)
        deserializeCoasterFileV1(fileVal as string | Uint8Array);
      else compileCoasterFile(fileVal as CoasterFileV1);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    // Validate track has required typed arrays and checksum matches file
    const track = rec.track as unknown as Record<string, unknown>;
    const requiredArrays: Array<[string, string]> = [
      ["positions", "Float64Array"],
      ["tangents", "Float64Array"],
      ["normals", "Float64Array"],
      ["binormals", "Float64Array"],
      ["distances", "Float64Array"],
      ["curvature", "Float64Array"],
      ["curvatureVector", "Float64Array"],
      ["bank", "Float64Array"],
      ["bankDerivative", "Float64Array"],
      ["zoneMasks", "Uint32Array"],
      ["elementIndices", "Uint32Array"],
      ["elementBoundaries", "Uint32Array"],
      ["parameters", "Float64Array"],
    ];
    for (const [name, kind] of requiredArrays) {
      const v = track[name];
      if (kind === "Float64Array" && !(v instanceof Float64Array))
        fail(`response.track.${name}`, "Float64Array");
      if (kind === "Uint32Array" && !(v instanceof Uint32Array))
        fail(`response.track.${name}`, "Uint32Array");
    }
    if (!Array.isArray(track.zoneNames))
      fail("response.track.zoneNames", "array");
    if (
      typeof track.totalLength !== "number" ||
      !Number.isFinite(track.totalLength)
    )
      fail("response.track.totalLength", "finite number");
    if (
      typeof track.checksum !== "string" ||
      !/^[0-9a-f]{8}$/i.test(track.checksum)
    )
      fail("response.track.checksum", "8-char hex");
    // timeline strict checks via central validator
    const tl = rec.timeline as unknown as Record<string, unknown>;
    if (
      typeof tl.sampleRateHz !== "number" ||
      !Number.isFinite(tl.sampleRateHz)
    )
      fail("response.timeline.sampleRateHz", "finite number");
    if (
      typeof tl.length !== "number" ||
      !Number.isInteger(tl.length) ||
      tl.length < 0
    )
      fail("response.timeline.length", "non-negative integer");
    if (!Array.isArray(tl.buffers)) fail("response.timeline.buffers", "array");
    for (let i = 0; i < (tl.buffers as unknown[]).length; i++)
      if (!((tl.buffers as unknown[])[i] instanceof ArrayBuffer))
        fail(`response.timeline.buffers[${i}]`, "ArrayBuffer");
    if (
      typeof tl.carCount !== "number" ||
      !Number.isInteger(tl.carCount as number)
    )
      fail("response.timeline.carCount", "non-negative integer");
    // enforce exact buffer counts and nested frames rejection
    const bufCount = (tl.buffers as unknown[]).length;
    if (
      bufCount !== TIMELINE_LEGACY_BUFFER_COUNT &&
      bufCount !== TIMELINE_CURRENT_BUFFER_COUNT
    )
      fail(
        "response.timeline.buffers",
        `ArrayBuffer count must be exactly ${TIMELINE_LEGACY_BUFFER_COUNT} or ${TIMELINE_CURRENT_BUFFER_COUNT}`,
      );
    if ("frames" in tl && tl.frames !== undefined)
      fail("response.timeline.frames", "must be absent for compact worker");
    // central shape validation using views/byte lengths without copying payload
    try {
      validateRideTimelineTransfer(tl as unknown as RideTimelineTransfer);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  } else if (type === "failure") {
    if (!Array.isArray(rec.diagnostics)) fail("response.diagnostics", "array");
    if (!Array.isArray(rec.relaxations)) fail("response.relaxations", "array");
    const allowed = new Set([
      "type",
      "requestId",
      "diagnostics",
      "relaxations",
    ]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`response.${key}`, "no extra field");
  } else {
    const allowed = new Set(["type", "requestId"]);
    for (const key of Object.keys(rec))
      if (!allowed.has(key)) fail(`response.${key}`, "no extra field");
  }
}
