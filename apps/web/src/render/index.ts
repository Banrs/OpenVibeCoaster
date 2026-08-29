export {
  createDeterministicHeightfield,
  buildTerrainMesh,
  createTerrainGroup,
} from "./terrain.js";
export type { TerrainGroup } from "./terrain.js";
export { buildTrackGeometries } from "./trackGeometry.js";
export type {
  TrackGeometries,
  BuildTrackOptions,
  MetricId,
  MetricData as TrackMetricData,
} from "./trackGeometry.js";
export {
  createTrainGroup,
  getCarTransforms,
  updateTrainTransforms,
  TRAIN_CAR_COUNT,
  CAR_PITCH_M,
} from "./train.js";
export type { TrainGroup, CarTransform } from "./train.js";
export { buildSupportColumns } from "./supports.js";
export type { SupportResult } from "./supports.js";
export {
  CAMERA_IDS,
  clampFovForSpeed,
  getCameraState,
  selectCamera,
} from "./cameras.js";
export type { CameraState, CameraId as RenderCameraId } from "./cameras.js";
export { createRendererHandle, disposeScene } from "./renderer.js";
export type { RendererHandle, CreateRendererOptions } from "./renderer.js";
export { RenderMetrics } from "./metrics.js";
export type { MetricsSnapshot } from "./metrics.js";
export {
  createHighlightMarker,
  updateHighlightMarker,
  disposeHighlightMarker,
  normalizeHighlightDistance,
} from "./highlight.js";
export type { HighlightMarker } from "./highlight.js";
