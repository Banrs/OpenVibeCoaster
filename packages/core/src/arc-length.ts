import { SeventhOrderHermiteSpan } from "./spans";
import type { ParametricSpan } from "./spans";
import { vec3Length } from "./math";
import type { Vec3 } from "./math";
import { TrackCompileError } from "./compile-error";

const nodes: readonly [number, number, number, number, number] = [
  0.0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664,
  0.906179845938664,
];
const weights: readonly [number, number, number, number, number] = [
  0.5688888888888889, 0.47862867049936647, 0.47862867049936647,
  0.23692688505618908, 0.23692688505618908,
];

export type PositionSpan = ParametricSpan<Vec3>;
const MIN_SPEED = 1e-12;
const REGULARITY_SEARCH_STEPS = 8;
const REGULARITY_ROOT_ITERATIONS = 50;
const MIN_NEWTON_SPEED = 1e-10;

const speed = (span: PositionSpan, u: number): number => {
  const value = vec3Length(span.derivative(u, 1));
  if (!Number.isFinite(value) || !(value > MIN_SPEED))
    throw new RangeError("A span derivative must be finite and non-zero");
  return value;
};

// --- Interval helpers for certified speed (outward) ---
const arcBits = new DataView(new ArrayBuffer(8));
const nextUp = (value: number): number => {
  if (Number.isNaN(value))
    throw new TrackCompileError("INTEGRATION_FAILED", "nextUp NaN", {
      stage: "speed",
    });
  if (value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  arcBits.setFloat64(0, value, false);
  let w = arcBits.getBigUint64(0, false);
  w = value > 0 ? w + 1n : w - 1n;
  arcBits.setBigUint64(0, w, false);
  return arcBits.getFloat64(0, false);
};
const nextDown = (value: number): number => {
  if (Number.isNaN(value))
    throw new TrackCompileError("INTEGRATION_FAILED", "nextDown NaN", {
      stage: "speed",
    });
  if (value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return -Number.MIN_VALUE;
  arcBits.setFloat64(0, value, false);
  let w = arcBits.getBigUint64(0, false);
  w = value > 0 ? w - 1n : w + 1n;
  arcBits.setBigUint64(0, w, false);
  return arcBits.getFloat64(0, false);
};
type Interval = { readonly lo: number; readonly hi: number };
const intervalExact = (v: number): Interval => {
  if (!Number.isFinite(v))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Interval exact requires finite",
      { stage: "speed", actual: v },
    );
  return { lo: v, hi: v };
};
const intervalAdd = (a: Interval, b: Interval): Interval => ({
  lo: nextDown(a.lo + b.lo),
  hi: nextUp(a.hi + b.hi),
});
const intervalSub = (a: Interval, b: Interval): Interval => ({
  lo: nextDown(a.lo - b.hi),
  hi: nextUp(a.hi - b.lo),
});
const intervalMul = (a: Interval, b: Interval): Interval => {
  const vals = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return { lo: nextDown(Math.min(...vals)), hi: nextUp(Math.max(...vals)) };
};

const binomial = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
};
const intervalDiv = (a: Interval, b: Interval): Interval => {
  if (b.lo <= 0 && b.hi >= 0)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Interval division by zero-spanning interval",
      { stage: "speed" },
    );
  const vals = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi];
  return { lo: nextDown(Math.min(...vals)), hi: nextUp(Math.max(...vals)) };
};
const restrictPowerCoefficientsInterval = (
  coeffs: readonly Interval[],
  a: number,
  b: number,
): Interval[] => {
  const wInterval = intervalSub(intervalExact(b), intervalExact(a));
  const aInterval = intervalExact(a);
  const n = coeffs.length;
  const aPowers: Interval[] = [intervalExact(1)];
  for (let i = 1; i < n; i += 1)
    aPowers.push(intervalMul(aPowers[i - 1]!, aInterval));
  const res: Interval[] = Array.from({ length: n }, () => intervalExact(0));
  for (let k = 0; k < n; k += 1) {
    let sum: Interval = intervalExact(0);
    let wPow: Interval = intervalExact(1);
    for (let p = 0; p < k; p += 1) wPow = intervalMul(wPow, wInterval);
    for (let i = k; i < n; i += 1) {
      const bin = intervalExact(binomial(i, k));
      const term = intervalMul(intervalMul(coeffs[i]!, bin), aPowers[i - k]!);
      sum = intervalAdd(sum, term);
    }
    res[k] = intervalMul(sum, wPow);
  }
  return res;
};
const powerToBernsteinInterval = (q: readonly Interval[]): Interval[] => {
  const n = q.length - 1;
  const b: Interval[] = Array.from({ length: n + 1 }, () => intervalExact(0));
  for (let k = 0; k <= n; k += 1) {
    let acc: Interval = q[k]!;
    for (let j = 0; j < k; j += 1) {
      const sign = (k - j) % 2 === 0 ? 1 : -1;
      const mij = binomial(n, j) * binomial(n - j, k - j) * sign;
      const term = intervalMul(b[j]!, intervalExact(mij));
      acc = intervalSub(acc, term);
    }
    const diag = binomial(n, k);
    if (diag === 0)
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        "Bernstein diagonal zero",
        { stage: "speed" },
      );
    b[k] = intervalMul(acc, intervalDiv(intervalExact(1), intervalExact(diag)));
  }
  return b;
};

