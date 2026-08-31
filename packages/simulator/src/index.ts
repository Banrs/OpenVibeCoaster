import {
  sampleTrackAtDistance,
  vec3,
  vec3Dot,
  vec3Normalize,
  vec3Scale,
} from "@openvibecoaster/core";
import type {
  CompiledTrackData,
  TrackSample,
  Vec3,
} from "@openvibecoaster/core";
import { RideTimeline } from "./timeline";
import type {
  CarConfiguration,
  CarState,
  CarTelemetry,
  OperationState,
  OperationZone,
  PerCarForce,
  RideTelemetry,
  SimulationDiagnostic,
  SimulationEvent,
  SimulationFrame,
  SimulationRequest,
  SimulationResult,
  SimulationStatus,
  SimulatorConfig,
  TrainConfiguration,
} from "./contracts";

export * from "./contracts";
export * from "./timeline";
export * from "./engineering-limits";

const DEFAULT_GRAVITY = 9.80665;
const SPEED_EPSILON = 1e-8;
const SAFE_TIMELINE_SAMPLE_RATE_HZ = 120;

export const createDefaultSimulatorConfig = (): SimulatorConfig => ({
  gravityMps2: DEFAULT_GRAVITY,
  gravityDirection: vec3(0, -1, 0),
  closedTrack: false,
  fixedStepSeconds: 1 / 240,
  timelineStepSeconds: 1 / 120,
  rollingResistanceCoefficient: 0.002,
  staticStictionCoefficient: 0.002,
  dragCdA: 4,
  airDensityKgPerM3: 1.225,
  lsmForcePerCarN: 14000,
  lsmPowerPerCarW: 1200000,
  lsmTargetGainNPerMps: 2000,
  maxBrakeForcePerCarN: 18000,
  zones: [],
  train: {
    cars: Array.from({ length: 6 }, (): CarConfiguration => ({
      massKg: 1500,
      seatCount: 4,
    })),
    spacingM: 3.4,
    envelope: {
      halfWidthM: 1.25,
      aboveRailM: 2.1,
      belowRailM: 0.8,
      noseTailMarginM: 0.75,
    },
  },
});

export const defaultSimulatorConfig = createDefaultSimulatorConfig;

interface DynamicsSample {
  readonly forces: readonly PerCarForce[];
  readonly totalForce: number;
  readonly accelerationMps2: number;
  readonly activeZones: readonly OperationZone[];
  readonly staticStictionCapacityN: number;
}

interface WorkState {
  driveJ: number;
  lossJ: number;
}

const finite = (value: number): boolean => Number.isFinite(value);

class SimulatorRangeError extends RangeError {
  public constructor(
    public readonly diagnosticCode: "SIM_INVALID_STATE" | "SIM_NUMERICAL",
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

class OpenTrackBoundaryError extends SimulatorRangeError {
  public constructor(
    field: string,
    message: string,
    public readonly boundaryM: number,
  ) {
    super("SIM_INVALID_STATE", field, message);
  }
}

const checkedFinite = (
  value: number,
  field: string,
  message: string,
): number => {
  if (!finite(value))
    throw new SimulatorRangeError("SIM_NUMERICAL", field, message);
  return value;
};

const checkedVector = (value: Vec3, field: string, message: string): Vec3 => {
  if (!value.every(finite))
    throw new SimulatorRangeError("SIM_NUMERICAL", field, message);
  return value;
};

const sumFinite = (
  values: readonly number[],
  field: string,
  message: string,
): number => {
  let sum = 0;
  for (const value of values) {
    sum = checkedFinite(sum + value, field, message);
  }
  return sum;
};

const dot = (a: Vec3, b: Vec3): number => vec3Dot(a, b);
const add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const subtract = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const scale = (a: Vec3, value: number): Vec3 => vec3Scale(a, value);
const wrappedDistance = (
  track: CompiledTrackData,
  distanceM: number,
): number => {
  if (track.totalLength <= 0) return 0;
  const remainder = distanceM % track.totalLength;
  return remainder < 0 ? remainder + track.totalLength : remainder;
};
const trackDistance = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
): number =>
  config.closedTrack ? wrappedDistance(track, distanceM) : distanceM;
const zoneContains = (
  track: CompiledTrackData,
  zone: OperationZone,
  distanceM: number,
  closedTrack = false,
): boolean => {
  // Zones own the half-open interval [startDistanceM, endDistanceM). Closed
  // tracks canonicalize the seam through wrappedDistance before this check.
  const trackDistanceM = closedTrack
    ? wrappedDistance(track, distanceM)
    : distanceM;
  if (
    trackDistanceM < zone.startDistanceM ||
    trackDistanceM >= zone.endDistanceM
  )
    return false;
  const zoneNames = track.zoneNames;
  const nameIndex = zoneNames.indexOf(zone.id);
  if (nameIndex < 0 || nameIndex >= 32) return true;
  const masks = track.zoneMasks;
  if (masks.length === 0 || track.totalLength <= 0) return true;
  const sampleIndex = Math.max(
    0,
    Math.min(
      masks.length - 1,
      Math.round((trackDistanceM / track.totalLength) * (masks.length - 1)),
    ),
  );
  return ((masks[sampleIndex] ?? 0) & (1 << nameIndex)) !== 0;
};

const activeZones = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
): readonly OperationZone[] =>
  config.zones.filter((zone) =>
    zoneContains(track, zone, distanceM, config.closedTrack),
  );

const activeZonesForTrain = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
): readonly OperationZone[] =>
  config.zones.filter((zone) =>
    config.train.cars.some((_, index) =>
      zoneContains(
        track,
        zone,
        headDistanceM - index * config.train.spacingM,
        config.closedTrack,
      ),
    ),
  );

const occupiedCarCount = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  zone: OperationZone,
  headDistanceM: number,
): number =>
  config.train.cars.reduce(
    (count, _, index) =>
      count +
      (zoneContains(
        track,
        zone,
        headDistanceM - index * config.train.spacingM,
        config.closedTrack,
      )
        ? 1
        : 0),
    0,
  );

const totalMass = (train: TrainConfiguration): number =>
  sumFinite(
    train.cars.map((car) => car.massKg),
    "train.totalMassKg",
    "Total train mass must be finite",
  );

interface OpenTrackViolation {
  readonly field: string;
  readonly kind: "car" | "seat";
  readonly distanceM: number;
  readonly boundaryM: number;
}

const openTrackViolation = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
): OpenTrackViolation | undefined => {
  if (config.closedTrack) return undefined;
  for (const [index, car] of config.train.cars.entries()) {
    const distanceM = headDistanceM - index * config.train.spacingM;
    if (distanceM < 0 || distanceM > track.totalLength)
      return {
        field: `state.train.cars[${index}].distanceM`,
        kind: "car",
        distanceM,
        boundaryM:
          distanceM < 0
            ? index * config.train.spacingM
            : track.totalLength + index * config.train.spacingM,
      };
    for (const [seatIndex, offset] of (car.seatPositionsM ?? []).entries()) {
      const seatDistanceM = distanceM + offset[2];
      if (seatDistanceM < 0 || seatDistanceM > track.totalLength)
        return {
          field: `state.train.cars[${index}].seats[${seatIndex}].distanceM`,
          kind: "seat",
          distanceM: seatDistanceM,
          boundaryM:
            seatDistanceM < 0
              ? index * config.train.spacingM - offset[2]
              : track.totalLength + index * config.train.spacingM - offset[2],
        };
    }
  }
  return undefined;
};

const gravityVector = (config: SimulatorConfig): Vec3 =>
  checkedVector(
    scale(
      vec3Normalize(config.gravityDirection ?? vec3(0, -1, 0)),
      config.gravityMps2,
    ),
    "gravityVector",
    "Gravity vector must be finite",
  );

const vectorIsFiniteAndNonzero = (value: Vec3): boolean =>
  value.every(finite) && Math.hypot(value[0], value[1], value[2]) > 1e-15;

const operationKinds = new Set<OperationZone["kind"]>([
  "station",
  "block",
  "launch",
  "boost",
  "brake",
]);

