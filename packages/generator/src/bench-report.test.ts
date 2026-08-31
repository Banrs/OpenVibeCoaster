import { describe, expect, it } from "vitest";
import {
  nearestRankPercentile,
  percentilePair,
  buildCombinedReport,
  formatCombinedReport,
} from "./bench-report";

describe("bench-report nearest-rank percentile", () => {
  it("p50/p95 nearest-rank on sorted ascending", () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(nearestRankPercentile(sorted, 50)).toBe(30);
    expect(nearestRankPercentile(sorted, 95)).toBe(50);
  });

  it("single value returns itself for any percentile", () => {
    expect(nearestRankPercentile([7], 0)).toBe(7);
    expect(nearestRankPercentile([7], 50)).toBe(7);
    expect(nearestRankPercentile([7], 100)).toBe(7);
  });

  it("p0 returns first, p100 returns last", () => {
    const sorted = [1, 2, 3, 4];
    expect(nearestRankPercentile(sorted, 0)).toBe(1);
    expect(nearestRankPercentile(sorted, 100)).toBe(4);
  });

  it("throws on unsorted", () => {
    expect(() => nearestRankPercentile([2, 1], 50)).toThrow(
      /sortedAscending must be sorted/,
    );
  });

  it("throws on empty", () => {
    expect(() => nearestRankPercentile([], 50)).toThrow(/non-empty/);
  });

  it("throws on non-finite or out-of-range percentile", () => {
    expect(() => nearestRankPercentile([1, 2], -1)).toThrow(/0\.\.100/);
    expect(() => nearestRankPercentile([1, 2], 101)).toThrow(/0\.\.100/);
    expect(() => nearestRankPercentile([1, 2], Number.NaN)).toThrow(/0\.\.100/);
  });

  it("percentilePair computes p50/p95 from unsorted input", () => {
    const values = [40, 10, 30, 20, 50];
    const pair = percentilePair(values);
    expect(pair.p50).toBe(30);
    expect(pair.p95).toBe(50);
  });

  it("percentilePair throws on empty or negative", () => {
    expect(() => percentilePair([])).toThrow(/non-empty/);
    expect(() => percentilePair([10, -1])).toThrow(/nonnegative/);
  });

  it("percentilePair p95 >= p50", () => {
    const pair = percentilePair([5, 5, 5, 100]);
    expect(pair.p95).toBeGreaterThanOrEqual(pair.p50);
  });

  it("buildCombinedReport preserves misses and evaluates targets honestly", () => {
    const eng = {
      p50Ms: 10,
      p95Ms: 900,
      stages: {
        candidateSearchInclusive: { p50Ms: 8, p95Ms: 15 },
        searchOverhead: { p50Ms: 1, p95Ms: 2 },
        solving: { p50Ms: 5, p95Ms: 10 },
        compilation: { p50Ms: 1, p95Ms: 2 },
        validation: { p50Ms: 1, p95Ms: 2 },
        total: { p50Ms: 10, p95Ms: 900 },
      },
      target: { met: true, misses: [] },
    };
    const browser = {
      percentiles: {
        generationTotal: { p50: 800, p95: 950 },
        simulation: { p50: 2, p95: 5 },
        workerTransfer: { p50: 1, p95: 2 },
        meshCreate: { p50: 10, p95: 20 },
        frame: { p50: 10, p95: 12 },
      },
      targets: { generationP95Met: true, frameP95Met: true },
      steadyFrameTotal: 200,
    };
    const report = buildCombinedReport(eng, browser);
    expect(report.allTargetsMet).toBe(true);
    expect(report.engineering.targetMet).toBe(true);
    expect(report.browser.generationP95Met).toBe(true);
    expect(report.generatedAt).toBeTruthy();
    const formatted = formatCombinedReport(report);
    expect(JSON.parse(formatted).allTargetsMet).toBe(true);
  });

  it("allTargetsMet false when any target miss", () => {
    const eng = {
      p50Ms: 10,
      p95Ms: 1100,
      stages: {
        candidateSearchInclusive: { p50Ms: 8, p95Ms: 15 },
        searchOverhead: { p50Ms: 1, p95Ms: 2 },
        solving: { p50Ms: 5, p95Ms: 10 },
        compilation: { p50Ms: 1, p95Ms: 2 },
        validation: { p50Ms: 1, p95Ms: 2 },
        total: { p50Ms: 10, p95Ms: 1100 },
      },
      target: {
        met: false,
        misses: [{ name: "full-auto-0", totalMs: 1100 }],
      },
    };
    const browser = {
      percentiles: {
        generationTotal: { p50: 800, p95: 1200 },
        simulation: { p50: 2, p95: 5 },
        workerTransfer: { p50: 1, p95: 2 },
        meshCreate: { p50: 10, p95: 20 },
        frame: { p50: 10, p95: 20 },
      },
      targets: { generationP95Met: false, frameP95Met: false },
      steadyFrameTotal: 150,
    };
    const report = buildCombinedReport(eng, browser);
    expect(report.allTargetsMet).toBe(false);
    expect(report.engineering.misses.length).toBe(1);
  });

  it("allTargetsMet false when browser generation null-ish (treated as not met)", () => {
    const eng = {
      p50Ms: 10,
      p95Ms: 500,
      stages: {
        candidateSearchInclusive: { p50Ms: 5, p95Ms: 6 },
        searchOverhead: { p50Ms: 1, p95Ms: 1 },
        solving: { p50Ms: 3, p95Ms: 4 },
        compilation: { p50Ms: 1, p95Ms: 1 },
        validation: { p50Ms: 1, p95Ms: 1 },
        total: { p50Ms: 10, p95Ms: 500 },
      },
      target: { met: true, misses: [] },
    };
    // Simulate missing generation target evaluation as null -> we pass false to be honest
    const browser = {
      percentiles: {
        generationTotal: { p50: 800, p95: 1200 },
        simulation: { p50: 2, p95: 5 },
        workerTransfer: { p50: 1, p95: 2 },
        meshCreate: { p50: 10, p95: 20 },
        frame: { p50: 10, p95: 20 },
      },
      targets: {
        generationP95Met: null as unknown as boolean,
        frameP95Met: true,
      },
      steadyFrameTotal: 150,
    };
    const report = buildCombinedReport(eng, browser as any);
    expect(report.allTargetsMet).toBe(false);
  });
});
