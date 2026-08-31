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
  const distances = track.distances,
    boundaries = track.elementBoundaries,
    indices = track.elementIndices;
  if (
    !(distances instanceof Float64Array) ||
    !(boundaries instanceof Uint32Array) ||
    !(indices instanceof Uint32Array)
  )
    return [fatal("Track distances/boundaries/indices must be typed arrays")];
  if (indices.length !== distances.length)
    return [
      fatal(
        `Track elementIndices length ${indices.length} must equal distances length ${distances.length}`,
      ),
    ];
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
  for (let i = 0; i < indices.length; i++)
    if (!Number.isInteger(indices[i]!) || indices[i]! >= spanIds.length)
      return [fatal(`Track elementIndices[${i}] out of range`)];
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
  for (let i = 0; i < count; i++) {
    const sIdx = boundaries[i * 2]!,
      eIdx = boundaries[i * 2 + 1]!;
    for (let j = sIdx; j <= eIdx; j++) {
      const expected = j === sIdx && i > 0 ? i - 1 : i;
      if (indices[j] !== expected)
        return [
          fatal(
            `Track elementIndices[${j}] expected ${expected} for element ${spanIds[i]} boundary seam but got ${indices[j]}`,
          ),
        ];
    }
  }
  const findElement = (s: number): string | undefined => {
    if (!finite(s)) return undefined;
    let lo = 0,
      hi = distances.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = distances[mid]!;
      if (d === s) return spanIds[indices[mid]!];
      if (d < s) lo = mid + 1;
      else hi = mid - 1;
    }
    if (hi < 0 || lo >= distances.length) return undefined;
    const leftOwner = indices[hi]!,
      rightOwner = indices[lo]!;
    if (leftOwner !== rightOwner) return spanIds[rightOwner]!;
    return spanIds[leftOwner]!;
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
  let expectedCarIndices: readonly number[] | undefined;
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
    const indicesInFrame = frame.cars.map((c: CarState) => c.index);
    let hasInvalid = false;
    for (const idx of indicesInFrame)
      if (!Number.isInteger(idx) || idx < 0) hasInvalid = true;
    if (hasInvalid) {
      diags.push(fatal(`Frame at t=${fmt(time)}s has invalid car index`));
      continue;
    }
    if (new Set(indicesInFrame).size !== indicesInFrame.length) {
      diags.push(fatal(`Frame at t=${fmt(time)}s has duplicate car indices`));
      continue;
    }
    if (!expectedCarIndices) expectedCarIndices = [...indicesInFrame];
    else if (
      expectedCarIndices.length !== frame.cars.length ||
      !expectedCarIndices.every((v, i) => v === indicesInFrame[i])
    ) {
      diags.push(
        fatal(
          `Frame at t=${fmt(time)}s has changed car count/order/indices – cannot validate`,
        ),
      );
      continue;
    }
    for (let slot = 0; slot < frame.cars.length; slot++) {
      const car = frame.cars[slot]!;
      if (
        !finite(car.distanceM) ||
        !Array.isArray(car.position) ||
        car.position.length !== 3 ||
        !car.position.every(finite)
      ) {
        diags.push(
          fatal(`Car ${car.index} has missing or non-finite distance/position`),
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
          fatal(`Car ${car.index} has missing or non-finite telemetry`, {
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
            `Car ${car.index} at s=${fmt(s)}m cannot be mapped to track element`,
            { s, time, position },
          ),
        );
        continue;
      }
      const carId = `car-${car.index}`;
      for (const spec of specs) {
        const actualRaw = spec.get(car);
        if (!finite(actualRaw)) {
          diags.push(
            fatal(`Car ${car.index} ${spec.code} actual is non-finite`, {
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
                car.index < Number(existing.carId.split("-")[1] ?? 99))));
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
