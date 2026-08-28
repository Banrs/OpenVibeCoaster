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

const DEFAULT_GRAVITY = 9.80665;
const SPEED_EPSILON = 1e-8;

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
}

interface WorkState {
  driveJ: number;
  lossJ: number;
}

const finite = (value: number): boolean => Number.isFinite(value);
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
  const trackDistanceM = closedTrack
    ? wrappedDistance(track, distanceM)
    : distanceM;
  if (trackDistanceM < Math.min(zone.startDistanceM, zone.endDistanceM))
    return false;
  if (trackDistanceM > Math.max(zone.startDistanceM, zone.endDistanceM))
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

const totalMass = (train: TrainConfiguration): number =>
  train.cars.reduce((sum, car) => sum + car.massKg, 0);

const gravityVector = (config: SimulatorConfig): Vec3 =>
  scale(
    vec3Normalize(config.gravityDirection ?? vec3(0, -1, 0)),
    config.gravityMps2,
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
  if (!finite(config.fixedStepSeconds) || config.fixedStepSeconds <= 0)
    diagnostics.push({
      code: "SIM_INVALID_CONFIGURATION",
      severity: "error",
      field: "fixedStepSeconds",
      message: "Fixed simulation step must be positive",
    });
  if (!finite(config.timelineStepSeconds) || config.timelineStepSeconds <= 0)
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
  return diagnostics;
};

const forceAt = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
  speedMps: number,
  car: CarConfiguration,
  carCount: number,
): PerCarForce => {
  const sample = sampleTrackAtDistance(
    track,
    trackDistance(track, config, distanceM),
  );
  const zones = activeZones(track, config, distanceM);
  const gravity = car.massKg * dot(gravityVector(config), sample.tangent);
  const rollingMagnitude =
    config.rollingResistanceCoefficient * car.massKg * config.gravityMps2;
  const rolling =
    Math.abs(speedMps) > SPEED_EPSILON && rollingMagnitude > 0
      ? -Math.sign(speedMps) * rollingMagnitude
      : 0;
  const drag =
    -0.5 *
    config.airDensityKgPerM3 *
    (config.dragCdA / carCount) *
    speedMps *
    Math.abs(speedMps);
  let drive = 0;
  let brake = 0;
  let launchActive = false;
  let brakeActive = false;
  for (const zone of zones) {
    if (zone.kind === "launch" || zone.kind === "boost") {
      launchActive = true;
      const target = zone.targetSpeedMps ?? 0;
      const requested =
        zone.targetSpeedMps === undefined
          ? (zone.lsmForcePerCarN ?? config.lsmForcePerCarN)
          : config.lsmTargetGainNPerMps * (target - speedMps);
      const forceLimit = Math.max(
        0,
        zone.lsmForcePerCarN ?? config.lsmForcePerCarN,
      );
      const powerLimit = Math.max(
        0,
        zone.lsmPowerPerCarW ?? config.lsmPowerPerCarW,
      );
      const capped = Math.max(-forceLimit, Math.min(forceLimit, requested));
      const powerCapped =
        Math.abs(speedMps) > SPEED_EPSILON
          ? Math.sign(capped) *
            Math.min(Math.abs(capped), powerLimit / Math.abs(speedMps))
          : capped;
      drive += powerCapped;
    } else if (zone.kind === "brake") {
      brakeActive = true;
      const limit = Math.max(
        0,
        zone.brakeForcePerCarN ?? config.maxBrakeForcePerCarN,
      );
      brake += -Math.sign(speedMps) * limit;
    }
  }
  return {
    gravity,
    rolling,
    drag,
    drive,
    brake,
    net: gravity + rolling + drag + drive + brake,
    launchActive,
    brakeActive,
  };
};

const dynamicsAt = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  headDistanceM: number,
  speedMps: number,
): DynamicsSample => {
  const forces = config.train.cars.map((car, index) =>
    forceAt(
      track,
      config,
      headDistanceM - index * config.train.spacingM,
      speedMps,
      car,
      config.train.cars.length,
    ),
  );
  const totalForce = forces.reduce((sum, force) => sum + force.net, 0);
  const active = activeZones(track, config, headDistanceM);
  return {
    forces,
    totalForce,
    accelerationMps2: totalForce / totalMass(config.train),
    activeZones: active,
  };
};