const validate = (
  request: SimulationRequest,
  track: CompiledTrackData,
): readonly SimulationDiagnostic[] => {
  const diagnostics: SimulationDiagnostic[] = [];
  const { config, initial, durationSeconds } = request;
  if (!finite(durationSeconds) || durationSeconds < 0)
    diagnostics.push({
      code: "SIM_INVALID_STATE",
      severity: "error",
      field: "durationSeconds",
      message: "Duration must be a finite non-negative number",
    });
  if (!finite(initial.headDistanceM) || !finite(initial.speedMps))
    diagnostics.push({
      code: "SIM_INVALID_STATE",
      severity: "error",
      field: "initial",
      message: "Initial head distance and speed must be finite",
    });
  if (
    !finite(config.fixedStepSeconds) ||
    config.fixedStepSeconds <= 0 ||
    !finite(1 / config.fixedStepSeconds)
  )
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "fixedStepSeconds",
      message: "Fixed simulation step must be positive",
    });
  if (
    !finite(config.timelineStepSeconds) ||
    config.timelineStepSeconds <= 0 ||
    !finite(1 / config.timelineStepSeconds)
  )
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "timelineStepSeconds",
      message: "Timeline step must be positive",
    });
  if (
    config.gravityDirection &&
    !vectorIsFiniteAndNonzero(config.gravityDirection)
  )
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "gravityDirection",
      message: "Gravity direction must be a finite non-zero vector",
    });
  if (
    config.closedTrack !== undefined &&
    typeof config.closedTrack !== "boolean"
  )
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "closedTrack",
      message: "Closed-track mode must be boolean",
    });
  if (config.train.cars.length === 0 || config.train.cars.length > 6)
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "train.cars",
      message: "Train must contain between one and six cars",
    });
  if (!finite(config.train.spacingM) || config.train.spacingM <= 0)
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "train.spacingM",
      message: "Car spacing must be positive",
    });
  const envelope = config.train.envelope;
  for (const [field, value, positive] of [
    ["halfWidthM", envelope.halfWidthM, true],
    ["aboveRailM", envelope.aboveRailM, true],
    ["belowRailM", envelope.belowRailM, true],
    ["noseTailMarginM", envelope.noseTailMarginM, false],
  ] as const)
    if (!finite(value) || (positive ? value <= 0 : value < 0))
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `train.envelope.${field}`,
        message: `Envelope ${field} must be finite and ${positive ? "positive" : "non-negative"}`,
      });
  for (const [index, car] of config.train.cars.entries()) {
    if (
      !finite(car.massKg) ||
      car.massKg <= 0 ||
      !Number.isInteger(car.seatCount) ||
      car.seatCount < 0
    )
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `train.cars[${index}]`,
        message:
          "Each car needs a positive mass and non-negative integer seat count",
      });
    if (car.seatPositionsM && car.seatPositionsM.length !== car.seatCount)
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `train.cars[${index}].seatPositionsM`,
        message: "Seat positions must match seat count",
      });
    for (const [seatIndex, position] of (car.seatPositionsM ?? []).entries())
      if (!position.every(finite))
        diagnostics.push({
          code: "SIM_INVALID_CONFIGURATION",
          severity: "error",
          field: `train.cars[${index}].seatPositionsM[${seatIndex}]`,
          message: "Seat offset must contain only finite values",
        });
  }
  if (config.train.cars.every((car) => finite(car.massKg) && car.massKg > 0)) {
    let massKg = 0;
    for (const car of config.train.cars) {
      massKg += car.massKg;
      if (!finite(massKg)) {
        diagnostics.push({
          code: "SIM_NUMERICAL",
          severity: "error",
          field: "train.totalMassKg",
          message: "Total train mass must be finite",
        });
        break;
      }
    }
  }
  for (const [field, value] of [
    ["gravityMps2", config.gravityMps2],
    ["rollingResistanceCoefficient", config.rollingResistanceCoefficient],
    ["staticStictionCoefficient", config.staticStictionCoefficient],
    ["dragCdA", config.dragCdA],
    ["airDensityKgPerM3", config.airDensityKgPerM3],
    ["lsmForcePerCarN", config.lsmForcePerCarN],
    ["lsmPowerPerCarW", config.lsmPowerPerCarW],
    ["lsmTargetGainNPerMps", config.lsmTargetGainNPerMps],
    ["maxBrakeForcePerCarN", config.maxBrakeForcePerCarN],
  ] as const)
    if (!finite(value) || (field === "gravityMps2" ? value <= 0 : value < 0))
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field,
        message: `${field} must be finite and ${field === "gravityMps2" ? "positive" : "non-negative"}`,
      });
  for (const [index, zone] of config.zones.entries()) {
    if (!zone.id.trim())
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].id`,
        message: "Zone id must be non-empty",
      });
    if (!operationKinds.has(zone.kind))
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].kind`,
        message: "Zone kind is not supported",
      });
    if (!finite(zone.startDistanceM) || zone.startDistanceM < 0)
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].startDistanceM`,
        message: "Zone start must be finite and non-negative",
      });
    else if (
      finite(zone.endDistanceM) &&
      zone.endDistanceM <= zone.startDistanceM
    )
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].startDistanceM`,
        message: "Zone start must be less than its end",
      });
    if (!finite(zone.endDistanceM) || zone.endDistanceM <= zone.startDistanceM)
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].endDistanceM`,
        message: "Zone end must be finite and greater than its start",
      });
    if (finite(track.totalLength) && zone.endDistanceM > track.totalLength)
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].endDistanceM`,
        message: "Zone end must not exceed the compiled track length",
      });
    for (const [field, value] of [
      ["lsmForcePerCarN", zone.lsmForcePerCarN],
      ["lsmPowerPerCarW", zone.lsmPowerPerCarW],
      ["brakeForcePerCarN", zone.brakeForcePerCarN],
    ] as const)
      if (value !== undefined && (!finite(value) || value < 0))
        diagnostics.push({
          code: "SIM_INVALID_CONFIGURATION",
          severity: "error",
          field: `zones[${index}].${field}`,
          message: `${field} must be finite and non-negative`,
        });
    if (zone.targetSpeedMps !== undefined && !finite(zone.targetSpeedMps))
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].targetSpeedMps`,
        message: "Target speed must be finite",
      });
    if (zone.blockId !== undefined && !zone.blockId.trim())
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].blockId`,
        message: "Block id must be non-empty",
      });
  }
  if (
    !config.closedTrack &&
    finite(track.totalLength) &&
    track.totalLength >= 0 &&
    finite(initial.headDistanceM) &&
    finite(config.train.spacingM)
  ) {
    for (const [index, car] of config.train.cars.entries()) {
      const distanceM = initial.headDistanceM - index * config.train.spacingM;
      if (!finite(distanceM) || distanceM < 0 || distanceM > track.totalLength)
        diagnostics.push({
          code: "SIM_INVALID_STATE",
          severity: "error",
          field: `initial.train.cars[${index}].distanceM`,
          message: `Car distance must be within [0, ${track.totalLength}] on an open track`,
        });
      for (const [seatIndex, offset] of (car.seatPositionsM ?? []).entries()) {
        const seatDistanceM = distanceM + offset[2];
        if (
          !finite(seatDistanceM) ||
          seatDistanceM < 0 ||
          seatDistanceM > track.totalLength
        )
          diagnostics.push({
            code: "SIM_INVALID_STATE",
            severity: "error",
            field: `initial.train.cars[${index}].seatPositionsM[${seatIndex}].distanceM`,
            message: `Seat distance must be within [0, ${track.totalLength}] on an open track`,
          });
      }
    }
  }
  if (
    config.train.cars.length > 0 &&
    finite(config.airDensityKgPerM3) &&
    finite(config.dragCdA) &&
    !finite(
      0.5 *
        config.airDensityKgPerM3 *
        (config.dragCdA / config.train.cars.length),
    )
  )
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "airDensityKgPerM3*dragCdA",
      message: "Aerodynamic drag coefficient product must be finite",
    });
  for (const [index, car] of config.train.cars.entries())
    if (
      finite(car.massKg) &&
      finite(config.gravityMps2) &&
      !finite(car.massKg * config.gravityMps2)
    )
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `train.cars[${index}].massKg*gravityMps2`,
        message: "Per-car gravity force scale must be finite",
      });
  for (const [index, zone] of config.zones.entries())
    if (
      zone.targetSpeedMps !== undefined &&
      finite(zone.targetSpeedMps) &&
      finite(initial.speedMps) &&
      finite(config.lsmTargetGainNPerMps) &&
      !finite(
        config.lsmTargetGainNPerMps * (zone.targetSpeedMps - initial.speedMps),
      )
    )
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: `zones[${index}].targetSpeedMps*lsmTargetGainNPerMps`,
        message: "Target-speed LSM force product must be finite",
      });
  return diagnostics;
};

const forceIsFinite = (force: PerCarForce): boolean =>
  [
    force.gravity,
    force.rolling,
    force.drag,
    force.drive,
    force.brake,
    force.net,
  ].every(finite);

