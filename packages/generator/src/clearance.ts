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
  readonly startU: number;
  readonly endU: number;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly startS: number;
  readonly endS: number;
  readonly curveError: number;
  readonly bounds: readonly [Vec3, Vec3];
}

interface ClosestPair {
  readonly distance: number;
  readonly firstU: number;
  readonly secondU: number;
  readonly firstPosition: Vec3;
  readonly secondPosition: Vec3;
}

const CURVE_POSITION_TOLERANCE = 2;
const CURVE_TANGENT_TOLERANCE = 0.2;
const TERRAIN_CERTIFICATION_EPSILON = 1e-10;
const TERRAIN_CERTIFICATION_MAX_DEPTH = 24;
const TERRAIN_CERTIFICATION_MAX_WORK = 100_000;

const min = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]));
const max = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
const expand = (point: Vec3, amount: number): Vec3 =>
  vec3(point[0] - amount, point[1] - amount, point[2] - amount);
const expandMax = (point: Vec3, amount: number): Vec3 =>
  vec3(point[0] + amount, point[1] + amount, point[2] + amount);
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const scale = (a: Vec3, value: number): Vec3 =>
  vec3(a[0] * value, a[1] * value, a[2] * value);
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.acos(
    Math.max(
      -1,
      Math.min(1, dot(a, b) / Math.max(1e-30, length(a) * length(b))),
    ),
  );

const distanceToChord = (point: Vec3, start: Vec3, end: Vec3): number => {
  const direction = sub(end, start);
  const denominator = dot(direction, direction);
  const parameter =
    denominator > 0
      ? clamp(dot(sub(point, start), direction) / denominator)
      : 0;
  return length(sub(point, add(start, scale(direction, parameter))));
};

const curvePoint = (
  segment: Segment,
  t: number,
  spans: readonly SolvedSpan[],
): Vec3 =>
  spans[segment.spanIndex]!.span.position(
    segment.startU + (segment.endU - segment.startU) * clamp(t),
  );
const curveParameter = (segment: Segment, t: number): number =>
  segment.startU + (segment.endU - segment.startU) * clamp(t);
const curveDerivative = (
  segment: Segment,
  t: number,
  spans: readonly SolvedSpan[],
  order = 1,
): Vec3 => {
  const width = segment.endU - segment.startU;
  return scale(
    spans[segment.spanIndex]!.span.derivative(
      curveParameter(segment, t),
      order,
    ),
    width ** order,
  );
};

const sweptBounds = (
  points: readonly Vec3[],
  amount: number,
): readonly [Vec3, Vec3] => {
  let lower = points[0]!;
  let upper = points[0]!;
  for (const point of points.slice(1)) {
    lower = min(lower, point);
    upper = max(upper, point);
  }
  return [expand(lower, amount), expandMax(upper, amount)];
};

const segmentDistance = (
  first: Segment,
  second: Segment,
): readonly [number, number] => {
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
  if (a <= epsilon && e <= epsilon) return [0, 0];
  if (a <= epsilon) t = clamp(f / e);
  else {
    const c = dot(d1, r);
    if (e <= epsilon) s = clamp(-c / a);
    else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      if (denominator !== 0) s = clamp((b * f - c * e) / denominator);
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  return [s, t];
};

const refineClosestPair = (
  first: Segment,
  second: Segment,
  spans: readonly SolvedSpan[],
  initial: readonly [number, number],
): ClosestPair => {
  let u = clamp(initial[0]);
  let v = clamp(initial[1]);
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const firstPosition = curvePoint(first, u, spans);
    const secondPosition = curvePoint(second, v, spans);
    const delta = sub(firstPosition, secondPosition);
    const firstDerivative = curveDerivative(first, u, spans);
    const secondDerivative = curveDerivative(second, v, spans);
    const firstSecondDerivative = curveDerivative(first, u, spans, 2);
    const secondSecondDerivative = curveDerivative(second, v, spans, 2);
    const g1 = dot(delta, firstDerivative);
    const g2 = dot(delta, secondDerivative);
    const j11 =
      dot(firstDerivative, firstDerivative) + dot(delta, firstSecondDerivative);
    const j12 = -dot(firstDerivative, secondDerivative);
    const j21 = dot(firstDerivative, secondDerivative);
    const j22 =
      -dot(secondDerivative, secondDerivative) +
      dot(delta, secondSecondDerivative);
    const determinant = j11 * j22 - j12 * j21;
    if (Math.abs(determinant) <= 1e-18) break;
    const deltaU = (g1 * j22 - j12 * g2) / determinant;
    const deltaV = (j11 * g2 - g1 * j21) / determinant;
    const nextU = clamp(u - deltaU);
    const nextV = clamp(v - deltaV);
    u = nextU;
    v = nextV;
    if (Math.max(Math.abs(deltaU), Math.abs(deltaV)) < 1e-10) break;
  }
  const firstPosition = curvePoint(first, u, spans);
  const secondPosition = curvePoint(second, v, spans);
  return {
    distance: length(sub(firstPosition, secondPosition)),
    firstU: curveParameter(first, u),
    secondU: curveParameter(second, v),
    firstPosition,
    secondPosition,
  };
};

