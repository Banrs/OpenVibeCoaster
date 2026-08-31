import type {
  CompiledTrackData,
  Diagnostic,
  EngineeringLimitsProfile,
  Vec3,
} from "@openvibecoaster/core";
import { validateEngineeringLimitsProfile } from "@openvibecoaster/core";
import type { CarState, SimulationFrame } from "./contracts";

type Candidate = {
  readonly actual: number;
  readonly limit: number;
  readonly margin: number;
  readonly time: number;
  readonly s: number;
  readonly position: Vec3;
  readonly elementId: string;
  readonly carId: string;
};

const finite = (v: number): boolean => Number.isFinite(v);
const fmt = (v: number): string =>
  Number.isFinite(v) ? v.toFixed(3) : String(v);

function fatal(message: string, actual?: number, limit?: number): Diagnostic {
  return {
    code: "ENGINEERING_LIMITS_UNCERTIFIED",
    severity: "fatal",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    ...(actual !== undefined ? { actual } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function warning(
  code: string,
  actual: number,
  limit: number,
  margin: number,
  s: number,
  time: number,
  position: Vec3,
  elementId: string,
  carId: string,
): Diagnostic {
  const label = code.replace("ENGINEERING_LIMIT_", "").replace(/_/g, " ");
  return {
    code,
    severity: "warning",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message: `${label} ${fmt(actual)} exceeded project limit ${fmt(limit)} (margin ${fmt(margin)}) at t=${fmt(time)}s s=${fmt(s)}m`,
    elementId,
    actual,
    limit,
    margin,
    location: { s, time, position },
    relatedIds: [carId],
  };
}

export function validateEngineeringLimits(
  frames: readonly SimulationFrame[],
  track: CompiledTrackData | undefined,
  profile: unknown,
  spanIds: readonly string[] | undefined,
): readonly Diagnostic[] {
  try {
    validateEngineeringLimitsProfile(profile);
  } catch (e) {
    return [fatal(e instanceof Error ? e.message : String(e))];
  }
  const p = profile as EngineeringLimitsProfile;
  if (!Array.isArray(frames) || frames.length === 0)
    return [
      fatal(
        "Timeline frames missing or empty – cannot validate engineering limits",
      ),
    ];

  // snapshot track element ranges once
  const ranges: { id: string; start: number; end: number }[] = [];
  if (track && spanIds) {
    const distances = track.distances;
    const boundaries = track.elementBoundaries;
    const count = Math.floor(boundaries.length / 2);
    for (let i = 0; i < count; i++) {
      const sIdx = boundaries[i * 2]!;
      const eIdx = boundaries[i * 2 + 1]!;
      const start = distances[sIdx]!;
      const end = distances[eIdx]!;
      const id = spanIds[i] ?? `element-${i}`;
      if (!finite(start) || !finite(end))
        return [fatal(`Track element ${id} has non-finite bounds`)];
      ranges.push({ id, start, end });
    }
  } else if (track) {
    const distances = track.distances;
    const boundaries = track.elementBoundaries;
    const count = Math.floor(boundaries.length / 2);
    for (let i = 0; i < count; i++) {
      const sIdx = boundaries[i * 2]!;
      const eIdx = boundaries[i * 2 + 1]!;
      const start = distances[sIdx]!;
      const end = distances[eIdx]!;
      ranges.push({ id: `element-${i}`, start, end });
    }
  }

  const findElement = (s: number): string | undefined => {
    if (ranges.length === 0) return undefined;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const isLast = i === ranges.length - 1;
      if (s >= r.start && (isLast ? s <= r.end : s < r.end)) return r.id;
    }
    return undefined;
  };

  const specs: {
    code: string;
    limit: number;
    isMin: boolean;
    get: (c: CarState) => number;
  }[] = [
    {
      code: "ENGINEERING_LIMIT_VERTICAL_G_MAX",
      limit: p.verticalG.maximum,
      isMin: false,
      get: (c) => c.telemetry.verticalG,
    },
    {
      code: "ENGINEERING_LIMIT_VERTICAL_G_MIN",
      limit: p.verticalG.minimum,
      isMin: true,
      get: (c) => c.telemetry.verticalG,
    },
    {
      code: "ENGINEERING_LIMIT_LATERAL_G",
      limit: p.maximumAbsoluteLateralG,
      isMin: false,
      get: (c) => Math.abs(c.telemetry.lateralG),
    },
    {
      code: "ENGINEERING_LIMIT_LONGITUDINAL_G",
      limit: p.maximumAbsoluteLongitudinalG,
      isMin: false,
      get: (c) => Math.abs(c.telemetry.longitudinalG),
    },
    {
      code: "ENGINEERING_LIMIT_JERK",
      limit: p.maximumJerkMps3,
      isMin: false,
      get: (c) =>
        Math.hypot(
          c.telemetry.jerkMps3[0]!,
          c.telemetry.jerkMps3[1]!,
          c.telemetry.jerkMps3[2]!,
        ),
    },
    {
      code: "ENGINEERING_LIMIT_ROLL_RATE",
      limit: p.maximumRollRateRadPerSecond,
      isMin: false,
      get: (c) => Math.abs(c.telemetry.rollRateRadPerSec),
    },
  ];

  const worst = new Map<string, Candidate>();
  const diags: Diagnostic[] = [];

  for (const frame of frames) {
    if (
      !finite(frame.timeSeconds) ||
      !Array.isArray(frame.cars) ||
      frame.cars.length === 0
    ) {
      diags.push(
        fatal(
          `Frame at time ${String(frame.timeSeconds)} has missing or non-finite time/cars`,
        ),
      );
      continue;
    }
    const time = frame.timeSeconds;
    for (let carIdx = 0; carIdx < frame.cars.length; carIdx++) {
      const car = frame.cars[carIdx]!;
      if (
        !finite(car.distanceM) ||
        !Array.isArray(car.position) ||
        car.position.length !== 3 ||
        !car.position.every(finite)
      ) {
        diags.push(
          fatal(
            `Car ${carIdx} at t=${fmt(time)}s has missing or non-finite distance/position`,
            car.distanceM,
            time,
          ),
        );
        continue;
      }
      const tel = car.telemetry;
      if (
        !tel ||
        !finite(tel.verticalG) ||
        !finite(tel.lateralG) ||
        !finite(tel.longitudinalG) ||
        !finite(tel.rollRateRadPerSec) ||
        !Array.isArray(tel.jerkMps3) ||
        tel.jerkMps3.length !== 3 ||
        !tel.jerkMps3.every(finite)
      ) {
        diags.push(
          fatal(
            `Car ${carIdx} at t=${fmt(time)}s s=${fmt(car.distanceM)}m has missing or non-finite telemetry`,
            tel?.verticalG,
            time,
          ),
        );
        continue;
      }
      const s = car.distanceM;
      const position = car.position as Vec3;
      const elementId = findElement(s) ?? `element-${carIdx}`;
      const carId = `car-${carIdx}`;
      for (const spec of specs) {
        const actualRaw = spec.get(car);
        if (!finite(actualRaw)) {
          diags.push(
            fatal(
              `Car ${carIdx} ${spec.code} actual is non-finite at t=${fmt(time)}s`,
              actualRaw,
              spec.limit,
            ),
          );
          continue;
        }
        // vertical min is checked as actual < limit (more negative), others as actual > limit (with abs already)
        const isExceed = spec.isMin
          ? actualRaw < spec.limit
          : actualRaw > spec.limit;
        if (!isExceed) continue;
        const margin = spec.isMin
          ? actualRaw - spec.limit
          : spec.limit - actualRaw;
        const existing = worst.get(spec.code);
        const actualForCompare = actualRaw;
        const isWorse =
          !existing ||
          (spec.isMin
            ? actualForCompare < existing.actual
            : actualForCompare > existing.actual) ||
          (actualForCompare === existing.actual &&
            (time < existing.time ||
              (time === existing.time &&
                carIdx < Number(existing.carId.split("-")[1] ?? 99))));
        if (isWorse) {
          worst.set(spec.code, {
            actual: actualRaw,
            limit: spec.limit,
            margin,
            time,
            s,
            position,
            elementId,
            carId,
          });
        }
      }
    }
  }

  // if any fatal already, return them plus warnings (but keep warnings as warnings)
  for (const [code, c] of worst.entries()) {
    diags.push(
      warning(
        code,
        c.actual,
        c.limit,
        c.margin,
        c.s,
        c.time,
        c.position,
        c.elementId,
        c.carId,
      ),
    );
  }
  return diags;
}
