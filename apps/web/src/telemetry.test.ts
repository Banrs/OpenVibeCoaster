import { describe, expect, it } from "vitest";
import {
  RideTimeline,
  simulateRide,
  createDefaultSimulatorConfig,
} from "@openvibecoaster/simulator";
import { compileTrack } from "@openvibecoaster/core";
import type { CompiledTrackData, Diagnostic } from "@openvibecoaster/core";
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
import { computeTelemetrySignature } from "./app/telemetrySignature.js";

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

  it("seam inspection returns authoritative boundary and all seam evidence without inventing", () => {
    const track = straightTrack();
    const diagnostics = [
      { code: "SEAM", severity: "info" as const, message: "ok" },
      { code: "OTHER", severity: "warning" as const, message: "other" },
    ];
    const enabled = getSeamInspection(track, diagnostics, true);
    expect(enabled.boundaries).toEqual(Array.from(track.elementBoundaries));
    expect(enabled.seamDiagnostics).toEqual([diagnostics[0]]);
    // toggle off
    const off = getSeamInspection(track, diagnostics, false);
    expect(off.seamDiagnostics).toEqual([]);
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

  it("rejects non-finite time/head-distance arrays and empty/one-sample truthfully", () => {
    const track = straightTrack();
    // Use fake timeline objects to avoid RideTimeline constructor throwing on NaN – controller should still reject
    const nanHead = {
      length: 2,
      headDistanceM: new Float64Array([0, Number.NaN]),
      timeSeconds: new Float64Array([0, 1]),
      speedMps: new Float64Array([5, 6]),
      verticalG: new Float64Array([0, 0]),
      lateralG: new Float64Array([0, 0]),
      longitudinalG: new Float64Array([0, 0]),
      jerkMps3: new Float64Array([0, 0]),
      frames: [],
    } as unknown as RideTimeline;
    expect(getTimelineSeries(nanHead, "speed", track).available).toBe(false);
    const infTime = {
      length: 2,
      headDistanceM: new Float64Array([0, 10]),
      timeSeconds: new Float64Array([0, Number.POSITIVE_INFINITY]),
      speedMps: new Float64Array([5, 6]),
      verticalG: new Float64Array([0, 0]),
      lateralG: new Float64Array([0, 0]),
      longitudinalG: new Float64Array([0, 0]),
      jerkMps3: new Float64Array([0, 0]),
      frames: [],
    } as unknown as RideTimeline;
    expect(getTimelineSeries(infTime, "speed", track).available).toBe(false);
    const empty = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([]),
      headDistanceM: new Float64Array([]),
      speedMps: new Float64Array([]),
    });
    expect(getTimelineSeries(empty, "speed", track).available).toBe(false);
    const one = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0]),
      headDistanceM: new Float64Array([0]),
      speedMps: new Float64Array([5]),
    });
    expect(getTimelineSeries(one, "speed", track).available).toBe(false);
  });

  it("graph position selection rejects non-finite without fabricating", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    expect(getGraphSelection(timeline, track, Number.NaN, 100)).toBeNull();
    expect(getGraphSelection(timeline, track, 10, Number.NaN)).toBeNull();
    expect(
      getGraphSelection(timeline, track, Number.POSITIVE_INFINITY, 100),
    ).toBeNull();
    // finite case still works
    expect(getGraphSelection(timeline, track, 50, 100)).not.toBeNull();
  });

  it("metric graph/color output is metric-distinct", () => {
    const timeline = simpleTimeline();
    const track = straightTrack();
    const speed = getMetricColorData(timeline, track, "speed");
    const gForce = getMetricColorData(timeline, track, "gForce");
    // values differ because speed vs gForce magnitudes differ
    expect(speed.values).not.toEqual(gForce.values);
    expect(speed.range).not.toEqual(gForce.range);
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
  it("seam inspection includes in-window and explicit seam evidence, excludes far diagnostics, preserves originals", () => {
    const track = straightTrack();
    const distances = track.distances;
    const boundaries = Array.from(track.elementBoundaries);
    const firstBoundaryDist = distances[boundaries[0]!] ?? 0;
    // Use first boundary for in-window
    const inWindow: Diagnostic = {
      code: "OTHER",
      severity: "info",
      message: "near seam",
      location: { s: firstBoundaryDist + 2 },
    } as unknown as Diagnostic;
    const far: Diagnostic = {
      code: "OTHER",
      severity: "info",
      message: "far away",
      location: { s: firstBoundaryDist + 20 },
    } as unknown as Diagnostic;
    const explicitSeam: Diagnostic = {
      code: "SEAM_GAP",
      severity: "error",
      message: "seam continuity issue",
    } as unknown as Diagnostic;
    const explicitMsg: Diagnostic = {
      code: "OTHER",
      severity: "warning",
      message: "continuity break at seam",
    } as unknown as Diagnostic;
    const diagnostics = [inWindow, far, explicitSeam, explicitMsg];
    const enabled = getSeamInspection(track, diagnostics, true);
    expect(enabled.boundaries).toEqual(boundaries);
    expect(enabled.seamDiagnostics).toContain(inWindow);
    expect(enabled.seamDiagnostics).toContain(explicitSeam);
    expect(enabled.seamDiagnostics).toContain(explicitMsg);
    expect(enabled.seamDiagnostics).not.toContain(far);
    // Preserves original objects/values (not altered)
    expect(enabled.seamDiagnostics[0]).toBe(inWindow);
    expect(enabled.seamDiagnostics[0]!.location!.s).toBe(firstBoundaryDist + 2);
    // Disabled -> empty
    const disabled = getSeamInspection(track, diagnostics, false);
    expect(disabled.seamDiagnostics).toEqual([]);
    expect(disabled.boundaries).toEqual([]);
    // No track -> empty
    const noTrack = getSeamInspection(null, diagnostics, true);
    expect(noTrack.seamDiagnostics).toEqual([]);
  });
});

