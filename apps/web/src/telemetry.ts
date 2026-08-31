import type { CompiledTrackData } from "@openvibecoaster/core";
import { sampleTrackAtDistance } from "@openvibecoaster/core";
import type { RideTimeline } from "@openvibecoaster/simulator";
import type { Diagnostic } from "@openvibecoaster/core";

export type TimelineMetricId =
  | "speed"
  | "verticalG"
  | "lateralG"
  | "longitudinalG"
  | "jerk"
  | "rollRate"
  | "clearance"
  | "energyResidual"
  | "gForce";

export interface TimelineSeries {
  readonly metric: TimelineMetricId | "height";
  readonly label: string;
  readonly unit: string;
  readonly values: readonly number[];
  readonly distances: readonly number[];
  readonly times: readonly number[];
  readonly available: boolean;
  readonly reason?: string;
  readonly range?: { readonly min: number; readonly max: number };
}

export interface TimelineSelection {
  readonly index: number;
  readonly distanceM: number;
  readonly timeSeconds: number;
  // Canonical synchronized positions for track/train highlighting
  readonly trackPosition?: readonly [number, number, number];
  readonly trainFrontPosition?: readonly [number, number, number];
}

export interface GraphSelection {
  readonly index: number;
  readonly timeSeconds: number;
  readonly distanceM: number;
  readonly position: readonly [number, number, number];
}

export interface SeamInspectionState {
  readonly enabled: boolean;
  readonly boundaries: readonly number[]; // sample indices of element boundaries
  readonly seamDiagnostics: readonly Diagnostic[];
}

const metadata: Record<
  TimelineMetricId | "height",
  { label: string; unit: string }
> = {
  speed: { label: "Speed", unit: "m/s" },
  verticalG: { label: "Vertical G", unit: "g" },
  lateralG: { label: "Lateral G", unit: "g" },
  longitudinalG: { label: "Longitudinal G", unit: "g" },
  jerk: { label: "Jerk", unit: "m/s³" },
  rollRate: { label: "Roll rate", unit: "rad/s" },
  clearance: { label: "Clearance", unit: "m" },
  energyResidual: { label: "Energy residual", unit: "J" },
  gForce: { label: "G force", unit: "g" },
  height: { label: "Height", unit: "m" },
};

function copyArray(input: Float64Array): number[] {
  return Array.from(input);
}

function arraysFromTimeline(timeline: RideTimeline): {
  distances: number[];
  times: number[];
} {
  // Deep copy, never expose internal buffers
  return {
    distances: copyArray(timeline.headDistanceM),
    times: copyArray(timeline.timeSeconds),
  };
}

function unavailable(
  timeline: RideTimeline,
  metric: TimelineMetricId | "height",
  reason: string,
): TimelineSeries {
  const { distances, times } = arraysFromTimeline(timeline);
  return Object.freeze({
    metric,
    ...metadata[metric],
    values: Object.freeze([]) as readonly number[],
    distances: Object.freeze(distances) as readonly number[],
    times: Object.freeze(times) as readonly number[],
    available: false,
    reason,
  });
}

function finiteRange(
  values: readonly number[],
): { min: number; max: number } | undefined {
  if (values.length === 0) return undefined;
  let min = Infinity,
    max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) return undefined;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return { min, max };
}

function interpolateTrackBankDerivative(
  track: CompiledTrackData,
  distanceM: number,
): number {
  // Use authoritative sampleTrackAtDistance to get bankDerivative at exact distance
  const sample = sampleTrackAtDistance(track, distanceM);
  return sample.bankDerivative;
}

/**
 * Derives timeline series from authoritative CompiledTrackData and RideTimeline.
 * - Front/middle/rear forces are taken from timeline.frames telemetry where available.
 * - Roll rate uses timeline rollRateRadPerSec first; falls back to bankDerivative * signed speed with correct rad/s.
 *   Never uses bank angle itself.
 * - Jerk magnitude is derived from vector jerk (finite checked).
 * - Energy residual from frames.
 * - Clearance only when finite clearanceM evidence is supplied – never invented zero.
 * - Distance/time arrays are strictly aligned to authoritative timeline.
 */
