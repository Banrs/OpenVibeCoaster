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

export const restrictedBernsteinBoxes = (
  coefficientsX: readonly number[],
  coefficientsZ: readonly number[],
  start: number,
  end: number,
  budget: CertifiedWorkBudget,
): { readonly x: readonly Interval[]; readonly z: readonly Interval[] } => ({
  x: restrictedBernstein(coefficientsX, start, end, budget),
  z: restrictedBernstein(coefficientsZ, start, end, budget),
});

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
  const pending: Array<{
    readonly start: number;
    readonly end: number;
    readonly depth: number;
  }> = [{ start, end, depth: 0 }];
  while (pending.length > 0) {
    budget.charge();
    const interval = pending.pop()!;
    const bernstein = restrictedBernstein(
      coefficients,
      interval.start,
      interval.end,
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
    const middle = (interval.start + interval.end) / 2;
    const witnesses = [interval.start, middle, interval.end].map((u) => ({
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
    if (interval.depth >= maxDepth)
      throw new CertificationError(
        `Polynomial ${direction} threshold remained uncertified`,
      );
    pending.push(
      { start: middle, end: interval.end, depth: interval.depth + 1 },
      { start: interval.start, end: middle, depth: interval.depth + 1 },
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