const dynamicsAt = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
  speedMps: number,
): DynamicsSample => {
  const violation = openTrackViolation(track, config, headDistanceM);
  if (violation)
    throw new OpenTrackBoundaryError(
      violation.field,
      `Open-track ${violation.kind} distance left [0, ${track.totalLength}] during integration`,
      violation.boundaryM,
    );
  const gVec = gravityVector(config);
  const carCount = config.train.cars.length;
  let staticStictionCapacityN = 0;
  const forces = config.train.cars.map((car, index) => {
    const distanceM = headDistanceM - index * config.train.spacingM;
    const forceField = `train.cars[${index}].force`;
    const sample = sampleTrackAtDistance(
      track,
      trackDistance(track, config, distanceM),
    );
    const zones = activeZones(track, config, distanceM);
    const gravity = checkedFinite(
      car.massKg * dot(gVec, sample.tangent),
      `${forceField}.gravity`,
      "Per-car gravity force must be finite",
    );
    const tangentProjection = dot(gVec, sample.tangent);
    const perp = subtract(gVec, scale(sample.tangent, tangentProjection));
    const perpMag = Math.hypot(perp[0], perp[1], perp[2]);
    const normalN = checkedFinite(
      car.massKg * perpMag,
      `train.cars[${index}].normal`,
      "Per-car normal force must be finite",
    );
    const rollingMagnitude = checkedFinite(
      config.rollingResistanceCoefficient * normalN,
      `${forceField}.rollingMagnitude`,
      "Rolling resistance force must be finite",
    );
    const rolling =
      Math.abs(speedMps) > SPEED_EPSILON && rollingMagnitude > 0
        ? -Math.sign(speedMps) * rollingMagnitude
        : 0;
    const drag = checkedFinite(
      -0.5 *
        config.airDensityKgPerM3 *
        (config.dragCdA / carCount) *
        speedMps *
        Math.abs(speedMps),
      `${forceField}.drag`,
      "Aerodynamic drag force must be finite",
    );
    let drive = 0;
    let brake = 0;
    let launchActive = false;
    let brakeActive = false;
    const addTargetBrake = (target: number, limit: number): void => {
      if (Math.abs(speedMps) <= target) return;
      const rawRequested = checkedFinite(
        config.lsmTargetGainNPerMps * (Math.abs(speedMps) - target),
        `${forceField}.requestedBrake`,
        "Requested brake force must be finite",
      );
      const capped = Math.min(limit, Math.max(0, rawRequested));
      brake = checkedFinite(
        brake - Math.sign(speedMps) * capped,
        `${forceField}.brake`,
        "Brake force must be finite",
      );
    };
    for (const zone of zones) {
      if (zone.kind === "launch" || zone.kind === "boost") {
        launchActive = true;
        const target = zone.targetSpeedMps ?? 0;
        const requested =
          zone.targetSpeedMps === undefined
            ? (zone.lsmForcePerCarN ?? config.lsmForcePerCarN)
            : config.lsmTargetGainNPerMps * (target - speedMps);
        const checkedRequested = checkedFinite(
          requested,
          `${forceField}.requestedDrive`,
          "Requested drive force must be finite",
        );
        const forceLimit = Math.max(
          0,
          zone.lsmForcePerCarN ?? config.lsmForcePerCarN,
        );
        const powerLimit = Math.max(
          0,
          zone.lsmPowerPerCarW ?? config.lsmPowerPerCarW,
        );
        const capped = Math.max(
          -forceLimit,
          Math.min(forceLimit, checkedRequested),
        );
        const powerCapped =
          Math.abs(speedMps) > SPEED_EPSILON
            ? Math.sign(capped) *
              Math.min(Math.abs(capped), powerLimit / Math.abs(speedMps))
            : capped;
        drive = checkedFinite(
          drive + powerCapped,
          `${forceField}.drive`,
          "Drive force must be finite",
        );
      } else if (zone.kind === "brake") {
        brakeActive = true;
        const target = Math.max(0, zone.targetSpeedMps ?? 0);
        const limit = Math.max(
          0,
          zone.brakeForcePerCarN ?? config.maxBrakeForcePerCarN,
        );
        addTargetBrake(target, limit);
      } else if (zone.kind === "station") {
        if (zone.targetSpeedMps === undefined) continue;
        brakeActive = true;
        const target = Math.max(0, zone.targetSpeedMps);
        const limit = Math.max(
          0,
          zone.brakeForcePerCarN ?? config.maxBrakeForcePerCarN,
        );
        addTargetBrake(target, limit);
      }
    }
    const capacity = checkedFinite(
      config.staticStictionCoefficient * normalN,
      "staticStictionLimitN",
      "Static stiction limit must be finite",
    );
    staticStictionCapacityN = checkedFinite(
      staticStictionCapacityN + capacity,
      "staticStictionLimitN",
      "Static stiction limit must be finite",
    );
    return {
      gravity,
      rolling: checkedFinite(
        rolling,
        `${forceField}.rolling`,
        "Rolling resistance force must be finite",
      ),
      drag,
      drive,
      brake,
      net: sumFinite(
        [gravity, rolling, drag, drive, brake],
        `${forceField}.net`,
        "Per-car net force must be finite",
      ),
      launchActive,
      brakeActive,
    };
  });
  const totalForce = sumFinite(
    forces.map((force) => force.net),
    "totalForce",
    "Summed train force must be finite",
  );
  const active = activeZones(track, config, headDistanceM);
  const accelerationMps2 = checkedFinite(
    totalForce / totalMass(config.train),
    "accelerationMps2",
    "Train acceleration must be finite",
  );
  return {
    forces,
    totalForce,
    accelerationMps2,
    activeZones: active,
    staticStictionCapacityN,
  };
};

const derivative = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
  speedMps: number,
): readonly [number, number] => {
  const sample = dynamicsAt(track, config, distanceM, speedMps);
  if (
    Math.abs(speedMps) <= SPEED_EPSILON &&
    Math.abs(sample.totalForce) <= sample.staticStictionCapacityN
  )
    return [0, 0];
  return [speedMps, sample.accelerationMps2];
};

const rk4 = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
  speedMps: number,
  stepSeconds: number,
): readonly [number, number] => {
  const k1 = derivative(track, config, distanceM, speedMps);
  const k2 = derivative(
    track,
    config,
    distanceM + 0.5 * stepSeconds * k1[0],
    speedMps + 0.5 * stepSeconds * k1[1],
  );
  const k3 = derivative(
    track,
    config,
    distanceM + 0.5 * stepSeconds * k2[0],
    speedMps + 0.5 * stepSeconds * k2[1],
  );
  const k4 = derivative(
    track,
    config,
    distanceM + stepSeconds * k3[0],
    speedMps + stepSeconds * k3[1],
  );
  const distanceIncrement =
    (stepSeconds * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])) / 6;
  const speedIncrement =
    (stepSeconds * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])) / 6;
  return [distanceM + distanceIncrement, speedMps + speedIncrement];
};

const boundedRk4 = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
  speedMps: number,
  stepSeconds: number,
): {
  readonly distanceM: number;
  readonly speedMps: number;
  readonly elapsedSeconds: number;
  readonly boundaryError?: OpenTrackBoundaryError;
} => {
  const checkedStep = (elapsedSeconds: number): readonly [number, number] => {
    const state = rk4(track, config, distanceM, speedMps, elapsedSeconds);
    if (!finite(state[0]) || !finite(state[1]))
      throw new SimulatorRangeError(
        "SIM_NUMERICAL",
        "state",
        "Fixed-step integration produced a non-finite state",
      );
    const violation = openTrackViolation(track, config, state[0]);
    if (violation)
      throw new OpenTrackBoundaryError(
        violation.field,
        `Open-track ${violation.kind} distance left [0, ${track.totalLength}] during integration`,
        violation.boundaryM,
      );
    return state;
  };
  try {
    const state = checkedStep(stepSeconds);
    return {
      distanceM: state[0],
      speedMps: state[1],
      elapsedSeconds: stepSeconds,
    };
  } catch (error) {
    if (!(error instanceof OpenTrackBoundaryError)) throw error;
    let low = 0;
    let high = stepSeconds;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const middle = (low + high) / 2;
      try {
        checkedStep(middle);
        low = middle;
      } catch (middleError) {
        if (!(middleError instanceof OpenTrackBoundaryError)) throw middleError;
        high = middle;
      }
    }
    const state = low > 0 ? checkedStep(low) : ([distanceM, speedMps] as const);
    return {
      distanceM: error.boundaryM,
      speedMps: state[1],
      elapsedSeconds: low,
      boundaryError: error,
    };
  }
};

const seatPositions = (car: CarConfiguration): readonly Vec3[] =>
  car.seatPositionsM
    ? car.seatPositionsM.map((position) => vec3(...position))
    : Array.from({ length: car.seatCount }, () => vec3(0, 0, 0));

const seatWorldPosition = (
  seatFrame: TrackSample,
  offset: Vec3,
  field: string,
): Vec3 =>
  checkedVector(
    add(
      seatFrame.position,
      add(
        scale(seatFrame.binormal, -offset[0]),
        scale(seatFrame.normal, offset[1]),
      ),
    ),
    field,
    "Seat world position must be finite",
  );

const makeCars = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
  speedMps: number,
  accelerationMps2: number,
): readonly CarState[] =>
  config.train.cars.map((car, index) => {
    const distanceM = headDistanceM - index * config.train.spacingM;
    const sample = sampleTrackAtDistance(
      track,
      trackDistance(track, config, distanceM),
    );
    const offsets = seatPositions(car);
    const telemetry = carTelemetry(
      sample,
      worldAcceleration(sample, speedMps, accelerationMps2),
      gravityVector(config),
      config.gravityMps2,
      speedMps,
    );
    const seats = offsets.map((offset, seatIndex) => {
      const seatDistanceM = checkedFinite(
        distanceM + offset[2],
        `state.train.cars[${index}].seats[${seatIndex}].distanceM`,
        "Seat distance must be finite",
      );
      const seatFrame = sampleTrackAtDistance(
        track,
        trackDistance(track, config, seatDistanceM),
      );
      return {
        index: seatIndex,
        distanceM: seatDistanceM,
        position: seatWorldPosition(
          seatFrame,
          offset,
          `state.train.cars[${index}].seats[${seatIndex}].position`,
        ),
        frame: seatFrame,
        telemetry: carTelemetry(
          seatFrame,
          worldAcceleration(seatFrame, speedMps, accelerationMps2),
          gravityVector(config),
          config.gravityMps2,
          speedMps,
        ),
      };
    });
    return {
      index,
      distanceM,
      position: sample.position,
      tangent: sample.tangent,
      normal: sample.normal,
      binormal: sample.binormal,
      frame: sample,
      seatOffsets: offsets,
      seatPositions: seats.map((seat) => seat.position),
      telemetry,
      seats,
    };
  });

