import {
  SeventhOrderHermiteSpan,
  arcLength,
  type Diagnostic,
  type EnvironmentQuery,
  type SolvedSpan,
  type Vec3,
  vec3,
} from "@openvibecoaster/core";
import type { ClearanceOptions } from "./types";

interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

interface Segment {
  readonly segmentId: number;
  readonly spanIndex: number;
  readonly segmentIndex: number;
  readonly startU: number;
  readonly endU: number;
  readonly startS: number;
  readonly endS: number;
  readonly bounds: Bounds;
  readonly certified: boolean;
}

interface PairNode {
  readonly first: Segment;
  readonly second: Segment;
  readonly firstU0: number;
  readonly firstU1: number;
  readonly secondU0: number;
  readonly secondU1: number;
  readonly depth: number;
}

const TERRAIN_CERTIFICATION_EPSILON = 1e-10;
const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_WORK = 100_000;
const PARAMETER_TOLERANCE = 1e-12;
const COLLISION_TOLERANCE = 1e-9;

const min = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]));
const max = (a: Vec3, b: Vec3): Vec3 =>
  vec3(Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
const expand = (value: Vec3, amount: number): Vec3 =>
  vec3(value[0] - amount, value[1] - amount, value[2] - amount);
const expandMax = (value: Vec3, amount: number): Vec3 =>
  vec3(value[0] + amount, value[1] + amount, value[2] + amount);
const add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const scale = (a: Vec3, value: number): Vec3 =>
  vec3(a[0] * value, a[1] * value, a[2] * value);
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const binomial = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) result *= (n - k + index) / index;
  return result;
};

const overlaps = (left: Bounds, right: Bounds): boolean =>
  left.min[0] <= right.max[0] &&
  right.min[0] <= left.max[0] &&
  left.min[1] <= right.max[1] &&
  right.min[1] <= left.max[1] &&
  left.min[2] <= right.max[2] &&
  right.min[2] <= left.max[2];

const boxDistance = (left: Bounds, right: Bounds): number => {
  const gap = (axis: 0 | 1 | 2): number =>
    left.max[axis] < right.min[axis]
      ? right.min[axis] - left.max[axis]
      : right.max[axis] < left.min[axis]
        ? left.min[axis] - right.max[axis]
        : 0;
  return Math.hypot(gap(0), gap(1), gap(2));
};

const distanceToBox = (point: Vec3, box: Bounds): number =>
  Math.hypot(
    Math.max(Math.abs(point[0] - box.min[0]), Math.abs(point[0] - box.max[0])),
    Math.max(Math.abs(point[1] - box.min[1]), Math.abs(point[1] - box.max[1])),
    Math.max(Math.abs(point[2] - box.min[2]), Math.abs(point[2] - box.max[2])),
  );

const polynomialRows = (
  solved: SolvedSpan,
): readonly (readonly number[])[] | undefined =>
  solved.positionCoefficients ??
  (solved.span instanceof SeventhOrderHermiteSpan
    ? solved.span.coefficients
    : undefined);

const restrictedBernstein = (
  coefficients: readonly number[],
  start: number,
  end: number,
): readonly number[] => {
  const degree = coefficients.length - 1;
  const width = end - start;
  const power = Array.from({ length: degree + 1 }, () => 0);
  for (let source = 0; source <= degree; source += 1)
    for (let target = 0; target <= source; target += 1)
      power[target]! +=
        coefficients[source]! *
        binomial(source, target) *
        start ** (source - target) *
        width ** target;
  return power.map((_, index) =>
    power
      .slice(0, index + 1)
      .reduce(
        (sum, value, powerIndex) =>
          sum +
          (value * binomial(index, powerIndex)) /
            Math.max(1, binomial(degree, powerIndex)),
        0,
      ),
  );
};

const polynomialBounds = (
  solved: SolvedSpan,
  start: number,
  end: number,
): Bounds | undefined => {
  const rows = polynomialRows(solved);
  if (!rows || rows.length !== 3 || rows.some((row) => row.length !== 8))
    return undefined;
  const ranges = rows.map((row) => {
    const values = restrictedBernstein(row, start, end);
    const lower = Math.min(...values);
    const upper = Math.max(...values);
    const padding =
      Number.EPSILON * 128 * Math.max(1, Math.abs(lower), Math.abs(upper));
    return [lower - padding, upper + padding] as const;
  });
  return {
    min: vec3(ranges[0]![0], ranges[1]![0], ranges[2]![0]),
    max: vec3(ranges[0]![1], ranges[1]![1], ranges[2]![1]),
  };
};

