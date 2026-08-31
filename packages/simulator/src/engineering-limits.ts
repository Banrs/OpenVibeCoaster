import type {
  CompiledTrackData,
  Diagnostic,
  Vec3,
} from "@openvibecoaster/core";
import type { RideTimeline } from "./timeline";

export interface ProjectEngineeringLimits {
  readonly profileId: string;
  readonly provenance: "PROJECT_ENGINEERING_LIMIT";
  readonly verticalG: { readonly minimum: number; readonly maximum: number };
  readonly maximumAbsoluteLateralG: number;
  readonly maximumAbsoluteLongitudinalG: number;
  readonly maximumJerkMps3: number;
  readonly maximumRollRateRadPerSecond: number;
  readonly clearanceMarginM?: number;
}

export const defaultProjectEngineeringLimits: ProjectEngineeringLimits = {
  profileId: "project-engineering-limits-v1",
  provenance: "PROJECT_ENGINEERING_LIMIT",
  verticalG: { minimum: -1.2, maximum: 5.0 },
  maximumAbsoluteLateralG: 1.5,
  maximumAbsoluteLongitudinalG: 1.5,
  maximumJerkMps3: 15,
  maximumRollRateRadPerSecond: 1.5,
  clearanceMarginM: 0.5,
};

type Candidate = {
  readonly actual: number;
  readonly metricAbs?: number | undefined;
  readonly timeSeconds: number;
  readonly s: number;
  readonly position: Vec3;
  readonly carIndex?: number | undefined;
  readonly elementIndex?: number | undefined;
};

const finite = (v: number): boolean => Number.isFinite(v);

function vec3FromArray(arr: Float64Array, base: number): Vec3 | undefined {
  if (base + 2 >= arr.length) return undefined;
  const x = arr[base]!;
  const y = arr[base + 1]!;
  const z = arr[base + 2]!;
  if (!finite(x) || !finite(y) || !finite(z)) return undefined;
  return [x, y, z] as Vec3;
}

function elementIndexForS(
  track: CompiledTrackData | undefined,
  s: number,
): number | undefined {
  if (!track || !finite(s)) return undefined;
  const distances = track.distances;
  const indices = track.elementIndices;
  if (distances.length === 0 || indices.length === 0) return undefined;
  if (distances.length !== indices.length) return undefined;
  // binary search for largest distance <= s, fallback to nearest
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (distances[mid]! <= s) low = mid;
    else high = mid - 1;
  }
  // low is index where distances[low] <= s < distances[low+1] or last
  // Choose closest sample for element
  let bestIdx = low;
  if (low + 1 < distances.length) {
    const d0 = Math.abs(distances[low]! - s);
    const d1 = Math.abs(distances[low + 1]! - s);
    if (d1 < d0) bestIdx = low + 1;
  }
  const el = indices[bestIdx];
  return Number.isInteger(el) ? el : undefined;
}

function makeDiagnostic(
  code: string,
  message: string,
  actual: number,
  limit: number,
  margin: number,
  location: { readonly s: number; readonly position?: Vec3 },
  relatedIds?: readonly string[],
): Diagnostic {
  const loc: Diagnostic["location"] =
    location.position !== undefined
      ? { s: location.s, position: location.position }
      : { s: location.s };
  return {
    code,
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    actual,
    limit,
    margin,
    location: loc,
    ...(relatedIds && relatedIds.length > 0 ? { relatedIds } : {}),
  };
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : String(v);
}

