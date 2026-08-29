import { CompiledTrackData } from "@openvibecoaster/core";
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
  return {
    track,
    timeline,
    file: success.file,
    spanHashes: success.spanHashes,
  };
}