export function getTimelineSeries(
  timeline: RideTimeline,
  metric: TimelineMetricId,
  track?: CompiledTrackData | null,
  clearanceM?: Float64Array | null,
): TimelineSeries {
  const { distances, times } = arraysFromTimeline(timeline);
  const length = timeline.length;
  // Reject non-finite or misaligned time/head-distance arrays truthfully (NaN/Infinity/empty/one-sample)
  if (length === 0) return unavailable(timeline, metric, "timeline is empty");
  if (length === 1)
    return unavailable(
      timeline,
      metric,
      "timeline requires at least two samples",
    );
  if (distances.length !== length || times.length !== length)
    return unavailable(
      timeline,
      metric,
      "time/head-distance arrays misaligned",
    );
  if (
    !distances.every((v) => Number.isFinite(v)) ||
    !times.every((v) => Number.isFinite(v))
  )
    return unavailable(
      timeline,
      metric,
      "time/head-distance arrays must be finite",
    );
  let values: number[] | null = null;
  let reason = "";

  switch (metric) {
    case "speed": {
      const speedMps = timeline.speedMps;
      if (speedMps.length === length) values = Array.from(speedMps);
      else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "verticalG": {
      const verticalG = timeline.verticalG;
      if (verticalG.length === length) values = Array.from(verticalG);
      else if (timeline.frames.length === length)
        values = timeline.frames.map((f) => f.telemetry.verticalG);
      else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "lateralG": {
      const lateralG = timeline.lateralG;
      if (lateralG.length === length) values = Array.from(lateralG);
      else if (timeline.frames.length === length)
        values = timeline.frames.map((f) => f.telemetry.lateralG);
      else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "longitudinalG": {
      const longitudinalG = timeline.longitudinalG;
      if (longitudinalG.length === length) values = Array.from(longitudinalG);
      else if (timeline.frames.length === length)
        values = timeline.frames.map((f) => f.telemetry.longitudinalG);
      else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "gForce": {
      // Magnitude of total G vector: derived from per-sample vertical/lateral/longitudinal if available
      const verticalG = timeline.verticalG;
      const lateralG = timeline.lateralG;
      const longitudinalG = timeline.longitudinalG;
      if (
        verticalG.length === length &&
        lateralG.length === length &&
        longitudinalG.length === length
      ) {
        values = [];
        for (let i = 0; i < length; i += 1) {
          const v = verticalG[i] ?? 0;
          const lat = lateralG[i] ?? 0;
          const long = longitudinalG[i] ?? 0;
          values.push(Math.hypot(v, lat, long));
        }
      } else if (timeline.frames.length === length) {
        values = timeline.frames.map((f) =>
          Math.hypot(
            f.telemetry.verticalG,
            f.telemetry.lateralG,
            f.telemetry.longitudinalG,
          ),
        );
      } else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "jerk": {
      const jerk = timeline.jerkMps3;
      if (jerk.length === length) {
        // scalar magnitude already
        values = Array.from(jerk);
      } else if (jerk.length === length * 3) {
        values = [];
        for (let i = 0; i < length; i += 1) {
          const off = i * 3;
          values.push(
            Math.hypot(jerk[off] ?? 0, jerk[off + 1] ?? 0, jerk[off + 2] ?? 0),
          );
        }
      } else if (timeline.frames.length === length) {
        values = timeline.frames.map((f) =>
          Math.hypot(...f.telemetry.jerkMps3),
        );
      } else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "rollRate": {
      // Authoritative: timeline frames rollRateRadPerSec if finite and length matches
      if (timeline.frames.length === length) {
        const candidate = timeline.frames.map(
          (f) => f.telemetry.rollRateRadPerSec,
        );
        if (candidate.every((v) => Number.isFinite(v))) values = candidate;
        else reason = "The authoritative timeline does not contain this series";
      }
      if (values === null && track) {
        // Fallback: bankDerivative (rad/m) * signed speed (m/s) = rad/s – correct units, not bank angle
        // Reuse distances snapshot from arraysFromTimeline to avoid per-sample defensive copy
        const speed = timeline.speedMps;
        if (speed.length === length) {
          const derived: number[] = [];
          for (let i = 0; i < length; i += 1) {
            const s = speed[i]!;
            const distance = distances[i] ?? 0;
            const derivative = interpolateTrackBankDerivative(track, distance);
            if (!Number.isFinite(derivative) || !Number.isFinite(s)) {
              derived.length = 0;
              break;
            }
            derived.push(derivative * s);
          }
          if (derived.length === length && derived.every(Number.isFinite))
            values = derived;
          else
            reason = "The authoritative timeline does not contain this series";
        } else
          reason = "The authoritative timeline does not contain this series";
      }
      if (values === null && reason === "")
        reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "energyResidual": {
      if (timeline.frames.length === length) {
        const candidate = timeline.frames.map((f) => f.telemetry.energyErrorJ);
        if (candidate.every((v) => Number.isFinite(v))) values = candidate;
        else reason = "The authoritative timeline does not contain this series";
      } else reason = "The authoritative timeline does not contain this series";
      break;
    }
    case "clearance": {
      // Never invent zero; only when actual clearance evidence supplied and finite + correct length + aligned
      if (
        clearanceM &&
        clearanceM.length === length &&
        Array.from(clearanceM).every((v) => Number.isFinite(v))
      ) {
        values = Array.from(clearanceM);
      } else {
        return unavailable(
          timeline,
          metric,
          "No authoritative clearance series was supplied",
        );
      }
      break;
    }
  }

  if (!values || values.length !== length) {
    return unavailable(
      timeline,
      metric,
      reason || "The authoritative timeline does not contain this series",
    );
  }
  // Validate finite and alignment
  if (!values.every((v) => Number.isFinite(v))) {
    return unavailable(
      timeline,
      metric,
      "The authoritative timeline does not contain this series",
    );
  }
  if (distances.length !== length || times.length !== length) {
    return unavailable(
      timeline,
      metric,
      "The authoritative timeline does not contain this series",
    );
  }
  const range = finiteRange(values);
  // Range must be finite for available series; if not finite, treat as unavailable (no silent misalign)
  if (!range)
    return unavailable(
      timeline,
      metric,
      "The authoritative timeline does not contain this series",
    );

  return Object.freeze({
    metric,
    ...metadata[metric],
    values: Object.freeze([...values]),
    distances: Object.freeze([...distances]),
    times: Object.freeze([...times]),
    available: true,
    range: Object.freeze(range),
  });
}

// Synchronized graph selection – canonical index/time/distance/position alignment
export function getTimelineSelection(
  timeline: RideTimeline,
  index: number,
  track?: CompiledTrackData | null,
): TimelineSelection | null {
  if (timeline.length === 0) return null;
  const safeIndex = Math.max(
    0,
    Math.min(timeline.length - 1, Math.trunc(index)),
  );
  const distanceM = timeline.headDistanceM[safeIndex] ?? 0;
  const timeSeconds = timeline.timeSeconds[safeIndex] ?? 0;
  if (!Number.isFinite(distanceM) || !Number.isFinite(timeSeconds)) return null;
  let trackPosition: readonly [number, number, number] | undefined;
  let trainFrontPosition: readonly [number, number, number] | undefined;
  if (track) {
    try {
      const sample = sampleTrackAtDistance(track, distanceM);
      trackPosition = Object.freeze([...sample.position] as [
        number,
        number,
        number,
      ]);
      // train front position is same as track position at head distance (authoritative path)
      trainFrontPosition = trackPosition;
    } catch {
      // keep undefined if sampling fails – do not fabricate
    }
  } else if (timeline.frames.length > safeIndex) {
    const frame = timeline.frames[safeIndex];
    if (frame) {
      trackPosition = Object.freeze([...frame.cars[0]!.position] as [
        number,
        number,
        number,
      ]);
      trainFrontPosition = trackPosition;
    }
  }
  return Object.freeze({
    index: safeIndex,
    distanceM,
    timeSeconds,
    ...(trackPosition ? { trackPosition } : {}),
    ...(trainFrontPosition ? { trainFrontPosition } : {}),
  });
}

export function moveTimelineSelection(
  timeline: RideTimeline,
  index: number,
  key: string,
): number {
  if (timeline.length === 0) return 0;
  if (key === "Home") return 0;
  if (key === "End") return timeline.length - 1;
  if (key === "ArrowLeft" || key === "ArrowDown") {
    return Math.max(0, Math.min(timeline.length - 1, Math.trunc(index) - 1));
  }
  if (key === "ArrowRight" || key === "ArrowUp") {
    return Math.max(0, Math.min(timeline.length - 1, Math.trunc(index) + 1));
  }
  return Math.max(0, Math.min(timeline.length - 1, Math.trunc(index)));
}

export function indexAtGraphPosition(
  timeline: RideTimeline,
  x: number,
  width: number,
): number {
  if (timeline.length === 0 || width <= 0) return 0;
  if (!Number.isFinite(x) || !Number.isFinite(width)) return 0;
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.round(ratio * (timeline.length - 1));
}

/**
 * Graph highlight position – synchronized index/sample/path position for track/train highlighting.
 */
export function getGraphSelection(
  timeline: RideTimeline,
  track: CompiledTrackData | null,
  x: number,
  width: number,
): GraphSelection | null {
  if (timeline.length === 0 || !track) return null;
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return null;
  const index = indexAtGraphPosition(timeline, x, width);
  const distanceM = timeline.headDistanceM[index] ?? 0;
  const timeSeconds = timeline.timeSeconds[index] ?? 0;
  if (!Number.isFinite(distanceM) || !Number.isFinite(timeSeconds)) return null;
  const sample = sampleTrackAtDistance(track, distanceM);
  return Object.freeze({
    index,
    timeSeconds,
    distanceM,
    position: Object.freeze([...sample.position] as [number, number, number]),
  });
}

/**
 * Metric-color data for renderer highlighting (speed/G/roll-rate/clearance).
 * Explicit unavailable state, finite ranges, stable sample mapping.
 */
export function getMetricColorData(
  timeline: RideTimeline,
  track: CompiledTrackData | null,
  metric: TimelineMetricId,
  clearanceM?: Float64Array | null,
): {
  readonly available: boolean;
  readonly values: readonly number[];
  readonly range: { readonly min: number; readonly max: number } | null;
  readonly reason?: string;
} {
  const series = getTimelineSeries(timeline, metric, track, clearanceM ?? null);
  if (!series.available) {
    return Object.freeze({
      available: false as const,
      values: Object.freeze([]),
      range: null,
      ...(series.reason ? { reason: series.reason } : {}),
    });
  }
  // Stable sample mapping: values aligned to timeline samples
  const values = series.values;
  const range =
    series.range ?? finiteRange(values as readonly number[]) ?? null;
  if (!range)
    return Object.freeze({
      available: false as const,
      values: Object.freeze([]),
      range: null,
      reason: "Metric range is not finite",
    });
  return Object.freeze({
    available: true as const,
    values: Object.freeze([...values]),
    range: Object.freeze(range),
  });
}

/**
 * Seam inspection uses compiled boundaries and analytic diagnostic evidence.
 * Toggle state is honored – when disabled, returns empty boundaries/diagnostics.
 * When enabled and an explicit semantic seam set is supplied, that set is
 * authoritative (validated against the canonical compiled boundary set);
 * otherwise falls back to all canonical compiled boundaries.
 */
export function getSeamInspection(
  track: CompiledTrackData | null,
  diagnostics: readonly Diagnostic[],
  enabled: boolean,
  semanticSeamIndices?: readonly number[],
): SeamInspectionState {
  if (!enabled || !track) {
    return Object.freeze({
      enabled: false,
      boundaries: Object.freeze([]),
      seamDiagnostics: Object.freeze([]),
    });
  }
  const canonicalSet = new Set<number>(Array.from(track.elementBoundaries));
  let boundaries: readonly number[];
  if (semanticSeamIndices && semanticSeamIndices.length > 0) {
    const validated = semanticSeamIndices.filter(
      (idx) => Number.isInteger(idx) && canonicalSet.has(idx),
    );
    boundaries = Object.freeze([...validated]);
  } else if (semanticSeamIndices && semanticSeamIndices.length === 0) {
    boundaries = Object.freeze([]);
  } else {
    boundaries = Object.freeze(Array.from(track.elementBoundaries));
  }
  const distances = track.distances;
  const boundaryDistances = boundaries.map((idx) =>
    Number.isFinite(distances[idx]!) ? distances[idx]! : Number.NaN,
  );
  const seamDiagnostics = Object.freeze(
    diagnostics.filter((d) => {
      const codeSeam =
        typeof d.code === "string" && /SEAM|CONTINUITY/i.test(d.code);
      const msgSeam =
        typeof d.message === "string" && /seam|continuity/i.test(d.message);
      if (codeSeam || msgSeam) return true;
      if (d.location && Number.isFinite(d.location.s)) {
        const s = d.location.s!;
        return boundaryDistances.some(
          (bd) => Number.isFinite(bd) && Math.abs(s - bd) <= 5,
        );
      }
      return false;
    }),
  );
  return Object.freeze({ enabled: true, boundaries, seamDiagnostics });
}

export function drawTimelineGraph(
  canvas: HTMLCanvasElement,
  series: TimelineSeries,
  selectedIndex: number | null,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (!series.available || series.values.length < 2) return;
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    const y = (height / 4) * row;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  const range = series.range ?? finiteRange(series.values);
  if (!range) return;
  const min = range.min;
  const max = range.max;
  const span = Math.max(max - min, 1e-9);
  const metricColors: Record<TimelineMetricId | "height", string> = {
    speed: "#6ea1ff",
    verticalG: "#ff6e6e",
    lateralG: "#6eff8a",
    longitudinalG: "#ffde6e",
    jerk: "#d36eff",
    rollRate: "#6efff2",
    clearance: "#ff9f6e",
    energyResidual: "#8aff6e",
    gForce: "#ff6eb5",
    height: "#ff8a65",
  };
  context.strokeStyle = metricColors[series.metric] ?? "#6ea1ff";
  context.lineWidth = 2;
  context.beginPath();
  series.values.forEach((value, index) => {
    const x = (index / (series.values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) - 4;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  if (
    selectedIndex !== null &&
    Number.isFinite(selectedIndex) &&
    selectedIndex >= 0
  ) {
    const clamped = Math.min(selectedIndex, series.values.length - 1);
    const x = (clamped / (series.values.length - 1)) * width;
    context.strokeStyle = "#f0b429";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
}
