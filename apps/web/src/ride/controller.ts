import type { Vec3 } from "@openvibecoaster/core";
import type {
  CarState,
  CarTelemetry,
  RideTimeline,
  RideTelemetry,
  SeatState,
  SimulationFrame,
} from "@openvibecoaster/simulator";

export type RideCameraId = "front" | "middle" | "rear" | "chase" | "orbit";
export type RideSelectionId = "front" | "middle" | "rear";
export type RidePlaybackRate = 0.25 | 0.5 | 1 | 2;

export const RIDE_CAMERA_IDS: readonly RideCameraId[] = [
  "front",
  "middle",
  "rear",
  "chase",
  "orbit",
] as const;

export const RIDE_PLAYBACK_RATES: readonly RidePlaybackRate[] = [
  0.25, 0.5, 1, 2,
] as const;

export interface RideSelection {
  readonly id: RideSelectionId;
  readonly carIndex: number;
  readonly car: CarState | undefined;
  readonly seatIndex: number;
  readonly seat: SeatState | undefined;
  readonly position: Vec3 | undefined;
  readonly tangent: Vec3 | undefined;
  readonly normal: Vec3 | undefined;
  readonly binormal: Vec3 | undefined;
}

export interface RidePlaybackSnapshot {
  readonly timeSeconds: number;
  readonly sampleIndex: number;
  readonly headDistanceM: number;
  readonly speedMps: number;
  readonly telemetry: RideTelemetry | undefined;
  readonly isPlaying: boolean;
  readonly ended: boolean;
  readonly rate: RidePlaybackRate;
  readonly camera: RideCameraId;
  readonly selectedSeat: RideSelectionId;
  readonly reducedMotion: boolean;
  readonly disposed: boolean;
  readonly selections: Readonly<Record<RideSelectionId, RideSelection>>;
  readonly cars: readonly CarState[];
  readonly carCount: number;
}

export type RidePlaybackListener = (snapshot: RidePlaybackSnapshot) => void;
export type RideSelectionListener = (
  selection: RideSelectionId,
  snapshot: RidePlaybackSnapshot,
) => void;
export type RideCameraListener = (
  camera: RideCameraId,
  snapshot: RidePlaybackSnapshot,
) => void;

export interface RidePlaybackController {
  getSnapshot(): RidePlaybackSnapshot;
  play(): void;
  pause(): void;
  tick(deltaSeconds: number): void;
  scrubTime(timeSeconds: number): void;
  scrubIndex(index: number): void;
  reset(): void;
  setRate(rate: number): void;
  setCamera(camera: RideCameraId): void;
  selectSeat(selection: RideSelectionId, seatIndex?: number): void;
  setReducedMotion(reducedMotion: boolean): void;
  subscribe(listener: RidePlaybackListener): () => void;
  onSelectionChange(listener: RideSelectionListener): () => void;
  onCameraChange(listener: RideCameraListener): () => void;
  dispose(): void;
}

interface TimelineData {
  readonly times: Float64Array;
  readonly distances: Float64Array;
  readonly speeds: Float64Array;
  readonly jerkMps3: Float64Array;
  readonly carCount: number;
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly frames: readonly SimulationFrame[];
  readonly longitudinalG: Float64Array;
  readonly lateralG: Float64Array;
  readonly verticalG: Float64Array;
  readonly launchActivity: Float64Array;
  readonly brakeActivity: Float64Array;
  readonly kineticEnergyJ: Float64Array;
  readonly potentialEnergyJ: Float64Array;
  readonly accumulatedDriveWorkJ: Float64Array;
  readonly accumulatedLossWorkJ: Float64Array;
  readonly energyErrorJ: Float64Array;
  readonly bankRad: Float64Array;
  readonly rollRateRadPerSec: Float64Array;
  readonly specificForceXYZ: Float64Array;
  readonly perCarLongitudinalG: Float64Array;
  readonly perCarLateralG: Float64Array;
  readonly perCarVerticalG: Float64Array;
  readonly perCarBankRad: Float64Array;
  readonly perCarRollRateRadPerSec: Float64Array;
  readonly perCarSpecificForceXYZ: Float64Array;
  readonly perCarJerkXYZ: Float64Array;
}

const selectionIds: readonly RideSelectionId[] = ["front", "middle", "rear"];

const isSelectionId = (value: string): value is RideSelectionId =>
  selectionIds.includes(value as RideSelectionId);

const isCameraId = (value: string): value is RideCameraId =>
  RIDE_CAMERA_IDS.includes(value as RideCameraId);

const isPlaybackRate = (value: number): value is RidePlaybackRate =>
  RIDE_PLAYBACK_RATES.includes(value as RidePlaybackRate);

