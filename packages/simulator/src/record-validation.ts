import type {
  CoasterFileV1,
  CompiledTrackData,
  Diagnostic,
  RecordTargetProfile,
  Vec3,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "./operation-zones.js";
import type { RideTimeline } from "./timeline.js";

export type RecordElementKind =
  | "topHat"
  | "immelmann"
  | "verticalLoop"
  | "diveDrop";

export interface LocalHeightMeasurement {
  readonly deltaM: number;
  readonly maxY: number;
  readonly minY: number;
  readonly s: number;
  readonly relatedIds: string[];
}

function semanticOwner(spanId: string): string {
  return spanId.replace(/#\d+$/, "");
}

function elementKind(file: CoasterFileV1, owner: string): string | undefined {
  const element = file.intent.elements.find(({ id }) => id === owner);
  return element ? (element.kind ?? element.type) : undefined;
}

export function localHeightForKind(
  track: CompiledTrackData,
  file: CoasterFileV1,
  kind: RecordElementKind,
): LocalHeightMeasurement {
  const positions = track.positions;
  const distances = track.distances;
  const boundaries = track.elementBoundaries;
  let maxY = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let summitIndex = 0;
  const relatedIds: string[] = [];

  for (let spanIndex = 0; spanIndex < file.solvedSpans.length; spanIndex += 1) {
    const span = file.solvedSpans[spanIndex]!;
    const owner = semanticOwner(span.id);
    if (elementKind(file, owner) !== kind) continue;
    if (!relatedIds.includes(owner)) relatedIds.push(owner);
    const start = boundaries[spanIndex * 2];
    const end = boundaries[spanIndex * 2 + 1];
    if (start === undefined || end === undefined) continue;
    for (let sampleIndex = start; sampleIndex <= end; sampleIndex += 1) {
      const y = positions[sampleIndex * 3 + 1];
      if (y === undefined) continue;
      if (y > maxY) {
        maxY = y;
        summitIndex = sampleIndex;
      }
      if (y < minY) minY = y;
    }
  }

  return {
    deltaM: maxY - minY,
    maxY,
    minY,
    s: distances[summitIndex] ?? 0,
    relatedIds,
  };
}

export function summitHoldWindow(
  file: CoasterFileV1,
  trainFootprintM = 18.5,
): { centerS: number; toleranceM: number } {
  if (!Number.isFinite(trainFootprintM) || trainFootprintM < 0)
    throw new RangeError("trainFootprintM must be finite and non-negative");
  const zone = operationZonesFromCoasterFile(file).find(
    ({ id }) => id === "brake-007",
  );
  if (!zone) throw new RangeError("Missing brake-007 summit hold zone");
  return {
    centerS: (zone.startDistanceM + zone.endDistanceM) / 2,
    toleranceM:
      (zone.endDistanceM - zone.startDistanceM) / 2 + trainFootprintM,
  };
}

interface HoldProof {
  readonly holdSeconds: number;
  readonly holdLocationS: number;
}

function positionAt(track: CompiledTrackData, index: number): Vec3 {
  const positions = track.positions;
  return [
    positions[index * 3] ?? 0,
    positions[index * 3 + 1] ?? 0,
    positions[index * 3 + 2] ?? 0,
  ];
}

function extremum(values: Float64Array, mode: "min" | "max"): number {
  if (values.length === 0) return 0;
  let result = values[0]!;
  for (let index = 1; index < values.length; index += 1)
    result = mode === "min" ? Math.min(result, values[index]!) : Math.max(result, values[index]!);
  return result;
}

function maximumMagnitude(values: Float64Array): number {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}

function rangeDiagnostic(
  code: string,
  actual: number,
  range: readonly [number, number],
  s: number,
  position: Vec3,
  relatedIds: readonly string[],
): Diagnostic | undefined {
  if (actual >= range[0] && actual <= range[1]) return undefined;
  const limit = actual < range[0] ? range[0] : range[1];
  return {
    code,
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message: `${code} measured ${actual} outside [${range[0]}, ${range[1]}]`,
    actual,
    limit,
    margin: actual < range[0] ? actual - range[0] : range[1] - actual,
    location: { s, position },
    relatedIds,
  };
}

function upperDiagnostic(
  code: string,
  actual: number,
  limit: number,
  relatedIds: readonly string[],
): Diagnostic | undefined {
  if (actual <= limit) return undefined;
  return {
    code,
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message: `${code} measured ${actual} above ${limit}`,
    actual,
    limit,
    margin: limit - actual,
    location: { s: 0, position: [0, 0, 0] },
    relatedIds,
  };
}

function measuredDiveAngle(
  track: CompiledTrackData,
  file: CoasterFileV1,
): { angleDeg: number; s: number; position: Vec3; relatedIds: string[] } | undefined {
  const boundaries = track.elementBoundaries;
  const parameters = track.parameters;
  const tangents = track.tangents;
  const distances = track.distances;
  const matching: number[] = [];
  const relatedIds: string[] = [];
  for (let index = 0; index < file.solvedSpans.length; index += 1) {
    const owner = semanticOwner(file.solvedSpans[index]!.id);
    if (elementKind(file, owner) !== "diveDrop") continue;
    matching.push(index);
    if (!relatedIds.includes(owner)) relatedIds.push(owner);
  }
  if (matching.length === 0) return undefined;
  const middleSpan = matching[Math.floor(matching.length / 2)]!;
  const start = boundaries[middleSpan * 2];
  const end = boundaries[middleSpan * 2 + 1];
  if (start === undefined || end === undefined) return undefined;
  let sampleIndex = start;
  let parameterError = Number.POSITIVE_INFINITY;
  for (let index = start; index <= end; index += 1) {
    const error = Math.abs((parameters[index] ?? 0) - 0.5);
    if (error < parameterError) {
      parameterError = error;
      sampleIndex = index;
    }
  }
  const x = tangents[sampleIndex * 3] ?? 0;
  const y = tangents[sampleIndex * 3 + 1] ?? 0;
  const z = tangents[sampleIndex * 3 + 2] ?? 0;
  const pitchDeg = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
  return {
    angleDeg: 180 + pitchDeg,
    s: distances[sampleIndex] ?? 0,
    position: positionAt(track, sampleIndex),
    relatedIds,
  };
}

function measureHold(
  timeline: RideTimeline,
  file: CoasterFileV1,
): HoldProof {
  const { centerS, toleranceM } = summitHoldWindow(file);
  const speeds = timeline.speedMps;
  const distances = timeline.headDistanceM;
  let run = 0;
  let best = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const inWindow = Math.abs((distances[index] ?? 0) - centerS) <= toleranceM;
    run = Math.abs(speeds[index] ?? 0) <= 0.05 && inWindow ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { holdSeconds: best / timeline.sampleRateHz, holdLocationS: centerS };
}

export function validateRecordTargets(
  track: CompiledTrackData,
  timeline: RideTimeline,
  file: CoasterFileV1,
  profile: RecordTargetProfile,
  holdProof?: HoldProof,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const allIds = file.intent.elements.map(({ id }) => id);
  const positions = track.positions;
  let maximumHeight = Number.NEGATIVE_INFINITY;
  let maximumHeightIndex = 0;
  for (let index = 0; index < positions.length / 3; index += 1) {
    const y = positions[index * 3 + 1]!;
    if (y > maximumHeight) {
      maximumHeight = y;
      maximumHeightIndex = index;
    }
  }
  const globalPosition = positionAt(track, maximumHeightIndex);
  const globalS = track.distances[maximumHeightIndex] ?? 0;
  const add = (diagnostic: Diagnostic | undefined): void => {
    if (diagnostic) diagnostics.push(diagnostic);
  };

  add(rangeDiagnostic("RECORD_LENGTH", track.totalLength, profile.totalLengthM, 0, positionAt(track, 0), allIds));
  add(rangeDiagnostic("RECORD_HEIGHT", maximumHeight, profile.maxHeightM, globalS, globalPosition, allIds));
  add(rangeDiagnostic("RECORD_SPEED", extremum(timeline.speedMps, "max"), [profile.maxSpeedKmh[0] / 3.6, profile.maxSpeedKmh[1] / 3.6], 0, positionAt(track, 0), allIds));

  const heightTargets: readonly [RecordElementKind, string, readonly [number, number]][] = [
    ["topHat", "RECORD_INVERSION", profile.invertedTopHatM],
    ["immelmann", "RECORD_IMMELMANN", profile.immelmannM],
    ["verticalLoop", "RECORD_LOOP", profile.verticalLoopM],
    ["diveDrop", "RECORD_DIVE_HEIGHT", [profile.diveDrop.heightM - profile.diveDrop.toleranceM, profile.diveDrop.heightM + profile.diveDrop.toleranceM]],
  ];
  for (const [kind, code, range] of heightTargets) {
    const measurement = localHeightForKind(track, file, kind);
    if (measurement.relatedIds.length === 0) continue;
    add(rangeDiagnostic(code, measurement.deltaM, range, measurement.s, positionAt(track, 0), measurement.relatedIds));
  }

  const dive = measuredDiveAngle(track, file);
  if (dive)
    add(rangeDiagnostic("RECORD_DIVE_ANGLE", dive.angleDeg, [profile.diveDrop.angleDeg - profile.diveDrop.toleranceDeg, profile.diveDrop.angleDeg + profile.diveDrop.toleranceDeg], dive.s, dive.position, dive.relatedIds));

  add(rangeDiagnostic("RECORD_FORCE_PEAK_POS", extremum(timeline.verticalG, "max"), profile.force.verticalPeakG, 0, positionAt(track, 0), allIds));
  const minimumVerticalG = extremum(timeline.verticalG, "min");
  if (minimumVerticalG > -1) {
    diagnostics.push({
      code: "RECORD_FORCE_NEG",
      severity: "error",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message: "Negative-G target was not achieved",
      actual: minimumVerticalG,
      limit: -1,
      margin: minimumVerticalG + 1,
      location: { s: 0, position: positionAt(track, 0) },
      relatedIds: allIds,
    });
  } else if (minimumVerticalG < -1.2) {
    diagnostics.push({
      code: "RECORD_FORCE_NEG",
      severity: "error",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message: "Negative-G project floor was breached",
      actual: minimumVerticalG,
      limit: -1.2,
      margin: minimumVerticalG + 1.2,
      location: { s: 0, position: positionAt(track, 0) },
      relatedIds: allIds,
    });
  }
  add(upperDiagnostic("RECORD_FORCE_LAT", maximumMagnitude(timeline.lateralG), profile.force.lateralMaxG, allIds));
  add(upperDiagnostic("RECORD_FORCE_LONG", maximumMagnitude(timeline.longitudinalG), profile.force.longitudinalMaxG, allIds));
  add(upperDiagnostic("RECORD_JERK", maximumMagnitude(timeline.jerkMps3), profile.force.jerkMps3, allIds));
  add(upperDiagnostic("RECORD_ROLL", maximumMagnitude(timeline.rollRateRadPerSec), profile.force.rollRateRadPerSec, allIds));

  const hold = holdProof ?? measureHold(timeline, file);
  if (hold.holdSeconds < profile.holdSeconds)
    diagnostics.push({
      code: "HOLD_DURATION",
      severity: "error",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message: "Summit hold duration is below the project target",
      actual: hold.holdSeconds,
      limit: profile.holdSeconds,
      margin: hold.holdSeconds - profile.holdSeconds,
      location: { s: hold.holdLocationS, position: positionAt(track, 0) },
      relatedIds: ["brake-007"],
    });

  const launchActivity = timeline.launchActivity;
  const launchSamples = Array.from(launchActivity).filter((value) => value > 0).length;
  const availableDriveWork = (launchSamples / timeline.sampleRateHz) * 7.2e6;
  const driveWork = timeline.accumulatedDriveWorkJ[timeline.length - 1] ?? 0;
  if (launchSamples > 0)
    add(upperDiagnostic("ENERGY_LSM_REQUIRED_WORK", driveWork, availableDriveWork, allIds));

  const terminalSpeed = Math.abs(timeline.speedMps[timeline.length - 1] ?? 0);
  add(upperDiagnostic("BRAKE_MARGIN", terminalSpeed, 0.2, ["brake-018"]));
  return Object.freeze(diagnostics);
}
