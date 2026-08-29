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
import {
  CertifiedWorkBudget,
  CertificationError,
  WorkBudgetExceeded,
  certifiedPolynomialBounds,
  nextDown,
  nextUp,
} from "./polynomial-bounds";

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
  readonly centerBounds: Bounds;
  readonly bounds: Bounds;
}

type CertifiedSpan = SolvedSpan & {
  readonly span: SeventhOrderHermiteSpan<Vec3>;
};

interface PairNode {
  readonly first: Segment;
  readonly second: Segment;
  readonly firstU0: number;
  readonly firstU1: number;
  readonly secondU0: number;
  readonly secondU1: number;
  readonly depth: number;
}

interface SelfSubdivision {
  readonly segments: readonly Segment[];
  readonly unresolvedSpanIds: readonly string[];
}

const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_WORK = 1_000_000;
const DEFAULT_TERRAIN_MAX_WORK = 100_000;
const PARAMETER_TOLERANCE = 1e-12;
// Generated seams may differ below the solver's numerical resolution even
// though their coefficient-authoritative endpoint intervals represent a join.
const SHARED_ENDPOINT_TOLERANCE = 1e-10;
// The smallest integer above sqrt(3) bounds 3D arc length by a certified
// monotonic coordinate projection; an adjacent pair contributes two leaves.
const DIRECTIONAL_LOCALITY_FACTOR = Math.ceil(Math.sqrt(3));
const ADJACENT_LOCALITY_FACTOR = DIRECTIONAL_LOCALITY_FACTOR * 2;

const origin = vec3(0, 0, 0);

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value))
    throw new CertificationError(`${label} must be finite`);
  return value;
};

const finiteVec3 = (value: Vec3, label: string): Vec3 => {
  finite(value[0], `${label}.x`);
  finite(value[1], `${label}.y`);
  finite(value[2], `${label}.z`);
  return value;
};

const polynomialRows = (solved: SolvedSpan): readonly (readonly number[])[] => {
  const rows =
    solved.positionCoefficients ??
    (solved.span instanceof SeventhOrderHermiteSpan
      ? solved.span.coefficients
      : undefined);
  if (!rows || rows.length !== 3 || rows.some((row) => row.length !== 8))
    throw new CertificationError(
      `Span ${solved.id} has no certified degree-seven position polynomial`,
    );
  return rows;
};

const canonicalSpan = (
  solved: SolvedSpan,
  budget: CertifiedWorkBudget,
): CertifiedSpan => {
  const rows = polynomialRows(solved).map((row) =>
    row.map((coefficient) =>
      chargeFinite(
        budget,
        coefficient,
        `Span ${solved.id} position coefficient`,
      ),
    ),
  );
  return {
    ...solved,
    span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows),
    positionCoefficients: rows,
  };
};

const chargeFinite = (
  budget: CertifiedWorkBudget,
  value: number,
  label: string,
): number => {
  budget.charge();
  return finite(value, label);
};

const safePosition = (
  span: CertifiedSpan,
  u: number,
  budget: CertifiedWorkBudget,
): Vec3 => {
  budget.charge();
  const value = span.span.position(finite(u, "Position parameter"));
  return finiteVec3(value, `Span ${span.id} position`);
};

const safeDerivative = (
  span: CertifiedSpan,
  u: number,
  order: number,
  budget: CertifiedWorkBudget,
): Vec3 => {
  budget.charge();
  const value = span.span.derivative(finite(u, "Derivative parameter"), order);
  return finiteVec3(value, `Span ${span.id} derivative`);
};

const safeArcLength = (
  span: CertifiedSpan,
  start = 0,
  end = 1,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge();
  return finite(arcLength(span.span, start, end), `Span ${span.id} arc length`);
};

const safeDistance = (
  left: Vec3,
  right: Vec3,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge();
  return finite(
    Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]),
    "Witness distance",
  );
};

const outwardDifference = (
  left: number,
  right: number,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge();
  const difference = finite(left - right, "Certified lower subtraction");
  return finite(nextDown(difference), "Certified lower subtraction");
};

const outwardSum = (
  left: number,
  right: number,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge();
  const sum = finite(left + right, "Certified upper addition");
  return finite(nextUp(sum), "Certified upper addition");
};

const inflate = (
  bounds: Bounds,
  amount: number,
  budget: CertifiedWorkBudget,
): Bounds => {
  const min = vec3(
    outwardDifference(bounds.min[0], amount, budget),
    outwardDifference(bounds.min[1], amount, budget),
    outwardDifference(bounds.min[2], amount, budget),
  );
  const max = vec3(
    outwardSum(bounds.max[0], amount, budget),
    outwardSum(bounds.max[1], amount, budget),
    outwardSum(bounds.max[2], amount, budget),
  );
  return { min, max };
};

const boxDistanceLower = (
  left: Bounds,
  right: Bounds,
  budget: CertifiedWorkBudget,
): number => {
  const gap = (axis: 0 | 1 | 2): number => {
    if (left.max[axis] < right.min[axis])
      return outwardDifference(right.min[axis], left.max[axis], budget);
    if (right.max[axis] < left.min[axis])
      return outwardDifference(left.min[axis], right.max[axis], budget);
    return 0;
  };
  budget.charge();
  const distance = finite(Math.hypot(gap(0), gap(1), gap(2)), "Box distance");
  return finite(nextDown(distance), "Box distance");
};

const distanceToBoxUpper = (
  point: Vec3,
  box: Bounds,
  budget: CertifiedWorkBudget,
): number => {
  const distance = (axis: 0 | 1 | 2): number => {
    budget.charge();
    return Math.max(
      Math.abs(point[axis] - box.min[axis]),
      Math.abs(point[axis] - box.max[axis]),
    );
  };
  const upper = finite(
    Math.hypot(distance(0), distance(1), distance(2)),
    "Distance-to-box bound",
  );
  return finite(nextUp(upper), "Distance-to-box bound");
};

const overlaps = (left: Bounds, right: Bounds): boolean =>
  left.min[0] <= right.max[0] &&
  right.min[0] <= left.max[0] &&
  left.min[1] <= right.max[1] &&
  right.min[1] <= left.max[1] &&
  left.min[2] <= right.max[2] &&
  right.min[2] <= left.max[2];

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
  if (right.spanIndex === left.spanIndex + 1)
    return left.endU === 1 && right.startU === 0;
  return (
    closed &&
    left.spanIndex === 0 &&
    right.spanIndex === spanCount - 1 &&
    left.startU === 0 &&
    right.endU === 1
  );
};

const finiteDiagnostic = (
  code: "TERRAIN_CLEARANCE" | "TRACK_CLEARANCE" | "CLEARANCE_UNCERTIFIED",
  message: string,
  position: Vec3,
  actual: number,
  limit: number,
  s: number,
  relatedIds: readonly string[],
  severity: Diagnostic["severity"] = "error",
): Diagnostic => {
  finiteVec3(position, "Diagnostic position");
  finite(actual, "Diagnostic actual");
  finite(limit, "Diagnostic limit");
  finite(s, "Diagnostic arc location");
  const margin = finite(actual - limit, "Diagnostic margin");
  return {
    code,
    severity,
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    location: { s, position },
    actual,
    limit,
    margin,
    relatedIds,
  };
};