export function validateEngineeringLimits(
  timeline: RideTimeline,
  track: CompiledTrackData | undefined,
  profile: ProjectEngineeringLimits,
): readonly Diagnostic[] {
  // validate profile finiteness – if invalid, produce fatal uncertified
  const verticalMin = profile.verticalG.minimum;
  const verticalMax = profile.verticalG.maximum;
  const maxLat = profile.maximumAbsoluteLateralG;
  const maxLong = profile.maximumAbsoluteLongitudinalG;
  const maxJerk = profile.maximumJerkMps3;
  const maxRoll = profile.maximumRollRateRadPerSecond;
  const profileNumbers = [
    verticalMin,
    verticalMax,
    maxLat,
    maxLong,
    maxJerk,
    maxRoll,
  ];
  for (const n of profileNumbers) {
    if (!finite(n)) {
      return [
        {
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: "Engineering limits profile contains non-finite value",
          actual: n,
          limit: n,
          margin: 0,
        },
      ];
    }
  }
  if (verticalMin > verticalMax) {
    return [
      {
        code: "ENGINEERING_LIMITS_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: "Engineering limits profile vertical minimum exceeds maximum",
        actual: verticalMin,
        limit: verticalMax,
        margin: verticalMax - verticalMin,
      },
    ];
  }
  const length = timeline.length;
  if (length === 0) {
    return [
      {
        code: "ENGINEERING_LIMITS_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message:
          "Timeline is empty – cannot validate engineering limits against authoritative series",
        actual: 0,
        limit: 0,
        margin: 0,
      },
    ];
  }
  const carCount = timeline.carCount;
  const timeSeconds = timeline.timeSeconds;
  const headDistanceM = timeline.headDistanceM;
  const carPositionsXYZ = timeline.carPositionsXYZ;

  // ride level arrays
  const rideVert = timeline.verticalG;
  const rideLat = timeline.lateralG;
  const rideLong = timeline.longitudinalG;
  const rideJerk = timeline.jerkMps3;
  const rideRoll = timeline.rollRateRadPerSec;

  // per-car arrays
  const perVert = timeline.perCarVerticalG;
  const perLat = timeline.perCarLateralG;
  const perLong = timeline.perCarLongitudinalG;
  const perRoll = timeline.perCarRollRateRadPerSec;
  const perJerk = timeline.perCarJerkXYZ;

  const hasRideVert = rideVert.length === length;
  const hasRideLat = rideLat.length === length;
  const hasRideLong = rideLong.length === length;
  const hasRideJerk = rideJerk.length === length * 3;
  const hasRideRoll = rideRoll.length === length;

  const hasPerVert = carCount > 0 && perVert.length === length * carCount;
  const hasPerLat = carCount > 0 && perLat.length === length * carCount;
  const hasPerLong = carCount > 0 && perLong.length === length * carCount;
  const hasPerRoll = carCount > 0 && perRoll.length === length * carCount;
  const hasPerJerk = carCount > 0 && perJerk.length === length * carCount * 3;
  const hasCarPos =
    carCount > 0 && carPositionsXYZ.length === length * carCount * 3;

  // If no authoritative data for any category, we still need to report missing,
  // but spec says do not fabricate – so if both ride and per-car missing for a metric,
  // we report uncertified for that metric rather than silently passing.
  const diagnostics: Diagnostic[] = [];

  // Helper to get position for a given time index and optional car
  const positionFor = (
    timeIdx: number,
    carIdx: number | undefined,
  ): Vec3 | undefined => {
    if (hasCarPos && carIdx !== undefined && carIdx >= 0 && carIdx < carCount) {
      const base = (timeIdx * carCount + carIdx) * 3;
      return vec3FromArray(carPositionsXYZ, base);
    }
    if (hasCarPos && carCount > 0) {
      const base = timeIdx * carCount * 3;
      return vec3FromArray(carPositionsXYZ, base);
    }
    return undefined;
  };

  let worstVertMax: Candidate | undefined;
  let worstVertMin: Candidate | undefined;
  let worstLat: Candidate | undefined;
  let worstLong: Candidate | undefined;
  let worstJerk: Candidate | undefined;
  let worstRoll: Candidate | undefined;

  // Scan timeline in deterministic order: time ascending, car ascending (0 = front)
  for (let i = 0; i < length; i += 1) {
    const t = timeSeconds[i]!;
    const s = headDistanceM[i]!;
    if (!finite(t) || !finite(s)) {
      diagnostics.push({
        code: "ENGINEERING_LIMITS_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Timeline time/s at index ${i} is non-finite – cannot validate limits`,
        actual: t,
        limit: s,
        margin: 0,
        location: { s: finite(s) ? s : 0 },
      });
      // continue but don't use this sample for worst
      continue;
    }
    const elementIndex = elementIndexForS(track, s);

    // ride-level checks
    if (hasRideVert) {
      const v = rideVert[i]!;
      if (!finite(v)) {
        diagnostics.push({
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Ride verticalG at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
          actual: v,
          limit: verticalMax,
          margin: 0,
          location: {
            s,
            ...(positionFor(i, undefined)
              ? { position: positionFor(i, undefined)! }
              : {}),
          },
        });
      } else {
        if (v > verticalMax) {
          if (
            worstVertMax === undefined ||
            v > worstVertMax.actual ||
            (v === worstVertMax.actual &&
              (t < worstVertMax.timeSeconds ||
                (t === worstVertMax.timeSeconds &&
                  0 < (worstVertMax.carIndex ?? Infinity))))
          ) {
            worstVertMax = {
              actual: v,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
        if (v < verticalMin) {
          if (
            worstVertMin === undefined ||
            v < worstVertMin.actual ||
            (v === worstVertMin.actual &&
              (t < worstVertMin.timeSeconds ||
                (t === worstVertMin.timeSeconds &&
                  0 < (worstVertMin.carIndex ?? Infinity))))
          ) {
            worstVertMin = {
              actual: v,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
      }
    }
    if (hasRideLat) {
      const v = rideLat[i]!;
      if (!finite(v)) {
        diagnostics.push({
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Ride lateralG at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
          actual: v,
          limit: maxLat,
          margin: 0,
          location: {
            s,
            ...(positionFor(i, undefined)
              ? { position: positionFor(i, undefined)! }
              : {}),
          },
        });
      } else {
        const abs = Math.abs(v);
        if (abs > maxLat) {
          if (
            worstLat === undefined ||
            abs > (worstLat.metricAbs ?? -Infinity) ||
            (abs === worstLat.metricAbs &&
              (t < worstLat.timeSeconds ||
                (t === worstLat.timeSeconds &&
                  0 < (worstLat.carIndex ?? Infinity))))
          ) {
            worstLat = {
              actual: v,
              metricAbs: abs,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
      }
    }
    if (hasRideLong) {
      const v = rideLong[i]!;
      if (!finite(v)) {
        diagnostics.push({
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Ride longitudinalG at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
          actual: v,
          limit: maxLong,
          margin: 0,
          location: {
            s,
            ...(positionFor(i, undefined)
              ? { position: positionFor(i, undefined)! }
              : {}),
          },
        });
      } else {
        const abs = Math.abs(v);
        if (abs > maxLong) {
          if (
            worstLong === undefined ||
            abs > (worstLong.metricAbs ?? -Infinity) ||
            (abs === worstLong.metricAbs &&
              (t < worstLong.timeSeconds ||
                (t === worstLong.timeSeconds &&
                  0 < (worstLong.carIndex ?? Infinity))))
          ) {
            worstLong = {
              actual: v,
              metricAbs: abs,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
      }
    }
    if (hasRideJerk) {
      const x = rideJerk[i * 3]!;
      const y = rideJerk[i * 3 + 1]!;
      const z = rideJerk[i * 3 + 2]!;
      if (!finite(x) || !finite(y) || !finite(z)) {
        diagnostics.push({
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Ride jerk at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
          actual: x,
          limit: maxJerk,
          margin: 0,
          location: {
            s,
            ...(positionFor(i, undefined)
              ? { position: positionFor(i, undefined)! }
              : {}),
          },
        });
      } else {
        const mag = Math.hypot(x, y, z);
        if (mag > maxJerk) {
          if (
            worstJerk === undefined ||
            mag > (worstJerk.metricAbs ?? -Infinity) ||
            (mag === worstJerk.metricAbs &&
              (t < worstJerk.timeSeconds ||
                (t === worstJerk.timeSeconds &&
                  0 < (worstJerk.carIndex ?? Infinity))))
          ) {
            worstJerk = {
              actual: mag,
              metricAbs: mag,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
      }
    }
    if (hasRideRoll) {
      const v = rideRoll[i]!;
      if (!finite(v)) {
        diagnostics.push({
          code: "ENGINEERING_LIMITS_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Ride roll rate at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
          actual: v,
          limit: maxRoll,
          margin: 0,
          location: {
            s,
            ...(positionFor(i, undefined)
              ? { position: positionFor(i, undefined)! }
              : {}),
          },
        });
      } else {
        const abs = Math.abs(v);
        if (abs > maxRoll) {
          if (
            worstRoll === undefined ||
            abs > (worstRoll.metricAbs ?? -Infinity) ||
            (abs === worstRoll.metricAbs &&
              (t < worstRoll.timeSeconds ||
                (t === worstRoll.timeSeconds &&
                  0 < (worstRoll.carIndex ?? Infinity))))
          ) {
            worstRoll = {
              actual: v,
              metricAbs: abs,
              timeSeconds: t,
              s,
              position: positionFor(i, undefined) ?? [0, 0, 0],
              carIndex: undefined,
              elementIndex,
            };
          }
        }
      }
    }

    // per-car checks
    for (let c = 0; c < carCount; c += 1) {
      const idx = i * carCount + c;
      const pos = positionFor(i, c);
      // vertical
      if (hasPerVert) {
        const v = perVert[idx]!;
        if (!finite(v)) {
          diagnostics.push({
            code: "ENGINEERING_LIMITS_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Per-car verticalG car ${c} at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
            actual: v,
            limit: verticalMax,
            margin: 0,
            location: { s, ...(pos ? { position: pos } : {}) },
          });
        } else {
          if (v > verticalMax) {
            if (
              worstVertMax === undefined ||
              v > worstVertMax.actual ||
              (v === worstVertMax.actual &&
                (t < worstVertMax.timeSeconds ||
                  (t === worstVertMax.timeSeconds &&
                    c < (worstVertMax.carIndex ?? Infinity))))
            ) {
              worstVertMax = {
                actual: v,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
          if (v < verticalMin) {
            if (
              worstVertMin === undefined ||
              v < worstVertMin.actual ||
              (v === worstVertMin.actual &&
                (t < worstVertMin.timeSeconds ||
                  (t === worstVertMin.timeSeconds &&
                    c < (worstVertMin.carIndex ?? Infinity))))
            ) {
              worstVertMin = {
                actual: v,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
        }
      }
      if (hasPerLat) {
        const v = perLat[idx]!;
        if (!finite(v)) {
          diagnostics.push({
            code: "ENGINEERING_LIMITS_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Per-car lateralG car ${c} at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
            actual: v,
            limit: maxLat,
            margin: 0,
            location: { s, ...(pos ? { position: pos } : {}) },
          });
        } else {
          const abs = Math.abs(v);
          if (abs > maxLat) {
            if (
              worstLat === undefined ||
              abs > (worstLat.metricAbs ?? -Infinity) ||
              (abs === worstLat.metricAbs &&
                (t < worstLat.timeSeconds ||
                  (t === worstLat.timeSeconds &&
                    c < (worstLat.carIndex ?? Infinity))))
            ) {
              worstLat = {
                actual: v,
                metricAbs: abs,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
        }
      }
      if (hasPerLong) {
        const v = perLong[idx]!;
        if (!finite(v)) {
          diagnostics.push({
            code: "ENGINEERING_LIMITS_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Per-car longitudinalG car ${c} at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
            actual: v,
            limit: maxLong,
            margin: 0,
            location: { s, ...(pos ? { position: pos } : {}) },
          });
        } else {
          const abs = Math.abs(v);
          if (abs > maxLong) {
            if (
              worstLong === undefined ||
              abs > (worstLong.metricAbs ?? -Infinity) ||
              (abs === worstLong.metricAbs &&
                (t < worstLong.timeSeconds ||
                  (t === worstLong.timeSeconds &&
                    c < (worstLong.carIndex ?? Infinity))))
            ) {
              worstLong = {
                actual: v,
                metricAbs: abs,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
        }
      }
      if (hasPerRoll) {
        const v = perRoll[idx]!;
        if (!finite(v)) {
          diagnostics.push({
            code: "ENGINEERING_LIMITS_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Per-car roll rate car ${c} at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
            actual: v,
            limit: maxRoll,
            margin: 0,
            location: { s, ...(pos ? { position: pos } : {}) },
          });
        } else {
          const abs = Math.abs(v);
          if (abs > maxRoll) {
            if (
              worstRoll === undefined ||
              abs > (worstRoll.metricAbs ?? -Infinity) ||
              (abs === worstRoll.metricAbs &&
                (t < worstRoll.timeSeconds ||
                  (t === worstRoll.timeSeconds &&
                    c < (worstRoll.carIndex ?? Infinity))))
            ) {
              worstRoll = {
                actual: v,
                metricAbs: abs,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
        }
      }
      if (hasPerJerk) {
        const base = idx * 3;
        const x = perJerk[base]!;
        const y = perJerk[base + 1]!;
        const z = perJerk[base + 2]!;
        if (!finite(x) || !finite(y) || !finite(z)) {
          diagnostics.push({
            code: "ENGINEERING_LIMITS_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Per-car jerk car ${c} at t=${fmt(t)}s s=${fmt(s)}m is non-finite`,
            actual: x,
            limit: maxJerk,
            margin: 0,
            location: { s, ...(pos ? { position: pos } : {}) },
          });
        } else {
          const mag = Math.hypot(x, y, z);
          if (mag > maxJerk) {
            if (
              worstJerk === undefined ||
              mag > (worstJerk.metricAbs ?? -Infinity) ||
              (mag === worstJerk.metricAbs &&
                (t < worstJerk.timeSeconds ||
                  (t === worstJerk.timeSeconds &&
                    c < (worstJerk.carIndex ?? Infinity))))
            ) {
              worstJerk = {
                actual: mag,
                metricAbs: mag,
                timeSeconds: t,
                s,
                position: pos ?? [0, 0, 0],
                carIndex: c,
                elementIndex,
              };
            }
          }
        }
      }
    }
  }

  // If no authoritative data for a category (both ride and perCar missing), treat as uncertified
  const missingFor = (
    hasRide: boolean,
    hasPer: boolean,
    _label: string,
  ): boolean => !hasRide && !hasPer;
  if (missingFor(hasRideVert, hasPerVert, "verticalG")) {
    diagnostics.push({
      code: "ENGINEERING_LIMITS_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        "Timeline missing verticalG authoritative series – cannot validate vertical limits",
      actual: 0,
      limit: verticalMax,
      margin: 0,
    });
  }
  if (missingFor(hasRideLat, hasPerLat, "lateralG")) {
    diagnostics.push({
      code: "ENGINEERING_LIMITS_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        "Timeline missing lateralG authoritative series – cannot validate lateral limits",
      actual: 0,
      limit: maxLat,
      margin: 0,
    });
  }
  if (missingFor(hasRideLong, hasPerLong, "longitudinalG")) {
    diagnostics.push({
      code: "ENGINEERING_LIMITS_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        "Timeline missing longitudinalG authoritative series – cannot validate longitudinal limits",
      actual: 0,
      limit: maxLong,
      margin: 0,
    });
  }
  if (missingFor(hasRideJerk, hasPerJerk, "jerk")) {
    diagnostics.push({
      code: "ENGINEERING_LIMITS_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        "Timeline missing jerk authoritative series – cannot validate jerk limits",
      actual: 0,
      limit: maxJerk,
      margin: 0,
    });
  }
  if (missingFor(hasRideRoll, hasPerRoll, "rollRate")) {
    diagnostics.push({
      code: "ENGINEERING_LIMITS_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message:
        "Timeline missing rollRate authoritative series – cannot validate roll rate limits",
      actual: 0,
      limit: maxRoll,
      margin: 0,
    });
  }

  // If any fatal uncertified already, return those plus worst exceedances (but ensure we still report exceedances as error diagnostics)
  // Now emit worst exceedance diagnostics
  const emit = (
    cand: Candidate | undefined,
    code: string,
    limit: number,
    kindLabel: string,
    isMin = false,
  ): void => {
    if (!cand) return;
    const actual = cand.actual;
    const margin = isMin ? actual - limit : limit - (cand.metricAbs ?? actual);
    // For absolute metrics, actual for diagnostic should be metricAbs? But preserve signed actual for context?
    // Use metricAbs as actual for absolute limits so margin = limit - abs(actual)
    const diagnosticActual = cand.metricAbs ?? actual;
    const relatedIds: string[] = [];
    if (cand.carIndex !== undefined) relatedIds.push(`car-${cand.carIndex}`);
    if (cand.elementIndex !== undefined)
      relatedIds.push(`element-${cand.elementIndex}`);
    const carPart = cand.carIndex !== undefined ? ` car ${cand.carIndex}` : "";
    const elPart =
      cand.elementIndex !== undefined ? ` element ${cand.elementIndex}` : "";
    const message = `${kindLabel} ${fmt(diagnosticActual)} exceeded project limit ${fmt(limit)} (margin ${fmt(margin)}) at t=${fmt(cand.timeSeconds)}s s=${fmt(cand.s)}m${carPart}${elPart}`;
    diagnostics.push(
      makeDiagnostic(
        code,
        message,
        diagnosticActual,
        limit,
        margin,
        { s: cand.s, position: cand.position },
        relatedIds,
      ),
    );
  };

  emit(
    worstVertMax,
    "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    verticalMax,
    "Vertical G",
    false,
  );
  emit(
    worstVertMin,
    "ENGINEERING_LIMIT_VERTICAL_G_MIN",
    verticalMin,
    "Vertical G",
    true,
  );
  emit(worstLat, "ENGINEERING_LIMIT_LATERAL_G", maxLat, "Lateral G");
  emit(
    worstLong,
    "ENGINEERING_LIMIT_LONGITUDINAL_G",
    maxLong,
    "Longitudinal G",
  );
  emit(worstJerk, "ENGINEERING_LIMIT_JERK", maxJerk, "Jerk");
  emit(worstRoll, "ENGINEERING_LIMIT_ROLL_RATE", maxRoll, "Roll rate");

  return diagnostics;
}
