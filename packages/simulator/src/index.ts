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
const zoneContains = (
  track: CompiledTrackData,
  zone: OperationZone,
  distanceM: number,
): boolean => {
  if (distanceM < Math.min(zone.startDistanceM, zone.endDistanceM))
    return false;
  if (distanceM > Math.max(zone.startDistanceM, zone.endDistanceM))
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
      Math.round((distanceM / track.totalLength) * (masks.length - 1)),
    ),
  );
  return ((masks[sampleIndex] ?? 0) & (1 << nameIndex)) !== 0;
};

const activeZones = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  distanceM: number,
): readonly OperationZone[] =>
  config.zones.filter((zone) => zoneContains(track, zone, distanceM));

const totalMass = (train: TrainConfiguration): number =>
  train.cars.reduce((sum, car) => sum + car.massKg, 0);

const gravityVector = (config: SimulatorConfig): Vec3 =>
  scale(
    vec3Normalize(config.gravityDirection ?? vec3(0, -1, 0)),
    config.gravityMps2,
  );

const vectorIsFiniteAndNonzero = (value: Vec3): boolean =>
  value.every(finite) && Math.hypot(value[0], value[1], value[2]) > 1e-15;

const validate = (
  request: SimulationRequest,
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
  }
  for (const [field, value] of [
    ["gravityMps2", config.gravityMps2],
    ["rollingResistanceCoefficient", config.rollingResistanceCoefficient],
    ["staticStictionCoefficient", config.staticStictionCoefficient],
    ["dragCdA", config.dragCdA],
    ["airDensityKgPerM3", config.airDensityKgPerM3],
    ["lsmForcePerCarN", config.lsmForcePerCarN],
    ["lsmPowerPerCarW", config.lsmPowerPerCarW],
    ["maxBrakeForcePerCarN", config.maxBrakeForcePerCarN],
  ] as const)
    if (!finite(value) || value < 0)
      diagnostics.push({
        code: "SIM_INVALID_CONFIGURATION",
        severity: "error",
        field,
        message: `${field} must be finite and non-negative`,
      });
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
  const sample = sampleTrackAtDistance(track, distanceM);
  const zones = activeZones(track, config, distanceM);
  const gravity = car.massKg * dot(gravityVector(config), sample.tangent);
  const rolling =
    Math.abs(speedMps) > SPEED_EPSILON
      ? -Math.sign(speedMps) *
        config.rollingResistanceCoefficient *
        car.massKg *
        config.gravityMps2
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
      const forceLimit = zone.lsmForcePerCarN ?? config.lsmForcePerCarN;
      const powerLimit = zone.lsmPowerPerCarW ?? config.lsmPowerPerCarW;
      const capped = Math.max(-forceLimit, Math.min(forceLimit, requested));
      const powerCapped =
        Math.abs(speedMps) > SPEED_EPSILON
          ? Math.sign(capped) *
            Math.min(Math.abs(capped), powerLimit / Math.abs(speedMps))
          : capped;
      drive += powerCapped;
    } else if (zone.kind === "brake") {
      brakeActive = true;
      const limit = zone.brakeForcePerCarN ?? config.maxBrakeForcePerCarN;
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
): readonly CarState[] =>
  config.train.cars.map((car, index) => {
    const distanceM = headDistanceM - index * config.train.spacingM;
    const sample = sampleTrackAtDistance(track, distanceM);
    const offsets = seatPositions(car);
    const right = scale(sample.binormal, -1);
    const seats = offsets.map((offset, seatIndex) => ({
      index: seatIndex,
      position: add(
        sample.position,
        add(
          scale(right, offset[0]),
          add(
            scale(sample.normal, offset[1]),
            scale(sample.tangent, offset[2]),
          ),
        ),
      ),
      frame: sample,
    }));
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
      seats,
    };
  });

const worldAcceleration = (
  sample: TrackSample,
  speedMps: number,
  accelerationMps2: number,
): Vec3 => {
  const curvatureDirection = add(
    scale(sample.normal, Math.sin(sample.bank)),
    scale(sample.binormal, Math.cos(sample.bank)),
  );
  return add(
    scale(sample.tangent, accelerationMps2),
    scale(curvatureDirection, sample.curvature * speedMps * speedMps),
  );
};

const carTelemetry = (
  sample: TrackSample,
  worldAccelerationMps2: Vec3,
  gravity: Vec3,
  gravityMps2: number,
  speedMps: number,
): CarTelemetry => {
  const specific = subtract(worldAccelerationMps2, gravity);
  const right = scale(sample.binormal, -1);
  return {
    longitudinalG: dot(specific, sample.tangent) / gravityMps2,
    lateralG: dot(specific, right) / gravityMps2,
    verticalG: dot(specific, sample.normal) / gravityMps2,
    specificForceMps2: specific,
    bankRad: sample.bank,
    rollRateRadPerSec: sample.bankDerivative * speedMps,
  };
};

