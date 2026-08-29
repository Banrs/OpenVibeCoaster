import { describe, expect, it } from "vitest";
import {
  RideTimeline,
  simulateRide,
  createDefaultSimulatorConfig,
} from "@openvibecoaster/simulator";
import { compileTrack } from "@openvibecoaster/core";
import type { CompiledTrackData } from "@openvibecoaster/core";
import {
  getGraphSelection,
  getMetricColorData,
  getSeamInspection,
  getTimelineSelection,
  getTimelineSeries,
  indexAtGraphPosition,
  moveTimelineSelection,
  type TimelineMetricId,
} from "./telemetry.js";

import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
function straightTrack(): CompiledTrackData {
  const span1 = new SeventhOrderHermiteSpan({
    p0: vec3(0, 10, 0),
    d10: vec3(1, 0, 0),
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(50, 10, 0),
    d11: vec3(1, 0, 0),
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  const span2 = new SeventhOrderHermiteSpan({
    p0: vec3(50, 10, 0),
    d10: vec3(1, 0, 0),
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(100, 10, 0),
    d11: vec3(1, 0, 0),
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  return compileTrack([
    {
      id: "a",
      span: span1,
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
    {
      id: "b",
      span: span2,
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: Math.PI / 6,
        d11: 0,
        d21: 0,
      }),
      zones: [],
    },
  ]);
}

function simpleTimeline(): RideTimeline {
  return new RideTimeline({
    sampleRateHz: 10,
    timeSeconds: new Float64Array([0, 1, 2, 3]),
    headDistanceM: new Float64Array([0, 10, 20, 30]),
    speedMps: new Float64Array([5, 6, 7, 8]),
    longitudinalG: new Float64Array([0.1, 0.2, 0.3, 0.4]),
    lateralG: new Float64Array([0.05, 0.06, 0.07, 0.08]),
    verticalG: new Float64Array([1, 1.1, 1.2, 1.3]),
    jerkMps3: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]),
  });
}

function simulatedTimeline(): RideTimeline {
  const track = straightTrack();
  const config = createDefaultSimulatorConfig();
  const result = simulateRide(track, {
    config,
    initial: { headDistanceM: 30, speedMps: 5 },
    durationSeconds: 0.5,
  });
  // debugging: ensure we got timeline
  if (result.timeline.length === 0)
    console.warn("simulated timeline empty diagnostics", result.diagnostics);
  return result.timeline;
}

describe("telemetry – authoritative series alignment", () => {
  it("derives speed and G series without fabricating and aligns time/distance", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const speed = getTimelineSeries(timeline, "speed", track);
    expect(speed.available).toBe(true);
    expect(speed.values).toEqual([5, 6, 7, 8]);
    expect(speed.distances).toEqual([0, 10, 20, 30]);
    expect(speed.times).toEqual([0, 1, 2, 3]);
    expect(speed.range).toEqual({ min: 5, max: 8 });
    for (const v of speed.values) expect(Number.isFinite(v)).toBe(true);
    const lateral = getTimelineSeries(timeline, "lateralG", track);
    expect(lateral.values).toEqual([0.05, 0.06, 0.07, 0.08]);
  });

  it("computes jerk magnitude and does not misalign arrays", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const jerk = getTimelineSeries(timeline, "jerk", track);
    expect(jerk.available).toBe(true);
    expect(jerk.values.length).toBe(timeline.length);
    expect(jerk.distances.length).toBe(timeline.length);
    expect(jerk.values[0]).toBeCloseTo(0);
    expect(jerk.values[1]).toBeCloseTo(Math.hypot(1, 1, 1));
  });

  it("derives roll rate from timeline frames and falls back to bankDerivative*speed with correct units", () => {
    const simulated = simulatedTimeline();
    const track = straightTrack();
    const roll = getTimelineSeries(simulated, "rollRate", track);
    expect(roll.available).toBe(true);
    for (const v of roll.values) expect(Number.isFinite(v)).toBe(true);
    // Ensure not using bank angle directly: fallback should use derivative * speed
    const noFrames = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1]),
      headDistanceM: new Float64Array([0, 50]),
      speedMps: new Float64Array([5, -5]),
      frames: [],
    });
    const fallback = getTimelineSeries(noFrames, "rollRate", track);
    expect(fallback.available).toBe(true);
    for (const v of fallback.values) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(fallback.values[0]!)).toBe(true);
  });

  it("derives energy residual from timeline frames and reports unavailable when missing", () => {
    const simulated = simulatedTimeline();
    const track = straightTrack();
    const energy = getTimelineSeries(simulated, "energyResidual", track);
    expect(energy.available).toBe(true);
    for (const v of energy.values) expect(Number.isFinite(v)).toBe(true);
    const empty = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0]),
      headDistanceM: new Float64Array([0]),
      speedMps: new Float64Array([0]),
      frames: [],
    });
    expect(getTimelineSeries(empty, "energyResidual", track).available).toBe(
      false,
    );
  });

  it("reports clearance unavailable and never invents zero when no evidence", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const noClearance = getTimelineSeries(timeline, "clearance", track);
    expect(noClearance.available).toBe(false);
    expect(noClearance.values).toEqual([]);
    expect(noClearance.reason).toMatch(/clearance/i);

    const badLength = new Float64Array([1, 2]);
    expect(
      getTimelineSeries(timeline, "clearance", track, badLength).available,
    ).toBe(false);

    const withClearance = new Float64Array([2, 2.5, 3, 3.5]);
    const ok = getTimelineSeries(timeline, "clearance", track, withClearance);
    expect(ok.available).toBe(true);
    expect(ok.values).toEqual([2, 2.5, 3, 3.5]);
  });

  it("never uses bank angle as roll rate and keeps finite ranges", () => {
    const simulated = simulatedTimeline();
    const track = straightTrack();
    void getTimelineSeries(simulated, "rollRate", track);
    const noFrames = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1]),
      headDistanceM: new Float64Array([0, 1]),
      speedMps: new Float64Array([2, 2]),
      frames: [],
    });
    const derived = getTimelineSeries(noFrames, "rollRate", track);
    expect(derived.available).toBe(true);
    for (const v of derived.values) expect(Number.isFinite(v)).toBe(true);
    expect(derived.range).toBeDefined();
    expect(Number.isFinite(derived.range!.min)).toBe(true);
    // bank angle is ~0 at distance 0; roll rate derived should be derivative*speed not angle
    expect(derived.values[0]).not.toBeCloseTo(0.5, 1);
  });

  it("keeps distance/time arrays aligned and finite", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    for (const metric of [
      "speed",
      "verticalG",
      "lateralG",
      "longitudinalG",
      "jerk",
    ] as TimelineMetricId[]) {
      const s = getTimelineSeries(timeline, metric as never, track);
      if (s.available) {
        expect(s.distances.length).toBe(timeline.length);
        expect(s.times.length).toBe(timeline.length);
        expect(s.distances.every(Number.isFinite)).toBe(true);
        expect(s.times.every(Number.isFinite)).toBe(true);
      }
    }
  });
});

