import {
  arcLength,
  type Diagnostic,
  type EnvironmentQuery,
  type SolvedSpan,
  type Vec3,
  vec3,
} from "@openvibecoaster/core";
import type { ClearanceOptions } from "./types";

interface Segment {
  readonly segmentId: number;
  readonly spanIndex: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly startS: number;
  readonly endS: number;
}
interface ClosestPair {
  readonly distance: number;
  readonly firstT: number;
}

const min = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]));
const max = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
const expand = (point: Vec3, amount: number): Vec3 =>
  vec3(point[0] - amount, point[1] - amount, point[2] - amount);
const expandMax = (point: Vec3, amount: number): Vec3 =>
  vec3(point[0] + amount, point[1] + amount, point[2] + amount);
const aabb = (segment: Segment, amount: number): readonly [Vec3, Vec3] => [
  expand(min(segment.start, segment.end), amount),
  expandMax(max(segment.start, segment.end), amount),
];
const overlaps = (
  left: readonly [Vec3, Vec3],
  right: readonly [Vec3, Vec3],
): boolean =>
  left[0][0] <= right[1][0] &&
  right[0][0] <= left[1][0] &&
  left[0][1] <= right[1][1] &&
  right[0][1] <= left[1][1] &&
  left[0][2] <= right[1][2] &&
  right[0][2] <= left[1][2];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const scale = (a: Vec3, value: number): Vec3 =>
  vec3(a[0] * value, a[1] * value, a[2] * value);
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

const segmentDistance = (first: Segment, second: Segment): ClosestPair => {
  const p = first.start;
  const q = second.start;
  const d1 = sub(first.end, p);
  const d2 = sub(second.end, q);
  const r = sub(p, q);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  const epsilon = 1e-14;
  if (a <= epsilon && e <= epsilon) return { distance: length(r), firstT: 0 };
  if (a <= epsilon) {
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= epsilon) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      if (denominator !== 0)
        s = Math.max(0, Math.min(1, (b * f - c * e) / denominator));
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const delta = sub(add(p, scale(d1, s)), add(q, scale(d2, t)));
  return { distance: length(delta), firstT: s };
};

const adjacent = (first: Segment, second: Segment): boolean => {
  if (first.spanIndex === second.spanIndex)
    return Math.abs(first.segmentIndex - second.segmentIndex) <= 1;
  if (Math.abs(first.spanIndex - second.spanIndex) !== 1) return false;
  const left = first.spanIndex < second.spanIndex ? first : second;
  const right = first.spanIndex < second.spanIndex ? second : first;
  return (
    left.segmentIndex + 1 === left.segmentCount && right.segmentIndex === 0
  );
};

const diagnostic = (
  code: "TERRAIN_CLEARANCE" | "TRACK_CLEARANCE",
  message: string,
  segment: Segment,
  position: Vec3,
  actual: number,
  limit: number,
  s: number,
  relatedIds: readonly string[],
): Diagnostic => ({
  code,
  severity: "error",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  message,
  location: {
    s,
    position,
  },
  actual,
  limit,
  margin: actual - limit,
  relatedIds,
});

