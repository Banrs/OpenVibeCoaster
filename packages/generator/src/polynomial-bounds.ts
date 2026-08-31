import { vec3, type Vec3 } from "@openvibecoaster/core";

export interface CertifiedBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface CertifiedThresholdWitness {
  readonly u: number;
  readonly value: number;
}

export type CertifiedThresholdResult =
  | { readonly status: "satisfied" }
  | {
      readonly status: "violated";
      readonly witness: CertifiedThresholdWitness;
    };

export class CertificationError extends RangeError {
  public constructor(message: string) {
    super(message);
    this.name = "CertificationError";
  }
}

export class WorkBudgetExceeded extends CertificationError {
  public constructor() {
    super("Certified polynomial work budget exhausted");
    this.name = "WorkBudgetExceeded";
  }
}

export class CertifiedWorkBudget {
  public readonly maxWork: number;
  public used = 0;

  public constructor(maxWork: number) {
    if (!Number.isSafeInteger(maxWork) || maxWork < 1)
      throw new RangeError(
        "Certified work budget must be a positive safe integer",
      );
    this.maxWork = maxWork;
  }

  public charge(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new CertificationError(
        "Certified work charge is not a safe integer",
      );
    if (count > this.maxWork - this.used) throw new WorkBudgetExceeded();
    this.used += count;
  }

  public static checkedProduct(left: number, right: number): number {
    if (
      !Number.isSafeInteger(left) ||
      !Number.isSafeInteger(right) ||
      left < 0 ||
      right < 0
    )
      throw new CertificationError(
        "Certified loop bound is not a safe integer",
      );
    if (left !== 0 && right > Number.MAX_SAFE_INTEGER / left)
      throw new CertificationError("Certified loop bound overflows");
    return left * right;
  }
}

const bits = new DataView(new ArrayBuffer(8));

const scaleDouble1075 = (value: number): bigint => {
  if (!Number.isFinite(value))
    throw new CertificationError("scaleDouble received non-finite");
  if (value === 0) return 0n;
  bits.setFloat64(0, value, false);
  const word = bits.getBigUint64(0, false);
  const sign = (word >> 63n) & 1n;
  const exp = Number((word >> 52n) & 0x7ffn);
  const mant = word & ((1n << 52n) - 1n);
  let scaled: bigint;
  if (exp === 0) {
    scaled = mant * 2n;
  } else {
    const base = (1n << 52n) + mant;
    scaled = base << BigInt(exp);
  }
  return sign === 1n ? -scaled : scaled;
};

type Dyadic = {
  readonly n: bigint;
  readonly e: number;
};

const dyadicZero: Dyadic = { n: 0n, e: 0 };

const float64ToDyadic = (value: number): Dyadic => {
  finite(value, "Dyadic conversion");
  if (value === 0) return dyadicZero;
  return { n: scaleDouble1075(value), e: -1075 };
};

const dyadicNeg = (value: Dyadic): Dyadic =>
  value.n === 0n ? dyadicZero : { n: -value.n, e: value.e };

const dyadicAdd = (
  budget: CertifiedWorkBudget,
  left: Dyadic,
  right: Dyadic,
): Dyadic => {
  budget.charge();
  if (left.n === 0n) return right;
  if (right.n === 0n) return left;
  if (left.e === right.e) return { n: left.n + right.n, e: left.e };
  if (left.e < right.e) {
    const delta = right.e - left.e;
    return { n: left.n + (right.n << BigInt(delta)), e: left.e };
  }
  const delta = left.e - right.e;
  return { n: (left.n << BigInt(delta)) + right.n, e: right.e };
};

const dyadicMul = (
  budget: CertifiedWorkBudget,
  left: Dyadic,
  right: Dyadic,
): Dyadic => {
  budget.charge();
  if (left.n === 0n || right.n === 0n) return dyadicZero;
  return { n: left.n * right.n, e: left.e + right.e };
};

const bitLength = (value: bigint): number => {
  const abs = value < 0n ? -value : value;
  if (abs === 0n) return 0;
  return abs.toString(2).length;
};

const bitsToFloat64 = (
  sign: number,
  expField: number,
  mantField: bigint,
): number => {
  const word =
    (BigInt(sign) << 63n) |
    (BigInt(expField) << 52n) |
    (mantField & ((1n << 52n) - 1n));
  bits.setBigUint64(0, word, false);
  return bits.getFloat64(0, false);
};