const sampledBounds = (
  solved: SolvedSpan,
  start: number,
  end: number,
): Bounds => {
  const points = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    solved.span.position(start + (end - start) * fraction),
  );
  let lower = points[0]!;
  let upper = points[0]!;
  for (const point of points.slice(1)) {
    lower = min(lower, point);
    upper = max(upper, point);
  }
  const chord = sub(points[4]!, points[0]!);
  const error = Math.max(
    ...points.slice(1, 4).map((point) => {
      const denominator = dot(chord, chord);
      const t =
        denominator > 0
          ? clamp(dot(sub(point, points[0]!), chord) / denominator)
          : 0;
      return length(sub(point, add(points[0]!, scale(chord, t))));
    }),
  );
  return { min: expand(lower, error), max: expandMax(upper, error) };
};

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const positionBounds = (
  segment: Segment,
  start: number,
  end: number,
  spans: readonly SolvedSpan[],
): { readonly bounds: Bounds; readonly certified: boolean } => {
  const solved = spans[segment.spanIndex]!;
  const exact = polynomialBounds(solved, start, end);
  return exact
    ? { bounds: exact, certified: true }
    : { bounds: sampledBounds(solved, start, end), certified: false };
};

const makeSegments = (
  spans: readonly SolvedSpan[],
  initialCount: number,
  broadAmount: number,
): Segment[] => {
  const segments: Segment[] = [];
  let station = 0;
  let segmentId = 0;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const spanLength = arcLength(span.span, 0, 1);
    for (let index = 0; index < initialCount - 1; index += 1) {
      const startU = index / (initialCount - 1);
      const endU = (index + 1) / (initialCount - 1);
      const exact = polynomialBounds(span, startU, endU);
      const bounds = exact ?? sampledBounds(span, startU, endU);
      segments.push({
        segmentId,
        spanIndex,
        segmentIndex: index,
        startU,
        endU,
        startS: station + arcLength(span.span, 0, startU),
        endS: station + arcLength(span.span, 0, endU),
        bounds: {
          min: expand(bounds.min, broadAmount),
          max: expandMax(bounds.max, broadAmount),
        },
        certified: exact !== undefined,
      });
      segmentId += 1;
    }
    station += spanLength;
  }
  return segments;
};

const curvePoint = (
  segment: Segment,
  parameter: number,
  spans: readonly SolvedSpan[],
): Vec3 =>
  spans[segment.spanIndex]!.span.position(
    segment.startU + (segment.endU - segment.startU) * clamp(parameter),
  );

const curveS = (
  segment: Segment,
  parameter: number,
  spans: readonly SolvedSpan[],
): number =>
  segment.startS +
  arcLength(
    spans[segment.spanIndex]!.span,
    segment.startU,
    segment.startU + (segment.endU - segment.startU) * clamp(parameter),
  );

const adjacent = (
  first: Segment,
  second: Segment,
  closed: boolean,
  spanCount: number,
): boolean => {
  if (first.spanIndex === second.spanIndex) {
    if (first.segmentIndex + 1 === second.segmentIndex) return true;
    if (second.segmentIndex + 1 === first.segmentIndex) return true;
    return (
      closed &&
      spanCount === 1 &&
      ((first.startU === 0 && second.endU === 1) ||
        (second.startU === 0 && first.endU === 1))
    );
  }
  const left = first.spanIndex < second.spanIndex ? first : second;
  const right = first.spanIndex < second.spanIndex ? second : first;
  if (right.spanIndex !== left.spanIndex + 1) return false;
  if (left.endU === 1 && right.startU === 0) return true;
  return (
    closed &&
    left.spanIndex === 0 &&
    right.spanIndex === spanCount - 1 &&
    left.startU === 0 &&
    right.endU === 1
  );
};