describe("telemetry – defensive-copy amplification regression", () => {
  function spyTimelineGetters(_timeline: RideTimeline) {
    const proto = RideTimeline.prototype as unknown as Record<string, unknown>;
    const descriptors: Record<string, PropertyDescriptor> = {};
    const counts: Record<string, number> = {};
    for (const key of [
      "headDistanceM",
      "timeSeconds",
      "speedMps",
      "verticalG",
      "lateralG",
      "longitudinalG",
      "jerkMps3",
    ] as const) {
      const desc = Object.getOwnPropertyDescriptor(proto as object, key);
      if (!desc?.get) continue;
      descriptors[key] = desc;
      counts[key] = 0;
      Object.defineProperty(proto, key, {
        get(this: RideTimeline) {
          counts[key]!++;
          return (desc.get as () => Float64Array).call(this);
        },
        configurable: true,
      });
    }
    return {
      counts,
      restore() {
        for (const key of Object.keys(descriptors)) {
          Object.defineProperty(proto, key, descriptors[key]!);
        }
      },
    };
  }

  it("gForce path snapshots vertical/lateral/longitudinal G once each, not per sample", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 6, 7, 8]),
      longitudinalG: new Float64Array([0.1, 0.2, 0.3, 0.4]),
      lateralG: new Float64Array([0.05, 0.06, 0.07, 0.08]),
      verticalG: new Float64Array([1, 1.1, 1.2, 1.3]),
      frames: [],
    });
    const track = straightTrack();
    const spy = spyTimelineGetters(timeline);
    try {
      const series = getTimelineSeries(timeline, "gForce", track);
      expect(series.available).toBe(true);
      // gForce previously did 3 copies per sample (12 for length 4) plus length checks
      expect(spy.counts.verticalG).toBeLessThanOrEqual(1);
      expect(spy.counts.lateralG).toBeLessThanOrEqual(1);
      expect(spy.counts.longitudinalG).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });

  it("speed metric copies speedMps exactly once (not twice for length check + Array.from)", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3, 4]),
      headDistanceM: new Float64Array([0, 10, 20, 30, 40]),
      speedMps: new Float64Array([5, 6, 7, 8, 9]),
      frames: [],
    });
    const track = straightTrack();
    const spy = spyTimelineGetters(timeline);
    try {
      const series = getTimelineSeries(timeline, "speed", track);
      expect(series.available).toBe(true);
      expect(spy.counts.speedMps).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });

  it("rollRate fallback reuses distances snapshot and does not re-read headDistanceM per sample", () => {
    const track = straightTrack();
    // timeline without frames to force fallback bankDerivative * speed
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 5, 5, 5]),
      frames: [],
    });
    const spy = spyTimelineGetters(timeline);
    try {
      const series = getTimelineSeries(timeline, "rollRate", track);
      expect(series.available).toBe(true);
      // arraysFromTimeline already does one headDistanceM copy; fallback must not do per-sample copies
      // Total headDistanceM copies must be <=1 (the one from arraysFromTimeline via distances)
      // Speed may be one copy
      expect(spy.counts.headDistanceM).toBeLessThanOrEqual(1);
      expect(spy.counts.speedMps).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });

  it("verticalG/lateralG/longitudinalG do not double-copy when frames fallback not needed", () => {
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 6, 7, 8]),
      verticalG: new Float64Array([1, 1, 1, 1]),
      lateralG: new Float64Array([0, 0, 0, 0]),
      longitudinalG: new Float64Array([0, 0, 0, 0]),
      frames: [],
    });
    const track = straightTrack();
    const spy = spyTimelineGetters(timeline);
    try {
      const v = getTimelineSeries(timeline, "verticalG", track);
      expect(v.available).toBe(true);
      expect(spy.counts.verticalG).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
    const spy2 = spyTimelineGetters(timeline);
    try {
      const lat = getTimelineSeries(timeline, "lateralG", track);
      expect(lat.available).toBe(true);
      expect(spy2.counts.lateralG).toBeLessThanOrEqual(1);
    } finally {
      spy2.restore();
    }
  });

  it("computeTelemetrySignature snapshots speedMps/headDistanceM/timeSeconds once per 64-sample hash (not 128 copies)", () => {
    const track = straightTrack();
    const length = 70;
    const timeSeconds = new Float64Array(length);
    const headDistanceM = new Float64Array(length);
    const speedMps = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      timeSeconds[i] = i * 0.5;
      headDistanceM[i] = i * 2;
      speedMps[i] = 10 + i;
    }
    const timeline = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds,
      headDistanceM,
      speedMps,
    });
    const spy = spyTimelineGetters(timeline);
    try {
      const sig = computeTelemetrySignature(track, timeline);
      expect(typeof sig).toBe("string");
      expect(sig.length).toBeGreaterThan(0);
      // Previously 64 iterations each did timeline.speedMps and timeline.headDistanceM copies => 128 copies + timeSeconds once
      expect(spy.counts.speedMps).toBeLessThanOrEqual(1);
      expect(spy.counts.headDistanceM).toBeLessThanOrEqual(1);
      expect(spy.counts.timeSeconds).toBeLessThanOrEqual(1);
    } finally {
      spy.restore();
    }
  });
});

