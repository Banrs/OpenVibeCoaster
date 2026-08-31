import type { CompiledTrackData } from "@openvibecoaster/core";
import type { RideTimeline } from "@openvibecoaster/simulator";

export function computeTelemetrySignature(
  track: CompiledTrackData,
  timeline: RideTimeline,
): string {
  const checksum = track.checksum.toLowerCase();
  const len = timeline.length;
  const timeSeconds = timeline.timeSeconds;
  const speedMps = timeline.speedMps;
  const headDistanceM = timeline.headDistanceM;
  const duration = timeSeconds[len - 1] ?? 0;
  let hash = 0x811c9dc5;
  const update = (v: number) => {
    const s = v.toFixed(6);
    for (let i = 0; i < s.length; i++) {
      hash = Math.imul(hash ^ s.charCodeAt(i), 0x01000193);
    }
  };
  for (let i = 0; i < Math.min(len, 64); i++) {
    update(speedMps[i] ?? 0);
    update(headDistanceM[i] ?? 0);
  }
  update(len);
  update(duration);
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${checksum}-${hex}-${len}-${duration.toFixed(2)}`;
}
