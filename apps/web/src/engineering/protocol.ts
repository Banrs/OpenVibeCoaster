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
import type { RideTimelineTransfer } from "@openvibecoaster/simulator";

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

export type EngineeringWorkerSuccess = {
  readonly type: "success";
  readonly requestId: string;
  readonly file: CoasterFileV1;
  readonly track: CompiledTrackTransfer;
  readonly timeline: RideTimelineTransfer;
  readonly diagnostics: readonly Diagnostic[];
  readonly relaxations: readonly string[];
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
  } else if (type === "failure") {
    if (!Array.isArray(rec.diagnostics)) fail("response.diagnostics", "array");
    if (!Array.isArray(rec.relaxations)) fail("response.relaxations", "array");
  }
}
