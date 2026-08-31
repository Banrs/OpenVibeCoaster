import {
  arcLength,
  isPointInsidePolygonStrict,
  segmentWithinPolygonStrict,
  signedDistanceStrictXZ,
  vec3,
  SeventhOrderHermiteSpan,
  type FootprintPolygon,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import {
  CertificationError,
  CertifiedWorkBudget,
  WorkBudgetExceeded,
  restrictedBernstein,
} from "./polynomial-bounds";

export type FootprintSpanStatus =
  | { readonly status: "inside" }
  | {
      readonly status: "outside";
      readonly witness: {
        readonly u: number;
        readonly position: Vec3;
        readonly s: number;
        readonly signedDistance: number;
      };
    }
  | { readonly status: "uncertified"; readonly reason: string };

const positionGeometry = (span: SolvedSpan): SeventhOrderHermiteSpan<Vec3> => {
  const rows =
    span.positionCoefficients ??
    (span.span instanceof SeventhOrderHermiteSpan
      ? span.span.coefficients
      : undefined);
  if (
    rows === undefined ||
    rows.length !== 3 ||
    rows.some((row) => row.length !== 8)
  )
    throw new CertificationError(
      `Span ${span.id} has no certified degree-seven position polynomial`,
    );
  if (rows.some((row) => row.some((value) => !Number.isFinite(value))))
    throw new CertificationError(
      `Span ${span.id} has non-finite position coefficients`,
    );
  return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows);
};

const isLinearSpan = (geometry: SeventhOrderHermiteSpan<Vec3>): boolean => {
  const coeffs = geometry.coefficients;
  const rowsX = coeffs[0]!;
  const rowsZ = coeffs[2]!;
  return (
    rowsX.slice(2).every((v) => v === 0) && rowsZ.slice(2).every((v) => v === 0)
  );
};