const worldAcceleration = (
  sample: TrackSample,
  speedMps: number,
  accelerationMps2: number,
): Vec3 => {
  const centripetalScale = checkedFinite(
    speedMps * speedMps,
    "telemetry.worldAccelerationMps2",
    "World acceleration must be finite",
  );
  return checkedVector(
    add(
      scale(sample.tangent, accelerationMps2),
      scale(sample.curvatureVector, centripetalScale),
    ),
    "telemetry.worldAccelerationMps2",
    "World acceleration must be finite",
  );
};

const carTelemetry = (
  sample: TrackSample,
  worldAccelerationMps2: Vec3,
  gravity: Vec3,
  gravityMps2: number,
  speedMps: number,
): CarTelemetry => {
  const specific = checkedVector(
    subtract(worldAccelerationMps2, gravity),
    "telemetry.specificForceMps2",
    "Specific force must be finite",
  );
  const right = scale(sample.binormal, -1);
  const telemetry = {
    longitudinalG: checkedFinite(
      dot(specific, sample.tangent) / gravityMps2,
      "telemetry.longitudinalG",
      "Longitudinal G must be finite",
    ),
    lateralG: checkedFinite(
      dot(specific, right) / gravityMps2,
      "telemetry.lateralG",
      "Lateral G must be finite",
    ),
    verticalG: checkedFinite(
      dot(specific, sample.normal) / gravityMps2,
      "telemetry.verticalG",
      "Vertical G must be finite",
    ),
    specificForceMps2: specific,
    jerkMps3: vec3(),
    bankRad: sample.bank,
    rollRateRadPerSec: sample.bankDerivative * speedMps,
  };
  checkedFinite(
    telemetry.bankRad,
    "telemetry.bankRad",
    "Bank telemetry must be finite",
  );
  checkedFinite(
    telemetry.rollRateRadPerSec,
    "telemetry.rollRateRadPerSec",
    "Roll-rate telemetry must be finite",
  );
  return telemetry;
};

const makeTelemetry = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  cars: readonly CarState[],
  speedMps: number,
  work: WorkState,
  initialEnergyJ: number,
  launchActivity: boolean,
  brakeActivity: boolean,
): RideTelemetry => {
  const gravity = gravityVector(config);
  const perCar = cars.map((car) => car.telemetry);
  const first =
    perCar[0] ??
    carTelemetry(
      sampleTrackAtDistance(track, 0),
      vec3(),
      gravity,
      config.gravityMps2,
      speedMps,
    );
  const totalMassKg = totalMass(config.train);
  const kineticEnergyJ = checkedFinite(
    0.5 * totalMassKg * speedMps * speedMps,
    "telemetry.kineticEnergyJ",
    "Kinetic energy must be finite",
  );
  const potentialEnergyJ = sumFinite(
    cars.map(
      (car, index) =>
        -(config.train.cars[index]?.massKg ?? 0) * dot(gravity, car.position),
    ),
    "telemetry.potentialEnergyJ",
    "Potential energy must be finite",
  );
  const accumulatedDriveWorkJ = checkedFinite(
    work.driveJ,
    "telemetry.accumulatedDriveWorkJ",
    "Accumulated drive work must be finite",
  );
  const accumulatedLossWorkJ = checkedFinite(
    work.lossJ,
    "telemetry.accumulatedLossWorkJ",
    "Accumulated loss work must be finite",
  );
  const energyErrorJ = sumFinite(
    [
      initialEnergyJ,
      accumulatedDriveWorkJ,
      -accumulatedLossWorkJ,
      -kineticEnergyJ,
      -potentialEnergyJ,
    ],
    "telemetry.energyErrorJ",
    "Energy residual must be finite",
  );
  return {
    perCar,
    longitudinalG: first.longitudinalG,
    lateralG: first.lateralG,
    verticalG: first.verticalG,
    specificForceMps2: first.specificForceMps2,
    jerkMps3: first.jerkMps3,
    bankRad: first.bankRad,
    rollRateRadPerSec: first.rollRateRadPerSec,
    launchActivity,
    brakeActivity,
    kineticEnergyJ,
    potentialEnergyJ,
    accumulatedDriveWorkJ,
    accumulatedLossWorkJ,
    energyErrorJ,
  };
};

const statusFor = (
  previousSpeedMps: number,
  speedMps: number,
  accelerationMps2: number,
  force: number,
  staticLimit: number,
): SimulationStatus => {
  if (Math.abs(speedMps) <= SPEED_EPSILON) {
    if (previousSpeedMps !== 0) return "stall";
    if (Math.abs(force) <= staticLimit) return "static-hold";
  }
  if (previousSpeedMps * speedMps < 0) return "reversal";
  if (Math.abs(previousSpeedMps) <= SPEED_EPSILON && speedMps < 0)
    return "rollback";
  if (Math.abs(speedMps) <= SPEED_EPSILON && Math.abs(accelerationMps2) <= 1e-7)
    return "stall";
  return "rolling";
};

const operationStateFor = (zones: readonly OperationZone[]): OperationState => {
  const blocks = zones
    .filter((zone) => zone.kind === "block")
    .map((zone) => zone.blockId ?? zone.id);
  const station = zones.find((zone) => zone.kind === "station");
  return {
    trainCount: 1,
    activeZoneIds: zones.map((zone) => zone.id),
    occupiedBlockIds: [...new Set(blocks)],
    ...(station ? { stationId: station.id } : {}),
  };
};

