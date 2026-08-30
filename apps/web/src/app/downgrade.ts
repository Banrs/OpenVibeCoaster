import type { AppState } from "../viewState.js";

export function downgradeIfNoTrack(
  status: AppState["generationStatus"],
  hasTrack: boolean,
): AppState["generationStatus"] {
  if (!hasTrack && (status === "ready" || status === "generating")) {
    return "error";
  }
  return status;
}