const CERTIFY_MAX_WORK = 200000;
const certifySpeedInterval = (
  span: PositionSpan,
  a: number,
  b: number,
  depth = 0,
  work: { count: number } = { count: 0 },
): void => {
  work.count += 1;
  if (work.count > CERTIFY_MAX_WORK)
    throw new TrackCompileError(
      "SPEED_CERTIFICATION_FAILED",
      `Speed certification exceeded work ${CERTIFY_MAX_WORK} on [${a},${b}]`,
      {
        stage: "speed",
        uInterval: [a, b],
        depth,
        work: work.count,
        limit: CERTIFY_MAX_WORK,
      },
    );
  if (a === b) return;
  if (depth > 32)
    throw new TrackCompileError(
      "SPEED_CERTIFICATION_FAILED",
      `Speed certification exceeded depth on [${a},${b}]`,
      { stage: "speed", uInterval: [a, b], depth, work: work.count },
    );
  // Try to certify lower bound for this interval
  if (span instanceof SeventhOrderHermiteSpan) {
    const rows = (span as SeventhOrderHermiteSpan<Vec3>)
      .coefficients as readonly (readonly number[])[];
    // Derivative coefficients: degree 6, 7 values per component
    const derivRows: Interval[][] = rows.map((row) => {
      const derivCoeffs: Interval[] = [];
      for (let i = 1; i < row.length; i += 1)
        derivCoeffs.push(intervalMul(intervalExact(row[i]!), intervalExact(i)));
      // derivCoeffs length 7 for degree 6
      return derivCoeffs;
    });
    // For each component, restrict to [a,b] and get Bernstein intervals, then find range
    let minAbsSquaredDown = 0;
    for (let comp = 0; comp < 3; comp += 1) {
      const q = restrictPowerCoefficientsInterval(derivRows[comp]!, a, b);
      const bern = powerToBernsteinInterval(q);
      let lo = Infinity,
        hi = -Infinity;
      for (const iv of bern) {
        lo = Math.min(lo, iv.lo);
        hi = Math.max(hi, iv.hi);
      }
      let compMinAbs: number;
      if (lo <= 0 && hi >= 0) compMinAbs = 0;
      else compMinAbs = Math.min(Math.abs(lo), Math.abs(hi));
      const sq = compMinAbs * compMinAbs;
      const sqDown = sq === 0 ? 0 : nextDown(sq);
      const sum = minAbsSquaredDown + sqDown;
      minAbsSquaredDown = sum === 0 ? 0 : nextDown(sum);
      if (minAbsSquaredDown !== 0 && !Number.isFinite(minAbsSquaredDown))
        throw new TrackCompileError(
          "SPEED_CERTIFICATION_FAILED",
          `Speed lower bound non-finite on [${a},${b}]`,
          { stage: "speed", uInterval: [a, b], work: work.count },
        );
    }
    const speedLower =
      minAbsSquaredDown === 0 ? 0 : Math.sqrt(minAbsSquaredDown);
    const lowerOutward = minAbsSquaredDown === 0 ? 0 : nextDown(speedLower);
    if (lowerOutward > 1e-12) return; // certified positive
    // Not certified, need to subdivide deterministically
    const mid = (a + b) / 2;
    if (!Number.isFinite(mid) || mid <= a || mid >= b)
      throw new TrackCompileError(
        "SPEED_CERTIFICATION_FAILED",
        `Speed certification reached parameter resolution on [${a},${b}]`,
        {
          stage: "speed",
          uInterval: [a, b],
          actual: lowerOutward,
          limit: 1e-12,
          depth,
          work: work.count,
        },
      );
    certifySpeedInterval(span, a, mid, depth + 1, work);
    certifySpeedInterval(span, mid, b, depth + 1, work);
    return;
  }
  // Opaque span: require explicit speed lower bound certifier
  const maybe = span as unknown as {
    speedLowerBound?: (a: number, b: number) => number;
  };
  if (typeof maybe.speedLowerBound === "function") {
    const lb = maybe.speedLowerBound(a, b);
    if (!Number.isFinite(lb) || lb <= 1e-12)
      throw new TrackCompileError(
        "SPEED_CERTIFICATION_FAILED",
        `Speed lower bound not positive on [${a},${b}]`,
        { stage: "speed", uInterval: [a, b], actual: lb, limit: 1e-12 },
      );
    return;
  }
  throw new TrackCompileError(
    "SPEED_CERTIFICATION_FAILED",
    `Span requires speedLowerBound certifier for [${a},${b}]`,
    { stage: "speed", uInterval: [a, b] },
  );
};

