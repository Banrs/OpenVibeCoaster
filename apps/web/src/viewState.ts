export type GenerationStatus = "pending" | "ready" | "generating" | "error";
export type AppMode = "edit" | "ride";
export type CameraId = "front" | "middle" | "rear" | "chase" | "orbit";
export type MetricId =
  "speed" | "gForce" | "rollRate" | "clearance" | "height" | "energy";
export type DataAction =
  | "generate"
  | "save"
  | "load"
  | "export"
  | "scrub"
  | "playback"
  | "seamInspect"
  | "localRegenerate";

export const CAMERA_IDS: readonly CameraId[] = [
  "front",
  "middle",
  "rear",
  "chase",
  "orbit",
] as const;

export const METRIC_IDS: readonly MetricId[] = [
  "speed",
  "gForce",
  "rollRate",
  "clearance",
  "height",
  "energy",
] as const;

export const PLAYBACK_SPEED_MIN = 0.25;
export const PLAYBACK_SPEED_MAX = 2;

export interface AppState {
  generationStatus: GenerationStatus;
  appMode: AppMode;
  camera: CameraId;
  metric: MetricId;
  seatIndex: number;
  seatCount: number;
  playbackSpeed: number;
  isPaused: boolean;
  reducedMotion: boolean;
  isMuted: boolean;
  seed: string;
}

export function createInitialState(): AppState {
  return {
    generationStatus: "pending",
    appMode: "edit",
    camera: "chase",
    metric: "speed",
    seatIndex: 0,
    seatCount: 4,
    playbackSpeed: 1,
    isPaused: true,
    reducedMotion: false,
    isMuted: false,
    seed: "",
  };
}

export function getStatusText(status: GenerationStatus): string {
  switch (status) {
    case "pending":
      return "Generation pending — configure intent and generate";
    case "ready":
      return "Ready — track data loaded";
    case "generating":
      return "Generating…";
    case "error":
      return "Action failed — canonical track validation unavailable until integration";
    default:
      return "Unknown status";
  }
}

export function isDataReady(status: GenerationStatus): boolean {
  return status === "ready";
}

export function getActionEnabled(
  action: DataAction,
  status: GenerationStatus,
): boolean {
  // Load and generate are always available except generate during generating.
  if (action === "load") {
    return true;
  }
  if (action === "generate") {
    return status !== "generating";
  }
  // All other actions require ready data.
  return status === "ready";
}

export interface PanelVisibility {
  topBarVisible: boolean;
  leftRailVisible: boolean;
  rightInspectorVisible: boolean;
  telemetryVisible: boolean;
  viewportFocused: boolean;
  cameraControlsVisible: boolean;
}

export function getPanelVisibility(state: AppState): PanelVisibility {
  const isRide = state.appMode === "ride";
  return {
    topBarVisible: true,
    leftRailVisible: !isRide,
    rightInspectorVisible: !isRide,
    telemetryVisible: !isRide,
    viewportFocused: isRide,
    cameraControlsVisible: true,
  };
}

export function clampPlaybackSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) {
      return 1;
    }
    return value > 0 ? PLAYBACK_SPEED_MAX : PLAYBACK_SPEED_MIN;
  }
  if (value < PLAYBACK_SPEED_MIN) {
    return PLAYBACK_SPEED_MIN;
  }
  if (value > PLAYBACK_SPEED_MAX) {
    return PLAYBACK_SPEED_MAX;
  }
  return value;
}

export function isPlaybackSpeedValid(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= PLAYBACK_SPEED_MIN &&
    value <= PLAYBACK_SPEED_MAX
  );
}

export function selectCamera(
  requested: CameraId,
  fallback: CameraId,
): CameraId {
  if ((CAMERA_IDS as readonly string[]).includes(requested)) {
    return requested;
  }
  return fallback;
}

export function selectMetric(
  requested: MetricId,
  fallback: MetricId,
): MetricId {
  if ((METRIC_IDS as readonly string[]).includes(requested)) {
    return requested;
  }
  return fallback;
}

export function selectSeat(
  requested: number,
  seatCount: number,
  fallback: number,
): number {
  if (
    !Number.isInteger(requested) ||
    !Number.isInteger(seatCount) ||
    seatCount <= 0
  ) {
    return fallback;
  }
  if (requested < 0 || requested >= seatCount) {
    return fallback;
  }
  return requested;
}

export function getReducedMotionState(
  prefersReducedMotion: boolean,
  userOverride: boolean | null,
): boolean {
  if (userOverride !== null) {
    return userOverride;
  }
  return prefersReducedMotion;
}

export function getCanvasAriaLabel(status: GenerationStatus): string {
  if (status === "pending") {
    return "Viewport — generation pending, no track to display";
  }
  if (status === "generating") {
    return "Viewport — generating track";
  }
  return "Viewport — track preview";
}

export function getLayoutClass(state: AppState): string {
  const parts = ["layout"];
  parts.push(`mode-${state.appMode}`);
  parts.push(`status-${state.generationStatus}`);
  if (state.reducedMotion) {
    parts.push("reduced-motion");
  }
  return parts.join(" ");
}

export function getNextStatusAfterGenerate(
  _current: GenerationStatus,
): GenerationStatus {
  // Wave 1 shell has no canonical worker data or CompiledTrackData yet; never claim ready.
  return "error";
}

export function getNextStatusAfterLoad(
  _payload: unknown,
  _current: GenerationStatus,
): GenerationStatus {
  // Wave 1 has no real CoasterFileV1 parser or CompiledTrackData integration.
  // JSON is parsed only to distinguish malformed input; canonical validation is unavailable,
  // so we never transition to ready. Always return error to keep data-dependent actions disabled.
  return "error";
}
