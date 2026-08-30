import type { CoasterFileV1, CompiledTrackData } from "@openvibecoaster/core";

export function getElementCompiledRange(
  elementId: string,
  file: CoasterFileV1,
  track: CompiledTrackData,
): { start: number; end: number } | null {
  const solvedSpans = file.solvedSpans;
  let firstSpanIndex: number | null = null;
  let lastSpanIndex: number | null = null;
  for (let i = 0; i < solvedSpans.length; i++) {
    const sid = solvedSpans[i]!.id;
    if (sid === elementId || sid.startsWith(`${elementId}#`)) {
      if (firstSpanIndex === null) firstSpanIndex = i;
      lastSpanIndex = i;
    }
  }
  if (firstSpanIndex === null || lastSpanIndex === null) return null;
  const boundaries = track.elementBoundaries;
  const start = boundaries[firstSpanIndex * 2];
  const end = boundaries[lastSpanIndex * 2 + 1];
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

export function getSemanticSeamIndices(
  file: CoasterFileV1,
  track: CompiledTrackData,
): number[] {
  const elements = file.intent.elements;
  if (elements.length < 2) return [];
  const canonicalSet = new Set<number>(Array.from(track.elementBoundaries));
  const seen = new Set<number>();
  const result: number[] = [];
  const lastSample = track.distances.length - 1;
  for (let i = 0; i < elements.length - 1; i++) {
    const el = elements[i]!;
    const range = getElementCompiledRange(el.id, file, track);
    if (!range) continue;
    const seamIdx = range.end;
    if (seamIdx === 0 || seamIdx === lastSample) continue;
    if (seen.has(seamIdx)) continue;
    if (!canonicalSet.has(seamIdx)) continue;
    seen.add(seamIdx);
    result.push(seamIdx);
  }
  return result.sort((a, b) => a - b);
}
