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
  const trackDistances = result.track.distances;
  const timelineDistances = series.distances;
  const timelineValues = series.values;
  const resampled = new Float64Array(trackDistances.length);
  let ti = 0;
  for (let i = 0; i < trackDistances.length; i++) {
    const d = trackDistances[i]!;
    while (
      ti + 1 < timelineDistances.length &&
      timelineDistances[ti + 1]! < d
    ) {
      ti++;
    }
    if (ti + 1 >= timelineDistances.length) {
      resampled[i] = timelineValues[timelineValues.length - 1]!;
    } else if (timelineDistances[ti]! === d) {
      resampled[i] = timelineValues[ti]!;
    } else {
      const d0 = timelineDistances[ti]!;
      const d1 = timelineDistances[ti + 1]!;
      const v0 = timelineValues[ti]!;
      const v1 = timelineValues[ti + 1]!;
      const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0);
      resampled[i] = v0 + (v1 - v0) * t;
    }
  }
  const data: MetricData = {};
  if (metric === "speed") data.speed = resampled;
  else if (metric === "gForce") data.gForce = resampled;
  else if (metric === "rollRate") data.rollRate = resampled;
  else if (metric === "clearance") data.clearance = resampled;
  else if (metric === "energy") data.energy = resampled;
  return data;
}

export { toTimelineMetricId };