const closestPair = (
  first: Segment,
  second: Segment,
  spans: readonly SolvedSpan[],
): ClosestPair => {
  const lineSeed = segmentDistance(first, second);
  const seeds: readonly (readonly [number, number])[] = [
    lineSeed,
    [0, 0],
    [1, 1],
    [0.5, 0.5],
  ];
  let best: ClosestPair | undefined;
  for (const seed of seeds) {
    const candidate = refineClosestPair(first, second, spans, seed);
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best!;
};

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

const adjacent = (first: Segment, second: Segment): boolean => {
  if (first.spanIndex === second.spanIndex)
    return first.endU === second.startU || second.endU === first.startU;
  if (Math.abs(first.spanIndex - second.spanIndex) !== 1) return false;
  const left = first.spanIndex < second.spanIndex ? first : second;
  const right = first.spanIndex < second.spanIndex ? second : first;
  return left.endU === 1 && right.startU === 0;
};

const diagnostic = (
  code: "TERRAIN_CLEARANCE" | "TRACK_CLEARANCE",
  message: string,
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
  location: { s, position },
  actual,
  limit,
  margin: actual - limit,
  relatedIds,
});

const makeSegments = (
  spans: readonly SolvedSpan[],
  initialCount: number,
  radius: number,
): Segment[] => {
  const segments: Segment[] = [];
  let distance = 0;
  let segmentId = 0;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const spanLength = arcLength(span.span, 0, 1);
    const intervals: Array<readonly [number, number]> = [];
    const append = (startU: number, endU: number): void => {
      const quarterU = startU + (endU - startU) / 4;
      const middleU = (startU + endU) / 2;
      const threeQuarterU = startU + (3 * (endU - startU)) / 4;
      const start = span.span.position(startU);
      const quarter = span.span.position(quarterU);
      const middle = span.span.position(middleU);
      const threeQuarter = span.span.position(threeQuarterU);
      const end = span.span.position(endU);
      const tangentStart = span.span.derivative(startU, 1);
      const tangentQuarter = span.span.derivative(quarterU, 1);
      const tangentMiddle = span.span.derivative(middleU, 1);
      const tangentThreeQuarter = span.span.derivative(threeQuarterU, 1);
      const tangentEnd = span.span.derivative(endU, 1);
      const curveError = Math.max(
        distanceToChord(quarter, start, end),
        distanceToChord(middle, start, end),
        distanceToChord(threeQuarter, start, end),
      );
      const tangentError = Math.max(
        angleBetween(tangentStart, tangentQuarter),
        angleBetween(tangentQuarter, tangentMiddle),
        angleBetween(tangentMiddle, tangentThreeQuarter),
        angleBetween(tangentThreeQuarter, tangentEnd),
      );
      if (
        (curveError > CURVE_POSITION_TOLERANCE ||
          tangentError > CURVE_TANGENT_TOLERANCE) &&
        middleU !== startU &&
        middleU !== endU
      ) {
        append(startU, middleU);
        append(middleU, endU);
        return;
      }
      intervals.push([startU, endU]);
    };
    for (let index = 0; index < initialCount - 1; index += 1)
      append(index / (initialCount - 1), (index + 1) / (initialCount - 1));
    for (
      let segmentIndex = 0;
      segmentIndex < intervals.length;
      segmentIndex += 1
    ) {
      const [startU, endU] = intervals[segmentIndex]!;
      const start = span.span.position(startU);
      const quarter = span.span.position(startU + (endU - startU) / 4);
      const end = span.span.position(endU);
      const middle = span.span.position((startU + endU) / 2);
      const threeQuarter = span.span.position(
        startU + (3 * (endU - startU)) / 4,
      );
      const curveError = Math.max(
        distanceToChord(quarter, start, end),
        distanceToChord(middle, start, end),
        distanceToChord(threeQuarter, start, end),
      );
      segments.push({
        segmentId,
        spanIndex,
        segmentIndex,
        segmentCount: intervals.length,
        startU,
        endU,
        start,
        end,
        startS: distance + arcLength(span.span, 0, startU),
        endS: distance + arcLength(span.span, 0, endU),
        curveError,
        // A spherical train envelope is conservative for every orientation;
        // the curve-error term certifies the portion between adaptive points.
        bounds: sweptBounds(
          [start, quarter, middle, threeQuarter, end],
          radius + curveError,
        ),
      });
      segmentId += 1;
    }
    distance += spanLength;
  }
  return segments;
};

