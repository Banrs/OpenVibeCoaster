import { describe, expect, it } from "vitest";
import {
  nearestRankPercentile,
  percentilePair,
} from "../../../tests/e2e/benchmark-helpers.js";

describe("benchmark-helpers nearest-rank", () => {
  it("nearestRankPercentile exact ranks", () => {
    expect(nearestRankPercentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(nearestRankPercentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(nearestRankPercentile([10, 20, 30], 50)).toBe(20);
  });

  it("percentilePair sorts and validates", () => {
    const pair = percentilePair([30, 10, 20]);
    expect(pair.p50).toBe(20);
    expect(pair.p95).toBe(30);
  });

  it("percentilePair requires non-empty finite nonnegative", () => {
    expect(() => percentilePair([])).toThrow();
    expect(() => percentilePair([1, -1])).toThrow();
    expect(() => percentilePair([1, Number.NaN])).toThrow();
  });
});