const uncertain = (
  message: string,
  ids: readonly string[],
  context: { readonly position?: Vec3; readonly s?: number } = {},
): Diagnostic => ({
  code: "CLEARANCE_UNCERTIFIED",
  severity: "fatal",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  message,
  location: { s: context.s ?? 0, position: context.position ?? origin },
  actual: 0,
  limit: 0,
  margin: 0,
  relatedIds: ids,
});

const failureDiagnostic = (
  error: unknown,
  ids: readonly string[],
): Diagnostic =>
  uncertain(error instanceof Error ? error.message : String(error), ids);

const validateSpanNumerics = (
  span: CertifiedSpan,
  budget: CertifiedWorkBudget,
): void => {
  const rows = polynomialRows(span);
  for (const row of rows)
    for (const coefficient of row)
      chargeFinite(budget, coefficient, `Span ${span.id} position coefficient`);
  if (span.rollCoefficients)
    for (const coefficient of span.rollCoefficients)
      chargeFinite(budget, coefficient, `Span ${span.id} roll coefficient`);
  if (span.length !== undefined)
    chargeFinite(budget, span.length, `Span ${span.id} length`);
  if (span.bounds)
    for (const value of [...span.bounds.min, ...span.bounds.max])
      chargeFinite(budget, value, `Span ${span.id} bound`);
  for (const u of [0, 1]) {
    safePosition(span, u, budget);
    const derivative = safeDerivative(span, u, 1, budget);
    if (!(Math.hypot(...derivative) > 1e-12))
      throw new CertificationError(`Span ${span.id} derivative is zero`);
    safeDerivative(span, u, 2, budget);
    safeDerivative(span, u, 3, budget);
    if (span.bank) {
      budget.charge();
      finite(span.bank.position(u), `Span ${span.id} bank`);
      budget.charge();
      finite(span.bank.derivative(u, 1), `Span ${span.id} bank derivative`);
    }
  }
};

const curveS = (
  segment: Segment,
  u: number,
  spans: readonly CertifiedSpan[],
  budget: CertifiedWorkBudget,
): number =>
  finite(
    segment.startS +
      safeArcLength(spans[segment.spanIndex]!, segment.startU, u, budget),
    "Diagnostic arc location",
  );

const makeSegments = (
  spans: readonly CertifiedSpan[],
  initialCount: number,
  broadAmount: number,
  budget: CertifiedWorkBudget,
  getBounds: (span: CertifiedSpan, start: number, end: number) => Bounds,
): Segment[] => {
  const segmentCount = CertifiedWorkBudget.checkedProduct(
    spans.length,
    initialCount - 1,
  );
  budget.charge(segmentCount);
  const segments: Segment[] = [];
  let station = 0;
  let segmentId = 0;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const spanLength = safeArcLength(span, 0, 1, budget);
    for (let index = 0; index < initialCount - 1; index += 1) {
      const startU = index / (initialCount - 1);
      const endU = (index + 1) / (initialCount - 1);
      const centerBounds = getBounds(span, startU, endU);
      const bounds = inflate(centerBounds, broadAmount, budget);
      const startS = station + safeArcLength(span, 0, startU, budget);
      const endS = station + safeArcLength(span, 0, endU, budget);
      finite(startS, "Segment start arc location");
      finite(endS, "Segment end arc location");
      segments.push({
        segmentId,
        spanIndex,
        segmentIndex: index,
        startU,
        endU,
        startS,
        endS,
        centerBounds,
        bounds,
      });
      segmentId += 1;
    }
    station = finite(station + spanLength, "Track arc location");
  }
  return segments;
};

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

type DerivativeHull = readonly (readonly Interval[])[];

const BINOMIAL = [
  [1],
  [1, 1],
  [1, 2, 1],
  [1, 3, 3, 1],
  [1, 4, 6, 4, 1],
  [1, 5, 10, 10, 5, 1],
  [1, 6, 15, 20, 15, 6, 1],
] as const;

const intervalProduct = (
  left: Interval,
  right: Interval,
  budget: CertifiedWorkBudget,
): Interval => {
  budget.charge(6);
  const products = [
    left.lo * right.lo,
    left.lo * right.hi,
    left.hi * right.lo,
    left.hi * right.hi,
  ].map((value) => finite(value, "Derivative interval product"));
  return {
    lo: finite(nextDown(Math.min(...products)), "Derivative interval lower"),
    hi: finite(nextUp(Math.max(...products)), "Derivative interval upper"),
  };
};

const intervalSum = (
  left: Interval,
  right: Interval,
  budget: CertifiedWorkBudget,
): Interval => {
  budget.charge(4);
  return {
    lo: finite(
      nextDown(finite(left.lo + right.lo, "Derivative interval sum")),
      "Derivative interval lower",
    ),
    hi: finite(
      nextUp(finite(left.hi + right.hi, "Derivative interval sum")),
      "Derivative interval upper",
    ),
  };
};

const derivativeHull = (
  span: CertifiedSpan,
  budget: CertifiedWorkBudget,
): DerivativeHull =>
  polynomialRows(span).map((row) => {
    const powerCoefficients = Array.from({ length: 7 }, (_, power) => {
      budget.charge(3);
      const value = finite(
        row[power + 1]! * (power + 1),
        `Span ${span.id} derivative coefficient`,
      );
      return {
        lo: finite(
          nextDown(value),
          `Span ${span.id} derivative coefficient lower`,
        ),
        hi: finite(
          nextUp(value),
          `Span ${span.id} derivative coefficient upper`,
        ),
      };
    });
    return Array.from({ length: 7 }, (_, controlIndex) => {
      let sum: Interval | undefined;
      for (let power = 0; power <= controlIndex; power += 1) {
        budget.charge(3);
        const ratio = finite(
          BINOMIAL[controlIndex]![power]! / BINOMIAL[6]![power]!,
          `Span ${span.id} derivative Bernstein ratio`,
        );
        const term = intervalProduct(
          powerCoefficients[power]!,
          {
            lo: finite(nextDown(ratio), "Derivative ratio lower"),
            hi: finite(nextUp(ratio), "Derivative ratio upper"),
          },
          budget,
        );
        sum = sum === undefined ? term : intervalSum(sum, term, budget);
      }
      return sum!;
    });
  });

const derivativeHullBounds = (
  hull: DerivativeHull,
  budget: CertifiedWorkBudget,
): Bounds => {
  budget.charge(21);
  const ranges = hull.map((row) => ({
    lo: finite(
      Math.min(...row.map((value) => value.lo)),
      "Derivative hull lower",
    ),
    hi: finite(
      Math.max(...row.map((value) => value.hi)),
      "Derivative hull upper",
    ),
  }));
  return {
    min: vec3(ranges[0]!.lo, ranges[1]!.lo, ranges[2]!.lo),
    max: vec3(ranges[0]!.hi, ranges[1]!.hi, ranges[2]!.hi),
  };
};