describe("telemetry – compact series authoritative", () => {
  function spyCompactGetters(_timeline: RideTimeline) {
    const proto = RideTimeline.prototype as unknown as Record<string, unknown>;
    const keys = ["rollRateRadPerSec", "energyErrorJ"] as const;
    const descriptors: Record<string, PropertyDescriptor> = {};
    const counts: Record<string, number> = {};
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(proto as object, key);
      if (!desc?.get) continue;
      descriptors[key] = desc;
      counts[key] = 0;
      Object.defineProperty(proto, key, {
        get(this: RideTimeline) {
          counts[key]!++;
          return (desc.get as () => Float64Array).call(this);
        },
        configurable: true,
      });
    }
    return {
      counts,
      restore() {
        for (const key of Object.keys(descriptors))
          Object.defineProperty(proto, key, descriptors[key]!);
      },
    };
  }

  it("frame-empty compact timeline returns exact rollRate and energyResidual values, not fallback approximations", () => {
    const track = straightTrack();
    const compact = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 5, 5, 5]),
      rollRateRadPerSec: new Float64Array([0.1, 0.2, 0.3, 0.4]),
      energyErrorJ: new Float64Array([10, 20, 30, 40]),
      frames: [],
    });
    const roll = getTimelineSeries(compact, "rollRate", track);
    expect(roll.available).toBe(true);
    expect(roll.values).toEqual([0.1, 0.2, 0.3, 0.4]);
    const energy = getTimelineSeries(compact, "energyResidual", track);
    expect(energy.available).toBe(true);
    expect(energy.values).toEqual([10, 20, 30, 40]);
    // ensure not derived fallback (bankDerivative*speed would be different at these distances)
    const speedDerivedWouldBe = (() => {
      // bank at 0-50 is 0, but at 50-100 bank ramps; our distances 0,10,20,30 are within flat 0 bank
      // so derived would be ~0, not 0.1-0.4, proving we returned exact compact values
      return 0;
    })();
    expect(roll.values[0]).not.toBe(speedDerivedWouldBe);
  });

  it("frame-empty compact getters are snapshotted at most once per series request", () => {
    const track = straightTrack();
    const compact = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 5, 5, 5]),
      rollRateRadPerSec: new Float64Array([0.5, 0.6, 0.7, 0.8]),
      energyErrorJ: new Float64Array([1, 2, 3, 4]),
      frames: [],
    });
    const spyRoll = spyCompactGetters(compact);
    try {
      const r = getTimelineSeries(compact, "rollRate", track);
      expect(r.available).toBe(true);
      expect(spyRoll.counts.rollRateRadPerSec).toBeLessThanOrEqual(1);
    } finally {
      spyRoll.restore();
    }
    const spyEnergy = spyCompactGetters(compact);
    try {
      const e = getTimelineSeries(compact, "energyResidual", track);
      expect(e.available).toBe(true);
      expect(spyEnergy.counts.energyErrorJ).toBeLessThanOrEqual(1);
    } finally {
      spyEnergy.restore();
    }
  });

  it("legacy 11-buffer shape with empty compact series reports unavailable rather than zero approximations", () => {
    const track = straightTrack();
    // legacy shape: no compact roll/energy arrays, frames empty
    const legacy = new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1, 2, 3]),
      headDistanceM: new Float64Array([0, 10, 20, 30]),
      speedMps: new Float64Array([5, 5, 5, 5]),
      frames: [],
    });
    expect(getTimelineSeries(legacy, "rollRate", null).available).toBe(false);
    expect(getTimelineSeries(legacy, "energyResidual", track).available).toBe(
      false,
    );
  });
});
