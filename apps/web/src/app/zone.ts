import type { CompiledTrackData } from "@openvibecoaster/core";

export function resolveZoneMask(
  track: CompiledTrackData,
  distance: number,
): number {
  const distances = track.distances;
  const zoneMasks = track.zoneMasks;
  if (distances.length === 0) return 0;
  if (!Number.isFinite(distance)) return zoneMasks[0] ?? 0;
  const first = distances[0]!;
  const last = distances[distances.length - 1]!;
  if (distance <= first) return zoneMasks[0] ?? 0;
  if (distance >= last) return zoneMasks[zoneMasks.length - 1] ?? 0;
  let low = 0;
  let high = distances.length - 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (distances[mid]! <= distance) low = mid;
    else high = mid;
  }
  const dLow = Math.abs(distances[low]! - distance);
  const dHigh = Math.abs(distances[high]! - distance);
  const idx = dLow <= dHigh ? low : high;
  return zoneMasks[idx] ?? 0;
}
