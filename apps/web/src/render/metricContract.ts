export const METRIC_IDS = [
  "speed",
  "gForce",
  "rollRate",
  "clearance",
  "height",
  "energy",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export interface MetricData {
  speed?: Float64Array | undefined;
  gForce?: Float64Array | undefined;
  rollRate?: Float64Array | undefined;
  clearance?: Float64Array | undefined;
  energy?: Float64Array | undefined;
}