const zoneCrossings = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  zones: readonly OperationZone[],
  occupancyCounts: Map<string, number>,
  previousDistanceM: number,
  nextDistanceM: number,
  previousTimeSeconds: number,
  stepSeconds: number,
): readonly SimulationEvent[] => {
  const delta = nextDistanceM - previousDistanceM;
  if (delta === 0) return [];
  const direction = delta > 0 ? "forward" : "reverse";
  const candidates: {
    readonly zone: OperationZone;
    readonly boundary: "start" | "end";
    readonly carIndex: number;
    readonly timeSeconds: number;
    readonly delta: 1 | -1;
  }[] = [];
  for (const zone of zones) {
    for (let carIndex = 0; carIndex < config.train.cars.length; carIndex += 1) {
      const carOffset = carIndex * config.train.spacingM;
      for (const [boundary, distance] of [
        ["start", zone.startDistanceM],
        ["end", zone.endDistanceM],
      ] as const) {
        const baseDistance = distance + carOffset;
        const lower = Math.min(previousDistanceM, nextDistanceM);
        const upper = Math.max(previousDistanceM, nextDistanceM);
        const firstLap = config.closedTrack
          ? Math.floor((lower - baseDistance) / track.totalLength)
          : 0;
        const lastLap = config.closedTrack
          ? Math.ceil((upper - baseDistance) / track.totalLength)
          : 0;
        for (let lap = firstLap; lap <= lastLap; lap += 1) {
          const crossingDistance =
            baseDistance + (config.closedTrack ? lap * track.totalLength : 0);
          const crossed =
            direction === "forward"
              ? previousDistanceM < crossingDistance &&
                crossingDistance <= nextDistanceM
              : (previousDistanceM > crossingDistance &&
                  crossingDistance >= nextDistanceM) ||
                (previousTimeSeconds === 0 &&
                  previousDistanceM === crossingDistance &&
                  nextDistanceM < crossingDistance);
          if (!crossed) continue;
          const crossingTime =
            previousTimeSeconds +
            ((crossingDistance - previousDistanceM) / delta) * stepSeconds;
          candidates.push({
            zone,
            boundary,
            carIndex,
            timeSeconds: crossingTime,
            delta:
              direction === "forward"
                ? boundary === "start"
                  ? 1
                  : -1
                : boundary === "end"
                  ? 1
                  : -1,
          });
        }
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.timeSeconds - b.timeSeconds ||
      a.zone.id.localeCompare(b.zone.id) ||
      a.boundary.localeCompare(b.boundary) ||
      a.carIndex - b.carIndex,
  );
  const events: SimulationEvent[] = [];
  for (const zone of zones)
    if (!occupancyCounts.has(zone.id))
      occupancyCounts.set(
        zone.id,
        occupiedCarCount(track, config, zone, previousDistanceM),
      );
  let index = 0;
  while (index < candidates.length) {
    const candidate = candidates[index]!;
    const group = [candidate];
    index += 1;
    while (
      index < candidates.length &&
      candidates[index]!.zone.id === candidate.zone.id &&
      candidates[index]!.timeSeconds === candidate.timeSeconds
    ) {
      group.push(candidates[index]!);
      index += 1;
    }
    const before = occupancyCounts.get(candidate.zone.id) ?? 0;
    const change = group.reduce((sum, crossing) => sum + crossing.delta, 0);
    const after = before + change;
    occupancyCounts.set(candidate.zone.id, after);
    if (!((before === 0 && after > 0) || (before > 0 && after === 0))) continue;
    const entry = before === 0;
    const eventBoundary = entry
      ? direction === "forward"
        ? "start"
        : "end"
      : direction === "forward"
        ? "end"
        : "start";
    events.push({
      timeSeconds: candidate.timeSeconds,
      type: entry ? "zone-entry" : "zone-exit",
      zoneId: candidate.zone.id,
      operation: candidate.zone.kind,
      boundary: eventBoundary,
      direction,
    });
  }
  return events;
};

const withJerk = (
  frames: readonly SimulationFrame[],
): readonly SimulationFrame[] =>
  frames.map((frame, index) => {
    const previousFrame = frames[Math.max(0, index - 1)] ?? frame;
    const nextFrame = frames[Math.min(frames.length - 1, index + 1)] ?? frame;
    const denominator = nextFrame.timeSeconds - previousFrame.timeSeconds;
    const jerk = (previous: Vec3, next: Vec3): Vec3 =>
      denominator > 0
        ? checkedVector(
            scale(subtract(next, previous), 1 / denominator),
            "telemetry.jerkMps3",
            "Jerk telemetry must be finite",
          )
        : vec3();
    const cars = frame.cars.map((car, carIndex) => {
      const previousCar = previousFrame.cars[carIndex] ?? car;
      const nextCar = nextFrame.cars[carIndex] ?? car;
      const seats = car.seats.map((seat, seatIndex) => {
        const previousSeat = previousCar.seats[seatIndex] ?? seat;
        const nextSeat = nextCar.seats[seatIndex] ?? seat;
        return {
          ...seat,
          telemetry: {
            ...seat.telemetry,
            jerkMps3: jerk(
              previousSeat.telemetry.specificForceMps2,
              nextSeat.telemetry.specificForceMps2,
            ),
          },
        };
      });
      return {
        ...car,
        telemetry: {
          ...car.telemetry,
          jerkMps3: jerk(
            previousCar.telemetry.specificForceMps2,
            nextCar.telemetry.specificForceMps2,
          ),
        },
        seats,
      };
    });
    const perCar = cars.map((car) => car.telemetry);
    const first = perCar[0] ?? frame.telemetry;
    return {
      ...frame,
      cars,
      selection: {
        front: cars[0] as CarState,
        middle: cars[Math.floor((cars.length - 1) / 2)] as CarState,
        rear: cars[cars.length - 1] as CarState,
      },
      telemetry: {
        ...frame.telemetry,
        perCar,
        jerkMps3: first.jerkMps3,
      },
    };
  });

const timelineSampleRate = (timelineStepSeconds: number): number =>
  finite(timelineStepSeconds) &&
  timelineStepSeconds > 0 &&
  finite(1 / timelineStepSeconds)
    ? 1 / timelineStepSeconds
    : SAFE_TIMELINE_SAMPLE_RATE_HZ;

/**
 * Monotonic bracket locator shared by compact and full makeTimeline paths.
 * Advances at most once per monotonic output time, guaranteeing O(frames+outputs).
 */
export function createMonotonicBracketLocator(
  frames: readonly { readonly timeSeconds: number }[],
): (timeSeconds: number) => number {
  let cursor = 0;
  return (timeSeconds: number): number => {
    while (
      cursor < frames.length - 1 &&
      frames[cursor]!.timeSeconds < timeSeconds
    )
      cursor += 1;
    return cursor;
  };
}

const makeTimeline = (
  track: CompiledTrackData,
  frames: readonly SimulationFrame[],
  config: SimulatorConfig,
  compact = false,
): RideTimeline => {
  if (frames.length === 0)
    return new RideTimeline({
      sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
      timeSeconds: new Float64Array(),
      headDistanceM: new Float64Array(),
      speedMps: new Float64Array(),
    });
  const durationSeconds = frames[frames.length - 1]!.timeSeconds;
  const outputTimes: number[] = [];
  for (
    let index = 0;
    index * config.timelineStepSeconds < durationSeconds - 1e-12;
    index += 1
  )
    outputTimes.push(index * config.timelineStepSeconds);
  outputTimes.push(durationSeconds);
  const length = outputTimes.length;
  const carCount = frames[0]?.cars.length ?? 0;
  const interpolateTelemetry = (
    left: CarTelemetry,
    right: CarTelemetry,
    alpha: number,
  ): CarTelemetry => {
    const blend = (a: number, b: number): number => a * (1 - alpha) + b * alpha;
    const blendVec = (a: Vec3, b: Vec3): Vec3 =>
      vec3(blend(a[0], b[0]), blend(a[1], b[1]), blend(a[2], b[2]));
    return {
      longitudinalG: blend(left.longitudinalG, right.longitudinalG),
      lateralG: blend(left.lateralG, right.lateralG),
      verticalG: blend(left.verticalG, right.verticalG),
      specificForceMps2: blendVec(
        left.specificForceMps2,
        right.specificForceMps2,
      ),
      jerkMps3: blendVec(left.jerkMps3, right.jerkMps3),
      bankRad: blend(left.bankRad, right.bankRad),
      rollRateRadPerSec: blend(left.rollRateRadPerSec, right.rollRateRadPerSec),
    };
  };
  // Linear bracket search and streaming SoA
  if (compact) {
    const timeSeconds = new Float64Array(outputTimes);
    const headDistanceM = new Float64Array(length);
    const speedMps = new Float64Array(length);
    const longitudinalG = new Float64Array(length);
    const lateralG = new Float64Array(length);
    const verticalG = new Float64Array(length);
    const jerkMps3 = new Float64Array(length * 3);
    const launchActivity = new Float64Array(length);
    const brakeActivity = new Float64Array(length);
    const kineticEnergyJ = new Float64Array(length);
    const potentialEnergyJ = new Float64Array(length);
    const accumulatedDriveWorkJ = new Float64Array(length);
    const accumulatedLossWorkJ = new Float64Array(length);
    const energyErrorJ = new Float64Array(length);
    const bankRad = new Float64Array(length);
    const rollRateRadPerSec = new Float64Array(length);
    const specificForceXYZ = new Float64Array(length * 3);
    const carPositionsXYZ = new Float64Array(length * carCount * 3);
    const carTangentsXYZ = new Float64Array(length * carCount * 3);
    const carNormalsXYZ = new Float64Array(length * carCount * 3);
    const carBinormalsXYZ = new Float64Array(length * carCount * 3);
    const perCarLongitudinalG = new Float64Array(length * carCount);
    const perCarLateralG = new Float64Array(length * carCount);
    const perCarVerticalG = new Float64Array(length * carCount);
    const perCarBankRad = new Float64Array(length * carCount);
    const perCarRollRateRadPerSec = new Float64Array(length * carCount);
    const perCarSpecificForceXYZ = new Float64Array(length * carCount * 3);
    const perCarJerkXYZ = new Float64Array(length * carCount * 3);
    const locateCompact = createMonotonicBracketLocator(frames);
    for (let outIndex = 0; outIndex < length; outIndex += 1) {
      const time = outputTimes[outIndex]!;
      const upper = locateCompact(time);
      const lower = Math.max(0, upper - 1);
      const left = frames[lower]!;
      const right = frames[upper]!;
      const span = right.timeSeconds - left.timeSeconds;
      const alpha = span > 0 ? (time - left.timeSeconds) / span : 0;
      const blend = (a: number, b: number): number =>
        a * (1 - alpha) + b * alpha;
      headDistanceM[outIndex] = blend(left.headDistanceM, right.headDistanceM);
      speedMps[outIndex] = blend(left.speedMps, right.speedMps);
      // ride telemetry blending
      const firstLeft = left.telemetry.perCar[0] ?? left.telemetry;
      const firstRight = right.telemetry.perCar[0] ?? right.telemetry;
      const rideLeft = left.telemetry;
      const rideRight = right.telemetry;
      // front G
      longitudinalG[outIndex] = blend(
        firstLeft.longitudinalG,
        firstRight.longitudinalG,
      );
      lateralG[outIndex] = blend(firstLeft.lateralG, firstRight.lateralG);
      verticalG[outIndex] = blend(firstLeft.verticalG, firstRight.verticalG);
      // jerk
      for (let k = 0; k < 3; k += 1)
        jerkMps3[outIndex * 3 + k] = blend(
          firstLeft.jerkMps3[k]!,
          firstRight.jerkMps3[k]!,
        );
      // energy & activity
      launchActivity[outIndex] =
        alpha < 0.5
          ? rideLeft.launchActivity
            ? 1
            : 0
          : rideRight.launchActivity
            ? 1
            : 0;
      brakeActivity[outIndex] =
        alpha < 0.5
          ? rideLeft.brakeActivity
            ? 1
            : 0
          : rideRight.brakeActivity
            ? 1
            : 0;
      kineticEnergyJ[outIndex] = blend(
        rideLeft.kineticEnergyJ,
        rideRight.kineticEnergyJ,
      );
      potentialEnergyJ[outIndex] = blend(
        rideLeft.potentialEnergyJ,
        rideRight.potentialEnergyJ,
      );
      accumulatedDriveWorkJ[outIndex] = blend(
        rideLeft.accumulatedDriveWorkJ,
        rideRight.accumulatedDriveWorkJ,
      );
      accumulatedLossWorkJ[outIndex] = blend(
        rideLeft.accumulatedLossWorkJ,
        rideRight.accumulatedLossWorkJ,
      );
      energyErrorJ[outIndex] = blend(
        rideLeft.energyErrorJ,
        rideRight.energyErrorJ,
      );
      bankRad[outIndex] = blend(rideLeft.bankRad, rideRight.bankRad);
      rollRateRadPerSec[outIndex] = blend(
        rideLeft.rollRateRadPerSec,
        rideRight.rollRateRadPerSec,
      );
      for (let k = 0; k < 3; k += 1)
        specificForceXYZ[outIndex * 3 + k] = blend(
          rideLeft.specificForceMps2[k]!,
          rideRight.specificForceMps2[k]!,
        );
      // per-car transforms and telemetry
      for (let carIndex = 0; carIndex < carCount; carIndex += 1) {
        const leftCar = left.cars[carIndex]!;
        const rightCar = right.cars[carIndex] ?? leftCar;
        const distanceM = blend(leftCar.distanceM, rightCar.distanceM);
        const sampled = sampleTrackAtDistance(
          track,
          trackDistance(track, config, distanceM),
        );
        const baseOffset = (outIndex * carCount + carIndex) * 3;
        carPositionsXYZ[baseOffset] = sampled.position[0]!;
        carPositionsXYZ[baseOffset + 1] = sampled.position[1]!;
        carPositionsXYZ[baseOffset + 2] = sampled.position[2]!;
        carTangentsXYZ[baseOffset] = sampled.tangent[0]!;
        carTangentsXYZ[baseOffset + 1] = sampled.tangent[1]!;
        carTangentsXYZ[baseOffset + 2] = sampled.tangent[2]!;
        carNormalsXYZ[baseOffset] = sampled.normal[0]!;
        carNormalsXYZ[baseOffset + 1] = sampled.normal[1]!;
        carNormalsXYZ[baseOffset + 2] = sampled.normal[2]!;
        carBinormalsXYZ[baseOffset] = sampled.binormal[0]!;
        carBinormalsXYZ[baseOffset + 1] = sampled.binormal[1]!;
        carBinormalsXYZ[baseOffset + 2] = sampled.binormal[2]!;
        const carTele = interpolateTelemetry(
          leftCar.telemetry,
          rightCar.telemetry,
          alpha,
        );
        const flatIdx = outIndex * carCount + carIndex;
        perCarLongitudinalG[flatIdx] = carTele.longitudinalG;
        perCarLateralG[flatIdx] = carTele.lateralG;
        perCarVerticalG[flatIdx] = carTele.verticalG;
        perCarBankRad[flatIdx] = carTele.bankRad;
        perCarRollRateRadPerSec[flatIdx] = carTele.rollRateRadPerSec;
        const vecBase = flatIdx * 3;
        perCarSpecificForceXYZ[vecBase] = carTele.specificForceMps2[0]!;
        perCarSpecificForceXYZ[vecBase + 1] = carTele.specificForceMps2[1]!;
        perCarSpecificForceXYZ[vecBase + 2] = carTele.specificForceMps2[2]!;
        perCarJerkXYZ[vecBase] = carTele.jerkMps3[0]!;
        perCarJerkXYZ[vecBase + 1] = carTele.jerkMps3[1]!;
        perCarJerkXYZ[vecBase + 2] = carTele.jerkMps3[2]!;
      }
    }
    return new RideTimeline({
      sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
      timeSeconds,
      headDistanceM,
      speedMps,
      longitudinalG,
      lateralG,
      verticalG,
      jerkMps3,
      carCount,
      carPositionsXYZ,
      carTangentsXYZ,
      carNormalsXYZ,
      carBinormalsXYZ,
      launchActivity,
      brakeActivity,
      kineticEnergyJ,
      potentialEnergyJ,
      accumulatedDriveWorkJ,
      accumulatedLossWorkJ,
      energyErrorJ,
      bankRad,
      rollRateRadPerSec,
      specificForceXYZ,
      perCarLongitudinalG,
      perCarLateralG,
      perCarVerticalG,
      perCarBankRad,
      perCarRollRateRadPerSec,
      perCarSpecificForceXYZ,
      perCarJerkXYZ,
      frames: [],
    });
  }
  // Full path: monotonic cursor without streaming, retains frames
  const locateFull = createMonotonicBracketLocator(frames);
  const interpolateFrame = (time: number): SimulationFrame => {
    const upper = locateFull(time);
    const lower = Math.max(0, upper - 1);
    const left = frames[lower]!;
    const right = frames[upper]!;
    const span = right.timeSeconds - left.timeSeconds;
    const alpha = span > 0 ? (time - left.timeSeconds) / span : 0;
    const blend = (a: number, b: number): number => a * (1 - alpha) + b * alpha;
    const cars = left.cars.map((car, carIndex) => {
      const other = right.cars[carIndex] ?? car;
      const distanceM = blend(car.distanceM, other.distanceM);
      const frame = sampleTrackAtDistance(
        track,
        trackDistance(track, config, distanceM),
      );
      const telemetry = interpolateTelemetry(
        car.telemetry,
        other.telemetry,
        alpha,
      );
      const seats = car.seats.map((seat, seatIndex) => {
        const otherSeat = other.seats[seatIndex] ?? seat;
        const seatDistanceM = checkedFinite(
          blend(seat.distanceM, otherSeat.distanceM),
          `timeline.frames.cars[${carIndex}].seats[${seatIndex}].distanceM`,
          "Seat distance must be finite",
        );
        const seatFrame = sampleTrackAtDistance(
          track,
          trackDistance(track, config, seatDistanceM),
        );
        const offset = car.seatOffsets[seatIndex] ?? vec3();
        return {
          ...seat,
          distanceM: seatDistanceM,
          position: seatWorldPosition(
            seatFrame,
            offset,
            `timeline.frames.cars[${carIndex}].seats[${seatIndex}].position`,
          ),
          frame: seatFrame,
          telemetry: interpolateTelemetry(
            seat.telemetry,
            otherSeat.telemetry,
            alpha,
          ),
        };
      });
      return {
        ...car,
        distanceM,
        position: frame.position,
        tangent: frame.tangent,
        normal: frame.normal,
        binormal: frame.binormal,
        frame,
        telemetry,
        seats,
        seatPositions: seats.map((seat) => seat.position),
      };
    });
    const perCar = cars.map((car) => car.telemetry);
    const first = perCar[0] ?? left.telemetry;
    return {
      ...left,
      timeSeconds: time,
      headDistanceM: blend(left.headDistanceM, right.headDistanceM),
      speedMps: blend(left.speedMps, right.speedMps),
      status: alpha < 0.5 ? left.status : right.status,
      cars,
      selection: {
        front: cars[0] as CarState,
        middle: cars[Math.floor((cars.length - 1) / 2)] as CarState,
        rear: cars[cars.length - 1] as CarState,
      },
      telemetry: {
        ...left.telemetry,
        perCar,
        longitudinalG: first.longitudinalG,
        lateralG: first.lateralG,
        verticalG: first.verticalG,
        specificForceMps2: first.specificForceMps2,
        bankRad: first.bankRad,
        rollRateRadPerSec: first.rollRateRadPerSec,
        jerkMps3: first.jerkMps3,
        launchActivity:
          alpha < 0.5
            ? left.telemetry.launchActivity
            : right.telemetry.launchActivity,
        brakeActivity:
          alpha < 0.5
            ? left.telemetry.brakeActivity
            : right.telemetry.brakeActivity,
        kineticEnergyJ: blend(
          left.telemetry.kineticEnergyJ,
          right.telemetry.kineticEnergyJ,
        ),
        potentialEnergyJ: blend(
          left.telemetry.potentialEnergyJ,
          right.telemetry.potentialEnergyJ,
        ),
        accumulatedDriveWorkJ: blend(
          left.telemetry.accumulatedDriveWorkJ,
          right.telemetry.accumulatedDriveWorkJ,
        ),
        accumulatedLossWorkJ: blend(
          left.telemetry.accumulatedLossWorkJ,
          right.telemetry.accumulatedLossWorkJ,
        ),
        energyErrorJ: blend(
          left.telemetry.energyErrorJ,
          right.telemetry.energyErrorJ,
        ),
      },
    };
  };
  const selected = outputTimes.map(interpolateFrame);
  const flatten = (pick: (car: CarState) => Vec3): Float64Array => {
    const output = new Float64Array(selected.length * carCount * 3);
    selected.forEach((frame, frameIndex) =>
      frame.cars.forEach((car, carIndex) => {
        const value = pick(car);
        output.set(value, (frameIndex * carCount + carIndex) * 3);
      }),
    );
    return output;
  };
  // Populate compact arrays also for full path to allow identical SoA comparison
  const fullLongitudinal = new Float64Array(
    selected.map((frame) => frame.telemetry.longitudinalG),
  );
  const fullLateral = new Float64Array(
    selected.map((frame) => frame.telemetry.lateralG),
  );
  const fullVertical = new Float64Array(
    selected.map((frame) => frame.telemetry.verticalG),
  );
  const fullJerk = new Float64Array(
    selected.flatMap((frame) => frame.telemetry.jerkMps3),
  );
  const fullLaunch = new Float64Array(
    selected.map((f) => (f.telemetry.launchActivity ? 1 : 0)),
  );
  const fullBrake = new Float64Array(
    selected.map((f) => (f.telemetry.brakeActivity ? 1 : 0)),
  );
  const fullKinetic = new Float64Array(
    selected.map((f) => f.telemetry.kineticEnergyJ),
  );
  const fullPotential = new Float64Array(
    selected.map((f) => f.telemetry.potentialEnergyJ),
  );
  const fullDrive = new Float64Array(
    selected.map((f) => f.telemetry.accumulatedDriveWorkJ),
  );
  const fullLoss = new Float64Array(
    selected.map((f) => f.telemetry.accumulatedLossWorkJ),
  );
  const fullResidual = new Float64Array(
    selected.map((f) => f.telemetry.energyErrorJ),
  );
  const fullBank = new Float64Array(selected.map((f) => f.telemetry.bankRad));
  const fullRoll = new Float64Array(
    selected.map((f) => f.telemetry.rollRateRadPerSec),
  );
  const fullSpecific = new Float64Array(
    selected.flatMap((f) => f.telemetry.specificForceMps2),
  );
  const perCarLen = selected.length * carCount;
  const fullPerCarLong = new Float64Array(perCarLen);
  const fullPerCarLat = new Float64Array(perCarLen);
  const fullPerCarVert = new Float64Array(perCarLen);
  const fullPerCarBank = new Float64Array(perCarLen);
  const fullPerCarRoll = new Float64Array(perCarLen);
  const fullPerCarSpec = new Float64Array(perCarLen * 3);
  const fullPerCarJerk = new Float64Array(perCarLen * 3);
  selected.forEach((frame, fi) =>
    frame.cars.forEach((car, ci) => {
      const idx = fi * carCount + ci;
      fullPerCarLong[idx] = car.telemetry.longitudinalG;
      fullPerCarLat[idx] = car.telemetry.lateralG;
      fullPerCarVert[idx] = car.telemetry.verticalG;
      fullPerCarBank[idx] = car.telemetry.bankRad;
      fullPerCarRoll[idx] = car.telemetry.rollRateRadPerSec;
      fullPerCarSpec.set(car.telemetry.specificForceMps2, idx * 3);
      fullPerCarJerk.set(car.telemetry.jerkMps3, idx * 3);
    }),
  );
  return new RideTimeline({
    sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
    timeSeconds: new Float64Array(outputTimes),
    headDistanceM: new Float64Array(
      selected.map((frame) => frame.headDistanceM),
    ),
    speedMps: new Float64Array(selected.map((frame) => frame.speedMps)),
    longitudinalG: fullLongitudinal,
    lateralG: fullLateral,
    verticalG: fullVertical,
    jerkMps3: fullJerk,
    carCount,
    carPositionsXYZ: flatten((car) => car.position),
    carTangentsXYZ: flatten((car) => car.tangent),
    carNormalsXYZ: flatten((car) => car.normal),
    carBinormalsXYZ: flatten((car) => car.binormal),
    launchActivity: fullLaunch,
    brakeActivity: fullBrake,
    kineticEnergyJ: fullKinetic,
    potentialEnergyJ: fullPotential,
    accumulatedDriveWorkJ: fullDrive,
    accumulatedLossWorkJ: fullLoss,
    energyErrorJ: fullResidual,
    bankRad: fullBank,
    rollRateRadPerSec: fullRoll,
    specificForceXYZ: fullSpecific,
    perCarLongitudinalG: fullPerCarLong,
    perCarLateralG: fullPerCarLat,
    perCarVerticalG: fullPerCarVert,
    perCarBankRad: fullPerCarBank,
    perCarRollRateRadPerSec: fullPerCarRoll,
    perCarSpecificForceXYZ: fullPerCarSpec,
    perCarJerkXYZ: fullPerCarJerk,
    frames: selected,
  });
};

const diagnosticFromError = (error: unknown): SimulationDiagnostic => {
  if (error instanceof SimulatorRangeError)
    return {
      code: error.diagnosticCode,
      severity: "error",
      field: error.field,
      message: error.message,
    };
  return {
    code: "SIM_NUMERICAL",
    severity: "error",
    field: "state",
    message: "Fixed-step integration produced a non-finite state",
  };
};

export const simulateRide = (
  track: CompiledTrackData,
  request: SimulationRequest,
): SimulationResult => {
  const diagnostics = [...validate(request, track)];
  if (!finite(track.totalLength) || track.totalLength < 0)
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "track.totalLength",
      message: "Compiled track length must be finite and non-negative",
    });
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return {
      frames: [],
      timeline: new RideTimeline({
        sampleRateHz: timelineSampleRate(request.config.timelineStepSeconds),
        timeSeconds: new Float64Array(),
        headDistanceM: new Float64Array(),
        speedMps: new Float64Array(),
      }),
      events: [],
      operationState: {
        trainCount: 1,
        activeZoneIds: [],
        occupiedBlockIds: [],
      },
      diagnostics,
    };

  const { config, initial } = request;
  let mass: number;
  let initialDynamics: DynamicsSample;
  try {
    mass = totalMass(config.train);
    initialDynamics = dynamicsAt(
      track,
      config,
      initial.headDistanceM,
      initial.speedMps,
    );
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
    return {
      frames: [],
      timeline: new RideTimeline({
        sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
        timeSeconds: new Float64Array(),
        headDistanceM: new Float64Array(),
        speedMps: new Float64Array(),
      }),
      events: [],
      operationState: {
        trainCount: 1,
        activeZoneIds: [],
        occupiedBlockIds: [],
      },
      diagnostics,
    };
  }
  const invalidInitialForce = initialDynamics.forces.findIndex(
    (force) => !forceIsFinite(force),
  );
  if (invalidInitialForce >= 0) {
    diagnostics.push({
      code: "SIM_NUMERICAL",
      severity: "error",
      field: "state",
      message: "Fixed-step integration produced a non-finite state",
    });
    return {
      frames: [],
      timeline: new RideTimeline({
        sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
        timeSeconds: new Float64Array(),
        headDistanceM: new Float64Array(),
        speedMps: new Float64Array(),
      }),
      events: [],
      operationState: {
        trainCount: 1,
        activeZoneIds: [],
        occupiedBlockIds: [],
      },
      diagnostics,
    };
  }
  let initialCars: readonly CarState[];
  let initialEnergyJ: number;
  try {
    initialCars = makeCars(
      track,
      config,
      initial.headDistanceM,
      initial.speedMps,
      initialDynamics.accelerationMps2,
    );
    const gravity = gravityVector(config);
    const initialPotentialJ = sumFinite(
      initialCars.map(
        (car, index) =>
          -(config.train.cars[index]?.massKg ?? 0) * dot(gravity, car.position),
      ),
      "telemetry.potentialEnergyJ",
      "Potential energy must be finite",
    );
    const initialKineticJ = checkedFinite(
      0.5 * mass * initial.speedMps * initial.speedMps,
      "telemetry.kineticEnergyJ",
      "Kinetic energy must be finite",
    );
    initialEnergyJ = sumFinite(
      [initialPotentialJ, initialKineticJ],
      "telemetry.initialEnergyJ",
      "Initial energy must be finite",
    );
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
    return {
      frames: [],
      timeline: new RideTimeline({
        sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
        timeSeconds: new Float64Array(),
        headDistanceM: new Float64Array(),
        speedMps: new Float64Array(),
      }),
      events: [],
      operationState: {
        trainCount: 1,
        activeZoneIds: [],
        occupiedBlockIds: [],
      },
      diagnostics,
    };
  }
  const work: WorkState = { driveJ: 0, lossJ: 0 };
  const frames: SimulationFrame[] = [];
  const events: SimulationEvent[] = [];
  let timeSeconds = 0;
  let distanceM = initial.headDistanceM;
  let speedMps = initial.speedMps;
  let hasStalled = false;
  const initialDirection = speedMps < 0 ? "reverse" : "forward";
  const zoneOccupancy = new Map(
    config.zones.map((zone) => [
      zone.id,
      occupiedCarCount(track, config, zone, distanceM),
    ]),
  );
  for (const zone of config.zones) {
    if ((zoneOccupancy.get(zone.id) ?? 0) === 0) continue;
    const reverseAtStart =
      initialDirection === "reverse" &&
      config.train.cars.some((_, index) => {
        const carDistanceM = distanceM - index * config.train.spacingM;
        const canonicalDistanceM = config.closedTrack
          ? wrappedDistance(track, carDistanceM)
          : carDistanceM;
        return (
          canonicalDistanceM === zone.startDistanceM &&
          zoneContains(track, zone, carDistanceM, config.closedTrack)
        );
      });
    if (reverseAtStart) continue;
    events.push({
      timeSeconds: 0,
      type: "zone-entry",
      zoneId: zone.id,
      operation: zone.kind,
      boundary: initialDirection === "forward" ? "start" : "end",
      direction: initialDirection,
    });
  }

  const addFrame = (
    time: number,
    currentDistance: number,
    currentSpeed: number,
    previousSpeed: number,
  ): void => {
    const dynamics = dynamicsAt(track, config, currentDistance, currentSpeed);
    const cars = makeCars(
      track,
      config,
      currentDistance,
      currentSpeed,
      dynamics.accelerationMps2,
    );
    const telemetry = makeTelemetry(
      track,
      config,
      cars,
      currentSpeed,
      work,
      initialEnergyJ,
      dynamics.forces.some((force) => force.launchActive),
      dynamics.forces.some((force) => force.brakeActive),
    );
    const staticLimit = dynamics.staticStictionCapacityN;
    const computedStatus = statusFor(
      previousSpeed,
      currentSpeed,
      dynamics.accelerationMps2,
      dynamics.totalForce,
      staticLimit,
    );
    const status =
      hasStalled && Math.abs(currentSpeed) <= SPEED_EPSILON
        ? "stall"
        : computedStatus;
    if (status === "stall") hasStalled = true;
    frames.push({
      timeSeconds: time,
      headDistanceM: currentDistance,
      speedMps: currentSpeed,
      status,
      cars,
      selection: {
        front: cars[0] as CarState,
        middle: cars[Math.floor((cars.length - 1) / 2)] as CarState,
        rear: cars[cars.length - 1] as CarState,
      },
      telemetry,
    });
  };
  try {
    addFrame(0, distanceM, speedMps, speedMps);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
    return {
      frames: [],
      timeline: new RideTimeline({
        sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
        timeSeconds: new Float64Array(),
        headDistanceM: new Float64Array(),
        speedMps: new Float64Array(),
      }),
      events: [],
      operationState: {
        trainCount: 1,
        activeZoneIds: [],
        occupiedBlockIds: [],
      },
      diagnostics,
    };
  }
  while (timeSeconds < request.durationSeconds - 1e-12) {
    const step = Math.min(
      config.fixedStepSeconds,
      request.durationSeconds - timeSeconds,
    );
    const nextTime = timeSeconds + step;
    if (!finite(nextTime) || nextTime <= timeSeconds) {
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field: "fixedStepSeconds",
        message: "Fixed simulation step cannot advance simulation time",
      });
      break;
    }
    const previousDistance = distanceM;
    const previousSpeed = speedMps;
    let previousDynamics: DynamicsSample;
    try {
      previousDynamics = dynamicsAt(track, config, distanceM, speedMps);
    } catch (error) {
      diagnostics.push(diagnosticFromError(error));
      break;
    }
    let elapsedStep = step;
    let boundaryError: OpenTrackBoundaryError | undefined;
    try {
      const advanced = boundedRk4(track, config, distanceM, speedMps, step);
      distanceM = advanced.distanceM;
      speedMps = advanced.speedMps;
      elapsedStep = advanced.elapsedSeconds;
      boundaryError = advanced.boundaryError;
    } catch (error) {
      diagnostics.push(diagnosticFromError(error));
      break;
    }
    let nextDynamics: DynamicsSample;
    try {
      nextDynamics = dynamicsAt(track, config, distanceM, speedMps);
    } catch (error) {
      diagnostics.push(diagnosticFromError(error));
      break;
    }
    const invalidForce = nextDynamics.forces.findIndex(
      (force) => !forceIsFinite(force),
    );
    if (invalidForce >= 0) {
      diagnostics.push({
        code: "SIM_NUMERICAL",
        severity: "error",
        field: `train.cars[${invalidForce}].force`,
        message: "Per-car force computation produced non-finite data",
      });
      break;
    }
    if (
      previousSpeed !== 0 &&
      (previousSpeed * speedMps < 0 ||
        Math.abs(speedMps) <=
          Math.max(
            SPEED_EPSILON,
            step * Math.max(1, Math.abs(nextDynamics.accelerationMps2)),
          ))
    ) {
      const atRest = dynamicsAt(track, config, distanceM, 0);
      if (Math.abs(atRest.totalForce) <= atRest.staticStictionCapacityN)
        speedMps = 0;
    }
    const averageForces = previousDynamics.forces.map((force, index) => {
      const next = nextDynamics.forces[index];
      return {
        drive: (force.drive + (next?.drive ?? force.drive)) / 2,
        loss:
          (force.rolling +
            force.drag +
            force.brake +
            (next?.rolling ?? force.rolling) +
            (next?.drag ?? force.drag) +
            (next?.brake ?? force.brake)) /
          2,
      };
    });
    const deltaDistance = distanceM - previousDistance;
    try {
      const driveWork = sumFinite(
        averageForces.map((force) => force.drive * deltaDistance),
        "work.driveJ",
        "Drive work increment must be finite",
      );
      work.driveJ = checkedFinite(
        work.driveJ + driveWork,
        "work.driveJ",
        "Accumulated drive work must be finite",
      );
      const lossWork = sumFinite(
        averageForces.map((force) => -force.loss * deltaDistance),
        "work.lossJ",
        "Loss work increment must be finite",
      );
      work.lossJ = checkedFinite(
        work.lossJ + lossWork,
        "work.lossJ",
        "Accumulated loss work must be finite",
      );
    } catch (error) {
      diagnostics.push(diagnosticFromError(error));
      break;
    }
    timeSeconds += elapsedStep;
    if (request.durationSeconds - timeSeconds < 1e-12)
      timeSeconds = request.durationSeconds;
    events.push(
      ...zoneCrossings(
        track,
        config,
        config.zones,
        zoneOccupancy,
        previousDistance,
        distanceM,
        timeSeconds - elapsedStep,
        elapsedStep,
      ),
    );
    try {
      addFrame(timeSeconds, distanceM, speedMps, previousSpeed);
    } catch (error) {
      diagnostics.push(diagnosticFromError(error));
      break;
    }
    if (boundaryError) {
      diagnostics.push({
        code: boundaryError.diagnosticCode,
        severity: "error",
        field: boundaryError.field,
        message: boundaryError.message,
      });
      break;
    }
  }
  let completedFrames: readonly SimulationFrame[];
  try {
    completedFrames = withJerk(frames);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
    completedFrames = [];
  }
  const finalZones = activeZonesForTrain(track, config, distanceM);
  const eventKeys = new Set<string>();
  const uniqueEvents = events.filter((event) => {
    const key = JSON.stringify([
      event.timeSeconds,
      event.type,
      event.zoneId,
      event.boundary,
      event.direction,
    ]);
    if (eventKeys.has(key)) return false;
    eventKeys.add(key);
    return true;
  });
  let timeline: RideTimeline;
  try {
    timeline = makeTimeline(
      track,
      completedFrames,
      config,
      Boolean(request.compactTimeline),
    );
  } catch (error) {
    diagnostics.push(diagnosticFromError(error));
    timeline = new RideTimeline({
      sampleRateHz: timelineSampleRate(config.timelineStepSeconds),
      timeSeconds: new Float64Array(),
      headDistanceM: new Float64Array(),
      speedMps: new Float64Array(),
    });
  }
  return {
    frames: completedFrames,
    timeline,
    events: uniqueEvents,
    operationState: operationStateFor(finalZones),
    diagnostics,
  };
};