const dyadicToNearest = (
  budget: CertifiedWorkBudget,
  value: Dyadic,
): { readonly nearest: number; readonly exact: boolean } => {
  budget.charge();
  if (value.n === 0n) return { nearest: 0, exact: true };
  const sign = value.n < 0n ? 1 : 0;
  const absN = value.n < 0n ? -value.n : value.n;
  const e0 = value.e;
  const k = bitLength(absN) - 1;
  const E = k + e0;
  if (E >= -1022 && E <= 1023) {
    const shift = k - 52;
    if (shift <= 0) {
      const mantRounded = absN << BigInt(-shift);
      const expField = E + 1023;
      const mantField = mantRounded - (1n << 52n);
      const nearest = bitsToFloat64(sign, expField, mantField);
      return { nearest, exact: true };
    }
    const extra = shift;
    const mantHigh = absN >> BigInt(extra);
    const mask = (1n << BigInt(extra)) - 1n;
    const remainder = absN & mask;
    const half = 1n << BigInt(extra - 1);
    let needUp = false;
    if (remainder > half) needUp = true;
    else if (remainder === half) needUp = (mantHigh & 1n) === 1n;
    const mantRounded0 = mantHigh + (needUp ? 1n : 0n);
    const exact = remainder === 0n;
    if (mantRounded0 >= 1n << 53n) {
      const E2 = E + 1;
      if (E2 > 1023) {
        const nearest =
          sign === 1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
        return { nearest, exact: false };
      }
      const expField = E2 + 1023;
      const nearest = bitsToFloat64(sign, expField, 0n);
      return { nearest, exact };
    }
    const expField = E + 1023;
    const mantField = mantRounded0 - (1n << 52n);
    const nearest = bitsToFloat64(sign, expField, mantField);
    return { nearest, exact };
  }
  if (E < -1022) {
    const shiftSub = e0 + 1074;
    if (shiftSub >= 0) {
      const mant = absN << BigInt(shiftSub);
      if (mant >= 1n << 52n) {
        const nearest = bitsToFloat64(sign, 1, 0n);
        const exact = mant === 1n << 52n;
        return { nearest, exact };
      }
      const nearest = bitsToFloat64(sign, 0, mant);
      return { nearest, exact: true };
    }
    const divisor = -shiftSub;
    const mantHigh = absN >> BigInt(divisor);
    const mask = (1n << BigInt(divisor)) - 1n;
    const remainder = absN & mask;
    const half = 1n << BigInt(divisor - 1);
    let needUp = false;
    if (remainder > half) needUp = true;
    else if (remainder === half) needUp = (mantHigh & 1n) === 1n;
    const mantRounded = mantHigh + (needUp ? 1n : 0n);
    const exact = remainder === 0n;
    if (mantRounded >= 1n << 52n) {
      const nearest = bitsToFloat64(sign, 1, 0n);
      return { nearest, exact };
    }
    const nearest = bitsToFloat64(sign, 0, mantRounded);
    return { nearest, exact };
  }
  const nearest =
    value.n < 0n ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return { nearest, exact: false };
};

const dyadicToInterval = (
  budget: CertifiedWorkBudget,
  value: Dyadic,
): Interval => {
  if (value.n === 0n) return exact(0);
  const { nearest, exact: isExact } = dyadicToNearest(budget, value);
  finite(nearest, "Dyadic interval conversion");
  if (isExact) {
    const dy = float64ToDyadic(nearest);
    const eq =
      dy.n === value.n && dy.e === value.e
        ? true
        : (() => {
            if (dy.e === value.e) return dy.n === value.n;
            if (dy.e < value.e) {
              const delta = value.e - dy.e;
              return dy.n === value.n << BigInt(delta);
            }
            const delta = dy.e - value.e;
            return dy.n << BigInt(delta) === value.n;
          })();
    if (eq) return exact(nearest);
  }
  const lo = nextDown(nearest);
  const hi = nextUp(nearest);
  return interval(lo, hi);
};

const exactDivide = (
  coeffs: readonly Dyadic[],
  point: Dyadic,
  budget: CertifiedWorkBudget,
): { readonly quotient: Dyadic[]; readonly remainder: Dyadic } => {
  const d = coeffs.length - 1;
  if (d < 0) return { quotient: [], remainder: dyadicZero };
  if (d === 0) return { quotient: [], remainder: coeffs[0]! };
  const quotient: Dyadic[] = Array.from({ length: d }, () => dyadicZero);
  quotient[d - 1] = coeffs[d]!;
  for (let k = d - 1; k >= 1; k -= 1) {
    const qk = quotient[k]!;
    const prod = dyadicMul(budget, point, qk);
    quotient[k - 1] = dyadicAdd(budget, coeffs[k]!, prod);
  }
  const prod0 = dyadicMul(budget, point, quotient[0]!);
  const remainder = dyadicAdd(budget, coeffs[0]!, prod0);
  return { quotient, remainder };
};

