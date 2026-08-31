// Project limits validator – pure, table-driven over SimulationFrame[].
import type {
  CompiledTrackData,
  Diagnostic,
  EngineeringLimitsProfile,
  Vec3,
} from "@openvibecoaster/core";
import { validateEngineeringLimitsProfile } from "@openvibecoaster/core";
import type { CarState, SimulationFrame } from "./contracts";
type Candidate = {
  actual: number;
  limit: number;
  margin: number;
  time: number;
  s: number;
  position: Vec3;
  elementId: string;
  carId: string;
};
const finite = (v: number): boolean => Number.isFinite(v);
const fmt = (v: number): string =>
  Number.isFinite(v) ? v.toFixed(3) : String(v);
function fatal(message: string, location?: Diagnostic["location"]): Diagnostic {
  return {
    code: "ENGINEERING_LIMITS_UNCERTIFIED",
    severity: "fatal",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message,
    ...(location ? { location } : {}),
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
  return {
    code,
    severity: "warning",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    message: `${code.replace("ENGINEERING_LIMIT_", "").replace(/_/g, " ")} ${fmt(actual)} exceeded project limit ${fmt(limit)} (margin ${fmt(margin)}) at t=${fmt(time)}s s=${fmt(s)}m`,
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
  if (!track)
    return [
      fatal("Authoritative track missing – cannot validate engineering limits"),
    ];
  if (!Array.isArray(spanIds) || spanIds.length === 0)
    return [
      fatal(
        "Authoritative spanIds missing – cannot validate engineering limits",
      ),
    ];
  const distances = track.distances;
  const boundaries = track.elementBoundaries;
  if (
    !(distances instanceof Float64Array) ||
    !(boundaries instanceof Uint32Array)
  )
    return [fatal("Track distances/boundaries must be typed arrays")];
  if (boundaries.length % 2 !== 0)
    return [fatal("Track elementBoundaries must contain start/end pairs")];
  const count = boundaries.length / 2;
  if (spanIds.length !== count)
    return [
      fatal(
        `SpanIds cardinality ${spanIds.length} does not match element count ${count}`,
      ),
    ];
  if (distances.length === 0) return [fatal("Track distances empty")];
  for (let i = 0; i < distances.length; i++)
    if (!finite(distances[i]!))
      return [fatal(`Track distances[${i}] is non-finite`)];
  for (let i = 1; i < distances.length; i++)
    if (!(distances[i]! > distances[i - 1]!))
      return [
        fatal(`Track distances must be strictly increasing at index ${i}`),
      ];
  if (!finite(track.totalLength) || track.totalLength <= 0)
    return [fatal("Track totalLength must be finite positive")];
  if (
    Math.abs(distances[distances.length - 1]! - track.totalLength) >
    1e-9 * Math.max(1, Math.abs(track.totalLength))
  )
    return [fatal("Track distances last entry must equal totalLength")];
  if (distances[0] !== 0) return [fatal("Track distances must start at 0")];
  for (let i = 0; i < boundaries.length; i++) {
    const v = boundaries[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= distances.length)
      return [fatal(`Track elementBoundaries[${i}] is out of range`)];
  }
  for (let i = 0; i < spanIds.length; i++)
    if (typeof spanIds[i] !== "string" || spanIds[i]!.trim() === "")
      return [fatal(`SpanIds[${i}] must be non-empty string`)];
  if (boundaries[0] !== 0)
    return [fatal("Track elementBoundaries must start at 0")];
  if (boundaries[boundaries.length - 1] !== distances.length - 1)
    return [fatal("Track elementBoundaries must end at last sample")];
  for (let i = 0; i < count; i++) {
    const sIdx = boundaries[i * 2]!;
    const eIdx = boundaries[i * 2 + 1]!;
    if (sIdx >= eIdx)
      return [
        fatal(`Track element ${spanIds[i]} has invalid start/end indices`),
      ];
    if (i > 0 && sIdx !== boundaries[(i - 1) * 2 + 1]!)
      return [
        fatal(
          `Track elementBoundaries not contiguous at element ${spanIds[i]}`,
        ),
      ];
    const start = distances[sIdx]!;
    const end = distances[eIdx]!;
    if (!finite(start) || !finite(end))
      return [fatal(`Track element ${spanIds[i]} has non-finite bounds`)];
    if (start >= end)
      return [fatal(`Track element ${spanIds[i]} has start >= end`)];
  }
  const ranges: { id: string; start: number; end: number }[] = [];
  for (let i = 0; i < count; i++)
    ranges.push({
      id: spanIds[i]!,
      start: distances[boundaries[i * 2]!]!,
      end: distances[boundaries[i * 2 + 1]!]!,
    });
  const findElement = (s: number): string | undefined => {
    if (!finite(s)) return undefined;
    for (let i = 0; i < ranges.length; i++)
      if (s >= ranges[i]!.start && s <= ranges[i]!.end) return ranges[i]!.id;
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
      diags.push(fatal(`Frame has missing or non-finite time/cars`));
      continue;
    }
    const time = frame.timeSeconds;
    for (let carIdx = 0; carIdx < frame.cars.length; carIdx++) {
      const car = frame.cars[carIdx]!;
      const hasValidDistance = finite(car.distanceM);
      const hasValidPosition =
        Array.isArray(car.position) &&
        car.position.length === 3 &&
        car.position.every(finite);
      if (!hasValidDistance || !hasValidPosition) {
        const loc =
          hasValidDistance && hasValidPosition
            ? { s: car.distanceM, time, position: car.position as Vec3 }
            : undefined;
        diags.push(
          fatal(
            `Car ${carIdx} has missing or non-finite distance/position`,
            loc,
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
          fatal(`Car ${carIdx} has missing or non-finite telemetry`, {
            s: car.distanceM,
            time,
            position: car.position as Vec3,
          }),
        );
        continue;
      }
      const s = car.distanceM;
      const position = car.position as Vec3;
      const elementId = findElement(s);
      if (!elementId) {
        diags.push(
          fatal(
            `Car ${carIdx} at s=${fmt(s)}m cannot be mapped to track element`,
            { s, time, position },
          ),
        );
        continue;
      }
      const carId = `car-${carIdx}`;
      for (const spec of specs) {
        const actualRaw = spec.get(car);
        if (!finite(actualRaw)) {
          diags.push(
            fatal(`Car ${carIdx} ${spec.code} actual is non-finite`, {
              s,
              time,
              position,
            }),
          );
          continue;
        }
        const isExceed = spec.isMin
          ? actualRaw < spec.limit
          : actualRaw > spec.limit;
        if (!isExceed) continue;
        const margin = spec.isMin
          ? actualRaw - spec.limit
          : spec.limit - actualRaw;
        const existing = worst.get(spec.code);
        const isWorse =
          !existing ||
          (spec.isMin
            ? actualRaw < existing.actual
            : actualRaw > existing.actual) ||
          (actualRaw === existing.actual &&
            (time < existing.time ||
              (time === existing.time &&
                carIdx < Number(existing.carId.split("-")[1] ?? 99))));
        if (isWorse)
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
  for (const [code, c] of worst.entries())
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
  return diags;
}