export const simulate = (input: {
  readonly track: CompiledTrackData;
  readonly request: SimulationRequest;
}): SimulationResult => simulateRide(input.track, input.request);

export const createSimulator = (
  track: CompiledTrackData,
  config: SimulatorConfig,
) => ({
  simulate: (request: Omit<SimulationRequest, "config">): SimulationResult =>
    simulateRide(track, { ...request, config }),
});

export const computePerCarForces = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
  speedMps: number,
): readonly PerCarForce[] => {
  const diagnostics = [
    ...validate(
      {
        durationSeconds: 0,
        config,
        initial: { headDistanceM, speedMps },
      },
      track,
    ),
  ];
  if (!finite(track.totalLength) || track.totalLength < 0)
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "track.totalLength",
      message: "Compiled track length must be finite and non-negative",
    });
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0)
    throw new RangeError(
      errors
        .map(
          (diagnostic) =>
            `${diagnostic.field ?? "input"}: ${diagnostic.message}`,
        )
        .join("; "),
    );
  let forces: readonly PerCarForce[];
  try {
    forces = dynamicsAt(track, config, headDistanceM, speedMps).forces;
  } catch (error) {
    if (error instanceof SimulatorRangeError)
      throw new RangeError(`${error.field}: ${error.message}`);
    throw error;
  }
  const invalidForce = forces.findIndex((force) => !forceIsFinite(force));
  if (invalidForce >= 0)
    throw new RangeError(
      `train.cars[${invalidForce}].force: Per-car force computation produced non-finite data`,
    );
  return forces;
};