const divideRepeated = (
  coeffs: readonly Dyadic[],
  point: Dyadic,
  count: number,
  budget: CertifiedWorkBudget,
): Dyadic[] => {
  let cur: Dyadic[] = [...coeffs];
  for (let i = 0; i < count; i += 1) {
    const res = exactDivide(cur, point, budget);
    cur = res.quotient;
    if (cur.length === 0) break;
  }
  return cur;
};

const exactBernsteinSatisfies01 = (
  coefficients: readonly number[],
  limit: number,
  direction: "maximum" | "minimum",
  budget: CertifiedWorkBudget,
): boolean => {
  const n = coefficients.length - 1;
  if (n < 0 || n > 7) return false;
  const binom = (nn: number, kk: number): number => {
    if (kk < 0 || kk > nn) return 0;
    let r = 1;
    for (let i = 1; i <= kk; i++) r = (r * (nn - kk + i)) / i;
    return r;
  };
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;
  let L = 1;
  for (let i = 0; i <= n; i++) L = lcm(L, binom(n, i));
  budget.charge(n + 1);
  const scaledLimit = scaleDouble1075(limit);
  const scaledCoeffs = coefficients.map((c) => scaleDouble1075(c));
  for (let j = 0; j <= n; j++) {
    budget.charge();
    let S = 0n;
    for (let i = 0; i <= j; i++) {
      const cScaled = scaledCoeffs[i]!;
      if (cScaled === 0n) continue;
      const bji = binom(j, i);
      const bni = binom(n, i);
      const factor = L / bni;
      S += cScaled * BigInt(bji) * BigInt(factor);
    }
    const rhs = scaledLimit * BigInt(L);
    if (direction === "minimum") {
      if (S < rhs) return false;
    } else {
      if (S > rhs) return false;
    }
  }
  return true;
};

const exactMultiplicity = (
  coeffs: readonly Dyadic[],
  point: Dyadic,
  budget: CertifiedWorkBudget,
): number => {
  if (coeffs.every((item) => item.n === 0n)) return coeffs.length;
  let cur: Dyadic[] = [...coeffs];
  let m = 0;
  while (cur.length > 0) {
    const res = exactDivide(cur, point, budget);
    if (res.remainder.n !== 0n) break;
    m += 1;
    cur = res.quotient;
    if (cur.length === 0) break;
    if (m > 7) break;
  }
  return m;
};

export const nextDown = (value: number): number => {
  if (Number.isNaN(value))
    throw new CertificationError("nextDown received NaN");
  if (value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return -Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  let word = bits.getBigUint64(0, false);
  word = value > 0 ? word - 1n : word + 1n;
  bits.setBigUint64(0, word, false);
  return bits.getFloat64(0, false);
};

export const nextUp = (value: number): number => {
  if (Number.isNaN(value)) throw new CertificationError("nextUp received NaN");
  if (value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  let word = bits.getBigUint64(0, false);
  word = value > 0 ? word + 1n : word - 1n;
  bits.setBigUint64(0, word, false);
  return bits.getFloat64(0, false);
};

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value))
    throw new CertificationError(`${label} must be finite`);
  return value;
};

const interval = (lo: number, hi: number): Interval => ({
  lo: finite(lo, "Certified interval lower bound"),
  hi: finite(hi, "Certified interval upper bound"),
});

const exact = (value: number): Interval => interval(value, value);

const outward = (
  budget: CertifiedWorkBudget,
  value: number,
  direction: "down" | "up",
  label: string,
): number => {
  budget.charge();
  finite(value, label);
  const stepped = direction === "down" ? nextDown(value) : nextUp(value);
  return finite(stepped, `${label} outward rounding`);
};

const add = (
  budget: CertifiedWorkBudget,
  left: Interval,
  right: Interval,
): Interval => {
  budget.charge();
  return interval(
    outward(budget, left.lo + right.lo, "down", "Certified addition"),
    outward(budget, left.hi + right.hi, "up", "Certified addition"),
  );
};

const subtract = (
  budget: CertifiedWorkBudget,
  left: Interval,
  right: Interval,
): Interval => {
  budget.charge();
  return interval(
    outward(budget, left.lo - right.hi, "down", "Certified subtraction"),
    outward(budget, left.hi - right.lo, "up", "Certified subtraction"),
  );
};

