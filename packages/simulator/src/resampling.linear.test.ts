import { describe, expect, it } from "vitest";
import {
  compileTrack,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  simulateRide,
  createMonotonicBracketLocator,
} from "./index.js";

function straightTrack() {
  const span = new SeventhOrderHermiteSpan({
    p0: vec3(0, 10, 0),
    d10: vec3(1, 0, 0),
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(500, 10, 0),
    d11: vec3(1, 0, 0),
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  return compileTrack([
    {
      id: "a",
      span,
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      zones: [],
    },
  ]);
}

describe("resampling linear bracket regression - production helper", () => {
  it("resampling output equality between compact and full", () => {
    const track = straightTrack();
    const config = createDefaultSimulatorConfig();
    const full = simulateRide(track, {
      config,
      initial: { headDistanceM: 20, speedMps: 8 },
      durationSeconds: 1,
    });
    const compact = simulateRide(track, {
      config,
      initial: { headDistanceM: 20, speedMps: 8 },
      durationSeconds: 1,
      compactTimeline: true,
    });
    expect(Array.from(compact.timeline.headDistanceM)).toEqual(
      Array.from(full.timeline.headDistanceM),
    );
    expect(Array.from(compact.timeline.speedMps)).toEqual(
      Array.from(full.timeline.speedMps),
    );
    expect(compact.timeline.sampleRateHz).toBe(120);
  });

  it("monotonic bracket locator on production helper is O(frames+outputs) via getter counting", () => {
    const frameCount = 5000;
    const outputCount = 2500;
    let reads = 0;
    const frames = Array.from({ length: frameCount }, (_, i) => {
      const t = i * (1 / 240);
      return {
        get timeSeconds() {
          reads += 1;
          return t;
        },
      } as unknown as { timeSeconds: number };
    });
    const outputTimes = Array.from(
      { length: outputCount },
      (_, i) => i * (1 / 120),
    );
    const locator = createMonotonicBracketLocator(frames);
    for (const t of outputTimes) {
      locator(t);
    }
    // Linear: at most frames + outputs + small overhead, not quadratic
    // Quadratic would be ~6M reads; linear should be < 10000
    expect(reads).toBeLessThan(frameCount + outputCount * 2);
    expect(reads).toBeGreaterThan(frameCount - 100);
    expect(reads).toBeLessThan(12000);
    // Prove not quadratic
    const quadraticThreshold = frameCount * outputCount * 0.1;
    expect(reads).toBeLessThan(quadraticThreshold);
  });

  it("locator returns correct monotonic brackets for sorted times", () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({
      timeSeconds: i,
    }));
    const locator = createMonotonicBracketLocator(frames);
    expect(locator(0)).toBe(0);
    expect(locator(0.1)).toBe(1);
    expect(locator(1)).toBe(1);
    expect(locator(5.5)).toBe(6);
    expect(locator(9)).toBe(9);
    expect(locator(100)).toBe(9);
  });
});
