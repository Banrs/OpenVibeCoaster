import {
  arcLength,
  type Diagnostic,
  type EnvironmentQuery,
  type SolvedSpan,
  vec3Distance,
} from "@openvibecoaster/core";
import type { ClearanceOptions } from "./types";

interface Sample {
  readonly spanIndex: number;
  readonly local: number;
  readonly s: number;
  readonly point: readonly [number, number, number];
}

export const validateClearance = (
  spans: readonly SolvedSpan[],
  environment: EnvironmentQuery | undefined,
  options: ClearanceOptions = {},
): readonly Diagnostic[] => {
  const radius = options.trainEnvelopeRadius ?? 2;
  if (!Number.isFinite(radius) || radius < 0)
    throw new RangeError(
      "Train envelope radius must be non-negative and finite",
    );
  const count = Math.max(2, Math.floor(options.samplesPerSpan ?? 33));
  const samples: Sample[] = [];
  let distance = 0;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const length = arcLength(span.span, 0, 1);
    for (let index = 0; index < count; index += 1) {
      const local = index / (count - 1);
      samples.push({
        spanIndex,
        local,
        s: distance + length * local,
        point: span.span.position(local),
      });
    }
    distance += length;
  }
  const diagnostics: Diagnostic[] = [];
  if (environment) {
    for (const sample of samples) {
      const actual = environment.sampleSolid
        ? environment.sampleSolid(sample.point)
        : environment.signedDistance(sample.point);
      const margin = actual - radius;
      if (margin < 0)
        diagnostics.push({
          code: "TERRAIN_CLEARANCE",
          severity: "error",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Terrain clearance is ${margin.toFixed(6)} m at s=${sample.s.toFixed(6)} m`,
          location: { s: sample.s, position: sample.point },
          actual,
          limit: radius,
          margin,
          relatedIds: [spans[sample.spanIndex]!.id],
        });
    }
  }
  const cellSize = Math.max(1, options.trackClearance ?? radius * 2);
  const buckets = new Map<string, Sample[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
  for (const sample of samples) {
    const [x, y, z] = sample.point;
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dz = -1; dz <= 1; dz += 1) {
          const nearby = buckets.get(key(cx + dx, cy + dy, cz + dz));
          if (!nearby) continue;
          for (const other of nearby) {
            if (other.spanIndex >= sample.spanIndex - 1) continue;
            const actual = vec3Distance(sample.point, other.point);
            const margin = actual - radius * 2;
            if (margin < 0)
              diagnostics.push({
                code: "TRACK_CLEARANCE",
                severity: "error",
                provenance: "PROJECT_ENGINEERING_LIMIT",
                message: `Track clearance is ${margin.toFixed(6)} m at s=${sample.s.toFixed(6)} m`,
                location: { s: sample.s, position: sample.point },
                actual,
                limit: radius * 2,
                margin,
                relatedIds: [
                  spans[other.spanIndex]!.id,
                  spans[sample.spanIndex]!.id,
                ],
              });
          }
        }
    const bucket = buckets.get(key(cx, cy, cz)) ?? [];
    bucket.push(sample);
    buckets.set(key(cx, cy, cz), bucket);
  }
  return Object.freeze(diagnostics);
};