const requireFiniteNumber = (value: number, field: string): void => {
  if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`);
};

const requireFiniteVec = (value: Vec3, field: string): void => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => !Number.isFinite(component))
  )
    throw new RangeError(`${field} must contain finite 3-vectors`);
};

const requireFiniteSample = (value: CarState["frame"], field: string): void => {
  requireFiniteVec(value.position, `${field}.position`);
  requireFiniteVec(value.tangent, `${field}.tangent`);
  requireFiniteVec(value.normal, `${field}.normal`);
  requireFiniteVec(value.binormal, `${field}.binormal`);
  requireFiniteNumber(value.distance, `${field}.distance`);
  requireFiniteNumber(value.curvature, `${field}.curvature`);
  requireFiniteVec(value.curvatureVector, `${field}.curvatureVector`);
  requireFiniteNumber(value.bank, `${field}.bank`);
  requireFiniteNumber(value.bankDerivative, `${field}.bankDerivative`);
};

const requireFiniteTelemetry = (value: CarTelemetry, field: string): void => {
  requireFiniteNumber(value.longitudinalG, `${field}.longitudinalG`);
  requireFiniteNumber(value.lateralG, `${field}.lateralG`);
  requireFiniteNumber(value.verticalG, `${field}.verticalG`);
  requireFiniteVec(value.specificForceMps2, `${field}.specificForceMps2`);
  requireFiniteVec(value.jerkMps3, `${field}.jerkMps3`);
  requireFiniteNumber(value.bankRad, `${field}.bankRad`);
  requireFiniteNumber(value.rollRateRadPerSec, `${field}.rollRateRadPerSec`);
};

const requireOrthonormal = (
  tangent: Vec3,
  normal: Vec3,
  binormal: Vec3,
  field: string,
): void => {
  const dot = (a: Vec3, b: Vec3): number =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  if (
    Math.abs(dot(tangent, tangent) - 1) > 1e-7 ||
    Math.abs(dot(normal, normal) - 1) > 1e-7 ||
    Math.abs(dot(binormal, binormal) - 1) > 1e-7 ||
    Math.abs(dot(tangent, normal)) > 1e-7 ||
    Math.abs(dot(tangent, binormal)) > 1e-7 ||
    Math.abs(dot(normal, binormal)) > 1e-7 ||
    Math.abs(dot(cross(tangent, normal), binormal) - 1) > 1e-7
  )
    throw new RangeError(`${field} must be orthonormal and right-handed`);
};

const requireFiniteCar = (car: CarState, field: string): void => {
  requireFiniteNumber(car.index, `${field}.index`);
  requireFiniteNumber(car.distanceM, `${field}.distanceM`);
  requireFiniteVec(car.position, `${field}.position`);
  requireFiniteVec(car.tangent, `${field}.tangent`);
  requireFiniteVec(car.normal, `${field}.normal`);
  requireFiniteVec(car.binormal, `${field}.binormal`);
  requireOrthonormal(car.tangent, car.normal, car.binormal, `${field}.axes`);
  requireFiniteSample(car.frame, `${field}.frame`);
  requireOrthonormal(
    car.frame.tangent,
    car.frame.normal,
    car.frame.binormal,
    `${field}.frame.axes`,
  );
  car.seatOffsets.forEach((value, index) =>
    requireFiniteVec(value, `${field}.seatOffsets[${index}]`),
  );
  car.seatPositions.forEach((value, index) =>
    requireFiniteVec(value, `${field}.seatPositions[${index}]`),
  );
  if (
    car.seatOffsets.length !== car.seatPositions.length ||
    car.seats.length !== car.seatPositions.length
  )
    throw new RangeError(`${field} seat dimensions must agree`);
  requireFiniteTelemetry(car.telemetry, `${field}.telemetry`);
  car.seats.forEach((seat, index) => {
    const seatField = `${field}.seats[${index}]`;
    requireFiniteNumber(seat.index, `${seatField}.index`);
    requireFiniteNumber(seat.distanceM, `${seatField}.distanceM`);
    requireFiniteVec(seat.position, `${seatField}.position`);
    requireFiniteSample(seat.frame, `${seatField}.frame`);
    requireOrthonormal(
      seat.frame.tangent,
      seat.frame.normal,
      seat.frame.binormal,
      `${seatField}.frame.axes`,
    );
    requireFiniteTelemetry(seat.telemetry, `${seatField}.telemetry`);
  });
};

const validateTimeline = (timeline: RideTimeline): TimelineData => {
  const times = timeline.timeSeconds;
  const distances = timeline.headDistanceM;
  const speeds = timeline.speedMps;
  const carCount = timeline.carCount;
  const positions = timeline.carPositionsXYZ;
  const tangents = timeline.carTangentsXYZ;
  const normals = timeline.carNormalsXYZ;
  const binormals = timeline.carBinormalsXYZ;
  const frames = timeline.frames;
  const longitudinalG = timeline.longitudinalG;
  const lateralG = timeline.lateralG;
  const verticalG = timeline.verticalG;
  const launchActivity = timeline.launchActivity;
  const brakeActivity = timeline.brakeActivity;
  const kineticEnergyJ = timeline.kineticEnergyJ;
  const potentialEnergyJ = timeline.potentialEnergyJ;
  const accumulatedDriveWorkJ = timeline.accumulatedDriveWorkJ;
  const accumulatedLossWorkJ = timeline.accumulatedLossWorkJ;
  const energyErrorJ = timeline.energyErrorJ;
  const bankRad = timeline.bankRad;
  const rollRateRadPerSec = timeline.rollRateRadPerSec;
  const specificForceXYZ = timeline.specificForceXYZ;
  const perCarLongitudinalG = timeline.perCarLongitudinalG;
  const perCarLateralG = timeline.perCarLateralG;
  const perCarVerticalG = timeline.perCarVerticalG;
  const perCarBankRad = timeline.perCarBankRad;
  const perCarRollRateRadPerSec = timeline.perCarRollRateRadPerSec;
  const perCarSpecificForceXYZ = timeline.perCarSpecificForceXYZ;
  const perCarJerkXYZ = timeline.perCarJerkXYZ;

  requireFiniteNumber(timeline.sampleRateHz, "RideTimeline sample rate");
  if (timeline.sampleRateHz <= 0)
    throw new RangeError("RideTimeline sample rate must be positive");
  if (times.length !== distances.length || times.length !== speeds.length)
    throw new RangeError("RideTimeline scalar arrays must have equal lengths");
  if (!Number.isInteger(carCount) || carCount < 0)
    throw new RangeError(
      "RideTimeline car count must be a non-negative integer",
    );
  times.forEach((value, index) =>
    requireFiniteNumber(value, `timeSeconds[${index}]`),
  );
  distances.forEach((value, index) =>
    requireFiniteNumber(value, `headDistanceM[${index}]`),
  );
  speeds.forEach((value, index) =>
    requireFiniteNumber(value, `speedMps[${index}]`),
  );
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! <= times[index - 1]!)
      throw new RangeError(
        "RideTimeline timestamps must be strictly increasing",
      );
  }

  const expectedCarValues = times.length * carCount * 3;
  for (const [name, values] of [
    ["carPositionsXYZ", positions],
    ["carTangentsXYZ", tangents],
    ["carNormalsXYZ", normals],
    ["carBinormalsXYZ", binormals],
  ] as const) {
    if (values.length !== expectedCarValues)
      throw new RangeError(`${name} length must match RideTimeline car shape`);
    values.forEach((value, index) =>
      requireFiniteNumber(value, `${name}[${index}]`),
    );
  }
  if (frames.length === 0) {
    for (let sampleIndex = 0; sampleIndex < times.length; sampleIndex += 1) {
      for (let carIndex = 0; carIndex < carCount; carIndex += 1) {
        const offset = (sampleIndex * carCount + carIndex) * 3;
        requireOrthonormal(
          [tangents[offset]!, tangents[offset + 1]!, tangents[offset + 2]!],
          [normals[offset]!, normals[offset + 1]!, normals[offset + 2]!],
          [binormals[offset]!, binormals[offset + 1]!, binormals[offset + 2]!],
          `frame arrays at sample ${sampleIndex}, car ${carIndex}`,
        );
      }
    }
  }
  for (const [name, values] of [
    ["longitudinalG", longitudinalG],
    ["lateralG", lateralG],
    ["verticalG", verticalG],
  ] as const) {
    if (values.length !== 0 && values.length !== times.length)
      throw new RangeError(`${name} length must match time length`);
    values.forEach((value, index) =>
      requireFiniteNumber(value, `${name}[${index}]`),
    );
  }
  const jerkMps3 = timeline.jerkMps3;
  if (jerkMps3.length !== 0 && jerkMps3.length !== times.length * 3)
    throw new RangeError(
      "jerkMps3 length must contain three components per time sample",
    );
  jerkMps3.forEach((value, index) =>
    requireFiniteNumber(value, `jerkMps3[${index}]`),
  );
  for (const [name, values] of [
    ["launchActivity", launchActivity],
    ["brakeActivity", brakeActivity],
    ["kineticEnergyJ", kineticEnergyJ],
    ["potentialEnergyJ", potentialEnergyJ],
    ["accumulatedDriveWorkJ", accumulatedDriveWorkJ],
    ["accumulatedLossWorkJ", accumulatedLossWorkJ],
    ["energyErrorJ", energyErrorJ],
    ["bankRad", bankRad],
    ["rollRateRadPerSec", rollRateRadPerSec],
  ] as const) {
    if (values.length !== 0 && values.length !== times.length)
      throw new RangeError(`${name} length must match time length`);
    values.forEach((value, index) =>
      requireFiniteNumber(value, `${name}[${index}]`),
    );
  }
  if (
    specificForceXYZ.length !== 0 &&
    specificForceXYZ.length !== times.length * 3
  )
    throw new RangeError(
      "specificForceXYZ length must contain three components per time sample",
    );
  specificForceXYZ.forEach((value, index) =>
    requireFiniteNumber(value, `specificForceXYZ[${index}]`),
  );
  for (const [name, values] of [
    ["perCarLongitudinalG", perCarLongitudinalG],
    ["perCarLateralG", perCarLateralG],
    ["perCarVerticalG", perCarVerticalG],
    ["perCarBankRad", perCarBankRad],
    ["perCarRollRateRadPerSec", perCarRollRateRadPerSec],
  ] as const) {
    if (values.length !== 0 && values.length !== times.length * carCount)
      throw new RangeError(`${name} length must match time*carCount`);
    values.forEach((value, index) =>
      requireFiniteNumber(value, `${name}[${index}]`),
    );
  }
  for (const [name, values] of [
    ["perCarSpecificForceXYZ", perCarSpecificForceXYZ],
    ["perCarJerkXYZ", perCarJerkXYZ],
  ] as const) {
    if (values.length !== 0 && values.length !== times.length * carCount * 3)
      throw new RangeError(`${name} length must match time*carCount*3`);
    values.forEach((value, index) =>
      requireFiniteNumber(value, `${name}[${index}]`),
    );
  }
  if (frames.length !== 0 && frames.length !== times.length)
    throw new RangeError("RideTimeline frames length must match time length");
  frames.forEach((frame, index) => {
    requireFiniteNumber(frame.timeSeconds, `frames[${index}].timeSeconds`);
    if (frame.timeSeconds !== times[index])
      throw new RangeError(
        "RideTimeline frame timestamps must match timeSeconds",
      );
    requireFiniteNumber(frame.headDistanceM, `frames[${index}].headDistanceM`);
    requireFiniteNumber(frame.speedMps, `frames[${index}].speedMps`);
    if (frame.cars.length !== carCount)
      throw new RangeError(`RideTimeline frame ${index} car count mismatch`);
    if (frame.telemetry.perCar.length !== carCount)
      throw new RangeError(
        `RideTimeline frame ${index} telemetry count mismatch`,
      );
    requireFiniteTelemetry(frame.telemetry, `frames[${index}].telemetry`);
    requireFiniteNumber(
      frame.telemetry.kineticEnergyJ,
      `frames[${index}].telemetry.kineticEnergyJ`,
    );
    requireFiniteNumber(
      frame.telemetry.potentialEnergyJ,
      `frames[${index}].telemetry.potentialEnergyJ`,
    );
    requireFiniteNumber(
      frame.telemetry.accumulatedDriveWorkJ,
      `frames[${index}].telemetry.accumulatedDriveWorkJ`,
    );
    requireFiniteNumber(
      frame.telemetry.accumulatedLossWorkJ,
      `frames[${index}].telemetry.accumulatedLossWorkJ`,
    );
    requireFiniteNumber(
      frame.telemetry.energyErrorJ,
      `frames[${index}].telemetry.energyErrorJ`,
    );
    frame.telemetry.perCar.forEach((value, carIndex) =>
      requireFiniteTelemetry(
        value,
        `frames[${index}].telemetry.perCar[${carIndex}]`,
      ),
    );
    frame.cars.forEach((car, carIndex) =>
      requireFiniteCar(car, `frames[${index}].cars[${carIndex}]`),
    );
    requireFiniteCar(frame.selection.front, `frames[${index}].selection.front`);
    requireFiniteCar(
      frame.selection.middle,
      `frames[${index}].selection.middle`,
    );
    requireFiniteCar(frame.selection.rear, `frames[${index}].selection.rear`);
  });
  return {
    times,
    distances,
    speeds,
    jerkMps3,
    carCount,
    positions,
    tangents,
    normals,
    binormals,
    frames,
    longitudinalG,
    lateralG,
    verticalG,
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
  };
};

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

const lerp = (start: number, end: number, fraction: number): number =>
  start * (1 - fraction) + end * fraction;

const dot = (a: Vec3, b: Vec3): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

const length = (value: Vec3): number => Math.sqrt(dot(value, value));

const normalize = (value: Vec3, field: string): Vec3 => {
  const magnitude = length(value);
  if (!(magnitude > 1e-12) || !Number.isFinite(magnitude))
    throw new RangeError(`${field} cannot be interpolated into a frame`);
  return [value[0]! / magnitude, value[1]! / magnitude, value[2]! / magnitude];
};

const lerpVec = (start: Vec3, end: Vec3, fraction: number): Vec3 => [
  lerp(start[0]!, end[0]!, fraction),
  lerp(start[1]!, end[1]!, fraction),
  lerp(start[2]!, end[2]!, fraction),
];

const interpolateAxes = (
  startTangent: Vec3,
  startNormal: Vec3,
  startBinormal: Vec3,
  endTangent: Vec3,
  endNormal: Vec3,
  endBinormal: Vec3,
  fraction: number,
  field: string,
): { tangent: Vec3; normal: Vec3; binormal: Vec3 } => {
  const tangent = normalize(
    lerpVec(startTangent, endTangent, fraction),
    `${field}.tangent`,
  );
  const normalCandidate = lerpVec(startNormal, endNormal, fraction);
  let projectedNormal: Vec3 = [
    normalCandidate[0]! - tangent[0]! * dot(normalCandidate, tangent),
    normalCandidate[1]! - tangent[1]! * dot(normalCandidate, tangent),
    normalCandidate[2]! - tangent[2]! * dot(normalCandidate, tangent),
  ];
  if (!(length(projectedNormal) > 1e-12)) {
    const binormalCandidate = lerpVec(startBinormal, endBinormal, fraction);
    projectedNormal = cross(binormalCandidate, tangent);
  }
  const normal = normalize(projectedNormal, `${field}.normal`);
  let binormal = normalize(cross(tangent, normal), `${field}.binormal`);
  const binormalCandidate = lerpVec(startBinormal, endBinormal, fraction);
  if (
    length(binormalCandidate) > 1e-12 &&
    dot(binormal, binormalCandidate) < 0
  ) {
    binormal = [-binormal[0]!, -binormal[1]!, -binormal[2]!];
  }
  return {
    tangent,
    normal:
      dot(cross(tangent, normal), binormal) < 0
        ? [-normal[0]!, -normal[1]!, -normal[2]!]
        : normal,
    binormal,
  };
};

const interpolateTelemetry = (
  start: CarTelemetry,
  end: CarTelemetry,
  fraction: number,
): CarTelemetry => ({
  longitudinalG: lerp(start.longitudinalG, end.longitudinalG, fraction),
  lateralG: lerp(start.lateralG, end.lateralG, fraction),
  verticalG: lerp(start.verticalG, end.verticalG, fraction),
  specificForceMps2: lerpVec(
    start.specificForceMps2,
    end.specificForceMps2,
    fraction,
  ),
  jerkMps3: lerpVec(start.jerkMps3, end.jerkMps3, fraction),
  bankRad: lerp(start.bankRad, end.bankRad, fraction),
  rollRateRadPerSec: lerp(
    start.rollRateRadPerSec,
    end.rollRateRadPerSec,
    fraction,
  ),
});

const interpolateSample = (
  start: CarState["frame"],
  end: CarState["frame"],
  fraction: number,
): CarState["frame"] => {
  const axes = interpolateAxes(
    start.tangent,
    start.normal,
    start.binormal,
    end.tangent,
    end.normal,
    end.binormal,
    fraction,
    "frame",
  );
  return {
    position: lerpVec(start.position, end.position, fraction),
    ...axes,
    distance: lerp(start.distance, end.distance, fraction),
    curvature: lerp(start.curvature, end.curvature, fraction),
    curvatureVector: lerpVec(
      start.curvatureVector,
      end.curvatureVector,
      fraction,
    ),
    bank: lerp(start.bank, end.bank, fraction),
    bankDerivative: lerp(start.bankDerivative, end.bankDerivative, fraction),
  };
};

const interpolateSeat = (
  start: SeatState,
  end: SeatState,
  fraction: number,
): SeatState => ({
  index: start.index,
  distanceM: lerp(start.distanceM, end.distanceM, fraction),
  position: lerpVec(start.position, end.position, fraction),
  frame: interpolateSample(start.frame, end.frame, fraction),
  telemetry: interpolateTelemetry(start.telemetry, end.telemetry, fraction),
});

const interpolateCar = (
  start: CarState,
  end: CarState,
  fraction: number,
): CarState => {
  if (
    start.seats.length !== end.seats.length ||
    start.seatOffsets.length !== end.seatOffsets.length ||
    start.seatPositions.length !== end.seatPositions.length
  )
    throw new RangeError("RideTimeline car seat dimensions must be consistent");
  const axes = interpolateAxes(
    start.tangent,
    start.normal,
    start.binormal,
    end.tangent,
    end.normal,
    end.binormal,
    fraction,
    "car",
  );
  return {
    index: start.index,
    distanceM: lerp(start.distanceM, end.distanceM, fraction),
    position: lerpVec(start.position, end.position, fraction),
    ...axes,
    frame: interpolateSample(start.frame, end.frame, fraction),
    seatOffsets: start.seatOffsets.map((value, index) =>
      lerpVec(value, end.seatOffsets[index]!, fraction),
    ),
    seatPositions: start.seatPositions.map((value, index) =>
      lerpVec(value, end.seatPositions[index]!, fraction),
    ),
    telemetry: interpolateTelemetry(start.telemetry, end.telemetry, fraction),
    seats: start.seats.map((seat, index) =>
      interpolateSeat(seat, end.seats[index]!, fraction),
    ),
  };
};

const interpolateRideTelemetry = (
  start: RideTelemetry,
  end: RideTelemetry,
  fraction: number,
): RideTelemetry => ({
  perCar: start.perCar.map((telemetry, index) =>
    interpolateTelemetry(telemetry, end.perCar[index]!, fraction),
  ),
  longitudinalG: lerp(start.longitudinalG, end.longitudinalG, fraction),
  lateralG: lerp(start.lateralG, end.lateralG, fraction),
  verticalG: lerp(start.verticalG, end.verticalG, fraction),
  specificForceMps2: lerpVec(
    start.specificForceMps2,
    end.specificForceMps2,
    fraction,
  ),
  bankRad: lerp(start.bankRad, end.bankRad, fraction),
  rollRateRadPerSec: lerp(
    start.rollRateRadPerSec,
    end.rollRateRadPerSec,
    fraction,
  ),
  jerkMps3: lerpVec(start.jerkMps3, end.jerkMps3, fraction),
  launchActivity: fraction < 0.5 ? start.launchActivity : end.launchActivity,
  brakeActivity: fraction < 0.5 ? start.brakeActivity : end.brakeActivity,
  kineticEnergyJ: lerp(start.kineticEnergyJ, end.kineticEnergyJ, fraction),
  potentialEnergyJ: lerp(
    start.potentialEnergyJ,
    end.potentialEnergyJ,
    fraction,
  ),
  accumulatedDriveWorkJ: lerp(
    start.accumulatedDriveWorkJ,
    end.accumulatedDriveWorkJ,
    fraction,
  ),
  accumulatedLossWorkJ: lerp(
    start.accumulatedLossWorkJ,
    end.accumulatedLossWorkJ,
    fraction,
  ),
  energyErrorJ: lerp(start.energyErrorJ, end.energyErrorJ, fraction),
});

const removeListener = <T>(listeners: Set<T>, listener: T): void => {
  listeners.delete(listener);
};

export function createRidePlayback(
  timeline: RideTimeline,
  options: {
    readonly reducedMotion?: boolean;
    readonly rate?: RidePlaybackRate;
    readonly camera?: RideCameraId;
    readonly selectedSeat?: RideSelectionId;
  } = {},
): RidePlaybackController {
  const data = validateTimeline(timeline);
  let timeSeconds = data.times[0] ?? 0;
  let isPlaying = false;
  let ended = data.times.length === 0;
  let rate = options.rate ?? 1;
  let camera = options.camera ?? "front";
  let selectedSeat = options.selectedSeat ?? "front";
  let reducedMotion = options.reducedMotion ?? false;
  let disposed = false;
  const seatIndexes: Record<RideSelectionId, number> = {
    front: 0,
    middle: 0,
    rear: 0,
  };
  const listeners = new Set<RidePlaybackListener>();
  const selectionListeners = new Set<RideSelectionListener>();
  const cameraListeners = new Set<RideCameraListener>();

  if (!isPlaybackRate(rate)) throw new RangeError("Unsupported playback rate");
  if (!isCameraId(camera)) throw new RangeError("Unsupported camera ID");
  if (!isSelectionId(selectedSeat))
    throw new RangeError("Unsupported seat selection");

  const sampleIndexAtTime = (time: number): number => {
    if (data.times.length === 0) return 0;
    if (time <= data.times[0]!) return 0;
    if (time >= data.times[data.times.length - 1]!)
      return data.times.length - 1;
    let low = 0;
    let high = data.times.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (data.times[middle]! <= time) low = middle;
      else high = middle;
    }
    return low;
  };

  const scalarAtTime = (values: Float64Array, time: number): number => {
    if (data.times.length === 0) return 0;
    const index = sampleIndexAtTime(time);
    const nextIndex = Math.min(index + 1, values.length - 1);
    const startTime = data.times[index]!;
    const endTime = data.times[nextIndex] ?? startTime;
    const interpolation =
      nextIndex === index ? 0 : (time - startTime) / (endTime - startTime);
    return lerp(values[index] ?? 0, values[nextIndex] ?? 0, interpolation);
  };

  const timeBracket = (
    time: number,
  ): { index: number; nextIndex: number; fraction: number } => {
    const index = sampleIndexAtTime(time);
    const nextIndex = Math.min(index + 1, data.times.length - 1);
    return {
      index,
      nextIndex,
      fraction:
        nextIndex === index
          ? 0
          : (time - data.times[index]!) /
            (data.times[nextIndex]! - data.times[index]!),
    };
  };

  const vectorAtTime = (
    values: Float64Array,
    carIndex: number,
    bracket: { index: number; nextIndex: number; fraction: number },
  ): Vec3 | undefined => {
    if (data.times.length === 0 || data.carCount === 0) return undefined;
    const startOffset = (bracket.index * data.carCount + carIndex) * 3;
    const endOffset = (bracket.nextIndex * data.carCount + carIndex) * 3;
    return lerpVec(
      [
        values[startOffset] ?? 0,
        values[startOffset + 1] ?? 0,
        values[startOffset + 2] ?? 0,
      ],
      [
        values[endOffset] ?? 0,
        values[endOffset + 1] ?? 0,
        values[endOffset + 2] ?? 0,
      ],
      bracket.fraction,
    );
  };

  const jerkAtTime = (bracket: {
    index: number;
    nextIndex: number;
    fraction: number;
  }): Vec3 => {
    const startOffset = bracket.index * 3;
    const endOffset = bracket.nextIndex * 3;
    return lerpVec(
      [
        data.jerkMps3[startOffset]!,
        data.jerkMps3[startOffset + 1]!,
        data.jerkMps3[startOffset + 2]!,
      ],
      [
        data.jerkMps3[endOffset]!,
        data.jerkMps3[endOffset + 1]!,
        data.jerkMps3[endOffset + 2]!,
      ],
      bracket.fraction,
    );
  };

  const frameAtTime = (bracket: {
    index: number;
    nextIndex: number;
    fraction: number;
  }): { cars: readonly CarState[]; telemetry: RideTelemetry } | undefined => {
    const start = data.frames[bracket.index];
    if (!start) return undefined;
    const end = data.frames[bracket.nextIndex] ?? start;
    const cars = start.cars.map((car, index) =>
      interpolateCar(car, end.cars[index] ?? car, bracket.fraction),
    );
    return {
      cars,
      telemetry: interpolateRideTelemetry(
        start.telemetry,
        end.telemetry,
        bracket.fraction,
      ),
    };
  };

  const compactTelemetryAt = (bracket: {
    index: number;
    nextIndex: number;
    fraction: number;
  }): RideTelemetry | undefined => {
    if (data.times.length === 0) return undefined;
    // Require complete current compact schema; legacy 11-buffer timelines return undefined
    const expectedVec3 = data.times.length * 3;
    const expectedPerCarScalar = data.times.length * data.carCount;
    const expectedPerCarVec3 = data.times.length * data.carCount * 3;
    const hasCompleteCompact =
      data.launchActivity.length === data.times.length &&
      data.brakeActivity.length === data.times.length &&
      data.kineticEnergyJ.length === data.times.length &&
      data.potentialEnergyJ.length === data.times.length &&
      data.accumulatedDriveWorkJ.length === data.times.length &&
      data.accumulatedLossWorkJ.length === data.times.length &&
      data.energyErrorJ.length === data.times.length &&
      data.bankRad.length === data.times.length &&
      data.rollRateRadPerSec.length === data.times.length &&
      data.specificForceXYZ.length === expectedVec3 &&
      data.perCarLongitudinalG.length === expectedPerCarScalar &&
      data.perCarLateralG.length === expectedPerCarScalar &&
      data.perCarVerticalG.length === expectedPerCarScalar &&
      data.perCarBankRad.length === expectedPerCarScalar &&
      data.perCarRollRateRadPerSec.length === expectedPerCarScalar &&
      data.perCarSpecificForceXYZ.length === expectedPerCarVec3 &&
      data.perCarJerkXYZ.length === expectedPerCarVec3 &&
      data.longitudinalG.length === data.times.length &&
      data.lateralG.length === data.times.length &&
      data.verticalG.length === data.times.length &&
      data.jerkMps3.length === expectedVec3;
    if (!hasCompleteCompact) return undefined;
    const lerpAt = (values: Float64Array): number =>
      lerp(
        values[bracket.index] ?? 0,
        values[bracket.nextIndex] ?? 0,
        bracket.fraction,
      );
    const vecAt = (values: Float64Array): Vec3 => [
      lerp(
        values[bracket.index * 3] ?? 0,
        values[bracket.nextIndex * 3] ?? 0,
        bracket.fraction,
      ),
      lerp(
        values[bracket.index * 3 + 1] ?? 0,
        values[bracket.nextIndex * 3 + 1] ?? 0,
        bracket.fraction,
      ),
      lerp(
        values[bracket.index * 3 + 2] ?? 0,
        values[bracket.nextIndex * 3 + 2] ?? 0,
        bracket.fraction,
      ),
    ];
    const activityAt = (values: Float64Array): boolean => {
      if (values.length === 0) return false;
      return bracket.fraction < 0.5
        ? (values[bracket.index] ?? 0) >= 0.5
        : (values[bracket.nextIndex] ?? 0) >= 0.5;
    };
    const perCarTelemetry: CarTelemetry[] = [];
    for (let c = 0; c < data.carCount; c += 1) {
      const sIdx = bracket.index * data.carCount + c;
      const eIdx = bracket.nextIndex * data.carCount + c;
      const sVec = sIdx * 3;
      const eVec = eIdx * 3;
      perCarTelemetry.push({
        longitudinalG: lerp(
          data.perCarLongitudinalG[sIdx] ?? 0,
          data.perCarLongitudinalG[eIdx] ?? 0,
          bracket.fraction,
        ),
        lateralG: lerp(
          data.perCarLateralG[sIdx] ?? 0,
          data.perCarLateralG[eIdx] ?? 0,
          bracket.fraction,
        ),
        verticalG: lerp(
          data.perCarVerticalG[sIdx] ?? 0,
          data.perCarVerticalG[eIdx] ?? 0,
          bracket.fraction,
        ),
        specificForceMps2: [
          lerp(
            data.perCarSpecificForceXYZ[sVec] ?? 0,
            data.perCarSpecificForceXYZ[eVec] ?? 0,
            bracket.fraction,
          ),
          lerp(
            data.perCarSpecificForceXYZ[sVec + 1] ?? 0,
            data.perCarSpecificForceXYZ[eVec + 1] ?? 0,
            bracket.fraction,
          ),
          lerp(
            data.perCarSpecificForceXYZ[sVec + 2] ?? 0,
            data.perCarSpecificForceXYZ[eVec + 2] ?? 0,
            bracket.fraction,
          ),
        ],
        jerkMps3: [
          lerp(
            data.perCarJerkXYZ[sVec] ?? 0,
            data.perCarJerkXYZ[eVec] ?? 0,
            bracket.fraction,
          ),
          lerp(
            data.perCarJerkXYZ[sVec + 1] ?? 0,
            data.perCarJerkXYZ[eVec + 1] ?? 0,
            bracket.fraction,
          ),
          lerp(
            data.perCarJerkXYZ[sVec + 2] ?? 0,
            data.perCarJerkXYZ[eVec + 2] ?? 0,
            bracket.fraction,
          ),
        ],
        bankRad: lerp(
          data.perCarBankRad[sIdx] ?? 0,
          data.perCarBankRad[eIdx] ?? 0,
          bracket.fraction,
        ),
        rollRateRadPerSec: lerp(
          data.perCarRollRateRadPerSec[sIdx] ?? 0,
          data.perCarRollRateRadPerSec[eIdx] ?? 0,
          bracket.fraction,
        ),
      });
    }
    if (data.carCount === 0) {
      return {
        perCar: perCarTelemetry,
        longitudinalG: lerpAt(data.longitudinalG),
        lateralG: lerpAt(data.lateralG),
        verticalG: lerpAt(data.verticalG),
        specificForceMps2: vecAt(data.specificForceXYZ),
        jerkMps3: jerkAtTime(bracket),
        bankRad: lerpAt(data.bankRad),
        rollRateRadPerSec: lerpAt(data.rollRateRadPerSec),
        launchActivity: activityAt(data.launchActivity),
        brakeActivity: activityAt(data.brakeActivity),
        kineticEnergyJ: lerpAt(data.kineticEnergyJ),
        potentialEnergyJ: lerpAt(data.potentialEnergyJ),
        accumulatedDriveWorkJ: lerpAt(data.accumulatedDriveWorkJ),
        accumulatedLossWorkJ: lerpAt(data.accumulatedLossWorkJ),
        energyErrorJ: lerpAt(data.energyErrorJ),
      };
    }
    const firstPerCar = perCarTelemetry[0]!;
    return {
      perCar: perCarTelemetry,
      longitudinalG: firstPerCar.longitudinalG,
      lateralG: firstPerCar.lateralG,
      verticalG: firstPerCar.verticalG,
      specificForceMps2: vecAt(data.specificForceXYZ),
      jerkMps3: jerkAtTime(bracket),
      bankRad: firstPerCar.bankRad,
      rollRateRadPerSec: firstPerCar.rollRateRadPerSec,
      launchActivity: activityAt(data.launchActivity),
      brakeActivity: activityAt(data.brakeActivity),
      kineticEnergyJ: lerpAt(data.kineticEnergyJ),
      potentialEnergyJ: lerpAt(data.potentialEnergyJ),
      accumulatedDriveWorkJ: lerpAt(data.accumulatedDriveWorkJ),
      accumulatedLossWorkJ: lerpAt(data.accumulatedLossWorkJ),
      energyErrorJ: lerpAt(data.energyErrorJ),
    };
  };

  const selectionFor = (
    id: RideSelectionId,
    bracket: { index: number; nextIndex: number; fraction: number },
    frame: { cars: readonly CarState[]; telemetry: RideTelemetry } | undefined,
  ): RideSelection => {
    const carIndex =
      id === "front"
        ? 0
        : id === "rear"
          ? Math.max(0, data.carCount - 1)
          : Math.floor(Math.max(0, data.carCount - 1) / 2);
    const car = frame?.cars[carIndex];
    const seatIndex = seatIndexes[id];
    const seat = car?.seats[seatIndex];
    if (car) {
      return Object.freeze({
        id,
        carIndex: car.index,
        car,
        seatIndex,
        seat,
        position: seat?.position ?? car.position,
        tangent: seat?.frame.tangent ?? car.tangent,
        normal: seat?.frame.normal ?? car.normal,
        binormal: seat?.frame.binormal ?? car.binormal,
      });
    }
    const vector = (values: Float64Array): Vec3 | undefined =>
      vectorAtTime(values, carIndex, bracket);
    const position = vector(data.positions);
    const tangent = vector(data.tangents);
    const normal = vector(data.normals);
    const binormal = vector(data.binormals);
    const axes =
      tangent && normal && binormal
        ? interpolateAxes(
            tangent,
            normal,
            binormal,
            tangent,
            normal,
            binormal,
            0,
            "timeline",
          )
        : undefined;
    return Object.freeze({
      id,
      carIndex,
      car: undefined,
      seatIndex,
      seat: undefined,
      position,
      tangent: axes?.tangent,
      normal: axes?.normal,
      binormal: axes?.binormal,
    });
  };

  const carsAtTime = (bracket: {
    index: number;
    nextIndex: number;
    fraction: number;
  }): readonly CarState[] => {
    const frame = frameAtTime(bracket);
    if (frame) return frame.cars;
    if (data.carCount === 0) return Object.freeze([]);
    // Compact SoA fallback: build minimal CarState per car from interpolated vectors
    const cars: CarState[] = [];
    const headDist = scalarAtTime(data.distances, timeSeconds);
    for (let carIndex = 0; carIndex < data.carCount; carIndex++) {
      const pos = vectorAtTime(data.positions, carIndex, bracket);
      const tan = vectorAtTime(data.tangents, carIndex, bracket);
      const nor = vectorAtTime(data.normals, carIndex, bracket);
      const bin = vectorAtTime(data.binormals, carIndex, bracket);
      if (!pos || !tan || !nor || !bin) continue;
      const axes = interpolateAxes(tan, nor, bin, tan, nor, bin, 0, "timeline");
      // telemetry per car via compact arrays if available, else zero
      const sIdx = bracket.index * data.carCount + carIndex;
      const eIdx = bracket.nextIndex * data.carCount + carIndex;
      const lerpPer = (arr: Float64Array): number =>
        lerp(arr[sIdx] ?? 0, arr[eIdx] ?? 0, bracket.fraction);
      const sVec = sIdx * 3;
      const eVec = eIdx * 3;
      const lerpVec3 = (arr: Float64Array): Vec3 => [
        lerp(arr[sVec] ?? 0, arr[eVec] ?? 0, bracket.fraction),
        lerp(arr[sVec + 1] ?? 0, arr[eVec + 1] ?? 0, bracket.fraction),
        lerp(arr[sVec + 2] ?? 0, arr[eVec + 2] ?? 0, bracket.fraction),
      ];
      const telemetryPerCar: CarTelemetry = {
        longitudinalG:
          data.perCarLongitudinalG.length > 0
            ? lerpPer(data.perCarLongitudinalG)
            : 0,
        lateralG:
          data.perCarLateralG.length > 0 ? lerpPer(data.perCarLateralG) : 0,
        verticalG:
          data.perCarVerticalG.length > 0 ? lerpPer(data.perCarVerticalG) : 1,
        specificForceMps2:
          data.perCarSpecificForceXYZ.length > 0
            ? lerpVec3(data.perCarSpecificForceXYZ)
            : ([0, 0, 9.80665] as Vec3),
        jerkMps3:
          data.perCarJerkXYZ.length > 0
            ? lerpVec3(data.perCarJerkXYZ)
            : ([0, 0, 0] as Vec3),
        bankRad:
          data.perCarBankRad.length > 0 ? lerpPer(data.perCarBankRad) : 0,
        rollRateRadPerSec:
          data.perCarRollRateRadPerSec.length > 0
            ? lerpPer(data.perCarRollRateRadPerSec)
            : 0,
      };
      const frameSample = {
        position: pos,
        tangent: axes.tangent,
        normal: axes.normal,
        binormal: axes.binormal,
        distance: headDist,
        curvature: 0,
        curvatureVector: [0, 0, 0] as Vec3,
        bank: telemetryPerCar.bankRad,
        bankDerivative: 0,
      };
      cars.push(
        Object.freeze({
          index: carIndex,
          distanceM: headDist,
          position: pos,
          tangent: axes.tangent,
          normal: axes.normal,
          binormal: axes.binormal,
          frame: frameSample,
          seatOffsets: Object.freeze([]),
          seatPositions: Object.freeze([]),
          telemetry: telemetryPerCar,
          seats: Object.freeze([]),
        }) as CarState,
      );
    }
    return Object.freeze(cars);
  };

  const getSnapshot = (): RidePlaybackSnapshot => {
    const sampleIndex = sampleIndexAtTime(timeSeconds);
    const bracket = timeBracket(timeSeconds);
    const frame = frameAtTime(bracket);
    let telemetry = frame?.telemetry;
    if (!telemetry) telemetry = compactTelemetryAt(bracket);
    const snapshotTelemetry =
      telemetry && data.jerkMps3.length > 0
        ? { ...telemetry, jerkMps3: jerkAtTime(bracket) }
        : telemetry;
    const selections = Object.freeze({
      front: selectionFor("front", bracket, frame),
      middle: selectionFor("middle", bracket, frame),
      rear: selectionFor("rear", bracket, frame),
    });
    const cars = carsAtTime(bracket);
    return Object.freeze({
      timeSeconds,
      sampleIndex,
      headDistanceM: scalarAtTime(data.distances, timeSeconds),
      speedMps: scalarAtTime(data.speeds, timeSeconds),
      telemetry: snapshotTelemetry,
      isPlaying,
      ended,
      rate,
      camera,
      selectedSeat,
      reducedMotion,
      disposed,
      selections,
      cars,
      carCount: data.carCount,
    });
  };

  const emit = (): void => {
    if (disposed) return;
    const snapshot = getSnapshot();
    for (const listener of listeners) listener(snapshot);
  };

  const setTime = (nextTime: number): void => {
    if (data.times.length === 0) {
      timeSeconds = 0;
      ended = true;
      isPlaying = false;
      return;
    }
    const first = data.times[0]!;
    const last = data.times[data.times.length - 1]!;
    timeSeconds = clamp(nextTime, first, last);
    ended = timeSeconds >= last;
    if (ended) isPlaying = false;
  };

  const controller: RidePlaybackController = {
    getSnapshot,
    play: () => {
      if (disposed || data.times.length === 0 || ended) return;
      isPlaying = true;
      emit();
    },
    pause: () => {
      if (disposed) return;
      isPlaying = false;
      emit();
    },
    tick: (deltaSeconds) => {
      if (disposed) return;
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
        throw new RangeError("Tick delta must be finite and non-negative");
      if (isPlaying && data.times.length > 0) {
        setTime(timeSeconds + deltaSeconds * rate);
        emit();
      }
    },
    scrubTime: (nextTime) => {
      if (disposed) return;
      if (!Number.isFinite(nextTime))
        throw new RangeError("Scrub timestamp must be finite");
      setTime(nextTime);
      if (!ended) isPlaying = false;
      emit();
    },
    scrubIndex: (index) => {
      if (disposed) return;
      if (!Number.isFinite(index) || !Number.isInteger(index))
        throw new RangeError("Scrub index must be a finite integer");
      if (data.times.length === 0) setTime(0);
      else setTime(data.times[clamp(index, 0, data.times.length - 1)]!);
      if (!ended) isPlaying = false;
      emit();
    },
    reset: () => {
      if (disposed) return;
      timeSeconds = data.times[0] ?? 0;
      ended = data.times.length === 0;
      isPlaying = false;
      emit();
    },
    setRate: (nextRate) => {
      if (disposed) return;
      if (!Number.isFinite(nextRate) || !isPlaybackRate(nextRate))
        throw new RangeError("Playback rate must be 0.25, 0.5, 1, or 2");
      rate = nextRate;
      emit();
    },
    setCamera: (nextCamera) => {
      if (disposed) return;
      if (!isCameraId(nextCamera))
        throw new RangeError("Unsupported camera ID");
      if (camera === nextCamera) return;
      camera = nextCamera;
      const snapshot = getSnapshot();
      for (const listener of cameraListeners) listener(camera, snapshot);
      emit();
    },
    selectSeat: (selection, seatIndex = seatIndexes[selection]) => {
      if (disposed) return;
      if (!isSelectionId(selection))
        throw new RangeError("Unsupported seat selection");
      if (!Number.isInteger(seatIndex) || seatIndex < 0)
        throw new RangeError("Seat index must be a non-negative integer");
      const currentCar = data.frames[0]?.selection[selection];
      if (currentCar && seatIndex >= currentCar.seats.length)
        throw new RangeError("Seat index is outside the selected car");
      seatIndexes[selection] = seatIndex;
      selectedSeat = selection;
      const snapshot = getSnapshot();
      for (const listener of selectionListeners) listener(selection, snapshot);
      emit();
    },
    setReducedMotion: (nextReducedMotion) => {
      if (disposed) return;
      reducedMotion = nextReducedMotion;
      emit();
    },
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => removeListener(listeners, listener);
    },
    onSelectionChange: (listener) => {
      if (disposed) return () => undefined;
      selectionListeners.add(listener);
      return () => removeListener(selectionListeners, listener);
    },
    onCameraChange: (listener) => {
      if (disposed) return () => undefined;
      cameraListeners.add(listener);
      return () => removeListener(cameraListeners, listener);
    },
    dispose: () => {
      if (disposed) return;
      isPlaying = false;
      disposed = true;
      listeners.clear();
      selectionListeners.clear();
      cameraListeners.clear();
    },
  };
  return controller;
}