export const validateClearance = (
  spans: readonly SolvedSpan[],
  environment: EnvironmentQuery | undefined,
  options: ClearanceOptions = {},
): readonly Diagnostic[] => {
  const radius = options.trainEnvelopeRadius ?? 0;
  const requestedClearance = options.trackClearance ?? 0;
  const initialCount = options.samplesPerSpan ?? 2;
  if (!Number.isFinite(radius) || radius < 0)
    throw new RangeError(
      "Train envelope radius must be non-negative and finite",
    );
  if (!Number.isFinite(requestedClearance) || requestedClearance < 0)
    throw new RangeError("Track clearance must be non-negative and finite");
  if (!Number.isInteger(initialCount) || initialCount < 2)
    throw new RangeError(
      "Clearance samples per span must be an integer of at least 2",
    );

  const segments = makeSegments(spans, initialCount, radius);
  const diagnostics: Diagnostic[] = [];
  if (environment) {
    let terrainWork = 0;
    let uncertified = false;
    for (const segment of segments) {
      if (uncertified) break;
      const span = spans[segment.spanIndex]!;
      const terrainDistance = (u: number): number =>
        environment.signedDistance(span.span.position(u)) - radius;
      const report = (u: number, actual: number): boolean => {
        if (actual > 0) return false;
        const position = span.span.position(u);
        const s =
          segment.startS +
          (arcLength(span.span, 0, u) -
            arcLength(span.span, 0, segment.startU));
        diagnostics.push(
          diagnostic(
            "TERRAIN_CLEARANCE",
            `Terrain clearance is ${actual.toFixed(6)} m at s=${s.toFixed(6)} m`,
            position,
            actual,
            0,
            s,
            [span.id],
          ),
        );
        return true;
      };
      // A signed distance field is 1-Lipschitz. For every interval, the
      // smallest evaluated center distance minus the curve arc-length bound
      // (and the already-subtracted train radius) is a certified lower bound
      // for the swept envelope. A positive bound proves clearance; otherwise
      // branch-and-bound continues until a true penetration is evaluated or
      // floating-point parameter resolution is exhausted.
      const recurse = (
        leftU: number,
        rightU: number,
        leftDistance: number,
        rightDistance: number,
        depth: number,
      ): void => {
        terrainWork += 1;
        if (report(leftU, leftDistance) || report(rightU, rightDistance))
          return;
        const middleU = (leftU + rightU) / 2;
        if (middleU === leftU || middleU === rightU) return;
        const middleDistance = terrainDistance(middleU);
        if (report(middleU, middleDistance)) return;
        const intervalLength =
          arcLength(span.span, leftU, rightU) + segment.curveError;
        const lowerBound =
          Math.min(leftDistance, rightDistance, middleDistance) -
          intervalLength;
        if (lowerBound > TERRAIN_CERTIFICATION_EPSILON) return;
        if (
          depth >= TERRAIN_CERTIFICATION_MAX_DEPTH ||
          terrainWork > TERRAIN_CERTIFICATION_MAX_WORK
        ) {
          const s =
            segment.startS +
            (arcLength(span.span, 0, middleU) -
              arcLength(span.span, 0, segment.startU));
          const position = span.span.position(middleU);
          diagnostics.push({
            code: "CLEARANCE_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Terrain clearance certification could not prove a positive margin within deterministic ${depth >= TERRAIN_CERTIFICATION_MAX_DEPTH ? "depth" : "work"} bound at s=${s.toFixed(6)} m`,
            location: { s, position },
            actual: lowerBound,
            limit: TERRAIN_CERTIFICATION_EPSILON,
            margin: lowerBound - TERRAIN_CERTIFICATION_EPSILON,
            relatedIds: [span.id],
          });
          uncertified = true;
          return;
        }
        recurse(leftU, middleU, leftDistance, middleDistance, depth + 1);
        if (!uncertified)
          recurse(middleU, rightU, middleDistance, rightDistance, depth + 1);
      };
      recurse(
        segment.startU,
        segment.endU,
        terrainDistance(segment.startU),
        terrainDistance(segment.endU),
        0,
      );
    }
  }

  const limit = radius * 2 + requestedClearance;
  const cellSize = Math.max(limit, CURVE_POSITION_TOLERANCE, 1);
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
  const sAt = (segment: Segment, u: number, span: SolvedSpan): number =>
    segment.startS + arcLength(span.span, segment.startU, u);
  for (const segment of segments) {
    const ranges = bucketRange(segment.bounds);
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
            if (!overlaps(other.bounds, segment.bounds)) continue;
            const closest = closestPair(other, segment, spans);
            if (closest.distance <= limit) {
              const firstSpan = spans[other.spanIndex]!;
              diagnostics.push(
                diagnostic(
                  "TRACK_CLEARANCE",
                  `Track clearance is ${(closest.distance - limit).toFixed(6)} m at s=${sAt(other, closest.firstU, firstSpan).toFixed(6)} m`,
                  closest.firstPosition,
                  closest.distance,
                  limit,
                  sAt(other, closest.firstU, firstSpan),
                  [firstSpan.id, spans[segment.spanIndex]!.id],
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