const derivativeSpeedUpper = (
  bounds: Bounds,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge(5);
  const magnitudes = ([0, 1, 2] as const).map((axis) =>
    finite(
      Math.max(Math.abs(bounds.min[axis]), Math.abs(bounds.max[axis])),
      "Derivative magnitude upper",
    ),
  );
  return finite(
    nextUp(finite(Math.hypot(...magnitudes), "Derivative speed upper")),
    "Derivative speed upper",
  );
};

const hasDirectionalSeparation = (
  bounds: Bounds,
  speedUpper: number,
  budget: CertifiedWorkBudget,
): boolean => {
  for (const axis of [0, 1, 2] as const) {
    const magnitudeLower =
      bounds.min[axis] > 0
        ? bounds.min[axis]
        : bounds.max[axis] < 0
          ? -bounds.max[axis]
          : 0;
    if (!(magnitudeLower > 0)) continue;
    budget.charge(2);
    const projectedLower = finite(
      nextDown(
        finite(
          DIRECTIONAL_LOCALITY_FACTOR * magnitudeLower,
          "Directional derivative",
        ),
      ),
      "Directional derivative lower",
    );
    if (projectedLower >= speedUpper) return true;
  }
  return false;
};

const splitDerivativeHull = (
  hull: DerivativeHull,
  budget: CertifiedWorkBudget,
): readonly [DerivativeHull, DerivativeHull] => {
  const leftRows: Interval[][] = [];
  const rightRows: Interval[][] = [];
  for (const row of hull) {
    let level = [...row];
    const left = [level[0]!];
    const right = [level[level.length - 1]!];
    while (level.length > 1) {
      const next: Interval[] = [];
      for (let index = 0; index < level.length - 1; index += 1) {
        budget.charge(4);
        const lower = finite(
          level[index]!.lo / 2 + level[index + 1]!.lo / 2,
          "Derivative subdivision lower",
        );
        const upper = finite(
          level[index]!.hi / 2 + level[index + 1]!.hi / 2,
          "Derivative subdivision upper",
        );
        next.push({
          lo: finite(nextDown(lower), "Derivative subdivision lower"),
          hi: finite(nextUp(upper), "Derivative subdivision upper"),
        });
      }
      level = next;
      left.push(level[0]!);
      right.push(level[level.length - 1]!);
    }
    leftRows.push(left);
    rightRows.push(right.reverse());
  }
  return [leftRows, rightRows];
};

const makeSelfSegments = (
  spans: readonly CertifiedSpan[],
  firstSegmentId: number,
  broadAmount: number,
  maxDepth: number,
  budget: CertifiedWorkBudget,
  getBounds: (span: CertifiedSpan, start: number, end: number) => Bounds,
): SelfSubdivision => {
  const segments: Segment[] = [];
  const unresolvedSpanIds = new Set<string>();
  let station = 0;
  let segmentId = firstSegmentId;
  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex]!;
    const spanLength = safeArcLength(span, 0, 1, budget);
    const wholeDerivativeHull = derivativeHull(span, budget);
    const intervals: {
      readonly start: number;
      readonly end: number;
    }[] = [];
    const refine = (
      start: number,
      end: number,
      depth: number,
      hull: DerivativeHull,
    ): void => {
      budget.charge();
      const bounds = derivativeHullBounds(hull, budget);
      const speedUpper = derivativeSpeedUpper(bounds, budget);
      if (hasDirectionalSeparation(bounds, speedUpper, budget)) {
        intervals.push({ start, end });
        return;
      }
      if (end - start <= PARAMETER_TOLERANCE) {
        unresolvedSpanIds.add(span.id);
        intervals.push({ start, end });
        return;
      }
      if (depth >= maxDepth) {
        unresolvedSpanIds.add(span.id);
        intervals.push({ start, end });
        return;
      }
      const midpoint = (start + end) / 2;
      if (midpoint === start || midpoint === end) {
        unresolvedSpanIds.add(span.id);
        intervals.push({ start, end });
        return;
      }
      const [leftHull, rightHull] = splitDerivativeHull(hull, budget);
      refine(start, midpoint, depth + 1, leftHull);
      refine(midpoint, end, depth + 1, rightHull);
    };
    refine(0, 1, 0, wholeDerivativeHull);
    for (let index = 0; index < intervals.length; index += 1) {
      budget.charge();
      const interval = intervals[index]!;
      const centerBounds = getBounds(span, interval.start, interval.end);
      const bounds = inflate(centerBounds, broadAmount, budget);
      const startS = station + safeArcLength(span, 0, interval.start, budget);
      const endS = station + safeArcLength(span, 0, interval.end, budget);
      finite(startS, "Same-span segment start arc location");
      finite(endS, "Same-span segment end arc location");
      segments.push({
        segmentId,
        spanIndex,
        segmentIndex: index,
        startU: interval.start,
        endU: interval.end,
        startS,
        endS,
        centerBounds,
        bounds,
      });
      segmentId += 1;
    }
    station = finite(station + spanLength, "Track arc location");
  }
  return {
    segments,
    unresolvedSpanIds: [...unresolvedSpanIds],
  };
};

const safeBucketCoordinate = (
  value: number,
  cellSize: number,
  budget: CertifiedWorkBudget,
): number => {
  budget.charge();
  const quotient = value / cellSize;
  if (!Number.isFinite(quotient))
    throw new CertificationError(
      "Spatial-hash bucket coordinate is non-finite",
    );
  const coordinate = Math.floor(quotient);
  if (!Number.isSafeInteger(coordinate))
    throw new CertificationError("Spatial-hash bucket coordinate is unsafe");
  return coordinate;
};

const bucketRanges = (
  bounds: Bounds,
  cellSize: number,
  budget: CertifiedWorkBudget,
): readonly [number, number][] =>
  ([0, 1, 2] as const).map((axis) => [
    safeBucketCoordinate(bounds.min[axis], cellSize, budget),
    safeBucketCoordinate(bounds.max[axis], cellSize, budget),
  ]);

const rangeCount = (range: readonly [number, number]): number => {
  const count = range[1] - range[0] + 1;
  if (!Number.isSafeInteger(count) || count < 1)
    throw new CertificationError("Spatial-hash bucket range overflows");
  return count;
};

const pairKey = (left: Segment, right: Segment): string =>
  left.segmentId < right.segmentId
    ? `${left.segmentId}:${right.segmentId}`
    : `${right.segmentId}:${left.segmentId}`;

