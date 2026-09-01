import type { MetricId } from "../viewState.js";
import type { MetricData } from "../render/metricContract.js";
import type { AuthoritativeExperienceResult } from "../experienceController.js";
import { sampleTrackAtDistance } from "@openvibecoaster/core";
import type { CompiledTrackData } from "@openvibecoaster/core";
import type { RideTimeline } from "@openvibecoaster/simulator";
import {
  getTimelineSeries,
  type TimelineMetricId,
  type TimelineSeries,
} from "../telemetry.js";
import type { RideSelectionId } from "../ride/controller.js";

function toTimelineMetricId(
  metric: Exclude<MetricId, "height">,
): TimelineMetricId {
  switch (metric) {
    case "speed":
      return "speed";
    case "gForce":
      return "gForce";
    case "rollRate":
      return "rollRate";
    case "clearance":
      return "clearance";
    case "energy":
      return "energyResidual";
  }
}

export function getHeightSeries(
  track: CompiledTrackData,
  timeline: RideTimeline,
): TimelineSeries {
  const distances: number[] = Array.from(timeline.headDistanceM);
  const times: number[] = Array.from(timeline.timeSeconds);
  const values: number[] = [];
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i]!;
    const sample = sampleTrackAtDistance(track, d);
    values.push(sample.position[1]);
  }
  const finiteValues = values.filter((v) => Number.isFinite(v));
  const min = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const max = finiteValues.length > 0 ? Math.max(...finiteValues) : 1;
  return {
    metric: "height",
    label: "Height",
    unit: "m",
    values,
    distances,
    times,
    available: true,
    range: { min, max },
  };
}

export function getMetricSeries(
  metric: MetricId,
  track: CompiledTrackData,
  timeline: RideTimeline,
  clearanceM: Float64Array | null,
): TimelineSeries {
  if (metric === "height") return getHeightSeries(track, timeline);
  const timelineMetric = toTimelineMetricId(metric);
  return getTimelineSeries(timeline, timelineMetric, track, clearanceM);
}

function resampleToTrack(
  timelineDistances: readonly number[],
  timelineValues: readonly number[],
  trackDistances: ArrayLike<number>,
): Float64Array {
  const resampled = new Float64Array(trackDistances.length);
  let ti = 0;
  for (let i = 0; i < trackDistances.length; i++) {
    const d = trackDistances[i] as number;
    while (
      ti + 1 < timelineDistances.length &&
      (timelineDistances[ti + 1] as number) < d
    ) {
      ti++;
    }
    if (ti + 1 >= timelineDistances.length) {
      resampled[i] = timelineValues[timelineValues.length - 1] as number;
    } else if ((timelineDistances[ti] as number) === d) {
      resampled[i] = timelineValues[ti] as number;
    } else {
      const d0 = timelineDistances[ti] as number;
      const d1 = timelineDistances[ti + 1] as number;
      const v0 = timelineValues[ti] as number;
      const v1 = timelineValues[ti + 1] as number;
      const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0);
      resampled[i] = v0 + (v1 - v0) * t;
    }
  }
  return resampled;
}

export function deriveMetricData(
  metric: MetricId,
  result: AuthoritativeExperienceResult,
): MetricData | undefined {
  if (metric === "height") return undefined;
  const timelineMetric = toTimelineMetricId(metric);
  const series = getTimelineSeries(
    result.timeline,
    timelineMetric,
    result.track,
    result.clearanceM ?? null,
  );
  if (!series.available) return undefined;
  const resampled = resampleToTrack(
    series.distances,
    series.values,
    result.track.distances,
  );
  const data: MetricData = {};
  if (metric === "speed") data.speed = resampled;
  else if (metric === "gForce") data.gForce = resampled;
  else if (metric === "rollRate") data.rollRate = resampled;
  else if (metric === "clearance") data.clearance = resampled;
  else if (metric === "energy") data.energy = resampled;
  return data;
}

export function getSeatCarIndex(
  seatId: RideSelectionId,
  carCount: number,
): number {
  if (seatId === "front") return 0;
  if (seatId === "rear") return Math.max(0, carCount - 1);
  return Math.floor(Math.max(0, carCount - 1) / 2);
}

function extractPerCarValues(
  timeline: RideTimeline,
  carIndex: number,
  source: Float64Array,
): number[] | null {
  const expected = timeline.length * timeline.carCount;
  if (source.length !== expected) return null;
  const values: number[] = [];
  for (let i = 0; i < timeline.length; i++) {
    values.push(source[i * timeline.carCount + carIndex] as number);
  }
  return values;
}

export function getSeatMetricSeries(
  metric: MetricId,
  result: AuthoritativeExperienceResult,
  seatId: RideSelectionId,
): TimelineSeries {
  const timeline = result.timeline;
  const carCount = timeline.carCount;
  if (carCount === 0) {
    return getMetricSeries(
      metric,
      result.track,
      timeline,
      result.clearanceM ?? null,
    );
  }
  const carIndex = getSeatCarIndex(seatId, carCount);
  const distances = Array.from(timeline.headDistanceM);
  const times = Array.from(timeline.timeSeconds);
  if (metric === "rollRate") {
    const values = extractPerCarValues(
      timeline,
      carIndex,
      timeline.perCarRollRateRadPerSec,
    );
    if (!values) {
      return {
        metric: "rollRate",
        label: "Roll rate",
        unit: "rad/s",
        values: [],
        distances,
        times,
        available: false,
        reason: "per-car rollRate unavailable",
      };
    }
    let min = Infinity,
      max = -Infinity;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return {
      metric: "rollRate",
      label: "Roll rate",
      unit: "rad/s",
      values,
      distances,
      times,
      available: true,
      range: { min, max },
    };
  }
  if (metric === "gForce") {
    // signed vertical G per car (retain lateral/longitudinal in readout)
    const values = extractPerCarValues(
      timeline,
      carIndex,
      timeline.perCarVerticalG,
    );
    if (!values) {
      return {
        metric: "gForce",
        label: "G force",
        unit: "g",
        values: [],
        distances,
        times,
        available: false,
        reason: "per-car verticalG unavailable",
      };
    }
    let min = Infinity,
      max = -Infinity;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return {
      metric: "gForce",
      label: "G force",
      unit: "g",
      values,
      distances,
      times,
      available: true,
      range: { min, max },
    };
  }
  return getMetricSeries(
    metric,
    result.track,
    timeline,
    result.clearanceM ?? null,
  );
}

export function deriveSeatMetricData(
  metric: MetricId,
  result: AuthoritativeExperienceResult,
  seatId: RideSelectionId,
): MetricData | undefined {
  if (
    metric === "height" ||
    metric === "speed" ||
    metric === "clearance" ||
    metric === "energy"
  ) {
    // train-wide metrics remain authoritative from head/wall
    return deriveMetricData(metric, result);
  }
  const series = getSeatMetricSeries(metric, result, seatId);
  if (!series.available) return undefined;
  const resampled = resampleToTrack(
    series.distances,
    series.values,
    result.track.distances,
  );
  const data: MetricData = {};
  if (metric === "gForce") data.gForce = resampled;
  else if (metric === "rollRate") data.rollRate = resampled;
  return data;
}

export { toTimelineMetricId };
