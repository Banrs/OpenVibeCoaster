export * from "./types";
export {
  buildElement,
  createElement,
  defaultPose,
  stableElementId,
  validateElement,
} from "./elements";
export {
  boundedLevenbergMarquardt,
  compileElements,
  compileSemanticChain,
  diagnoseSeams,
  solveSemanticChain,
  solveTrack,
} from "./solver";
export {
  coasterFileSpanHashes,
  compileCoasterFile,
  generate,
  generateCoaster,
  isClosedChain,
  localRegenerate,
  regenerateCoasterFileLocal,
  regenerateLocal,
} from "./pipeline";
export { validateClearance } from "./clearance";
export * from "./clearance-field.js";
export type {
  CertifiedDistanceResult,
  ClearancePose,
  ClearanceTrainGeometry,
  SweptClearanceSegment,
} from "./clearance-geometry";
export { certifiedSweptDistance } from "./clearance-geometry";
export {
  certifyFootprintSpan,
  certifyFootprintSpans,
  scaffoldFitsFootprintPolygon,
  type FootprintSpanStatus,
} from "./footprint-certifier";