export const validateClearance = (
  spans: readonly SolvedSpan[],
  environment: EnvironmentQuery | undefined,
  options: ClearanceOptions = {},
): readonly Diagnostic[] => {
  const radius = options.trainEnvelopeRadius ?? 0;
  const requestedClearance = options.trackClearance ?? 0;
  const initialCount = options.samplesPerSpan ?? 2;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxWork =
    options.maxWork ??
    (environment === undefined ? DEFAULT_MAX_WORK : DEFAULT_TERRAIN_MAX_WORK);
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
  if (!Number.isSafeInteger(maxWork) || maxWork < 1)
    throw new RangeError(
      "Clearance maximum work must be a positive safe integer",
    );
  const budget = new CertifiedWorkBudget(maxWork);
  const ids = spans.map((span) => span.id);
  try {
    if (spans.length === 0)
      throw new CertificationError("No spans can be certified");
    if (spans.length > Number.MAX_SAFE_INTEGER / (initialCount - 1))
      throw new CertificationError("Segment count overflows");
    const certifiedSpans = spans.map((span) => canonicalSpan(span, budget));
    for (const span of certifiedSpans) validateSpanNumerics(span, budget);
    if (environment?.bounds) {
      const bounds = environment.bounds();
      for (const value of [...bounds.min, ...bounds.max])
        chargeFinite(budget, value, "Environment bound");
    }
    const limit = finite(radius * 2 + requestedClearance, "Clearance limit");
    const closed = options.closed ?? false;
    const localityLimit =
      limit === 0
        ? 0
        : finite(
            nextUp(
              finite(limit * ADJACENT_LOCALITY_FACTOR, "Local adjacency limit"),
            ),
            "Local adjacency limit",
          );
    const boundCache = new Map<string, Bounds>();
    const getBounds = (
      span: CertifiedSpan,
      start: number,
      end: number,
    ): Bounds => {
      const key = `${span.id}:${start}:${end}`;
      const cached = boundCache.get(key);
      if (cached) return cached;
      const computed = certifiedPolynomialBounds(
        polynomialRows(span),
        start,
        end,
        budget,
      );
      boundCache.set(key, computed);
      return computed;
    };
    const segments = makeSegments(
      certifiedSpans,
      initialCount,
      limit / 2,
      budget,
      getBounds,
    );
    const diagnostics: Diagnostic[] = [];
    let stopped = false;
    const stopWith = (error: unknown, relatedIds = ids): void => {
      if (!stopped)
        diagnostics.push(
          failureDiagnostic(
            error instanceof WorkBudgetExceeded
              ? new Error(`${error.message} (${budget.used}/${budget.maxWork})`)
              : error,
            relatedIds,
          ),
        );
      stopped = true;
    };
    interface TerrainNode {
      readonly start: number;
      readonly end: number;
      readonly depth: number;
      readonly point: Vec3;
      readonly actual: number;
      readonly witnessU: number;
      readonly lowerBound: number;
    }
    const makeTerrainNode = (
      segment: Segment,
      start: number,
      end: number,
      depth: number,
    ): TerrainNode => {
      const span = certifiedSpans[segment.spanIndex]!;
      const midpoint = (start + end) / 2;
      const witnessParameters = [start, midpoint, end];
      let witnessU = midpoint;
      let witnessPoint = safePosition(span, midpoint, budget);
      let actual = Number.POSITIVE_INFINITY;
      let witnessSignedDistance = Number.POSITIVE_INFINITY;
      for (const parameter of witnessParameters) {
        const candidatePoint =
          parameter === midpoint
            ? witnessPoint
            : safePosition(span, parameter, budget);
        budget.charge();
        const signedDistance = finite(
          environment!.signedDistance(candidatePoint),
          "Environment signed distance",
        );
        const candidateActual = finite(
          signedDistance - radius,
          "Terrain clearance witness",
        );
        if (candidateActual < actual) {
          actual = candidateActual;
          witnessU = parameter;
          witnessPoint = candidatePoint;
          witnessSignedDistance = signedDistance;
        }
      }
      const lowerBound = finite(
        witnessSignedDistance -
          radius -
          distanceToBoxUpper(witnessPoint, getBounds(span, start, end), budget),
        "Terrain clearance lower bound",
      );
      return {
        start,
        end,
        depth,
        point: witnessPoint,
        actual,
        witnessU,
        lowerBound,
      };
    };
    const certifyTerrain = (segment: Segment): void => {
      const span = certifiedSpans[segment.spanIndex]!;
      const stationaryParameters = new Set<number>();
      for (const axis of [0, 1, 2] as const)
        for (let seed = 0; seed <= 16; seed += 1) {
          let parameter = seed / 16;
          for (let iteration = 0; iteration < 12; iteration += 1) {
            const first = safeDerivative(span, parameter, 1, budget)[axis];
            const second = safeDerivative(span, parameter, 2, budget)[axis];
            if (Math.abs(second) < 1e-15) break;
            const next = Math.max(
              segment.startU,
              Math.min(segment.endU, parameter - first / second),
            );
            if (next === parameter) break;
            parameter = next;
          }
          stationaryParameters.add(parameter);
        }
      for (const parameter of stationaryParameters) {
        const point = safePosition(span, parameter, budget);
        budget.charge();
        const actual = finite(
          environment!.signedDistance(point) - radius,
          "Terrain clearance witness",
        );
        if (actual <= 0) {
          const s = curveS(segment, parameter, certifiedSpans, budget);
          diagnostics.push(
            finiteDiagnostic(
              "TERRAIN_CLEARANCE",
              `Terrain clearance is ${actual.toFixed(6)} m at s=${s.toFixed(6)} m`,
              point,
              actual,
              0,
              s,
              [span.id],
            ),
          );
          stopped = true;
          return;
        }
      }
      const pending: TerrainNode[] = [];
      const push = (node: TerrainNode): void => {
        budget.charge(Math.ceil(Math.log2(pending.length + 2)));
        pending.push(node);
        let index = pending.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (
            pending[parent]!.actual < pending[index]!.actual ||
            (pending[parent]!.actual === pending[index]!.actual &&
              pending[parent]!.lowerBound <= pending[index]!.lowerBound)
          )
            break;
          [pending[parent], pending[index]] = [
            pending[index]!,
            pending[parent]!,
          ];
          index = parent;
        }
      };
      const pop = (): TerrainNode => {
        budget.charge(Math.ceil(Math.log2(pending.length + 1)));
        const result = pending[0]!;
        const last = pending.pop()!;
        if (pending.length > 0) {
          pending[0] = last;
          let index = 0;
          while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (
              left < pending.length &&
              (pending[left]!.actual < pending[smallest]!.actual ||
                (pending[left]!.actual === pending[smallest]!.actual &&
                  pending[left]!.lowerBound < pending[smallest]!.lowerBound))
            )
              smallest = left;
            if (
              right < pending.length &&
              (pending[right]!.actual < pending[smallest]!.actual ||
                (pending[right]!.actual === pending[smallest]!.actual &&
                  pending[right]!.lowerBound < pending[smallest]!.lowerBound))
            )
              smallest = right;
            if (smallest === index) break;
            [pending[index], pending[smallest]] = [
              pending[smallest]!,
              pending[index]!,
            ];
            index = smallest;
          }
        }
        return result;
      };
      push(makeTerrainNode(segment, segment.startU, segment.endU, 0));
      while (pending.length > 0) {
        const node = pop();
        const span = certifiedSpans[segment.spanIndex]!;
        const s = curveS(segment, node.witnessU, certifiedSpans, budget);
        if (node.actual <= 0) {
          diagnostics.push(
            finiteDiagnostic(
              "TERRAIN_CLEARANCE",
              `Terrain clearance is ${node.actual.toFixed(6)} m at s=${s.toFixed(6)} m`,
              node.point,
              node.actual,
              0,
              s,
              [span.id],
            ),
          );
          stopped = true;
          return;
        }
        if (node.lowerBound > 0) continue;
        if (node.depth >= maxDepth)
          throw new CertificationError(
            "Terrain clearance certification exhausted its deterministic depth budget",
          );
        const midpoint = (node.start + node.end) / 2;
        if (midpoint === node.start || midpoint === node.end)
          throw new CertificationError(
            "Terrain clearance certification reached floating-point parameter resolution",
          );
        push(makeTerrainNode(segment, node.start, midpoint, node.depth + 1));
        push(makeTerrainNode(segment, midpoint, node.end, node.depth + 1));
      }
    };
    if (environment) {
      for (const segment of segments) {
        if (stopped) break;
        try {
          certifyTerrain(segment);
        } catch (error) {
          stopWith(error, [certifiedSpans[segment.spanIndex]!.id]);
        }
      }
    }
    if (stopped) return Object.freeze(diagnostics);

    let selfSubdivision: SelfSubdivision;
    try {
      selfSubdivision = makeSelfSegments(
        certifiedSpans,
        segments.length,
        limit / 2,
        maxDepth,
        budget,
        getBounds,
      );
    } catch (error) {
      if (error instanceof WorkBudgetExceeded)
        throw new CertificationError(
          `Certified polynomial work budget exhausted during same-span subdivision (${budget.used}/${budget.maxWork})`,
        );
      throw error;
    }
    const selfSegments = selfSubdivision.segments;
    const constantAxes = certifiedSpans.map((span) =>
      polynomialRows(span).map((row) =>
        row.slice(1).every((coefficient) => coefficient === 0),
      ),
    );
    const upperSum = (left: number, right: number): number => {
      budget.charge();
      return finite(
        nextUp(finite(left + right, "Local path upper sum")),
        "Local path upper sum",
      );
    };
    const localDerivativeHulls = certifiedSpans.map((span) =>
      derivativeHull(span, budget),
    );
    const derivativeHullChildren = new Map<
      string,
      readonly [DerivativeHull, DerivativeHull]
    >();
    const derivativeHullArcUppers = new Map<string, number>();
    const arcQueryCache = new Map<string, number>();
    const hullArcUpper = (
      spanIndex: number,
      start: number,
      end: number,
      hull: DerivativeHull,
    ): number => {
      const key = `${spanIndex}:${start}:${end}`;
      const cached = derivativeHullArcUppers.get(key);
      if (cached !== undefined) return cached;
      const speedUpper = derivativeSpeedUpper(
        derivativeHullBounds(hull, budget),
        budget,
      );
      budget.charge(2);
      const widthUpper = finite(
        nextUp(finite(end - start, "Parameter interval width")),
        "Parameter interval width upper",
      );
      const result = finite(
        nextUp(finite(speedUpper * widthUpper, "Arc-length upper product")),
        "Arc-length upper bound",
      );
      derivativeHullArcUppers.set(key, result);
      return result;
    };
    const certifiedArcUpper = (
      spanIndex: number,
      targetStart: number,
      targetEnd: number,
    ): number => {
      if (targetStart === targetEnd) return 0;
      const queryKey = `${spanIndex}:${targetStart}:${targetEnd}`;
      const cached = arcQueryCache.get(queryKey);
      if (cached !== undefined) return cached;
      const visit = (
        start: number,
        end: number,
        hull: DerivativeHull,
      ): number => {
        if (targetStart <= start && end <= targetEnd)
          return hullArcUpper(spanIndex, start, end, hull);
        const midpoint = (start + end) / 2;
        if (midpoint === start || midpoint === end)
          throw new CertificationError(
            "Local path certification reached floating-point parameter resolution",
          );
        const key = `${spanIndex}:${start}:${end}`;
        let children = derivativeHullChildren.get(key);
        if (!children) {
          children = splitDerivativeHull(hull, budget);
          derivativeHullChildren.set(key, children);
        }
        if (targetEnd <= midpoint) return visit(start, midpoint, children[0]);
        if (targetStart >= midpoint) return visit(midpoint, end, children[1]);
        return upperSum(
          visit(start, midpoint, children[0]),
          visit(midpoint, end, children[1]),
        );
      };
      const result = visit(0, 1, localDerivativeHulls[spanIndex]!);
      arcQueryCache.set(queryKey, result);
      return result;
    };
    const derivativeBoundsQueryCache = new Map<string, Bounds>();
    const certifiedDerivativeBounds = (
      spanIndex: number,
      targetStart: number,
      targetEnd: number,
    ): Bounds => {
      const queryKey = `${spanIndex}:${targetStart}:${targetEnd}`;
      const cached = derivativeBoundsQueryCache.get(queryKey);
      if (cached) return cached;
      const visit = (
        start: number,
        end: number,
        hull: DerivativeHull,
      ): Bounds => {
        if (targetStart <= start && end <= targetEnd)
          return derivativeHullBounds(hull, budget);
        const midpoint = (start + end) / 2;
        if (midpoint === start || midpoint === end)
          throw new CertificationError(
            "Directional certification reached floating-point parameter resolution",
          );
        const key = `${spanIndex}:${start}:${end}`;
        let children = derivativeHullChildren.get(key);
        if (!children) {
          children = splitDerivativeHull(hull, budget);
          derivativeHullChildren.set(key, children);
        }
        if (targetEnd <= midpoint) return visit(start, midpoint, children[0]);
        if (targetStart >= midpoint) return visit(midpoint, end, children[1]);
        const left = visit(start, midpoint, children[0]);
        const right = visit(midpoint, end, children[1]);
        budget.charge(6);
        return {
          min: vec3(
            Math.min(left.min[0], right.min[0]),
            Math.min(left.min[1], right.min[1]),
            Math.min(left.min[2], right.min[2]),
          ),
          max: vec3(
            Math.max(left.max[0], right.max[0]),
            Math.max(left.max[1], right.max[1]),
            Math.max(left.max[2], right.max[2]),
          ),
        };
      };
      const result = visit(0, 1, localDerivativeHulls[spanIndex]!);
      derivativeBoundsQueryCache.set(queryKey, result);
      return result;
    };
    const derivativeSign = (
      spanIndex: number,
      bounds: Bounds,
      axis: 0 | 1 | 2,
    ): -1 | 0 | 1 | undefined => {
      if (constantAxes[spanIndex]![axis]) return 0;
      if (bounds.min[axis] > 0) return 1;
      if (bounds.max[axis] < 0) return -1;
      return undefined;
    };
    const compatibleOrthants = (
      firstSpanIndex: number,
      firstBounds: Bounds,
      secondSpanIndex = firstSpanIndex,
      secondBounds = firstBounds,
    ): boolean =>
      ([0, 1, 2] as const).every((axis) => {
        const firstSign = derivativeSign(firstSpanIndex, firstBounds, axis);
        const secondSign = derivativeSign(secondSpanIndex, secondBounds, axis);
        return (
          firstSign !== undefined &&
          secondSign !== undefined &&
          (firstSign === 0 || secondSign === 0 || firstSign === secondSign)
        );
      });
    const segmentsBySpan = certifiedSpans.map(() => [] as Segment[]);
    for (const segment of selfSegments)
      segmentsBySpan[segment.spanIndex]!.push(segment);
    const endpointBoundsCache = new Map<string, Bounds>();
    const endpointBounds = (spanIndex: number, u: 0 | 1): Bounds => {
      const key = `${spanIndex}:${u}`;
      const cached = endpointBoundsCache.get(key);
      if (cached) return cached;
      const ranges = polynomialRows(certifiedSpans[spanIndex]!).map((row) => {
        if (u === 0) return { lo: row[0]!, hi: row[0]! };
        let lo = 0;
        let hi = 0;
        for (const coefficient of row) {
          budget.charge(2);
          lo = finite(
            nextDown(finite(lo + coefficient, "Endpoint lower sum")),
            "Endpoint lower bound",
          );
          hi = finite(
            nextUp(finite(hi + coefficient, "Endpoint upper sum")),
            "Endpoint upper bound",
          );
        }
        return { lo, hi };
      });
      const result = {
        min: vec3(ranges[0]!.lo, ranges[1]!.lo, ranges[2]!.lo),
        max: vec3(ranges[0]!.hi, ranges[1]!.hi, ranges[2]!.hi),
      };
      endpointBoundsCache.set(key, result);
      return result;
    };
    const endpointCoincidenceCache = new Map<string, boolean>();
    const endpointsCoincide = (
      firstSpanIndex: number,
      firstU: 0 | 1,
      secondSpanIndex: number,
      secondU: 0 | 1,
    ): boolean => {
      const key = `${firstSpanIndex}:${firstU}:${secondSpanIndex}:${secondU}`;
      const cached = endpointCoincidenceCache.get(key);
      if (cached !== undefined) return cached;
      let result = overlaps(
        endpointBounds(firstSpanIndex, firstU),
        endpointBounds(secondSpanIndex, secondU),
      );
      if (!result) {
        const firstPoint = safePosition(
          certifiedSpans[firstSpanIndex]!,
          firstU,
          budget,
        );
        const secondPoint = safePosition(
          certifiedSpans[secondSpanIndex]!,
          secondU,
          budget,
        );
        const endpointDistance = safeDistance(firstPoint, secondPoint, budget);
        result = endpointDistance <= SHARED_ENDPOINT_TOLERANCE;
      }
      endpointCoincidenceCache.set(key, result);
      return result;
    };
    const sequentialEndpointShared = (
      firstSpanIndex: number,
      secondSpanIndex: number,
    ): boolean => {
      const earlier = Math.min(firstSpanIndex, secondSpanIndex);
      const later = Math.max(firstSpanIndex, secondSpanIndex);
      return later === earlier + 1 && endpointsCoincide(earlier, 1, later, 0);
    };
    const closureEndpointShared = (
      firstSpanIndex: number,
      secondSpanIndex: number,
    ): boolean =>
      closed &&
      Math.min(firstSpanIndex, secondSpanIndex) === 0 &&
      Math.max(firstSpanIndex, secondSpanIndex) === certifiedSpans.length - 1 &&
      endpointsCoincide(certifiedSpans.length - 1, 1, 0, 0);
    const spanHeadUpper = (segment: Segment, u: number): number =>
      certifiedArcUpper(segment.spanIndex, 0, u);
    const spanTailUpper = (segment: Segment, u: number): number =>
      certifiedArcUpper(segment.spanIndex, u, 1);
    const sameSpanPathUpper = (
      first: Segment,
      firstU: number,
      second: Segment,
      secondU: number,
    ): number => {
      return certifiedArcUpper(
        first.spanIndex,
        Math.min(firstU, secondU),
        Math.max(firstU, secondU),
      );
    };
    const localPathUpper = (
      first: Segment,
      firstU: number,
      second: Segment,
      secondU: number,
    ): number | undefined => {
      const candidates: number[] = [];
      if (first.spanIndex === second.spanIndex) {
        if (Math.abs(first.segmentIndex - second.segmentIndex) === 1)
          candidates.push(sameSpanPathUpper(first, firstU, second, secondU));
        if (
          closed &&
          certifiedSpans.length === 1 &&
          closureEndpointShared(first.spanIndex, second.spanIndex) &&
          Math.min(first.segmentIndex, second.segmentIndex) === 0 &&
          Math.max(first.segmentIndex, second.segmentIndex) ===
            segmentsBySpan[first.spanIndex]!.length - 1
        ) {
          const lower =
            first.segmentIndex < second.segmentIndex
              ? { segment: first, u: firstU }
              : { segment: second, u: secondU };
          const upper =
            first.segmentIndex < second.segmentIndex
              ? { segment: second, u: secondU }
              : { segment: first, u: firstU };
          candidates.push(
            upperSum(
              spanTailUpper(upper.segment, upper.u),
              spanHeadUpper(lower.segment, lower.u),
            ),
          );
        }
      } else if (
        Math.abs(first.spanIndex - second.spanIndex) === 1 &&
        sequentialEndpointShared(first.spanIndex, second.spanIndex)
      ) {
        const earlier =
          first.spanIndex < second.spanIndex
            ? { segment: first, u: firstU }
            : { segment: second, u: secondU };
        const later =
          first.spanIndex < second.spanIndex
            ? { segment: second, u: secondU }
            : { segment: first, u: firstU };
        candidates.push(
          upperSum(
            spanTailUpper(earlier.segment, earlier.u),
            spanHeadUpper(later.segment, later.u),
          ),
        );
      }
      if (
        closed &&
        first.spanIndex !== second.spanIndex &&
        Math.min(first.spanIndex, second.spanIndex) === 0 &&
        Math.max(first.spanIndex, second.spanIndex) ===
          certifiedSpans.length - 1 &&
        closureEndpointShared(first.spanIndex, second.spanIndex)
      ) {
        const firstTrack =
          first.spanIndex === 0
            ? { segment: first, u: firstU }
            : { segment: second, u: secondU };
        const lastTrack =
          first.spanIndex === certifiedSpans.length - 1
            ? { segment: first, u: firstU }
            : { segment: second, u: secondU };
        candidates.push(
          upperSum(
            spanTailUpper(lastTrack.segment, lastTrack.u),
            spanHeadUpper(firstTrack.segment, firstTrack.u),
          ),
        );
      }
      return candidates.length === 0 ? undefined : Math.min(...candidates);
    };
    const localNodeUpper = (node: PairNode): number | undefined => {
      const candidates: number[] = [];
      if (node.first.spanIndex === node.second.spanIndex) {
        const lower =
          node.first.segmentIndex < node.second.segmentIndex
            ? {
                segment: node.first,
                directU: node.firstU0,
                seamU: node.firstU1,
              }
            : {
                segment: node.second,
                directU: node.secondU0,
                seamU: node.secondU1,
              };
        const upper =
          node.first.segmentIndex < node.second.segmentIndex
            ? {
                segment: node.second,
                directU: node.secondU1,
                seamU: node.secondU0,
              }
            : {
                segment: node.first,
                directU: node.firstU1,
                seamU: node.firstU0,
              };
        if (Math.abs(node.first.segmentIndex - node.second.segmentIndex) === 1)
          candidates.push(
            sameSpanPathUpper(
              lower.segment,
              lower.directU,
              upper.segment,
              upper.directU,
            ),
          );
        if (
          closed &&
          certifiedSpans.length === 1 &&
          closureEndpointShared(node.first.spanIndex, node.second.spanIndex) &&
          lower.segment.segmentIndex === 0 &&
          upper.segment.segmentIndex ===
            segmentsBySpan[node.first.spanIndex]!.length - 1
        ) {
          candidates.push(
            upperSum(
              spanTailUpper(upper.segment, upper.seamU),
              spanHeadUpper(lower.segment, lower.seamU),
            ),
          );
        }
      } else if (
        Math.abs(node.first.spanIndex - node.second.spanIndex) === 1 &&
        sequentialEndpointShared(node.first.spanIndex, node.second.spanIndex)
      ) {
        const earlier =
          node.first.spanIndex < node.second.spanIndex
            ? { segment: node.first, start: node.firstU0 }
            : { segment: node.second, start: node.secondU0 };
        const later =
          node.first.spanIndex < node.second.spanIndex
            ? { segment: node.second, end: node.secondU1 }
            : { segment: node.first, end: node.firstU1 };
        candidates.push(
          upperSum(
            spanTailUpper(earlier.segment, earlier.start),
            spanHeadUpper(later.segment, later.end),
          ),
        );
      }
      if (
        closed &&
        node.first.spanIndex !== node.second.spanIndex &&
        Math.min(node.first.spanIndex, node.second.spanIndex) === 0 &&
        Math.max(node.first.spanIndex, node.second.spanIndex) ===
          certifiedSpans.length - 1 &&
        closureEndpointShared(node.first.spanIndex, node.second.spanIndex)
      ) {
        const firstTrack =
          node.first.spanIndex === 0
            ? { segment: node.first, end: node.firstU1 }
            : { segment: node.second, end: node.secondU1 };
        const lastTrack =
          node.first.spanIndex === certifiedSpans.length - 1
            ? { segment: node.first, start: node.firstU0 }
            : { segment: node.second, start: node.secondU0 };
        candidates.push(
          upperSum(
            spanTailUpper(lastTrack.segment, lastTrack.start),
            spanHeadUpper(firstTrack.segment, firstTrack.end),
          ),
        );
      }
      return candidates.length === 0 ? undefined : Math.min(...candidates);
    };
    const hasOrthantPairCertificate = (node: PairNode): boolean => {
      if (node.first.spanIndex === node.second.spanIndex) {
        if (
          Math.abs(node.first.segmentIndex - node.second.segmentIndex) === 1
        ) {
          const bounds = certifiedDerivativeBounds(
            node.first.spanIndex,
            Math.min(node.first.startU, node.second.startU),
            Math.max(node.first.endU, node.second.endU),
          );
          if (compatibleOrthants(node.first.spanIndex, bounds)) return true;
        }
        if (
          closed &&
          certifiedSpans.length === 1 &&
          closureEndpointShared(node.first.spanIndex, node.second.spanIndex) &&
          Math.min(node.first.segmentIndex, node.second.segmentIndex) === 0 &&
          Math.max(node.first.segmentIndex, node.second.segmentIndex) ===
            segmentsBySpan[node.first.spanIndex]!.length - 1
        ) {
          const firstTrack =
            node.first.segmentIndex === 0 ? node.first : node.second;
          const lastTrack =
            node.first.segmentIndex ===
            segmentsBySpan[node.first.spanIndex]!.length - 1
              ? node.first
              : node.second;
          if (
            compatibleOrthants(
              lastTrack.spanIndex,
              certifiedDerivativeBounds(
                lastTrack.spanIndex,
                lastTrack.startU,
                1,
              ),
              firstTrack.spanIndex,
              certifiedDerivativeBounds(
                firstTrack.spanIndex,
                0,
                firstTrack.endU,
              ),
            )
          )
            return true;
        }
      } else if (
        Math.abs(node.first.spanIndex - node.second.spanIndex) === 1 &&
        sequentialEndpointShared(node.first.spanIndex, node.second.spanIndex)
      ) {
        const earlier =
          node.first.spanIndex < node.second.spanIndex
            ? node.first
            : node.second;
        const later =
          node.first.spanIndex < node.second.spanIndex
            ? node.second
            : node.first;
        if (
          compatibleOrthants(
            earlier.spanIndex,
            certifiedDerivativeBounds(earlier.spanIndex, earlier.startU, 1),
            later.spanIndex,
            certifiedDerivativeBounds(later.spanIndex, 0, later.endU),
          )
        )
          return true;
      }
      if (
        closed &&
        node.first.spanIndex !== node.second.spanIndex &&
        Math.min(node.first.spanIndex, node.second.spanIndex) === 0 &&
        Math.max(node.first.spanIndex, node.second.spanIndex) ===
          certifiedSpans.length - 1 &&
        closureEndpointShared(node.first.spanIndex, node.second.spanIndex)
      ) {
        const firstTrack =
          node.first.spanIndex === 0 ? node.first : node.second;
        const lastTrack =
          node.first.spanIndex === certifiedSpans.length - 1
            ? node.first
            : node.second;
        if (
          compatibleOrthants(
            lastTrack.spanIndex,
            certifiedDerivativeBounds(lastTrack.spanIndex, lastTrack.startU, 1),
            firstTrack.spanIndex,
            certifiedDerivativeBounds(firstTrack.spanIndex, 0, firstTrack.endU),
          )
        )
          return true;
      }
      return false;
    };
    const hasCoincidentAdjacentEndpoint = (
      first: Segment,
      second: Segment,
    ): boolean => {
      if (!adjacent(first, second, closed, certifiedSpans.length)) return false;
      if (first.spanIndex === second.spanIndex) {
        if (Math.abs(first.segmentIndex - second.segmentIndex) === 1)
          return true;
        return closureEndpointShared(first.spanIndex, second.spanIndex);
      }
      if (Math.abs(first.spanIndex - second.spanIndex) === 1)
        return sequentialEndpointShared(first.spanIndex, second.spanIndex);
      return closureEndpointShared(first.spanIndex, second.spanIndex);
    };

    const seenPairs = new Set<string>();
    const pairRoots: PairNode[] = [];
    const cellSize = Math.max(limit, 1);
    const addCandidate = (
      other: Segment,
      segment: Segment,
      sameSpan: boolean,
    ): void => {
      budget.charge();
      if (
        other === segment ||
        (other.spanIndex === segment.spanIndex) !== sameSpan ||
        (limit === 0 && hasCoincidentAdjacentEndpoint(other, segment)) ||
        !overlaps(other.bounds, segment.bounds)
      )
        return;
      const key = pairKey(other, segment);
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      budget.charge();
      pairRoots.push({
        first: other,
        second: segment,
        firstU0: other.startU,
        firstU1: other.endU,
        secondU0: segment.startU,
        secondU1: segment.endU,
        depth: 0,
      });
    };
    const collectCandidates = (
      candidatesToIndex: readonly Segment[],
      sameSpan: boolean,
    ): void => {
      let sweepAxis: 0 | 1 | 2 = 0;
      let sweepExtent = Number.NEGATIVE_INFINITY;
      for (const axis of [0, 1, 2] as const) {
        budget.charge(candidatesToIndex.length);
        let minimum = Number.POSITIVE_INFINITY;
        let maximum = Number.NEGATIVE_INFINITY;
        for (const segment of candidatesToIndex) {
          minimum = Math.min(minimum, segment.bounds.min[axis]);
          maximum = Math.max(maximum, segment.bounds.max[axis]);
        }
        const extent = finite(maximum - minimum, "Sweep-axis extent");
        if (extent > sweepExtent) {
          sweepAxis = axis;
          sweepExtent = extent;
        }
      }
      const sortCost =
        candidatesToIndex.length <= 1
          ? 0
          : CertifiedWorkBudget.checkedProduct(
              candidatesToIndex.length,
              Math.ceil(Math.log2(candidatesToIndex.length)) + 1,
            );
      budget.charge(sortCost);
      const ordered = [...candidatesToIndex].sort(
        (left, right) =>
          left.bounds.min[sweepAxis] - right.bounds.min[sweepAxis] ||
          left.segmentId - right.segmentId,
      );
      let active: Segment[] = [];
      for (const segment of ordered) {
        budget.charge(active.length);
        active = active.filter(
          (candidate) =>
            candidate.bounds.max[sweepAxis] >= segment.bounds.min[sweepAxis],
        );
        for (const other of active) addCandidate(other, segment, sameSpan);
        active.push(segment);
      }
    };
    try {
      if (
        certifiedSpans.length === 1 &&
        limit === 0 &&
        selfSegments.length === 1
      )
        for (const segment of segments) {
          const ranges = bucketRanges(segment.bounds, cellSize, budget);
          const bucketCount = CertifiedWorkBudget.checkedProduct(
            CertifiedWorkBudget.checkedProduct(
              rangeCount(ranges[0]!),
              rangeCount(ranges[1]!),
            ),
            rangeCount(ranges[2]!),
          );
          budget.charge(bucketCount);
        }
      if (certifiedSpans.length > 1) collectCandidates(selfSegments, false);
      let groupStart = 0;
      while (groupStart < selfSegments.length) {
        let groupEnd = groupStart + 1;
        while (
          groupEnd < selfSegments.length &&
          selfSegments[groupEnd]!.spanIndex ===
            selfSegments[groupStart]!.spanIndex
        )
          groupEnd += 1;
        if (groupEnd - groupStart > 1)
          collectCandidates(selfSegments.slice(groupStart, groupEnd), true);
        groupStart = groupEnd;
      }
    } catch (error) {
      if (error instanceof WorkBudgetExceeded)
        throw new CertificationError(
          `Certified polynomial work budget exhausted during spatial broad phase (${budget.used}/${budget.maxWork})`,
        );
      throw error;
    }
    const processPair = (root: PairNode): void => {
      if (limit > 0 && hasOrthantPairCertificate(root)) return;
      const stack: PairNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        budget.charge();
        const firstSpan = certifiedSpans[node.first.spanIndex]!;
        const secondSpan = certifiedSpans[node.second.spanIndex]!;
        const nodeLocalUpper = localNodeUpper(node);
        if (nodeLocalUpper !== undefined && nodeLocalUpper <= localityLimit)
          continue;
        const firstBox = getBounds(firstSpan, node.firstU0, node.firstU1);
        const secondBox = getBounds(secondSpan, node.secondU0, node.secondU1);
        if (boxDistanceLower(firstBox, secondBox, budget) > limit) continue;
        const firstMid = (node.firstU0 + node.firstU1) / 2;
        const secondMid = (node.secondU0 + node.secondU1) / 2;
        let witnessDistance = Number.POSITIVE_INFINITY;
        let witnessFirst = firstMid;
        const firstCandidates = [node.firstU0, firstMid, node.firstU1];
        const secondCandidates = [node.secondU0, secondMid, node.secondU1];
        budget.charge(
          CertifiedWorkBudget.checkedProduct(
            firstCandidates.length,
            secondCandidates.length,
          ),
        );
        for (const firstU of firstCandidates)
          for (const secondU of secondCandidates) {
            const witnessLocalUpper = localPathUpper(
              node.first,
              firstU,
              node.second,
              secondU,
            );
            if (
              witnessLocalUpper !== undefined &&
              witnessLocalUpper <= localityLimit
            )
              continue;
            const distance = safeDistance(
              safePosition(firstSpan, firstU, budget),
              safePosition(secondSpan, secondU, budget),
              budget,
            );
            if (distance < witnessDistance) {
              witnessDistance = distance;
              witnessFirst = firstU;
            }
          }
        const disjointParameters =
          node.first.spanIndex !== node.second.spanIndex ||
          node.firstU1 < node.secondU0 - PARAMETER_TOLERANCE ||
          node.secondU1 < node.firstU0 - PARAMETER_TOLERANCE;
        if (disjointParameters && witnessDistance <= limit) {
          const point = safePosition(firstSpan, witnessFirst, budget);
          const s = curveS(node.first, witnessFirst, certifiedSpans, budget);
          diagnostics.push(
            finiteDiagnostic(
              "TRACK_CLEARANCE",
              `Track clearance is ${(witnessDistance - limit).toFixed(6)} m at s=${s.toFixed(6)} m`,
              point,
              witnessDistance,
              limit,
              s,
              [firstSpan.id, secondSpan.id],
            ),
          );
          stopped = true;
          return;
        }
        if (node.depth >= maxDepth)
          throw new CertificationError(
            "Track clearance certification exhausted its deterministic depth budget",
          );
        if (
          firstMid === node.firstU0 ||
          firstMid === node.firstU1 ||
          secondMid === node.secondU0 ||
          secondMid === node.secondU1
        )
          throw new CertificationError(
            "Track clearance certification reached floating-point parameter resolution",
          );
        if (node.firstU1 - node.firstU0 >= node.secondU1 - node.secondU0) {
          stack.push(
            { ...node, firstU0: firstMid, depth: node.depth + 1 },
            { ...node, firstU1: firstMid, depth: node.depth + 1 },
          );
        } else {
          stack.push(
            { ...node, secondU0: secondMid, depth: node.depth + 1 },
            { ...node, secondU1: secondMid, depth: node.depth + 1 },
          );
        }
      }
    };
    for (const root of pairRoots) {
      if (stopped) break;
      try {
        processPair(root);
      } catch (error) {
        stopWith(error, [
          certifiedSpans[root.first.spanIndex]!.id,
          certifiedSpans[root.second.spanIndex]!.id,
        ]);
      }
    }
    if (!stopped && selfSubdivision.unresolvedSpanIds.length > 0)
      diagnostics.push(
        uncertain(
          "Same-span clearance subdivision exhausted its deterministic depth budget",
          selfSubdivision.unresolvedSpanIds,
        ),
      );
    return Object.freeze(diagnostics);
  } catch (error) {
    return Object.freeze([failureDiagnostic(error, ids)]);
  }
};