const speedSlope = (span: PositionSpan, u: number): number => {
  const first = span.derivative(u, 1);
  const value = vec3Length(first);
  if (!Number.isFinite(value) || !(value > MIN_SPEED))
    throw new RangeError("A span derivative must be finite and non-zero");
  const second = span.derivative(u, 2);
  const slope =
    first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  if (!Number.isFinite(slope))
    throw new RangeError("A span derivative must be finite and non-zero");
  return slope;
};
const hasOppositeSigns = (left: number, right: number): boolean =>
  (left < 0 && right > 0) || (left > 0 && right < 0);
const validateSpeedRegularity = (
  span: PositionSpan,
  start: number,
  end: number,
): void => {
  // This is a bounded search for the smooth analytic spans supported here;
  // opaque callbacks can still change between any two evaluated parameters.
  let previous = start;
  let previousSlope = speedSlope(span, previous);
  for (let step = 1; step <= REGULARITY_SEARCH_STEPS; step += 1) {
    const current = start + ((end - start) * step) / REGULARITY_SEARCH_STEPS;
    const currentSlope = speedSlope(span, current);
    if (previousSlope === 0) speed(span, previous);
    if (currentSlope === 0) speed(span, current);
    if (hasOppositeSigns(previousSlope, currentSlope)) {
      let low = previous;
      let high = current;
      let lowSlope = previousSlope;
      let root = (low + high) / 2;
      for (
        let iteration = 0;
        iteration < REGULARITY_ROOT_ITERATIONS;
        iteration += 1
      ) {
        root = (low + high) / 2;
        const rootSlope = speedSlope(span, root);
        if (rootSlope === 0) break;
        if (hasOppositeSigns(lowSlope, rootSlope)) high = root;
        else {
          low = root;
          lowSlope = rootSlope;
        }
      }
      speed(span, root);
    }
    previous = current;
    previousSlope = currentSlope;
  }
};
const gauss5 = (span: PositionSpan, a: number, b: number): number => {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  return (
    half *
    nodes.reduce(
      (sum, node, index) =>
        sum + weights[index]! * speed(span, mid + half * node),
      0,
    )
  );
};

const adaptive = (
  span: PositionSpan,
  a: number,
  b: number,
  tolerance: number,
  whole: number,
  depth: number,
): number => {
  const mid = (a + b) / 2;
  const left = gauss5(span, a, mid);
  const right = gauss5(span, mid, b);
  if (
    depth <= 0 ||
    Math.abs(left + right - whole) <= tolerance * (1 + Math.abs(left + right))
  )
    return left + right;
  return (
    adaptive(span, a, mid, tolerance / 2, left, depth - 1) +
    adaptive(span, mid, b, tolerance / 2, right, depth - 1)
  );
};

export const arcLength = (
  span: PositionSpan,
  a = 0,
  b = 1,
  tolerance = 1e-9,
): number => {
  if (b < a) return arcLength(span, b, a, tolerance);
  if (a === b) return 0;
  return adaptive(
    span,
    a,
    b,
    Math.max(tolerance, 1e-14),
    gauss5(span, a, b),
    18,
  );
};