const multiply = (
  budget: CertifiedWorkBudget,
  left: Interval,
  right: Interval,
): Interval => {
  budget.charge();
  const products = [
    left.lo * right.lo,
    left.lo * right.hi,
    left.hi * right.lo,
    left.hi * right.hi,
  ].map((value) => finite(value, "Certified multiplication"));
  return interval(
    outward(budget, Math.min(...products), "down", "Certified multiplication"),
    outward(budget, Math.max(...products), "up", "Certified multiplication"),
  );
};

const divide = (
  budget: CertifiedWorkBudget,
  numerator: Interval,
  denominator: Interval,
): Interval => {
  budget.charge();
  if (denominator.lo <= 0 && denominator.hi >= 0)
    throw new CertificationError("Certified division interval crosses zero");
  const quotients = [
    numerator.lo / denominator.lo,
    numerator.lo / denominator.hi,
    numerator.hi / denominator.lo,
    numerator.hi / denominator.hi,
  ].map((value) => finite(value, "Certified division"));
  return interval(
    outward(budget, Math.min(...quotients), "down", "Certified division"),
    outward(budget, Math.max(...quotients), "up", "Certified division"),
  );
};

const binomial = (
  n: number,
  k: number,
  budget: CertifiedWorkBudget,
): number => {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) {
    budget.charge();
    result *= (n - k + index) / index;
  }
  return finite(result, "Binomial coefficient");
};

const coreRestrictedBernstein = (
  coefficientIntervals: readonly Interval[],
  start: number,
  end: number,
  budget: CertifiedWorkBudget,
): readonly Interval[] => {
  const degree = coefficientIntervals.length - 1;
  if (degree < 0 || degree > 7)
    throw new CertificationError("Certified polynomial degree is invalid");
  const startInterval = exact(finite(start, "Polynomial interval start"));
  const endInterval = exact(finite(end, "Polynomial interval end"));
  if (start < 0 || end > 1 || start > end)
    throw new CertificationError(
      "Polynomial interval must be ordered in [0, 1]",
    );
  const width = subtract(budget, endInterval, startInterval);
  const startPowers = [exact(1)];
  const widthPowers = [exact(1)];
  for (let index = 1; index <= degree; index += 1) {
    startPowers.push(multiply(budget, startPowers[index - 1]!, startInterval));
    widthPowers.push(multiply(budget, widthPowers[index - 1]!, width));
  }
  const powerCoefficients = Array.from({ length: degree + 1 }, () => exact(0));
  for (let source = 0; source <= degree; source += 1) {
    const coefficient = coefficientIntervals[source]!;
    for (let target = 0; target <= source; target += 1) {
      let term = multiply(
        budget,
        coefficient,
        exact(binomial(source, target, budget)),
      );
      term = multiply(budget, term, startPowers[source - target]!);
      term = multiply(budget, term, widthPowers[target]!);
      powerCoefficients[target] = add(budget, powerCoefficients[target]!, term);
    }
  }
  return powerCoefficients.map((_, index) => {
    let value = exact(0);
    for (let powerIndex = 0; powerIndex <= index; powerIndex += 1) {
      const ratio = divide(
        budget,
        exact(binomial(index, powerIndex, budget)),
        exact(binomial(degree, powerIndex, budget)),
      );
      value = add(
        budget,
        value,
        multiply(budget, powerCoefficients[powerIndex]!, ratio),
      );
    }
    return value;
  });
};

export const restrictedBernstein = (
  coefficients: readonly number[],
  start: number,
  end: number,
  budget: CertifiedWorkBudget,
): readonly Interval[] => {
  const degree = coefficients.length - 1;
  if (degree < 0 || degree > 7)
    throw new CertificationError("Certified polynomial degree is invalid");
  const coefficientIntervals = coefficients.map((value) => {
    budget.charge();
    return exact(finite(value, "Polynomial coefficient"));
  });
  return coreRestrictedBernstein(coefficientIntervals, start, end, budget);
};

const restrictedBernsteinFromIntervals = (
  coefficientIntervals: readonly Interval[],
  start: number,
  end: number,
  budget: CertifiedWorkBudget,
): readonly Interval[] =>
  coreRestrictedBernstein(coefficientIntervals, start, end, budget);

