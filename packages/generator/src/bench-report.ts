/**
 * Pure helpers for benchmark orchestration/reporting.
 * Provides nearest-rank percentile (p50/p95) and a combined report builder
 * that merges engineering and browser summaries without hiding target misses.
 * No I/O, no product imports – deterministic.
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
  for (let i = 1; i < sortedAscending.length; i += 1) {
    if (sortedAscending[i]! < sortedAscending[i - 1]!) {
      throw new Error("sortedAscending must be sorted ascending");
    }
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

export interface BenchStageMs {
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface EngineeringStages {
  readonly candidateSearchInclusive: BenchStageMs;
  readonly searchOverhead: BenchStageMs;
  readonly solving: BenchStageMs;
  readonly compilation: BenchStageMs;
  readonly validation: BenchStageMs;
  readonly total: BenchStageMs;
}

export interface BrowserPercentiles {
  readonly p50: number;
  readonly p95: number;
}

export interface BrowserStages {
  readonly generationTotal: BrowserPercentiles;
  readonly simulation: BrowserPercentiles;
  readonly workerTransfer: BrowserPercentiles;
  readonly meshCreate: BrowserPercentiles;
  readonly frame: BrowserPercentiles;
}

export interface CombinedBenchReport {
  readonly engineering: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly stages: EngineeringStages;
    readonly targetMet: boolean;
    readonly misses: readonly { name: string; totalMs: number }[];
  };
  readonly browser: {
    readonly stages: BrowserStages;
    readonly generationP95Met: boolean | null;
    readonly frameP95Met: boolean;
    readonly steadyFrameTotal: number;
  };
  /** Honest aggregate: true only if every evaluated target is met; browser generation null => not counted as met. */
  readonly allTargetsMet: boolean;
  readonly generatedAt: string;
}

/**
 * Build a combined report from engineering summary (as produced by bench.test.ts)
 * and browser summary (as produced by browser-benchmark.acceptance.spec.ts).
 * Preserves misses verbatim and never weakens the gate.
 */
export function buildCombinedReport(
  engineering: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly stages: EngineeringStages;
    readonly target: {
      readonly met: boolean;
      readonly misses: readonly { name: string; totalMs: number }[];
    };
  },
  browser: {
    readonly percentiles: BrowserStages;
    readonly targets: {
      readonly generationP95Met: boolean | null;
      readonly frameP95Met: boolean;
    };
    readonly steadyFrameTotal: number;
  },
): CombinedBenchReport {
  const allTargetsMet =
    engineering.target.met &&
    browser.targets.frameP95Met &&
    (browser.targets.generationP95Met === null
      ? false
      : browser.targets.generationP95Met);
  // For strict honesty: if generation target not evaluated (null), allTargetsMet is false.
  return {
    engineering: {
      p50Ms: engineering.p50Ms,
      p95Ms: engineering.p95Ms,
      stages: engineering.stages,
      targetMet: engineering.target.met,
      misses: engineering.target.misses,
    },
    browser: {
      stages: browser.percentiles,
      generationP95Met: browser.targets.generationP95Met,
      frameP95Met: browser.targets.frameP95Met,
      steadyFrameTotal: browser.steadyFrameTotal,
    },
    allTargetsMet,
    generatedAt: new Date().toISOString(),
  };
}

export function formatCombinedReport(report: CombinedBenchReport): string {
  return JSON.stringify(report, null, 2);
}