export interface ArcLengthLut {
  readonly parameters: Float64Array;
  readonly distances: Float64Array;
  readonly totalLength: number;
}

export const buildArcLengthLut = (
  span: PositionSpan,
  segments = 128,
  tolerance = 1e-8,
): ArcLengthLut => {
  if (!Number.isInteger(segments) || segments < 1)
    throw new RangeError("LUT segments must be a positive integer");
  const parameters = new Float64Array(segments + 1);
  const distances = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i += 1) {
    parameters[i] = i / segments;
    if (i > 0) {
      validateSpeedRegularity(span, parameters[i - 1]!, parameters[i]!);
      distances[i] =
        distances[i - 1]! +
        arcLength(
          span,
          parameters[i - 1]!,
          parameters[i]!,
          tolerance / segments,
        );
    }
  }
  return Object.freeze({
    parameters,
    distances,
    totalLength: distances[segments]!,
  });
};

const invert = (
  span: PositionSpan,
  lut: ArcLengthLut,
  distance: number,
): number => {
  if (distance <= 0) return 0;
  if (distance >= lut.totalLength) return 1;
  let lowIndex = 0;
  while (
    lowIndex + 1 < lut.distances.length &&
    lut.distances[lowIndex + 1]! < distance
  )
    lowIndex += 1;
  let low = lut.parameters[lowIndex]!;
  let high = lut.parameters[lowIndex + 1]!;
  let u =
    low +
    ((distance - lut.distances[lowIndex]!) /
      (lut.distances[lowIndex + 1]! - lut.distances[lowIndex]!)) *
      (high - low);
  const base = lut.distances[lowIndex]!;
  const baseParameter = lut.parameters[lowIndex]!;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const travelled = base + arcLength(span, baseParameter, u, 1e-11);
    const error = travelled - distance;
    if (Math.abs(error) < 1e-10 * Math.max(1, lut.totalLength)) return u;
    if (error > 0) high = u;
    else low = u;
    const derivative = speed(span, u);
    const candidate =
      Math.abs(derivative) > MIN_NEWTON_SPEED
        ? u - error / derivative
        : Number.NaN;
    u =
      Number.isFinite(candidate) && candidate > low && candidate < high
        ? candidate
        : (low + high) / 2;
  }
  return u;
};

export function invertArcLength(
  span: PositionSpan,
  lut: ArcLengthLut,
  distance: number,
): number;
export function invertArcLength(
  lut: ArcLengthLut,
  distance: number,
  span: PositionSpan,
): number;
export function invertArcLength(
  first: PositionSpan | ArcLengthLut,
  second: ArcLengthLut | number,
  third: number | PositionSpan,
): number {
  if ("position" in first)
    return invert(first, second as ArcLengthLut, third as number);
  return invert(third as PositionSpan, first, second as number);
}

export const arcLengthToParameter = invertArcLength;
export const integrateArcLength = arcLength;
export const buildArcLengthLUT = buildArcLengthLut;

// --- Checked Gauss integration & bracketed Newton/bisection inversion (fail-closed) ---

const finiteChecked = (value: number, label: string): number => {
  if (!Number.isFinite(value))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      `${label} must be finite`,
    );
  return value;
};

const checkedSpeed = (span: PositionSpan, u: number): number => {
  let derivative: Vec3;
  try {
    derivative = span.derivative(u, 1);
  } catch (error) {
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !Array.isArray(derivative) ||
    derivative.length !== 3 ||
    !derivative.every(Number.isFinite)
  )
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Span derivative must be finite 3-vector",
    );
  const value = Math.hypot(derivative[0], derivative[1], derivative[2]);
  if (!Number.isFinite(value) || !(value > MIN_SPEED))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "A span derivative must be finite and non-zero",
    );
  return value;
};

const checkedGauss5 = (span: PositionSpan, a: number, b: number): number => {
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Integration interval must be finite",
    );
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  if (!Number.isFinite(half) || !Number.isFinite(mid))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Integration interval is non-finite",
    );
  let sum = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const weight = weights[index]!;
    const u = mid + half * node;
    if (!Number.isFinite(u) || u < a - 1e-12 || u > b + 1e-12) {
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        `Gauss node outside bracket [${a},${b}]`,
        { stage: "integration", uInterval: [a, b], actual: u },
      );
    }
    const v = checkedSpeed(span, u);
    sum += weight * v;
  }
  const result = half * sum;
  return finiteChecked(result, "Gauss quadrature");
};

