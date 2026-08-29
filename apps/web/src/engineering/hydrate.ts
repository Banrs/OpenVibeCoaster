import {
  CompiledTrackData,
  type Diagnostic,
  type Vec3,
} from "@openvibecoaster/core";
import { RideTimeline } from "@openvibecoaster/simulator";
import {
  validateEngineeringWorkerResponse,
  type EngineeringWorkerSuccess,
} from "./protocol";

/**
 * App-boundary hydration: validates a success response and constructs
 * real core CompiledTrackData and simulator RideTimeline without parallel
 * representations or JSON round-trip of typed arrays.
 */
export function hydrateEngineeringSuccess(response: unknown): {
  readonly track: CompiledTrackData;
  readonly timeline: RideTimeline;
  readonly file: EngineeringWorkerSuccess["file"];
  readonly spanHashes: Readonly<Record<string, string>>;
  readonly diagnostics: readonly import("@openvibecoaster/core").Diagnostic[];
  readonly relaxations: readonly string[];
} {
  validateEngineeringWorkerResponse(response);
  const success = response as EngineeringWorkerSuccess;
  if (success.type !== "success") throw new Error("Expected success response");
  // Construct real core track – CompiledTrackData copies buffers, no aliasing
  const track = new CompiledTrackData({
    positions: success.track.positions,
    tangents: success.track.tangents,
    normals: success.track.normals,
    binormals: success.track.binormals,
    distances: success.track.distances,
    curvature: success.track.curvature,
    curvatureVector: success.track.curvatureVector,
    bank: success.track.bank,
    bankDerivative: success.track.bankDerivative,
    zoneMasks: success.track.zoneMasks,
    zoneNames: [...success.track.zoneNames],
    elementIndices: success.track.elementIndices,
    elementBoundaries: success.track.elementBoundaries,
    parameters: success.track.parameters,
    totalLength: success.track.totalLength,
  });
  // Checksum equality – transfer checksum must equal reconstructed track checksum
  if (track.checksum !== success.track.checksum)
    throw new Error(
      `Checksum mismatch: transfer ${success.track.checksum} vs constructed ${track.checksum}`,
    );
  // Also must equal file's compiledDataChecksum (canonical compilation)
  if (
    track.checksum.toLowerCase() !==
    success.file.compiledDataChecksum.toLowerCase()
  )
    throw new Error(
      `File checksum mismatch: file ${success.file.compiledDataChecksum} vs track ${track.checksum}`,
    );
  const timeline = RideTimeline.fromTransferable(success.timeline);
  // Deep owned/frozen copies – caller mutation cannot affect hydrated values, no JSON round-trip
  // CoasterFileV1 is JSON-like after structuredClone: deep-freeze plain arrays/objects.
  // If an ArrayBuffer view is encountered, JS cannot freeze a non-empty typed array
  // (throws) – preserve ownership safely and return without claiming it was frozen, no throw.
  const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (value === null || typeof value !== "object") return value;
    const obj = value as unknown as object;
    if (seen.has(obj)) return value;
    seen.add(obj);
    if (
      ArrayBuffer.isView(value as unknown as ArrayBufferView) ||
      value instanceof ArrayBuffer
    ) {
      // Preserve ownership; do not enumerate indices and do not claim frozen for typed views
      return value;
    }
    for (const key of Object.getOwnPropertyNames(obj as object)) {
      const child = (value as unknown as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object")
        deepFreeze(child as unknown, seen);
    }
    return Object.freeze(value as unknown as T) as T;
  };
  const diagnostics = Object.freeze(
    success.diagnostics.map((d) => {
      const copy: Diagnostic = {
        ...d,
        ...(d.location
          ? {
              location: {
                ...d.location,
                ...(d.location.position
                  ? { position: [...d.location.position] as Vec3 }
                  : {}),
              },
            }
          : {}),
        ...(d.relatedIds ? { relatedIds: [...d.relatedIds] } : {}),
      };
      // Explicitly freeze nested hydration-owned containers (required by review)
      if (copy.location) Object.freeze(copy.location);
      if (copy.location?.position)
        Object.freeze(copy.location.position as unknown as object);
      if (copy.relatedIds) Object.freeze(copy.relatedIds as unknown as object);
      return deepFreeze(Object.freeze(copy));
    }),
  );
  const relaxations = Object.freeze([...success.relaxations]);
  const spanHashes = Object.freeze({ ...success.spanHashes });
  const rawFile = structuredClone(success.file);
  const file = deepFreeze(Object.freeze(rawFile));
  return {
    track,
    timeline,
    file,
    spanHashes,
    diagnostics,
    relaxations,
  };
}
