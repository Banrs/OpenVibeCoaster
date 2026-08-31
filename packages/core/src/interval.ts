import { TrackCompileError } from "./compile-error";

const bits = new DataView(new ArrayBuffer(8));

export const nextUp = (value: number, stage = "interval"): number => {
  if (Number.isNaN(value))
    throw new TrackCompileError("INTEGRATION_FAILED", "nextUp NaN", {
      stage,
    });
  if (value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  let w = bits.getBigUint64(0, false);
  w = value > 0 ? w + 1n : w - 1n;
  bits.setBigUint64(0, w, false);
  return bits.getFloat64(0, false);
};

export const nextDown = (value: number, stage = "interval"): number => {
  if (Number.isNaN(value))
    throw new TrackCompileError("INTEGRATION_FAILED", "nextDown NaN", {
      stage,
    });
  if (value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return -Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  let w = bits.getBigUint64(0, false);
  w = value > 0 ? w - 1n : w + 1n;
  bits.setBigUint64(0, w, false);
  return bits.getFloat64(0, false);
};

export type Interval = { readonly lo: number; readonly hi: number };

export const intervalExact = (v: number, stage = "interval"): Interval => {
  if (!Number.isFinite(v))
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Interval exact requires finite",
      { stage, actual: v },
    );
  return { lo: v, hi: v };
};

export const intervalAdd = (
  a: Interval,
  b: Interval,
  stage = "interval",
): Interval => ({
  lo: nextDown(a.lo + b.lo, stage),
  hi: nextUp(a.hi + b.hi, stage),
});

export const intervalSub = (
  a: Interval,
  b: Interval,
  stage = "interval",
): Interval => ({
  lo: nextDown(a.lo - b.hi, stage),
  hi: nextUp(a.hi - b.lo, stage),
});

export const intervalMul = (
  a: Interval,
  b: Interval,
  stage = "interval",
): Interval => {
  const vals = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  return {
    lo: nextDown(Math.min(...vals), stage),
    hi: nextUp(Math.max(...vals), stage),
  };
};

export const intervalDiv = (
  a: Interval,
  b: Interval,
  stage = "interval",
): Interval => {
  if (b.lo <= 0 && b.hi >= 0)
    throw new TrackCompileError(
      "INTEGRATION_FAILED",
      "Interval division by zero-spanning interval",
      { stage },
    );
  const vals = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi];
  return {
    lo: nextDown(Math.min(...vals), stage),
    hi: nextUp(Math.max(...vals), stage),
  };
};

export const intervalMid = (iv: Interval): number => (iv.lo + iv.hi) / 2;

export const binomial = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
};

export const restrictPowerCoefficientsInterval = (
  coeffs: readonly Interval[],
  a: number,
  b: number,
  stage = "interval",
): Interval[] => {
  const wInterval = intervalSub(
    intervalExact(b, stage),
    intervalExact(a, stage),
    stage,
  );
  const aInterval = intervalExact(a, stage);
  const n = coeffs.length;
  const aPowers: Interval[] = [intervalExact(1, stage)];
  for (let i = 1; i < n; i += 1)
    aPowers.push(intervalMul(aPowers[i - 1]!, aInterval, stage));
  const res: Interval[] = Array.from({ length: n }, () =>
    intervalExact(0, stage),
  );
  for (let k = 0; k < n; k += 1) {
    let sum: Interval = intervalExact(0, stage);
    let wPow: Interval = intervalExact(1, stage);
    for (let p = 0; p < k; p += 1) wPow = intervalMul(wPow, wInterval, stage);
    for (let i = k; i < n; i += 1) {
      const bin = intervalExact(binomial(i, k), stage);
      const term = intervalMul(
        intervalMul(coeffs[i]!, bin, stage),
        aPowers[i - k]!,
        stage,
      );
      sum = intervalAdd(sum, term, stage);
    }
    res[k] = intervalMul(sum, wPow, stage);
  }
  return res;
};

export const powerToBernsteinInterval = (
  q: readonly Interval[],
  stage = "interval",
): Interval[] => {
  const n = q.length - 1;
  const b: Interval[] = Array.from({ length: n + 1 }, () =>
    intervalExact(0, stage),
  );
  for (let k = 0; k <= n; k += 1) {
    let acc: Interval = q[k]!;
    for (let j = 0; j < k; j += 1) {
      const sign = (k - j) % 2 === 0 ? 1 : -1;
      const mij = binomial(n, j) * binomial(n - j, k - j) * sign;
      const term = intervalMul(b[j]!, intervalExact(mij, stage), stage);
      acc = intervalSub(acc, term, stage);
    }
    const diag = binomial(n, k);
    if (diag === 0)
      throw new TrackCompileError(
        "INTEGRATION_FAILED",
        "Bernstein diagonal zero",
        { stage },
      );
    b[k] = intervalMul(
      acc,
      intervalDiv(intervalExact(1, stage), intervalExact(diag, stage), stage),
      stage,
    );
  }
  return b;
};