const checkedAdaptive = (
  span: PositionSpan,
  a: number,
  b: number,
  tolerance: number,
  whole: number,
  depth: number,
): number => {
  if (!Number.isFinite(tolerance) || !(tolerance > 0))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Integration tolerance must be positive and finite",
      { stage: "integration", uInterval: [a, b] },
    );
  const mid = (a + b) / 2;
  const left = checkedGauss5(span, a, mid);
  const right = checkedGauss5(span, mid, b);
  const err = Math.abs(left + right - whole);
  const tol = tolerance * (1 + Math.abs(left + right));
  if (!Number.isFinite(err) || !Number.isFinite(tol))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Arc length integration error is non-finite",
      { stage: "integration", uInterval: [a, b] },
    );
  if (err <= tol) return left + right;
  // At this point, not converged – check if we can subdivide further
  if (!Number.isFinite(mid) || mid <= a || mid >= b)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Arc length integration reached parameter resolution without convergence",
      {
        stage: "integration",
        uInterval: [a, b],
        actual: err,
        limit: tol,
        depth,
      },
    );
  if (depth <= 0)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Arc length integration failed to converge",
      {
        stage: "integration",
        uInterval: [a, b],
        actual: err,
        limit: tol,
        depth,
      },
    );
  return (
    checkedAdaptive(span, a, mid, tolerance / 2, left, depth - 1) +
    checkedAdaptive(span, mid, b, tolerance / 2, right, depth - 1)
  );
};

export const checkedArcLength = (
  span: PositionSpan,
  a = 0,
  b = 1,
  tolerance = 1e-9,
): number => {
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Arc length interval must be finite",
      { stage: "integration", uInterval: [a, b] },
    );
  if (b < a) return checkedArcLength(span, b, a, tolerance);
  if (a === b) return 0;
  if (a < 0 || b > 1 || a > b)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Arc length interval must be in [0,1]",
      { stage: "integration", uInterval: [a, b] },
    );
  // Certified nonzero speed on the integration interval – for seventh-order via Bernstein, opaque requires explicit certifier
  certifySpeedInterval(span, a, b, 0);
  const whole = checkedGauss5(span, a, b);
  return checkedAdaptive(span, a, b, Math.max(tolerance, 1e-14), whole, 18);
};

export const buildCheckedLut = (
  span: PositionSpan,
  segments = 32,
): {
  parameters: Float64Array;
  distances: Float64Array;
  totalLength: number;
} => {
  if (!Number.isInteger(segments) || segments < 1)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "LUT segments must be positive integer",
      { stage: "integration" },
    );
  const parameters = new Float64Array(segments + 1);
  const distances = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i += 1) {
    parameters[i] = i / segments;
    if (i > 0) {
      const segLen = checkedArcLength(
        span,
        parameters[i - 1]!,
        parameters[i]!,
        1e-9,
      );
      distances[i] = distances[i - 1]! + segLen;
    }
  }
  return { parameters, distances, totalLength: distances[segments]! };
};

