import { describe, it, expect } from "vitest";
import {
  compileTrack,
  vec3,
  createDesignIntentV1,
  compileCoasterFile,
} from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import { RideTimeline } from "@openvibecoaster/simulator";
import {
  toTimelineMetricId,
  getHeightSeries,
  deriveMetricData,
  getMetricSeries,
} from "./metricData.js";
import type { AuthoritativeExperienceResult } from "../experienceController.js";

function makeTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) =>
            vec3(u * 20, 5 + Math.sin(u * Math.PI) * 2, 0),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(20, Math.cos(u * Math.PI) * Math.PI * 2, 0)
              : vec3(0, -Math.sin(u * Math.PI) * Math.PI * Math.PI * 2, 0),
        },
      },
    ],
    { samples: 16 },
  );
}

function makeTimeline(length = 8) {
  const timeSeconds = new Float64Array(length);
  const headDistanceM = new Float64Array(length);
  const speedMps = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    timeSeconds[i] = i * 0.5;
    headDistanceM[i] = i * 2;
    speedMps[i] = 10 + i;
  }
  return new RideTimeline({
    sampleRateHz: 2,
    timeSeconds,
    headDistanceM,
    speedMps,
  });
}

function makeValidResult(): AuthoritativeExperienceResult {
  const intent = createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    terrainProfileId: "rolling-highlands-v1",
    pinnedElementIds: [],
  });
  const generated = generateCoaster(intent, { name: "metric-test" });
  const track = compileCoasterFile(generated.file).track;
  const timeline = makeTimeline(8);
  return {
    file: generated.file,
    track,
    timeline,
    diagnostics: [],
    relaxations: [],
    spanHashes: { dummy: "abc12345" },
    clearanceM: new Float64Array(8).fill(5),
  };
}

describe("metricData helpers", () => {
  it("toTimelineMetricId maps exhaustively", () => {
    expect(toTimelineMetricId("speed")).toBe("speed");
    expect(toTimelineMetricId("gForce")).toBe("gForce");
    expect(toTimelineMetricId("rollRate")).toBe("rollRate");
    expect(toTimelineMetricId("clearance")).toBe("clearance");
    expect(toTimelineMetricId("energy")).toBe("energyResidual");
  });

  it("getHeightSeries samples canonical Y via sampleTrackAtDistance", () => {
    const track = makeTrack();
    const timeline = makeTimeline(4);
    const series = getHeightSeries(track, timeline);
    expect(series.metric).toBe("height");
    expect(series.available).toBe(true);
    expect(series.values.length).toBe(4);
    expect(series.distances.length).toBe(4);
    for (const v of series.values) expect(Number.isFinite(v)).toBe(true);
    expect(series.range).toBeDefined();
  });

  it("deriveMetricData returns undefined for height (renderer-native)", () => {
    const result = makeValidResult();
    const out = deriveMetricData("height", result);
    expect(out).toBeUndefined();
  });

  it("deriveMetricData resamples monotonically to track.distances length", () => {
    const result = makeValidResult();
    const out = deriveMetricData("speed", result);
    expect(out).toBeDefined();
    expect(out?.speed).toBeDefined();
    expect(out?.speed?.length).toBe(result.track.distances.length);
    if (out?.speed) {
      for (const v of out.speed) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("getMetricSeries centralizes height vs timeline choice", () => {
    const track = makeTrack();
    const timeline = makeTimeline(4);
    const heightSeries = getMetricSeries(
      "height",
      track,
      timeline,
      new Float64Array(4).fill(5),
    );
    expect(heightSeries.metric).toBe("height");
    const speedSeries = getMetricSeries(
      "speed",
      track,
      timeline,
      new Float64Array(4).fill(5),
    );
    expect(speedSeries.metric).toBe("speed");
    expect(speedSeries.available).toBe(true);
  });
});
