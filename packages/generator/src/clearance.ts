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

const DEFAULT_MAX_DEPTH = 40;
const DEFAULT_MAX_WORK = 1_000_000;
const PARAMETER_TOLERANCE = 1e-12;

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
    options.maxWork ?? (environment === undefined ? DEFAULT_MAX_WORK : 100_000);
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

    const buckets = new Map<string, Segment[]>();
    const seenPairs = new Set<string>();
    const pairRoots: PairNode[] = [];
    const cellSize = Math.max(limit, 1);
    const closed = options.closed ?? false;
    const addCandidate = (other: Segment, segment: Segment): void => {
      budget.charge();
      if (
        other === segment ||
        adjacent(other, segment, closed, certifiedSpans.length) ||
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
    for (const segment of segments) {
      if (stopped) break;
      const ranges = bucketRanges(segment.bounds, cellSize, budget);
      const bucketCount = CertifiedWorkBudget.checkedProduct(
        CertifiedWorkBudget.checkedProduct(
          rangeCount(ranges[0]!),
          rangeCount(ranges[1]!),
        ),
        rangeCount(ranges[2]!),
      );
      budget.charge(bucketCount);
      for (let x = ranges[0]![0]; x <= ranges[0]![1]; x += 1)
        for (let y = ranges[1]![0]; y <= ranges[1]![1]; y += 1)
          for (let z = ranges[2]![0]; z <= ranges[2]![1]; z += 1) {
            const key = `${x},${y},${z}`;
            const candidates = buckets.get(key) ?? [];
            budget.charge(candidates.length);
            for (const other of candidates) addCandidate(other, segment);
            candidates.push(segment);
            buckets.set(key, candidates);
          }
    }
    const sortCost =
      pairRoots.length <= 1
        ? 0
        : CertifiedWorkBudget.checkedProduct(
            pairRoots.length,
            Math.ceil(Math.log2(pairRoots.length)) + 1,
          );
    budget.charge(sortCost);
    pairRoots.sort(
      (left, right) =>
        left.first.segmentId - right.first.segmentId ||
        left.second.segmentId - right.second.segmentId,
    );
    const processPair = (root: PairNode): void => {
      const stack: PairNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        budget.charge();
        const firstSpan = certifiedSpans[node.first.spanIndex]!;
        const secondSpan = certifiedSpans[node.second.spanIndex]!;
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
    return Object.freeze(diagnostics);
  } catch (error) {
    return Object.freeze([failureDiagnostic(error, ids)]);
  }
};
