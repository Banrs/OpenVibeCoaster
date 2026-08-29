export function recordMeasure(name: string, start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  try {
    performance.measure(name, { start, end });
  } catch {
    // if recording throws, emit nothing
  }
}