const evaluatePolynomial = (
  coefficients: readonly number[],
  u: number,
  budget: CertifiedWorkBudget,
): number => {
  let value = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    budget.charge();
    value = finite(value * u + coefficients[index]!, "Polynomial evaluation");
  }
  return value;
};

export const certifyPolynomialThreshold = (
  coefficients: readonly number[],
  start: number,
  end: number,
  limit: number,
  direction: "maximum" | "minimum",
  budget: CertifiedWorkBudget,
  maxDepth = 32,
): CertifiedThresholdResult => {
  finite(limit, "Polynomial threshold");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new CertificationError(
      "Polynomial threshold depth must be a non-negative safe integer",
    );
  finite(start, "Polynomial interval start");
  finite(end, "Polynomial interval end");
  if (start < 0 || end > 1 || start > end)
    throw new CertificationError(
      "Polynomial interval must be ordered in [0, 1]",
    );
  // Validate degree 0..7 before mapping/early return, account bounded coefficient work
  const degree = coefficients.length - 1;
  if (degree < 0 || degree > 7)
    throw new CertificationError("Certified polynomial degree is invalid");
  budget.charge(10);
  // charge for bounded coefficient work: include degree check and per-coefficient overhead
  budget.charge(coefficients.length);
  for (let i = 0; i < coefficients.length; i += 1) {
    finite(coefficients[i]!, "Polynomial coefficient");
  }
  const limitDy = float64ToDyadic(limit);
  const fDyadics: Dyadic[] = coefficients.map((value, index) => {
    const coeffDy = float64ToDyadic(finite(value, "Polynomial coefficient"));
    if (index === 0) return dyadicAdd(budget, coeffDy, dyadicNeg(limitDy));
    return coeffDy;
  });
  const isIdenticallyZero = fDyadics.every((item) => item.n === 0n);
  if (isIdenticallyZero) return { status: "satisfied" };
  if (start === 0 && end === 1) {
    if (exactBernsteinSatisfies01(coefficients, limit, direction, budget)) {
      return { status: "satisfied" };
    }
  }
  const startDy = float64ToDyadic(start);
  const endDy = float64ToDyadic(end);
  const ms = exactMultiplicity(fDyadics, startDy, budget);
  const me = exactMultiplicity(fDyadics, endDy, budget);
  const tryQuotientCertification = (
    rDyadicsInput: Dyadic[] | undefined,
  ): CertifiedThresholdResult | undefined => {
    if (rDyadicsInput === undefined) return undefined;
    if (rDyadicsInput.length === 0) return { status: "satisfied" };
    const allZero = rDyadicsInput.every((item) => item.n === 0n);
    if (allZero) return { status: "satisfied" };
    const rIntervals = rDyadicsInput.map((item) =>
      dyadicToInterval(budget, item),
    );
    const fForWitness = (() => {
      const arr: number[] = [...coefficients];
      arr[0] = (arr[0] ?? 0) - limit;
      return arr;
    })();
    const pending: Array<{
      readonly start: number;
      readonly end: number;
      readonly depth: number;
    }> = [{ start, end, depth: 0 }];
    while (pending.length > 0) {
      budget.charge();
      const span = pending.pop()!;
      const bernstein = restrictedBernsteinFromIntervals(
        rIntervals,
        span.start,
        span.end,
        budget,
      );
      const lower = finite(
        Math.min(...bernstein.map((v) => v.lo)),
        "Polynomial threshold lower bound",
      );
      const upper = finite(
        Math.max(...bernstein.map((v) => v.hi)),
        "Polynomial threshold upper bound",
      );
      if (
        (direction === "maximum" && upper <= 0) ||
        (direction === "minimum" && lower >= 0)
      )
        continue;
      const middle = (span.start + span.end) / 2;
      const witnesses = [span.start, middle, span.end].map((u) => ({
        u,
        value: evaluatePolynomial(fForWitness, u, budget),
      }));
      const witness = witnesses.reduce((sel, cand) =>
        direction === "maximum"
          ? cand.value > sel.value
            ? cand
            : sel
          : cand.value < sel.value
            ? cand
            : sel,
      );
      if (
        (direction === "maximum" && witness.value > 0) ||
        (direction === "minimum" && witness.value < 0)
      ) {
        const origVal = evaluatePolynomial(coefficients, witness.u, budget);
        // Ensure witness actually crosses threshold; otherwise fail closed/continue
        const actuallyViolated =
          direction === "maximum" ? origVal > limit : origVal < limit;
        if (!Number.isFinite(origVal) || !actuallyViolated) {
          // Witness does not truthfully cross threshold -> continue subdivision rather than false violated
          if (span.depth >= maxDepth)
            throw new CertificationError(
              `Polynomial ${direction} threshold remained uncertified`,
            );
          pending.push(
            { start: middle, end: span.end, depth: span.depth + 1 },
            { start: span.start, end: middle, depth: span.depth + 1 },
          );
          continue;
        }
        return {
          status: "violated" as const,
          witness: { u: witness.u, value: origVal },
        };
      }
      if (span.depth >= maxDepth)
        throw new CertificationError(
          `Polynomial ${direction} threshold remained uncertified`,
        );
      pending.push(
        { start: middle, end: span.end, depth: span.depth + 1 },
        { start: span.start, end: middle, depth: span.depth + 1 },
      );
    }
    return { status: "satisfied" as const };
  };
  if (ms !== 0 || me !== 0) {
    let rDyadics: Dyadic[] | undefined;
    if (ms > 0 && me === 0) {
      rDyadics = divideRepeated(fDyadics, startDy, ms, budget);
    } else if (ms === 0 && me > 0) {
      let q = divideRepeated(fDyadics, endDy, me, budget);
      if (me % 2 === 1)
        q = q.map((item) => (item.n === 0n ? item : { n: -item.n, e: item.e }));
      rDyadics = q;
    } else if (ms > 0 && me > 0) {
      if (ms + me > fDyadics.length - 1 && !isIdenticallyZero) {
        rDyadics = undefined;
      } else {
        let qS = divideRepeated(fDyadics, startDy, ms, budget);
        let qR = divideRepeated(qS, endDy, me, budget);
        if (me % 2 === 1)
          qR = qR.map((item) =>
            item.n === 0n ? item : { n: -item.n, e: item.e },
          );
        rDyadics = qR;
      }
    }
    const res = tryQuotientCertification(rDyadics);
    if (res !== undefined) return res;
  }
  const pending: Array<{
    readonly start: number;
    readonly end: number;
    readonly depth: number;
  }> = [{ start, end, depth: 0 }];
  while (pending.length > 0) {
    budget.charge();
    const span = pending.pop()!;
    const bernstein = restrictedBernstein(
      coefficients,
      span.start,
      span.end,
      budget,
    );
    const lower = finite(
      Math.min(...bernstein.map((value) => value.lo)),
      "Polynomial threshold lower bound",
    );
    const upper = finite(
      Math.max(...bernstein.map((value) => value.hi)),
      "Polynomial threshold upper bound",
    );
    if (
      (direction === "maximum" && upper <= limit) ||
      (direction === "minimum" && lower >= limit)
    )
      continue;
    const middle = (span.start + span.end) / 2;
    const witnesses = [span.start, middle, span.end].map((u) => ({
      u,
      value: evaluatePolynomial(coefficients, u, budget),
    }));
    const witness = witnesses.reduce((selected, candidate) =>
      direction === "maximum"
        ? candidate.value > selected.value
          ? candidate
          : selected
        : candidate.value < selected.value
          ? candidate
          : selected,
    );
    if (
      (direction === "maximum" && witness.value > limit) ||
      (direction === "minimum" && witness.value < limit)
    )
      return { status: "violated", witness };
    if (span.depth >= maxDepth)
      throw new CertificationError(
        `Polynomial ${direction} threshold remained uncertified`,
      );
    pending.push(
      { start: middle, end: span.end, depth: span.depth + 1 },
      { start: span.start, end: middle, depth: span.depth + 1 },
    );
  }
  return { status: "satisfied" };
};

export const certifiedPolynomialBounds = (
  rows: readonly (readonly number[])[],
  start: number,
  end: number,
  budget: CertifiedWorkBudget,
): CertifiedBounds => {
  if (rows.length !== 3 || rows.some((row) => row.length !== 8))
    throw new CertificationError(
      "Position polynomial must contain three degree-seven rows",
    );
  budget.charge();
  const ranges = rows.map((row) => {
    const bernstein = restrictedBernstein(row, start, end, budget);
    return {
      lo: finite(
        Math.min(...bernstein.map((value) => value.lo)),
        "Certified polynomial minimum",
      ),
      hi: finite(
        Math.max(...bernstein.map((value) => value.hi)),
        "Certified polynomial maximum",
      ),
    };
  });
  return {
    min: vec3(ranges[0]!.lo, ranges[1]!.lo, ranges[2]!.lo),
    max: vec3(ranges[0]!.hi, ranges[1]!.hi, ranges[2]!.hi),
  };
};