export const certifyFootprintSpan = (
  span: SolvedSpan,
  polygon: FootprintPolygon,
  options: {
    readonly station?: number;
    readonly budget: CertifiedWorkBudget;
    readonly maxDepth?: number;
  },
): FootprintSpanStatus => {
  const station = options.station ?? 0;
  const budget = options.budget;
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new CertificationError(
      "Polynomial threshold depth must be a non-negative safe integer",
    );
  let geometry: SeventhOrderHermiteSpan<Vec3>;
  try {
    geometry = positionGeometry(span);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "uncertified", reason: msg };
  }
  if (isLinearSpan(geometry)) {
    const a = geometry.position(0);
    const b = geometry.position(1);
    const segStrict = segmentWithinPolygonStrict(polygon, a, b);
    if (segStrict.inside) return { status: "inside" };
    const witnessPos = segStrict.witness ?? b;
    const sd = signedDistanceStrictXZ(polygon, witnessPos);
    if (!(sd > 0))
      return {
        status: "uncertified",
        reason: "Linear segment near-boundary uncertainty",
      };
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-18) {
      t = ((witnessPos[0] - a[0]) * dx + (witnessPos[2] - a[2]) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    let s: number;
    try {
      budget.charge();
      s = station + arcLength(geometry, 0, t);
    } catch (error) {
      if (error instanceof WorkBudgetExceeded)
        return { status: "uncertified", reason: error.message };
      return {
        status: "uncertified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!Number.isFinite(s) || !Number.isFinite(sd)) {
      return { status: "uncertified", reason: "Non-finite witness" };
    }
    return {
      status: "outside",
      witness: { u: t, position: witnessPos, s, signedDistance: sd },
    };
  }

  const coeffsX = geometry.coefficients[0]!;
  const coeffsZ = geometry.coefficients[2]!;
  interface Interval {
    readonly start: number;
    readonly end: number;
    readonly depth: number;
  }
  const pending: Interval[] = [{ start: 0, end: 1, depth: 0 }];
  while (pending.length > 0) {
    let interval: Interval;
    try {
      budget.charge();
      const popped = pending.pop();
      if (popped === undefined) break;
      interval = popped;
    } catch (error) {
      if (error instanceof WorkBudgetExceeded)
        return { status: "uncertified", reason: error.message };
      return {
        status: "uncertified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const { start, end, depth } = interval;
    let xIntervals: readonly { lo: number; hi: number }[];
    let zIntervals: readonly { lo: number; hi: number }[];
    try {
      xIntervals = restrictedBernstein(coeffsX, start, end, budget);
      zIntervals = restrictedBernstein(coeffsZ, start, end, budget);
    } catch (error) {
      if (error instanceof WorkBudgetExceeded)
        return { status: "uncertified", reason: error.message };
      return {
        status: "uncertified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const corners: Vec3[] = [];
    for (let i = 0; i < xIntervals.length; i += 1) {
      const xi = xIntervals[i]!;
      const zi = zIntervals[i]!;
      corners.push(
        vec3(xi.lo, 0, zi.lo),
        vec3(xi.lo, 0, zi.hi),
        vec3(xi.hi, 0, zi.lo),
        vec3(xi.hi, 0, zi.hi),
      );
    }
    let hullInside = true;
    for (const p of corners) {
      try {
        budget.charge();
      } catch (error) {
        if (error instanceof WorkBudgetExceeded)
          return { status: "uncertified", reason: error.message };
        return {
          status: "uncertified",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (!isPointInsidePolygonStrict(polygon, p)) {
        hullInside = false;
        break;
      }
    }
    if (hullInside) {
      for (let i = 0; i < corners.length; i += 1) {
        for (let j = i + 1; j < corners.length; j += 1) {
          try {
            budget.charge();
          } catch (error) {
            if (error instanceof WorkBudgetExceeded)
              return { status: "uncertified", reason: error.message };
            return {
              status: "uncertified",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          const a = corners[i]!;
          const b = corners[j]!;
          const seg = segmentWithinPolygonStrict(polygon, a, b);
          if (!seg.inside) {
            hullInside = false;
            break;
          }
        }
        if (!hullInside) break;
      }
    }
    if (hullInside) {
      continue;
    }
    const mid = (start + end) / 2;
    if (!(mid > start && mid < end)) {
      return {
        status: "uncertified",
        reason: "Parameter interval collapsed",
      };
    }
    const samples: Array<{ readonly u: number; readonly point: Vec3 }> = [];
    for (const u of [start, mid, end] as const) {
      try {
        budget.charge();
        const pt = geometry.position(u);
        if (!pt.every(Number.isFinite))
          return {
            status: "uncertified",
            reason: "Non-finite position evaluation",
          };
        samples.push({ u, point: pt });
      } catch (error) {
        if (error instanceof WorkBudgetExceeded)
          return { status: "uncertified", reason: error.message };
        return {
          status: "uncertified",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    for (const sample of samples) {
      const sd = signedDistanceStrictXZ(polygon, sample.point);
      if (!Number.isFinite(sd))
        return {
          status: "uncertified",
          reason: "Non-finite signed distance",
        };
      if (sd > 0) {
        let s: number;
        try {
          budget.charge();
          s = station + arcLength(geometry, 0, sample.u);
        } catch (error) {
          if (error instanceof WorkBudgetExceeded)
            return { status: "uncertified", reason: error.message };
          return {
            status: "uncertified",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (!Number.isFinite(s)) {
          return { status: "uncertified", reason: "Non-finite station" };
        }
        return {
          status: "outside",
          witness: {
            u: sample.u,
            position: sample.point,
            s,
            signedDistance: sd,
          },
        };
      }
    }
    if (depth >= maxDepth) {
      return {
        status: "uncertified",
        reason: `Footprint certification max depth ${maxDepth} exceeded`,
      };
    }
    pending.push(
      { start: mid, end, depth: depth + 1 },
      { start, end: mid, depth: depth + 1 },
    );
  }
  return { status: "inside" };
};

export const certifyFootprintSpans = (
  spans: readonly SolvedSpan[],
  polygon: FootprintPolygon,
  options: {
    readonly budget?: CertifiedWorkBudget;
    readonly maxDepth?: number;
    readonly startStation?: number;
  } = {},
): ReadonlyMap<string, FootprintSpanStatus> => {
  const budget = options.budget ?? new CertifiedWorkBudget(1_000_000);
  const maxDepth = options.maxDepth ?? 32;
  const result = new Map<string, FootprintSpanStatus>();
  let station = options.startStation ?? 0;
  for (const span of spans) {
    const res = certifyFootprintSpan(span, polygon, {
      station,
      budget,
      maxDepth,
    });
    result.set(span.id, res);
    try {
      const geom = positionGeometry(span);
      station = station + arcLength(geom, 0, 1);
    } catch {
      // keep station as is for next
    }
  }
  return result;
};

export const scaffoldFitsFootprintPolygon = (
  spans: readonly SolvedSpan[],
  polygon: FootprintPolygon,
  budget: CertifiedWorkBudget,
  maxDepth = 32,
): "fits" | "does-not-fit" | "uncertified" => {
  for (const span of spans) {
    const res = certifyFootprintSpan(span, polygon, {
      station: 0,
      budget,
      maxDepth,
    });
    if (res.status === "outside") return "does-not-fit";
    if (res.status === "uncertified") return "uncertified";
  }
  return "fits";
};