const makeTelemetry = (
  track: CompiledTrackData,
  config: SimulatorConfig,
  cars: readonly CarState[],
  speedMps: number,
  accelerationMps2: number,
  work: WorkState,
  initialPotentialJ: number,
  launchActivity: boolean,
  brakeActivity: boolean,
): RideTelemetry => {
  const gravity = gravityVector(config);
  const perCar = cars.map((car) =>
    carTelemetry(
      car.frame,
      worldAcceleration(car.frame, speedMps, accelerationMps2),
      gravity,
      config.gravityMps2,
      speedMps,
    ),
  );
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
    initialPotentialJ +
    work.driveJ -
    work.lossJ -
    (kineticEnergyJ + potentialEnergyJ);
  return {
    perCar,
    longitudinalG: first.longitudinalG,
    lateralG: first.lateralG,
    verticalG: first.verticalG,
    specificForceMps2: first.specificForceMps2,
    bankRad: first.bankRad,
    rollRateRadPerSec: first.rollRateRadPerSec,
    jerkMps3: vec3(),
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

const withJerk = (
  frames: readonly SimulationFrame[],
  timelineStepSeconds: number,
): readonly SimulationFrame[] =>
  frames.map((frame, index) => {
    const previous =
      frames[Math.max(0, index - 1)]?.telemetry.specificForceMps2 ??
      frame.telemetry.specificForceMps2;
    const next =
      frames[Math.min(frames.length - 1, index + 1)]?.telemetry
        .specificForceMps2 ?? frame.telemetry.specificForceMps2;
    const denominator =
      index === 0 || index === frames.length - 1
        ? timelineStepSeconds
        : 2 * timelineStepSeconds;
    return {
      ...frame,
      telemetry: {
        ...frame.telemetry,
        jerkMps3: scale(subtract(next, previous), 1 / denominator),
      },
    };
  });

const makeTimeline = (
  frames: readonly SimulationFrame[],
  config: SimulatorConfig,
): RideTimeline => {
  const selected: SimulationFrame[] = [];
  let nextTime = 0;
  for (const frame of frames) {
    if (frame.timeSeconds + config.fixedStepSeconds * 0.51 >= nextTime) {
      selected.push(frame);
      nextTime += config.timelineStepSeconds;
    }
  }
  if (selected.length === 0 && frames.length > 0) selected.push(frames[0]!);
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
    timeSeconds: new Float64Array(
      selected.map((_, index) => index * config.timelineStepSeconds),
    ),
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
  });
};

export const simulateRide = (
  track: CompiledTrackData,
  request: SimulationRequest,
): SimulationResult => {
  const diagnostics = [...validate(request)];
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
  const initialCars = makeCars(track, config, initial.headDistanceM);
  const initialPotentialJ = initialCars.reduce(
    (sum, car, index) =>
      sum -
      (config.train.cars[index]?.massKg ?? 0) *
        dot(gravityVector(config), car.position),
    0,
  );
  const work: WorkState = { driveJ: 0, lossJ: 0 };
  const frames: SimulationFrame[] = [];
  const events: SimulationEvent[] = [];
  let timeSeconds = 0;
  let distanceM = initial.headDistanceM;
  let speedMps = initial.speedMps;
  let hasStalled = false;
  let previousZones = activeZones(track, config, distanceM);
  for (const zone of previousZones)
    events.push({
      timeSeconds: 0,
      type: "zone-entry",
      zoneId: zone.id,
      operation: zone.kind,
    });

  const addFrame = (
    time: number,
    currentDistance: number,
    currentSpeed: number,
    previousSpeed: number,
  ): void => {
    const dynamics = dynamicsAt(track, config, currentDistance, currentSpeed);
    const cars = makeCars(track, config, currentDistance);
    const telemetry = makeTelemetry(
      track,
      config,
      cars,
      currentSpeed,
      dynamics.accelerationMps2,
      work,
      initialPotentialJ,
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
    const zones = activeZones(track, config, distanceM);
    for (const zone of zones)
      if (!previousZones.some((previous) => previous.id === zone.id))
        events.push({
          timeSeconds,
          type: "zone-entry",
          zoneId: zone.id,
          operation: zone.kind,
        });
    previousZones = zones;
    addFrame(timeSeconds, distanceM, speedMps, previousSpeed);
  }
  const completedFrames = withJerk(frames, config.fixedStepSeconds);
  const finalZones = activeZones(track, config, distanceM);
  return {
    frames: completedFrames,
    timeline: makeTimeline(completedFrames, config),
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
): readonly PerCarForce[] =>
  dynamicsAt(track, config, headDistanceM, speedMps).forces;
