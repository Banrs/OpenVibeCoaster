import { describe, expect, it, vi } from "vitest";
import { createExactSampleCache } from "./exact-sample-cache";

describe("createExactSampleCache", () => {
  it("exposes sample and clear", () => {
    const sampler = vi.fn((distanceM: number) => ({ distanceM }));
    const cache = createExactSampleCache(sampler);
    expect(typeof cache.sample).toBe("function");
    expect(typeof cache.clear).toBe("function");
  });

  it("returns same reference for exact same finite key and calls base sampler once", () => {
    const sampler = vi.fn((distanceM: number) => ({ distanceM }));
    const cache = createExactSampleCache(sampler);
    const first = cache.sample(7);
    const second = cache.sample(7);
    expect(second).toBe(first);
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith(7);
  });

  it("treats 12.5 and 12.5 + Number.EPSILON as distinct keys", () => {
    const sampler = vi.fn((distanceM: number) => ({ distanceM }));
    const cache = createExactSampleCache(sampler);
    const a = cache.sample(12.5);
    const b = cache.sample(12.5 + Number.EPSILON);
    expect(b).not.toBe(a);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(a.distanceM).toBe(12.5);
    expect(b.distanceM).toBe(12.5 + Number.EPSILON);
  });

  it("clear makes a repeated exact key invoke the base sampler again", () => {
    const sampler = vi.fn((distanceM: number) => ({ distanceM }));
    const cache = createExactSampleCache(sampler);
    const first = cache.sample(9);
    expect(sampler).toHaveBeenCalledTimes(1);
    cache.clear();
    const second = cache.sample(9);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.distanceM).toBe(9);
    const third = cache.sample(9);
    expect(third).toBe(second);
    expect(sampler).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown result and retries on next exact call", () => {
    let shouldThrow = true;
    const sampler = vi.fn((distanceM: number) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("boom");
      }
      return { distanceM };
    });
    const cache = createExactSampleCache(sampler);
    expect(() => cache.sample(5)).toThrow();
    expect(sampler).toHaveBeenCalledTimes(1);
    const second = cache.sample(5);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(second.distanceM).toBe(5);
    const third = cache.sample(5);
    expect(third).toBe(second);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(() => cache.sample(5)).not.toThrow();
  });
});