export const validateClearance = (
  spans: readonly SolvedSpan[],
  environment: EnvironmentQuery | undefined,
  options: ClearanceOptions = {},
): readonly Diagnostic[] => {
  const radius = options.trainEnvelopeRadius ?? 0;
  const requestedClearance = options.trackClearance ?? 0;
  const count = options.samplesPerSpan ?? 33;
  if (!Number.isFinite(radius) || radius < 0)
    throw new RangeError(
      "Train envelope radius must be non-negative and finite",
    );
  if (!Number.isFinite(requestedClearance) || requestedClearance < 0)
    throw new RangeError("Track clearance must be non-negative and finite");
  if (!Number.isInteger(count) || count < 2)
    throw new RangeError(
      "Clearance samples per span must be an integer of at least 2",
    );
  const segments: Segment[] = [];
  let distance = 0;
  let segmentId = 0;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const spanLength = arcLength(span.span, 0, 1);
    for (let index = 0; index < count - 1; index += 1) {
      const startU = index / (count - 1);
      const endU = (index + 1) / (count - 1);
      const segment = {
        segmentId,
        spanIndex,
        segmentIndex: index,
        segmentCount: count - 1,
        start: span.span.position(startU),
        end: span.span.position(endU),
        startS: distance + spanLength * startU,
        endS: distance + spanLength * endU,
      };
      segmentId += 1;
      segments.push(segment);
    }
    distance += spanLength;
  }
  const diagnostics: Diagnostic[] = [];
  if (environment) {
    const terrainDistance = (span: SolvedSpan, u: number): number =>
      environment.signedDistance(span.span.position(u)) - radius;
    for (const segment of segments) {
      const span = spans[segment.spanIndex]!;
      const startU = segment.segmentIndex / segment.segmentCount;
      const endU = (segment.segmentIndex + 1) / segment.segmentCount;
      const report = (u: number, actual: number): void => {
        if (actual <= 0) {
          const point = span.span.position(u);
          const sampleS =
            segment.startS +
            (segment.endS - segment.startS) * ((u - startU) / (endU - startU));
          diagnostics.push(
            diagnostic(
              "TERRAIN_CLEARANCE",
              `Terrain clearance is ${actual.toFixed(6)} m at s=${sampleS.toFixed(6)} m`,
              segment,
              point,
              actual,
              0,
              sampleS,
              [span.id],
            ),
          );
        }
      };
      const sweptTolerance = 1e-3;
      const recurse = (
        leftU: number,
        rightU: number,
        leftDistance: number,
        rightDistance: number,
      ): void => {
        report(leftU, leftDistance);
        report(rightU, rightDistance);
        if (leftDistance <= 0 || rightDistance <= 0) return;
        const leftPoint = span.span.position(leftU);
        const rightPoint = span.span.position(rightU);
        const chordLength = length(sub(rightPoint, leftPoint));
        if (
          Math.min(leftDistance, rightDistance) - chordLength >
          sweptTolerance
        )
          return;
        const middleU = (leftU + rightU) / 2;
        const middleDistance = terrainDistance(span, middleU);
        report(middleU, middleDistance);
        if (middleDistance <= 0) return;
        if (
          chordLength <= sweptTolerance ||
          middleU === leftU ||
          middleU === rightU
        )
          return;
        recurse(leftU, middleU, leftDistance, middleDistance);
        recurse(middleU, rightU, middleDistance, rightDistance);
      };
      recurse(
        startU,
        endU,
        terrainDistance(span, startU),
        terrainDistance(span, endU),
      );
    }
  }
  const limit = radius * 2 + requestedClearance;
  const cellSize = limit > 0 ? limit : 1;
  const buckets = new Map<string, Segment[]>();
  const seenPairs = new Set<string>();
  const bucketKey = (x: number, y: number, z: number): string =>
    `${x},${y},${z}`;
  const bucketRange = (
    box: readonly [Vec3, Vec3],
  ): readonly [number, number][] =>
    [0, 1, 2].map((axis) => [
      Math.floor(box[0][axis]! / cellSize),
      Math.floor(box[1][axis]! / cellSize),
    ]);
  for (const segment of segments) {
    const box = aabb(segment, limit);
    const ranges = bucketRange(box);
    for (let x = ranges[0]![0]; x <= ranges[0]![1]; x += 1)
      for (let y = ranges[1]![0]; y <= ranges[1]![1]; y += 1)
        for (let z = ranges[2]![0]; z <= ranges[2]![1]; z += 1) {
          const key = bucketKey(x, y, z);
          const candidates = buckets.get(key) ?? [];
          for (const other of candidates) {
            if (other === segment || adjacent(other, segment)) continue;
            const pairKey =
              other.segmentId < segment.segmentId
                ? `${other.segmentId}:${segment.segmentId}`
                : `${segment.segmentId}:${other.segmentId}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            if (!overlaps(aabb(other, limit), box)) continue;
            const closest = segmentDistance(other, segment);
            const clearanceTolerance = 1e-10 * Math.max(1, limit);
            if (closest.distance <= limit + clearanceTolerance) {
              const point = add(
                other.start,
                scale(sub(other.end, other.start), closest.firstT),
              );
              diagnostics.push(
                diagnostic(
                  "TRACK_CLEARANCE",
                  `Track clearance is ${(closest.distance - limit).toFixed(6)} m at s=${(other.startS + (other.endS - other.startS) * closest.firstT).toFixed(6)} m`,
                  other,
                  point,
                  closest.distance,
                  limit,
                  other.startS + (other.endS - other.startS) * closest.firstT,
                  [spans[other.spanIndex]!.id, spans[segment.spanIndex]!.id],
                ),
              );
            }
          }
          candidates.push(segment);
          buckets.set(key, candidates);
        }
  }
  return Object.freeze(diagnostics);
};
