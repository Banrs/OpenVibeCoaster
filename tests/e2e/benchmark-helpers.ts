/**
 * Deterministic helpers for real-browser benchmark percentile reporting.
 * Pure – no product imports – test-only utilities.
 */

export function nearestRankPercentile(
  sortedAscending: readonly number[],
  percentile: number,
): number {
  if (sortedAscending.length === 0) {
    throw new Error("percentile requires non-empty array");
  }
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
    throw new Error(`percentile must be finite 0..100, got ${percentile}`);
  }
  const n = sortedAscending.length;
  const rank = Math.ceil((percentile / 100) * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  const value = sortedAscending[index];
  if (!Number.isFinite(value)) {
    throw new Error("percentile value not finite");
  }
  return value as number;
}

export function percentilePair(values: readonly number[]): {
  p50: number;
  p95: number;
} {
  if (values.length === 0) {
    throw new Error("percentilePair requires non-empty values");
  }
  const sorted = [...values].sort((a, b) => a - b);
  for (const v of sorted) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`duration must be finite nonnegative, got ${v}`);
    }
  }
  return {
    p50: nearestRankPercentile(sorted, 50),
    p95: nearestRankPercentile(sorted, 95),
  };
}

export function isValidDuration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export interface BenchmarkPercentiles {
  readonly p50: number;
  readonly p95: number;
}

export interface BenchmarkSummary {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly warmupSeedCount: number;
  readonly measuredSeedCount: number;
  readonly counts: {
    readonly generationTotal: number;
    readonly simulation: number;
    readonly workerTransfer: number;
    readonly meshCreate: number;
    readonly frame: number;
  };
  readonly percentiles: {
    readonly generationTotal?: BenchmarkPercentiles;
    readonly simulation: BenchmarkPercentiles;
    readonly workerTransfer: BenchmarkPercentiles;
    readonly meshCreate: BenchmarkPercentiles;
    readonly frame: BenchmarkPercentiles;
  };
  readonly targets: {
    readonly generationP95TargetMs: number;
    readonly frameP95TargetMs: number;
    readonly generationP95Met: boolean | null;
    readonly frameP95Met: boolean | null;
  };
  readonly steadyFrameTotal: number;
}