export const checkedInvertWithLut = (
  span: PositionSpan,
  target: number,
  lut: {
    parameters: Float64Array;
    distances: Float64Array;
    totalLength: number;
  },
  tolerance = 1e-10,
): number => {
  if (!Number.isFinite(target))
    throw new TrackCompileError(
      "INVERSION_FAILED",
      "Target distance must be finite",
      { stage: "inversion" },
    );
  if (target <= 0) return 0;
  if (target >= lut.totalLength) return 1;
  let lowIdx = 0;
  let highIdx = lut.distances.length - 1;
  while (lowIdx + 1 < highIdx) {
    const mid = Math.floor((lowIdx + highIdx) / 2);
    if (lut.distances[mid]! <= target) lowIdx = mid;
    else highIdx = mid;
  }
  let low = lut.parameters[lowIdx]!;
  let high = lut.parameters[lowIdx + 1]!;
  let lowDist = lut.distances[lowIdx]!;
  let highDist = lut.distances[lowIdx + 1]!;
  let u = low + ((target - lowDist) / (highDist - lowDist)) * (high - low);
  if (!Number.isFinite(u)) u = (low + high) / 2;
  u = Math.max(low, Math.min(high, u));
  for (let iter = 0; iter < 30; iter += 1) {
    const travelled = lowDist + checkedArcLength(span, low, u, 1e-11);
    const error = travelled - target;
    if (!Number.isFinite(error))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion error non-finite",
        { stage: "inversion", uInterval: [low, high] },
      );
    if (Math.abs(error) <= tolerance * Math.max(1, lut.totalLength)) return u;
    if (error > 0) {
      high = u;
      highDist = travelled;
    } else {
      low = u;
      lowDist = travelled;
    }
    if (!(high > low))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion bracket collapsed",
        { stage: "inversion", uInterval: [low, high] },
      );
    if (high - low < 1e-14)
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion reached parameter resolution",
        { stage: "inversion", uInterval: [low, high] },
      );
    let speed: number;
    try {
      speed = checkedSpeed(span, u);
    } catch {
      speed = Number.NaN;
    }
    const candidate =
      Number.isFinite(speed) && Math.abs(speed) > MIN_NEWTON_SPEED
        ? u - error / speed
        : Number.NaN;
    if (Number.isFinite(candidate) && candidate > low && candidate < high)
      u = candidate;
    else u = (low + high) / 2;
    if (!Number.isFinite(u))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion candidate non-finite",
        { stage: "inversion" },
      );
  }
  throw new TrackCompileError(
    "INVERSION_FAILED",
    "Arc length inversion failed to converge",
    { stage: "inversion" },
  );
};

export const checkedInvertArcLength = (
  span: PositionSpan,
  targetDistance: number,
  options: { readonly totalLength?: number; readonly tolerance?: number } = {},
): number => {
  const tolerance = options.tolerance ?? 1e-10;
  if (!Number.isFinite(targetDistance))
    throw new TrackCompileError(
      "INVERSION_FAILED",
      "Target distance must be finite",
    );
  if (!Number.isFinite(tolerance) || !(tolerance > 0))
    throw new TrackCompileError(
      "INVERSION_FAILED",
      "Inversion tolerance must be positive and finite",
    );
  let totalLength = options.totalLength;
  if (totalLength === undefined)
    totalLength = checkedArcLength(span, 0, 1, 1e-9);
  if (!Number.isFinite(totalLength) || !(totalLength > 0))
    throw new TrackCompileError(
      "INVERSION_FAILED",
      "Total length must be finite and positive",
    );
  if (targetDistance <= 0) return 0;
  if (targetDistance >= totalLength) return 1;
  // Validate bracket
  let low = 0;
  let high = 1;
  let lowDist = 0;
  let highDist = totalLength;
  // Ensure speed valid at bracket ends
  checkedSpeed(span, low);
  checkedSpeed(span, high);
  // Initial guess linear
  let u =
    low + ((targetDistance - lowDist) / (highDist - lowDist)) * (high - low);
  if (!Number.isFinite(u)) u = (low + high) / 2;
  u = Math.max(low, Math.min(high, u));
  for (let iteration = 0; iteration < 40; iteration += 1) {
    let travelled: number;
    try {
      travelled = checkedArcLength(span, 0, u, 1e-11);
    } catch (error) {
      throw new TrackCompileError(
        "INVERSION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
    const error = travelled - targetDistance;
    if (!Number.isFinite(error))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion error is non-finite",
      );
    if (Math.abs(error) <= tolerance * Math.max(1, totalLength)) return u;
    if (error > 0) {
      high = u;
      highDist = travelled;
    } else {
      low = u;
      lowDist = travelled;
    }
    if (!(high > low))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion bracket collapsed",
      );
    if (high - low < 1e-14)
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion reached parameter resolution",
      );
    let derivative: number;
    try {
      derivative = checkedSpeed(span, u);
    } catch {
      derivative = Number.NaN;
    }
    const candidate =
      Number.isFinite(derivative) && Math.abs(derivative) > MIN_NEWTON_SPEED
        ? u - error / derivative
        : Number.NaN;
    if (Number.isFinite(candidate) && candidate > low && candidate < high)
      u = candidate;
    else u = (low + high) / 2;
    if (!Number.isFinite(u))
      throw new TrackCompileError(
        "INVERSION_FAILED",
        "Inversion candidate is non-finite",
      );
  }
  throw new TrackCompileError(
    "INVERSION_FAILED",
    "Arc length inversion failed to converge",
  );
};