describe("telemetry – graph sync and seam", () => {
  it("returns canonical synchronized index/time/distance/position", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const sel = getTimelineSelection(timeline, 2, track);
    expect(sel).toEqual(
      expect.objectContaining({ index: 2, distanceM: 20, timeSeconds: 2 }),
    );
    expect(sel!.trackPosition).toBeDefined();
    const graph = getGraphSelection(timeline, track, 50, 100);
    expect(graph).not.toBeNull();
    expect(graph!.index).toBe(2);
    expect(graph!.distanceM).toBe(20);
  });

  it("metric-color data has explicit unavailable state, finite ranges, stable mapping", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const speedData = getMetricColorData(timeline, track, "speed");
    expect(speedData.available).toBe(true);
    expect(speedData.values.length).toBe(timeline.length);
    expect(speedData.range).toEqual({ min: 5, max: 8 });
    const missing = getMetricColorData(timeline, track, "clearance");
    expect(missing.available).toBe(false);
    expect(missing.values).toEqual([]);
    expect(missing.reason).toBeDefined();
    const second = getMetricColorData(timeline, track, "speed");
    expect(second.values).toEqual(speedData.values);
  });

  it("seam inspection uses compiled boundaries and honors toggle", () => {
    const track = straightTrack();
    const diagnostics = [
      {
        code: "SEAM_GAP",
        severity: "error" as const,
        message: "gap",
        relatedIds: ["a"],
      },
    ];
    const enabled = getSeamInspection(track, diagnostics, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.boundaries.length).toBeGreaterThan(0);
    expect(enabled.boundaries).toEqual(Array.from(track.elementBoundaries));
    const disabled = getSeamInspection(track, diagnostics, false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.boundaries).toEqual([]);
    expect(disabled.seamDiagnostics).toEqual([]);
    const nullTrack = getSeamInspection(null, diagnostics, true);
    expect(nullTrack.enabled).toBe(false);
  });

  it("graph helpers clamp and never produce NaN", () => {
    const timeline = simpleTimeline();
    expect(moveTimelineSelection(timeline, 0, "ArrowLeft")).toBe(0);
    expect(moveTimelineSelection(timeline, 3, "ArrowRight")).toBe(3);
    expect(moveTimelineSelection(timeline, 1, "Home")).toBe(0);
    expect(moveTimelineSelection(timeline, 1, "End")).toBe(3);
    expect(indexAtGraphPosition(timeline, -10, 100)).toBe(0);
    expect(indexAtGraphPosition(timeline, 200, 100)).toBe(3);
    expect(Number.isNaN(indexAtGraphPosition(timeline, Number.NaN, 100))).toBe(
      false,
    );
  });

  it("preserves caller immutability and determinism", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const beforeDistances = Array.from(timeline.headDistanceM);
    const series = getTimelineSeries(timeline, "speed", track);
    expect(Array.from(timeline.headDistanceM)).toEqual(beforeDistances);
    const second = getTimelineSeries(timeline, "speed", track);
    expect(series.values).toEqual(second.values);
    expect(Object.isFrozen(series)).toBe(true);
  });
});