const derivative = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
  speedMps: number,
): readonly [number, number] => {
  const sample = dynamicsAt(track, config, distanceM, speedMps);
  const staticLimit =
    config.staticStictionCoefficient *
    totalMass(config.train) *
    config.gravityMps2;
  if (
    Math.abs(speedMps) <= SPEED_EPSILON &&
    Math.abs(sample.totalForce) <= staticLimit
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
  return [
    distanceM + (stepSeconds / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
    speedMps + (stepSeconds / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
  ];
};

const seatPositions = (car: CarConfiguration): readonly Vec3[] =>
  car.seatPositionsM
    ? car.seatPositionsM.map((position) => vec3(...position))
    : Array.from({ length: car.seatCount }, () => vec3(0, 0, 0));

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
      const seatDistanceM = distanceM + offset[2];
      const seatFrame = sampleTrackAtDistance(
        track,
        trackDistance(track, config, seatDistanceM),
      );
      const seatRight = scale(seatFrame.binormal, -1);
      return {
        index: seatIndex,
        distanceM: seatDistanceM,
        position: add(
          seatFrame.position,
          add(scale(seatRight, offset[0]), scale(seatFrame.normal, offset[1])),
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
  return add(
    scale(sample.tangent, accelerationMps2),
    scale(sample.curvatureVector, speedMps * speedMps),
  );
};

const telemetryAxes = (sample: TrackSample, gravity: Vec3): TrackSample => {
  const up = scale(
    gravity,
    -1 / Math.max(Math.hypot(gravity[0], gravity[1], gravity[2]), 1e-30),
  );
  const tangentProjection = dot(up, sample.tangent);
  const projectedUp = subtract(up, scale(sample.tangent, tangentProjection));
  const projectedLength = Math.hypot(
    projectedUp[0],
    projectedUp[1],
    projectedUp[2],
  );
  if (projectedLength <= 1e-12) return sample;
  const unbankedNormal = scale(projectedUp, 1 / projectedLength);
  const unbankedBinormal = vec3Normalize(
    vec3(
      sample.tangent[1] * unbankedNormal[2] -
        sample.tangent[2] * unbankedNormal[1],
      sample.tangent[2] * unbankedNormal[0] -
        sample.tangent[0] * unbankedNormal[2],
      sample.tangent[0] * unbankedNormal[1] -
        sample.tangent[1] * unbankedNormal[0],
    ),
  );
  const normal = vec3Normalize(
    add(
      scale(unbankedNormal, Math.cos(sample.bank)),
      scale(unbankedBinormal, Math.sin(sample.bank)),
    ),
  );
  const binormal = vec3Normalize(
    vec3(
      sample.tangent[1] * normal[2] - sample.tangent[2] * normal[1],
      sample.tangent[2] * normal[0] - sample.tangent[0] * normal[2],
      sample.tangent[0] * normal[1] - sample.tangent[1] * normal[0],
    ),
  );
  return { ...sample, normal, binormal };
};

const carTelemetry = (
  sample: TrackSample,
  worldAccelerationMps2: Vec3,
  gravity: Vec3,
  gravityMps2: number,
  speedMps: number,
): CarTelemetry => {
  const specific = subtract(worldAccelerationMps2, gravity);
  const axes = telemetryAxes(sample, gravity);
  const right = scale(axes.binormal, -1);
  return {
    longitudinalG: dot(specific, axes.tangent) / gravityMps2,
    lateralG: dot(specific, right) / gravityMps2,
    verticalG: dot(specific, axes.normal) / gravityMps2,
    specificForceMps2: specific,
    jerkMps3: vec3(),
    bankRad: axes.bank,
    rollRateRadPerSec: sample.bankDerivative * speedMps,
  };
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
  const kineticEnergyJ = 0.5 * totalMassKg * speedMps * speedMps;
  const potentialEnergyJ = cars.reduce(
    (sum, car, index) =>
      sum -
      (config.train.cars[index]?.massKg ?? 0) * dot(gravity, car.position),
    0,
  );
  const energyErrorJ =
    initialEnergyJ +
    work.driveJ -
    work.lossJ -
    (kineticEnergyJ + potentialEnergyJ);
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
    accumulatedDriveWorkJ: work.driveJ,
    accumulatedLossWorkJ: work.lossJ,
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
  previousDistanceM: number,
  nextDistanceM: number,
  previousTimeSeconds: number,
  stepSeconds: number,
): readonly SimulationEvent[] => {
  const delta = nextDistanceM - previousDistanceM;
  if (delta === 0) return [];
  const direction = delta > 0 ? "forward" : "reverse";
  const crossingTolerance = Math.max(Math.abs(delta) * 1e-12, 1e-12);
  const candidates: {
    readonly zone: OperationZone;
    readonly boundary: "start" | "end";
    readonly timeSeconds: number;
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
          ? Math.floor((lower - baseDistance) / track.totalLength) - 1
          : 0;
        const lastLap = config.closedTrack
          ? Math.ceil((upper - baseDistance) / track.totalLength) + 1
          : 0;
        for (let lap = firstLap; lap <= lastLap; lap += 1) {
          const crossingDistance =
            baseDistance + (config.closedTrack ? lap * track.totalLength : 0);
          const crossed =
            direction === "forward"
              ? previousDistanceM < crossingDistance - crossingTolerance &&
                crossingDistance <= nextDistanceM + crossingTolerance
              : nextDistanceM <= crossingDistance + crossingTolerance &&
                crossingDistance < previousDistanceM - crossingTolerance;
          if (!crossed) continue;
          candidates.push({
            zone,
            boundary,
            timeSeconds:
              previousTimeSeconds +
              ((crossingDistance - previousDistanceM) / delta) * stepSeconds,
          });
        }
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.timeSeconds - b.timeSeconds ||
      a.zone.id.localeCompare(b.zone.id) ||
      a.boundary.localeCompare(b.boundary),
  );
  const events: SimulationEvent[] = [];
  const epsilon = Math.max(Math.abs(delta) * 1e-9, 1e-9);
  for (const candidate of candidates) {
    const beforeDistance =
      previousDistanceM +
      ((candidate.timeSeconds - previousTimeSeconds) / stepSeconds) * delta -
      Math.sign(delta) * epsilon;
    const afterDistance =
      previousDistanceM +
      ((candidate.timeSeconds - previousTimeSeconds) / stepSeconds) * delta +
      Math.sign(delta) * epsilon;
    const occupied = (headDistanceM: number): boolean =>
      config.train.cars.some((_, index) =>
        zoneContains(
          track,
          candidate.zone,
          headDistanceM - index * config.train.spacingM,
          config.closedTrack,
        ),
      );
    const before = occupied(beforeDistance);
    const after = occupied(afterDistance);
    if (before === after) continue;
    const entry = !before && after;
    const duplicate = events.some(
      (event) =>
        event.zoneId === candidate.zone.id &&
        event.type === (entry ? "zone-entry" : "zone-exit") &&
        event.boundary === candidate.boundary &&
        event.timeSeconds === candidate.timeSeconds,
    );
    if (duplicate) continue;
    events.push({
      timeSeconds: candidate.timeSeconds,
      type: entry ? "zone-entry" : "zone-exit",
      zoneId: candidate.zone.id,
      operation: candidate.zone.kind,
      boundary: candidate.boundary,
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
        ? scale(subtract(next, previous), 1 / denominator)
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

const makeTimeline = (
  track: CompiledTrackData,
  frames: readonly SimulationFrame[],
  config: SimulatorConfig,
): RideTimeline => {
  if (frames.length === 0)
    return new RideTimeline({
      sampleRateHz: 1 / config.timelineStepSeconds,
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
  const interpolateTelemetry = (
    left: CarTelemetry,
    right: CarTelemetry,
    alpha: number,
  ): CarTelemetry => {
    const blend = (a: number, b: number): number => a + (b - a) * alpha;
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
  const interpolateFrame = (time: number): SimulationFrame => {
    let upper = 0;
    while (upper < frames.length - 1 && frames[upper]!.timeSeconds < time)
      upper += 1;
    const lower = Math.max(0, upper - 1);
    const left = frames[lower]!;
    const right = frames[upper]!;
    const span = right.timeSeconds - left.timeSeconds;
    const alpha = span > 0 ? (time - left.timeSeconds) / span : 0;
    const blend = (a: number, b: number): number => a + (b - a) * alpha;
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
        const seatDistanceM = blend(seat.distanceM, otherSeat.distanceM);
        const seatFrame = sampleTrackAtDistance(
          track,
          trackDistance(track, config, seatDistanceM),
        );
        const offset = car.seatOffsets[seatIndex] ?? vec3();
        const seatRight = scale(seatFrame.binormal, -1);
        return {
          ...seat,
          distanceM: seatDistanceM,
          position: add(
            seatFrame.position,
            add(
              scale(seatRight, offset[0]),
              scale(seatFrame.normal, offset[1]),
            ),
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
  const carCount = selected[0]?.cars.length ?? 0;
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
  return new RideTimeline({
    sampleRateHz: 1 / config.timelineStepSeconds,
    timeSeconds: new Float64Array(outputTimes),
    headDistanceM: new Float64Array(
      selected.map((frame) => frame.headDistanceM),
    ),
    speedMps: new Float64Array(selected.map((frame) => frame.speedMps)),
    longitudinalG: new Float64Array(
      selected.map((frame) => frame.telemetry.longitudinalG),
    ),
    lateralG: new Float64Array(
      selected.map((frame) => frame.telemetry.lateralG),
    ),
    verticalG: new Float64Array(
      selected.map((frame) => frame.telemetry.verticalG),
    ),
    jerkMps3: new Float64Array(
      selected.flatMap((frame) => frame.telemetry.jerkMps3),
    ),
    carCount,
    carPositionsXYZ: flatten((car) => car.position),
    carTangentsXYZ: flatten((car) => car.tangent),
    carNormalsXYZ: flatten((car) => car.normal),
    carBinormalsXYZ: flatten((car) => car.binormal),
    frames: selected,
  });
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
        sampleRateHz: 1 / Math.max(request.config.timelineStepSeconds, 1),
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
  const mass = totalMass(config.train);
  const initialDynamics = dynamicsAt(
    track,
    config,
    initial.headDistanceM,
    initial.speedMps,
  );
  const initialCars = makeCars(
    track,
    config,
    initial.headDistanceM,
    initial.speedMps,
    initialDynamics.accelerationMps2,
  );
  const initialPotentialJ = initialCars.reduce(
    (sum, car, index) =>
      sum -
      (config.train.cars[index]?.massKg ?? 0) *
        dot(gravityVector(config), car.position),
    0,
  );
  const initialEnergyJ = initialPotentialJ + 0.5 * mass * initial.speedMps ** 2;
  const work: WorkState = { driveJ: 0, lossJ: 0 };
  const frames: SimulationFrame[] = [];
  const events: SimulationEvent[] = [];
  let timeSeconds = 0;
  let distanceM = initial.headDistanceM;
  let speedMps = initial.speedMps;
  let hasStalled = false;
  const initialZones = activeZonesForTrain(track, config, distanceM);
  const initialDirection = speedMps < 0 ? "reverse" : "forward";
  for (const zone of initialZones)
    events.push({
      timeSeconds: 0,
      type: "zone-entry",
      zoneId: zone.id,
      operation: zone.kind,
      boundary: initialDirection === "forward" ? "start" : "end",
      direction: initialDirection,
    });

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
    const staticLimit =
      config.staticStictionCoefficient * mass * config.gravityMps2;
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
  addFrame(0, distanceM, speedMps, speedMps);
  while (timeSeconds < request.durationSeconds - 1e-12) {
    const step = Math.min(
      config.fixedStepSeconds,
      request.durationSeconds - timeSeconds,
    );
    const previousDistance = distanceM;
    const previousSpeed = speedMps;
    const previousDynamics = dynamicsAt(track, config, distanceM, speedMps);
    [distanceM, speedMps] = rk4(track, config, distanceM, speedMps, step);
    if (!finite(distanceM) || !finite(speedMps)) {
      diagnostics.push({
        code: "SIM_NUMERICAL",
        severity: "error",
        field: "state",
        message: "Fixed-step integration produced a non-finite state",
      });
      break;
    }
    const nextDynamics = dynamicsAt(track, config, distanceM, speedMps);
    const staticLimit =
      config.staticStictionCoefficient * mass * config.gravityMps2;
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
      if (Math.abs(atRest.totalForce) <= staticLimit) speedMps = 0;
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
    work.driveJ += averageForces.reduce(
      (sum, force) => sum + force.drive * deltaDistance,
      0,
    );
    work.lossJ += averageForces.reduce(
      (sum, force) => sum - force.loss * deltaDistance,
      0,
    );
    timeSeconds += step;
    if (request.durationSeconds - timeSeconds < 1e-12)
      timeSeconds = request.durationSeconds;
    events.push(
      ...zoneCrossings(
        track,
        config,
        config.zones,
        previousDistance,
        distanceM,
        timeSeconds - step,
        step,
      ),
    );
    addFrame(timeSeconds, distanceM, speedMps, previousSpeed);
  }
  const completedFrames = withJerk(frames);
  const finalZones = activeZonesForTrain(track, config, distanceM);
  return {
    frames: completedFrames,
    timeline: makeTimeline(track, completedFrames, config),
    events,
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
  return dynamicsAt(track, config, headDistanceM, speedMps).forces;
};
