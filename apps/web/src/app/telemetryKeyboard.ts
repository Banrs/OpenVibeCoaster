import { getCanvasKeyboardAction } from "../accessibility.js";

export function getTelemetryNextIndex(
  currentIndex: number,
  key: string,
  count: number,
): number {
  if (!Number.isFinite(currentIndex) || !Number.isFinite(count) || count <= 0)
    return 0;
  const clamped = Math.max(0, Math.min(count - 1, Math.trunc(currentIndex)));
  const action = getCanvasKeyboardAction(key);
  switch (action) {
    case "previous":
      return Math.max(0, clamped - 1);
    case "next":
      return Math.min(count - 1, clamped + 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "none":
    default:
      return clamped;
  }
}