const diagnostic = (
  code: "TERRAIN_CLEARANCE" | "TRACK_CLEARANCE" | "CLEARANCE_UNCERTIFIED",
  message: string,
  position: Vec3,
  actual: number,
  limit: number,
  s: number,
  relatedIds: readonly string[],
  severity: Diagnostic["severity"] = "error",
): Diagnostic => ({
  code,
  severity,
  provenance: "PROJECT_ENGINEERING_LIMIT",
  message,
  location: { s, position },
  actual,
  limit,
  margin: actual - limit,
  relatedIds,
});

const uncertain = (
  message: string,
  position: Vec3,
  s: number,
  actual: number,
  limit: number,
  ids: readonly string[],
): Diagnostic =>
  diagnostic(
    "CLEARANCE_UNCERTIFIED",
    message,
    position,
    actual,
    limit,
    s,
    ids,
    "fatal",
  );

export const validateClearance = (
  spans: readonly SolvedSpan[],
  environment: EnvironmentQuery | undefined,
  options: ClearanceOptions = {},
): readonly Diagnostic[] => {
  const radius = options.trainEnvelopeRadius ?? 0;
  const requestedClearance = options.trackClearance ?? 0;
  const initialCount = options.samplesPerSpan ?? 2;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxWork = options.maxWork ?? DEFAULT_MAX_WORK;
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
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new RangeError(
      "Clearance maximum depth must be a non-negative integer",
    );
  if (!Number.isInteger(maxWork) || maxWork < 1)
    throw new RangeError("Clearance maximum work must be a positive integer");

  const limit = radius * 2 + requestedClearance;
  const segments = makeSegments(spans, initialCount, limit / 2);
  const diagnostics: Diagnostic[] = [];
  const work = { used: 0 };
  let certificationStopped = false;

  const spend = (): boolean => {
    work.used += 1;
    return work.used <= maxWork;
  };

  if (environment) {
    for (const segment of segments) {
      if (certificationStopped) break;
      const span = spans[segment.spanIndex]!;
      const stack: Array<{
        readonly start: number;
        readonly end: number;
        readonly depth: number;
      }> = [{ start: segment.startU, end: segment.endU, depth: 0 }];
      while (stack.length > 0 && !certificationStopped) {
        if (!spend()) {
          const midpoint = (segment.startU + segment.endU) / 2;
          const actual =
            environment.signedDistance(span.span.position(midpoint)) - radius;
          diagnostics.push(
            uncertain(
              "Terrain clearance certification exhausted its deterministic work budget",
              span.span.position(midpoint),
              curveS(
                segment,
                (midpoint - segment.startU) / (segment.endU - segment.startU),
                spans,
              ),
              actual,
              0,
              [span.id],
            ),
          );
          certificationStopped = true;
          break;
        }
        const node = stack.pop()!;
        const midpoint = (node.start + node.end) / 2;
        const point = span.span.position(midpoint);
        const actual = environment.signedDistance(point) - radius;
        const positionBox = positionBounds(
          segment,
          node.start,
          node.end,
          spans,
        );
        const lowerBound = actual - distanceToBox(point, positionBox.bounds);
        if (actual <= 0) {
          diagnostics.push(
            diagnostic(
              "TERRAIN_CLEARANCE",
              `Terrain clearance is ${actual.toFixed(6)} m at s=${curveS(segment, (midpoint - segment.startU) / (segment.endU - segment.startU), spans).toFixed(6)} m`,
              point,
              actual,
              0,
              curveS(
                segment,
                (midpoint - segment.startU) / (segment.endU - segment.startU),
                spans,
              ),
              [span.id],
            ),
          );
          continue;
        }
        if (positionBox.certified && lowerBound > TERRAIN_CERTIFICATION_EPSILON)
          continue;
        if (node.depth >= maxDepth) {
          diagnostics.push(
            uncertain(
              `Terrain clearance certification exhausted its deterministic depth budget at s=${curveS(segment, (midpoint - segment.startU) / (segment.endU - segment.startU), spans).toFixed(6)} m`,
              point,
              curveS(
                segment,
                (midpoint - segment.startU) / (segment.endU - segment.startU),
                spans,
              ),
              lowerBound,
              TERRAIN_CERTIFICATION_EPSILON,
              [span.id],
            ),
          );
          certificationStopped = true;
          break;
        }
        if (midpoint === node.start || midpoint === node.end) {
          diagnostics.push(
            uncertain(
              "Terrain clearance certification reached floating-point parameter resolution",
              point,
              curveS(
                segment,
                (midpoint - segment.startU) / (segment.endU - segment.startU),
                spans,
              ),
              lowerBound,
              TERRAIN_CERTIFICATION_EPSILON,
              [span.id],
            ),
          );
          certificationStopped = true;
          break;
        }
        stack.push(
          { start: midpoint, end: node.end, depth: node.depth + 1 },
          { start: node.start, end: midpoint, depth: node.depth + 1 },
        );
      }
    }
  }

  const buckets = new Map<string, Segment[]>();
  const seenPairs = new Set<string>();
  const pairRoots: PairNode[] = [];
  const baseCellSize = Math.max(limit, 1);
  const maximumExtent = segments.reduce(
    (maximum, segment) =>
      Math.max(
        maximum,
        segment.bounds.max[0] - segment.bounds.min[0],
        segment.bounds.max[1] - segment.bounds.min[1],
        segment.bounds.max[2] - segment.bounds.min[2],
      ),
    0,
  );
  // Keep the spatial hash deterministic and finite even for a valid, very
  // high-coefficient span. A larger cell only increases narrow-phase work;
  // it cannot hide a pair because every pair is still interval-checked.
  const cellSize = Math.max(baseCellSize, maximumExtent / 256);
  const bucketRange = (bounds: Bounds): readonly [number, number][] =>
    [0, 1, 2].map((axis) => [
      Math.floor(bounds.min[axis]! / cellSize),
      Math.floor(bounds.max[axis]! / cellSize),
    ]);
  const bucketKey = (x: number, y: number, z: number): string =>
    `${x},${y},${z}`;
  const closed = options.closed ?? false;

  const processPair = (root: PairNode): void => {
    const stack: PairNode[] = [root];
    while (stack.length > 0 && !certificationStopped) {
      if (!spend()) {
        const first = spans[root.first.spanIndex]!;
        const u = (root.firstU0 + root.firstU1) / 2;
        const v = (root.secondU0 + root.secondU1) / 2;
        const actual = length(
          sub(
            first.span.position(u),
            spans[root.second.spanIndex]!.span.position(v),
          ),
        );
        diagnostics.push(
          uncertain(
            "Track clearance certification exhausted its deterministic work budget",
            curvePoint(
              root.first,
              (u - root.first.startU) / (root.first.endU - root.first.startU),
              spans,
            ),
            curveS(
              root.first,
              (u - root.first.startU) / (root.first.endU - root.first.startU),
              spans,
            ),
            actual,
            limit,
            [first.id, spans[root.second.spanIndex]!.id],
          ),
        );
        certificationStopped = true;
        break;
      }
      const node = stack.pop()!;
      const firstBox = positionBounds(
        node.first,
        node.firstU0,
        node.firstU1,
        spans,
      );
      const secondBox = positionBounds(
        node.second,
        node.secondU0,
        node.secondU1,
        spans,
      );
      if (
        firstBox.certified &&
        secondBox.certified &&
        boxDistance(firstBox.bounds, secondBox.bounds) > limit
      )
        continue;

      const firstMid = (node.firstU0 + node.firstU1) / 2;
      const secondMid = (node.secondU0 + node.secondU1) / 2;
      const firstCandidates = [node.firstU0, firstMid, node.firstU1];
      const secondCandidates = [node.secondU0, secondMid, node.secondU1];
      let witness:
        | {
            readonly firstU: number;
            readonly secondU: number;
            readonly distance: number;
          }
        | undefined;
      for (const firstU of firstCandidates)
        for (const secondU of secondCandidates) {
          const distance = length(
            sub(
              spans[node.first.spanIndex]!.span.position(firstU),
              spans[node.second.spanIndex]!.span.position(secondU),
            ),
          );
          if (witness === undefined || distance < witness.distance)
            witness = { firstU, secondU, distance };
        }
      const firstPoint = spans[node.first.spanIndex]!.span.position(
        witness!.firstU,
      );
      const distance = witness!.distance;
      const disjointParameters =
        node.first.spanIndex !== node.second.spanIndex ||
        node.firstU1 < node.secondU0 - PARAMETER_TOLERANCE ||
        node.secondU1 < node.firstU0 - PARAMETER_TOLERANCE;
      if (disjointParameters && distance <= limit + COLLISION_TOLERANCE) {
        const firstSpan = spans[node.first.spanIndex]!;
        diagnostics.push(
          diagnostic(
            "TRACK_CLEARANCE",
            `Track clearance is ${(distance - limit).toFixed(6)} m at s=${curveS(node.first, (witness!.firstU - node.first.startU) / (node.first.endU - node.first.startU), spans).toFixed(6)} m`,
            firstPoint,
            distance,
            limit,
            curveS(
              node.first,
              (witness!.firstU - node.first.startU) /
                (node.first.endU - node.first.startU),
              spans,
            ),
            [firstSpan.id, spans[node.second.spanIndex]!.id],
          ),
        );
        certificationStopped = true;
        break;
      }
      if (node.depth >= maxDepth) {
        const firstSpan = spans[node.first.spanIndex]!;
        diagnostics.push(
          uncertain(
            "Track clearance certification exhausted its deterministic depth budget",
            firstPoint,
            curveS(
              node.first,
              (firstMid - node.first.startU) /
                (node.first.endU - node.first.startU),
              spans,
            ),
            boxDistance(firstBox.bounds, secondBox.bounds),
            limit,
            [firstSpan.id, spans[node.second.spanIndex]!.id],
          ),
        );
        certificationStopped = true;
        break;
      }
      const firstWidth = node.firstU1 - node.firstU0;
      const secondWidth = node.secondU1 - node.secondU0;
      if (firstWidth >= secondWidth) {
        const midpoint = (node.firstU0 + node.firstU1) / 2;
        stack.push(
          { ...node, firstU0: midpoint, depth: node.depth + 1 },
          { ...node, firstU1: midpoint, depth: node.depth + 1 },
        );
      } else {
        const midpoint = (node.secondU0 + node.secondU1) / 2;
        stack.push(
          { ...node, secondU0: midpoint, depth: node.depth + 1 },
          { ...node, secondU1: midpoint, depth: node.depth + 1 },
        );
      }
    }
  };

  for (const segment of segments) {
    if (certificationStopped) break;
    const ranges = bucketRange(segment.bounds);
    for (let x = ranges[0]![0]; x <= ranges[0]![1]; x += 1)
      for (let y = ranges[1]![0]; y <= ranges[1]![1]; y += 1)
        for (let z = ranges[2]![0]; z <= ranges[2]![1]; z += 1) {
          const key = bucketKey(x, y, z);
          const candidates = buckets.get(key) ?? [];
          for (const other of candidates) {
            if (
              other === segment ||
              adjacent(other, segment, closed, spans.length)
            )
              continue;
            const pairKey =
              other.segmentId < segment.segmentId
                ? `${other.segmentId}:${segment.segmentId}`
                : `${segment.segmentId}:${other.segmentId}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);
            if (!overlaps(other.bounds, segment.bounds)) continue;
            pairRoots.push({
              first: other,
              second: segment,
              firstU0: other.startU,
              firstU1: other.endU,
              secondU0: segment.startU,
              secondU1: segment.endU,
              depth: 0,
            });
          }
          candidates.push(segment);
          buckets.set(key, candidates);
          if (certificationStopped) break;
        }
  }
  const witnessDistance = (root: PairNode): number => {
    let closest = Number.POSITIVE_INFINITY;
    for (const firstU of [
      root.firstU0,
      (root.firstU0 + root.firstU1) / 2,
      root.firstU1,
    ])
      for (const secondU of [
        root.secondU0,
        (root.secondU0 + root.secondU1) / 2,
        root.secondU1,
      ])
        closest = Math.min(
          closest,
          length(
            sub(
              spans[root.first.spanIndex]!.span.position(firstU),
              spans[root.second.spanIndex]!.span.position(secondU),
            ),
          ),
        );
    return closest;
  };
  pairRoots.sort(
    (left, right) =>
      witnessDistance(left) - witnessDistance(right) ||
      left.first.segmentId - right.first.segmentId ||
      left.second.segmentId - right.second.segmentId,
  );
  for (const root of pairRoots) {
    if (certificationStopped) break;
    processPair(root);
  }
  return Object.freeze(diagnostics);
};
