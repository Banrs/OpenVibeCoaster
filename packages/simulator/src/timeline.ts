import type { SimulationFrame } from "./contracts";
import type { CarState, CarTelemetry, SeatState } from "./contracts";
import type { TrackSample, Vec3 } from "@openvibecoaster/core";

export interface RideTimelineInput {
  readonly sampleRateHz: number;
  readonly timeSeconds: Float64Array;
  readonly headDistanceM: Float64Array;
  readonly speedMps: Float64Array;
  readonly longitudinalG?: Float64Array;
  readonly lateralG?: Float64Array;
  readonly verticalG?: Float64Array;
  readonly jerkMps3?: Float64Array;
  readonly carCount?: number;
  readonly carPositionsXYZ?: Float64Array;
  readonly carTangentsXYZ?: Float64Array;
  readonly carNormalsXYZ?: Float64Array;
  readonly carBinormalsXYZ?: Float64Array;
  readonly launchActivity?: Float64Array;
  readonly brakeActivity?: Float64Array;
  readonly kineticEnergyJ?: Float64Array;
  readonly potentialEnergyJ?: Float64Array;
  readonly accumulatedDriveWorkJ?: Float64Array;
  readonly accumulatedLossWorkJ?: Float64Array;
  readonly energyErrorJ?: Float64Array;
  readonly bankRad?: Float64Array;
  readonly rollRateRadPerSec?: Float64Array;
  readonly specificForceXYZ?: Float64Array;
  readonly perCarLongitudinalG?: Float64Array;
  readonly perCarLateralG?: Float64Array;
  readonly perCarVerticalG?: Float64Array;
  readonly perCarBankRad?: Float64Array;
  readonly perCarRollRateRadPerSec?: Float64Array;
  readonly perCarSpecificForceXYZ?: Float64Array;
  readonly perCarJerkXYZ?: Float64Array;
  readonly frames?: readonly SimulationFrame[];
}

export interface RideTimelineTransfer {
  readonly sampleRateHz: number;
  readonly carCount: number;
  readonly length: number;
  readonly buffers: readonly ArrayBuffer[];
  readonly frames?: readonly SimulationFrame[];
}

const clone = (values: Float64Array | undefined): Float64Array =>
  values ? new Float64Array(values) : new Float64Array();
const requireFinite = (values: Float64Array, field: string): void => {
  for (const value of values)
    if (!Number.isFinite(value))
      throw new RangeError(`RideTimeline ${field} must be finite`);
};
const requireFiniteNumber = (value: number, field: string): void => {
  if (!Number.isFinite(value))
    throw new RangeError(`RideTimeline ${field} must be finite`);
};
const requireFiniteVec = (value: Vec3, field: string): void => {
  value.forEach((component, index) =>
    requireFiniteNumber(component, `${field}[${index}]`),
  );
};
const validateSample = (sample: TrackSample, field: string): void => {
  requireFiniteVec(sample.position, `${field}.position`);
  requireFiniteVec(sample.tangent, `${field}.tangent`);
  requireFiniteVec(sample.normal, `${field}.normal`);
  requireFiniteVec(sample.binormal, `${field}.binormal`);
  requireFiniteNumber(sample.distance, `${field}.distance`);
  requireFiniteNumber(sample.curvature, `${field}.curvature`);
  requireFiniteVec(sample.curvatureVector, `${field}.curvatureVector`);
  requireFiniteNumber(sample.bank, `${field}.bank`);
  requireFiniteNumber(sample.bankDerivative, `${field}.bankDerivative`);
};
const validateTelemetry = (telemetry: CarTelemetry, field: string): void => {
  requireFiniteNumber(telemetry.longitudinalG, `${field}.longitudinalG`);
  requireFiniteNumber(telemetry.lateralG, `${field}.lateralG`);
  requireFiniteNumber(telemetry.verticalG, `${field}.verticalG`);
  requireFiniteVec(telemetry.specificForceMps2, `${field}.specificForceMps2`);
  requireFiniteVec(telemetry.jerkMps3, `${field}.jerkMps3`);
  requireFiniteNumber(telemetry.bankRad, `${field}.bankRad`);
  requireFiniteNumber(
    telemetry.rollRateRadPerSec,
    `${field}.rollRateRadPerSec`,
  );
};
const validateCar = (car: CarState, field: string): void => {
  requireFiniteNumber(car.index, `${field}.index`);
  requireFiniteNumber(car.distanceM, `${field}.distanceM`);
  requireFiniteVec(car.position, `${field}.position`);
  requireFiniteVec(car.tangent, `${field}.tangent`);
  requireFiniteVec(car.normal, `${field}.normal`);
  requireFiniteVec(car.binormal, `${field}.binormal`);
  validateSample(car.frame, `${field}.frame`);
  car.seatOffsets.forEach((offset, seatIndex) =>
    requireFiniteVec(offset, `${field}.seatOffsets[${seatIndex}]`),
  );
  car.seatPositions.forEach((position, seatIndex) =>
    requireFiniteVec(position, `${field}.seatPositions[${seatIndex}]`),
  );
  validateTelemetry(car.telemetry, `${field}.telemetry`);
  car.seats.forEach((seat, seatIndex) => {
    const seatField = `${field}.seats[${seatIndex}]`;
    requireFiniteNumber(seat.index, `${seatField}.index`);
    requireFiniteNumber(seat.distanceM, `${seatField}.distanceM`);
    requireFiniteVec(seat.position, `${seatField}.position`);
    validateSample(seat.frame, `${seatField}.frame`);
    validateTelemetry(seat.telemetry, `${seatField}.telemetry`);
  });
};
const validateFrame = (frame: SimulationFrame, frameIndex: number): void => {
  const field = `frames[${frameIndex}]`;
  requireFiniteNumber(frame.timeSeconds, `${field}.timeSeconds`);
  requireFiniteNumber(frame.headDistanceM, `${field}.headDistanceM`);
  requireFiniteNumber(frame.speedMps, `${field}.speedMps`);
  validateTelemetry(frame.telemetry, `${field}.telemetry`);
  requireFiniteNumber(
    frame.telemetry.kineticEnergyJ,
    `${field}.telemetry.kineticEnergyJ`,
  );
  requireFiniteNumber(
    frame.telemetry.potentialEnergyJ,
    `${field}.telemetry.potentialEnergyJ`,
  );
  requireFiniteNumber(
    frame.telemetry.accumulatedDriveWorkJ,
    `${field}.telemetry.accumulatedDriveWorkJ`,
  );
  requireFiniteNumber(
    frame.telemetry.accumulatedLossWorkJ,
    `${field}.telemetry.accumulatedLossWorkJ`,
  );
  requireFiniteNumber(
    frame.telemetry.energyErrorJ,
    `${field}.telemetry.energyErrorJ`,
  );
  frame.telemetry.perCar.forEach((telemetry, carIndex) =>
    validateTelemetry(telemetry, `${field}.telemetry.perCar[${carIndex}]`),
  );
  frame.cars.forEach((car, carIndex) =>
    validateCar(car, `${field}.cars[${carIndex}]`),
  );
  validateCar(frame.selection.front, `${field}.selection.front`);
  validateCar(frame.selection.middle, `${field}.selection.middle`);
  validateCar(frame.selection.rear, `${field}.selection.rear`);
};
const cloneVec = (value: Vec3): Vec3 =>
  Object.freeze([value[0], value[1], value[2]]);
const cloneSample = (sample: TrackSample): TrackSample =>
  Object.freeze({
    ...sample,
    position: cloneVec(sample.position),
    tangent: cloneVec(sample.tangent),
    normal: cloneVec(sample.normal),
    binormal: cloneVec(sample.binormal),
    curvatureVector: cloneVec(sample.curvatureVector),
  });
const cloneTelemetry = (telemetry: CarTelemetry): CarTelemetry =>
  Object.freeze({
    ...telemetry,
    specificForceMps2: cloneVec(telemetry.specificForceMps2),
    jerkMps3: cloneVec(telemetry.jerkMps3),
  });
const cloneSeat = (seat: SeatState): SeatState =>
  Object.freeze({
    ...seat,
    position: cloneVec(seat.position),
    frame: cloneSample(seat.frame),
    telemetry: cloneTelemetry(seat.telemetry),
  });
const cloneCar = (car: CarState): CarState =>
  Object.freeze({
    ...car,
    position: cloneVec(car.position),
    tangent: cloneVec(car.tangent),
    normal: cloneVec(car.normal),
    binormal: cloneVec(car.binormal),
    frame: cloneSample(car.frame),
    seatOffsets: Object.freeze(car.seatOffsets.map(cloneVec)),
    seatPositions: Object.freeze(car.seatPositions.map(cloneVec)),
    telemetry: cloneTelemetry(car.telemetry),
    seats: Object.freeze(car.seats.map(cloneSeat)),
  });
const cloneFrame = (frame: SimulationFrame): SimulationFrame => {
  const cars = Object.freeze(frame.cars.map(cloneCar));
  const telemetry = Object.freeze({
    ...frame.telemetry,
    perCar: Object.freeze(cars.map((car) => car.telemetry)),
    specificForceMps2: cloneVec(frame.telemetry.specificForceMps2),
    jerkMps3: cloneVec(frame.telemetry.jerkMps3),
  });
  return Object.freeze({
    ...frame,
    cars,
    selection: Object.freeze({
      front: cars[0]!,
      middle: cars[Math.floor((cars.length - 1) / 2)]!,
      rear: cars[cars.length - 1]!,
    }),
    telemetry,
  });
};

export class RideTimeline {
  readonly #sampleRateHz: number;
  readonly #carCount: number;
  readonly #timeSeconds: Float64Array;
  readonly #headDistanceM: Float64Array;
  readonly #speedMps: Float64Array;
  readonly #longitudinalG: Float64Array;
  readonly #lateralG: Float64Array;
  readonly #verticalG: Float64Array;
  readonly #jerkMps3: Float64Array;
  readonly #carPositionsXYZ: Float64Array;
  readonly #carTangentsXYZ: Float64Array;
  readonly #carNormalsXYZ: Float64Array;
  readonly #carBinormalsXYZ: Float64Array;
  readonly #launchActivity: Float64Array;
  readonly #brakeActivity: Float64Array;
  readonly #kineticEnergyJ: Float64Array;
  readonly #potentialEnergyJ: Float64Array;
  readonly #accumulatedDriveWorkJ: Float64Array;
  readonly #accumulatedLossWorkJ: Float64Array;
  readonly #energyErrorJ: Float64Array;
  readonly #bankRad: Float64Array;
  readonly #rollRateRadPerSec: Float64Array;
  readonly #specificForceXYZ: Float64Array;
  readonly #perCarLongitudinalG: Float64Array;
  readonly #perCarLateralG: Float64Array;
  readonly #perCarVerticalG: Float64Array;
  readonly #perCarBankRad: Float64Array;
  readonly #perCarRollRateRadPerSec: Float64Array;
  readonly #perCarSpecificForceXYZ: Float64Array;
  readonly #perCarJerkXYZ: Float64Array;
  readonly #frames: readonly SimulationFrame[];

  public constructor(input: RideTimelineInput) {
    if (!Number.isFinite(input.sampleRateHz) || input.sampleRateHz <= 0)
      throw new RangeError("RideTimeline sample rate must be positive");
    const length = input.timeSeconds.length;
    requireFinite(input.timeSeconds, "timeSeconds");
    requireFinite(input.headDistanceM, "headDistanceM");
    requireFinite(input.speedMps, "speedMps");
    for (const values of [input.headDistanceM, input.speedMps])
      if (values.length !== length)
        throw new RangeError(
          "RideTimeline scalar arrays must have equal lengths",
        );
    for (const values of [input.longitudinalG, input.lateralG, input.verticalG])
      if (values && values.length !== 0 && values.length !== length)
        throw new RangeError(
          "RideTimeline metric arrays must match time length",
        );
    for (const values of [
      input.launchActivity,
      input.brakeActivity,
      input.kineticEnergyJ,
      input.potentialEnergyJ,
      input.accumulatedDriveWorkJ,
      input.accumulatedLossWorkJ,
      input.energyErrorJ,
      input.bankRad,
      input.rollRateRadPerSec,
    ] as const)
      if (values && values.length !== 0 && values.length !== length)
        throw new RangeError(
          "RideTimeline scalar energy/activity arrays must match time length",
        );
    if (
      input.specificForceXYZ &&
      input.specificForceXYZ.length !== 0 &&
      input.specificForceXYZ.length !== length * 3
    )
      throw new RangeError(
        "specificForceXYZ length must contain three components per time sample",
      );
    for (const values of [
      input.perCarLongitudinalG,
      input.perCarLateralG,
      input.perCarVerticalG,
      input.perCarBankRad,
      input.perCarRollRateRadPerSec,
    ] as const)
      if (
        values &&
        values.length !== 0 &&
        values.length !== length * (input.carCount ?? 0)
      )
        throw new RangeError(
          "RideTimeline per-car scalar arrays must match time*carCount",
        );
    for (const values of [
      input.perCarSpecificForceXYZ,
      input.perCarJerkXYZ,
    ] as const)
      if (
        values &&
        values.length !== 0 &&
        values.length !== length * (input.carCount ?? 0) * 3
      )
        throw new RangeError(
          "RideTimeline per-car vector arrays must match time*carCount*3",
        );
    for (const [field, values] of [
      ["longitudinalG", input.longitudinalG],
      ["lateralG", input.lateralG],
      ["verticalG", input.verticalG],
      ["jerkMps3", input.jerkMps3],
      ["carPositionsXYZ", input.carPositionsXYZ],
      ["carTangentsXYZ", input.carTangentsXYZ],
      ["carNormalsXYZ", input.carNormalsXYZ],
      ["carBinormalsXYZ", input.carBinormalsXYZ],
      ["launchActivity", input.launchActivity],
      ["brakeActivity", input.brakeActivity],
      ["kineticEnergyJ", input.kineticEnergyJ],
      ["potentialEnergyJ", input.potentialEnergyJ],
      ["accumulatedDriveWorkJ", input.accumulatedDriveWorkJ],
      ["accumulatedLossWorkJ", input.accumulatedLossWorkJ],
      ["energyErrorJ", input.energyErrorJ],
      ["bankRad", input.bankRad],
      ["rollRateRadPerSec", input.rollRateRadPerSec],
      ["specificForceXYZ", input.specificForceXYZ],
      ["perCarLongitudinalG", input.perCarLongitudinalG],
      ["perCarLateralG", input.perCarLateralG],
      ["perCarVerticalG", input.perCarVerticalG],
      ["perCarBankRad", input.perCarBankRad],
      ["perCarRollRateRadPerSec", input.perCarRollRateRadPerSec],
      ["perCarSpecificForceXYZ", input.perCarSpecificForceXYZ],
      ["perCarJerkXYZ", input.perCarJerkXYZ],
    ] as const)
      if (values) requireFinite(values, field);
    this.#sampleRateHz = input.sampleRateHz;
    this.#carCount = input.carCount ?? 0;
    this.#timeSeconds = new Float64Array(input.timeSeconds);
    this.#headDistanceM = new Float64Array(input.headDistanceM);
    this.#speedMps = new Float64Array(input.speedMps);
    this.#longitudinalG = clone(input.longitudinalG);
    this.#lateralG = clone(input.lateralG);
    this.#verticalG = clone(input.verticalG);
    this.#jerkMps3 = clone(input.jerkMps3);
    this.#carPositionsXYZ = clone(input.carPositionsXYZ);
    this.#carTangentsXYZ = clone(input.carTangentsXYZ);
    this.#carNormalsXYZ = clone(input.carNormalsXYZ);
    this.#carBinormalsXYZ = clone(input.carBinormalsXYZ);
    this.#launchActivity = clone(input.launchActivity);
    this.#brakeActivity = clone(input.brakeActivity);
    this.#kineticEnergyJ = clone(input.kineticEnergyJ);
    this.#potentialEnergyJ = clone(input.potentialEnergyJ);
    this.#accumulatedDriveWorkJ = clone(input.accumulatedDriveWorkJ);
    this.#accumulatedLossWorkJ = clone(input.accumulatedLossWorkJ);
    this.#energyErrorJ = clone(input.energyErrorJ);
    this.#bankRad = clone(input.bankRad);
    this.#rollRateRadPerSec = clone(input.rollRateRadPerSec);
    this.#specificForceXYZ = clone(input.specificForceXYZ);
    this.#perCarLongitudinalG = clone(input.perCarLongitudinalG);
    this.#perCarLateralG = clone(input.perCarLateralG);
    this.#perCarVerticalG = clone(input.perCarVerticalG);
    this.#perCarBankRad = clone(input.perCarBankRad);
    this.#perCarRollRateRadPerSec = clone(input.perCarRollRateRadPerSec);
    this.#perCarSpecificForceXYZ = clone(input.perCarSpecificForceXYZ);
    this.#perCarJerkXYZ = clone(input.perCarJerkXYZ);
    this.#frames = Object.freeze(
      (input.frames ?? []).map((frame, frameIndex) => {
        validateFrame(frame, frameIndex);
        return cloneFrame(frame);
      }),
    );
    Object.freeze(this);
  }

  public get sampleRateHz(): number {
    return this.#sampleRateHz;
  }
  public get carCount(): number {
    return this.#carCount;
  }
  public get length(): number {
    return this.#timeSeconds.length;
  }
  public get timeSeconds(): Float64Array {
    return new Float64Array(this.#timeSeconds);
  }
  public get headDistanceM(): Float64Array {
    return new Float64Array(this.#headDistanceM);
  }
  public get speedMps(): Float64Array {
    return new Float64Array(this.#speedMps);
  }
  public get longitudinalG(): Float64Array {
    return new Float64Array(this.#longitudinalG);
  }
  public get lateralG(): Float64Array {
    return new Float64Array(this.#lateralG);
  }
  public get verticalG(): Float64Array {
    return new Float64Array(this.#verticalG);
  }
  public get jerkMps3(): Float64Array {
    return new Float64Array(this.#jerkMps3);
  }
  public get carPositionsXYZ(): Float64Array {
    return new Float64Array(this.#carPositionsXYZ);
  }
  public get carTangentsXYZ(): Float64Array {
    return new Float64Array(this.#carTangentsXYZ);
  }
  public get carNormalsXYZ(): Float64Array {
    return new Float64Array(this.#carNormalsXYZ);
  }
  public get carBinormalsXYZ(): Float64Array {
    return new Float64Array(this.#carBinormalsXYZ);
  }
  public get launchActivity(): Float64Array {
    return new Float64Array(this.#launchActivity);
  }
  public get brakeActivity(): Float64Array {
    return new Float64Array(this.#brakeActivity);
  }
  public get kineticEnergyJ(): Float64Array {
    return new Float64Array(this.#kineticEnergyJ);
  }
  public get potentialEnergyJ(): Float64Array {
    return new Float64Array(this.#potentialEnergyJ);
  }
  public get accumulatedDriveWorkJ(): Float64Array {
    return new Float64Array(this.#accumulatedDriveWorkJ);
  }
  public get accumulatedLossWorkJ(): Float64Array {
    return new Float64Array(this.#accumulatedLossWorkJ);
  }
  public get energyErrorJ(): Float64Array {
    return new Float64Array(this.#energyErrorJ);
  }
  public get bankRad(): Float64Array {
    return new Float64Array(this.#bankRad);
  }
  public get rollRateRadPerSec(): Float64Array {
    return new Float64Array(this.#rollRateRadPerSec);
  }
  public get specificForceXYZ(): Float64Array {
    return new Float64Array(this.#specificForceXYZ);
  }
  public get perCarLongitudinalG(): Float64Array {
    return new Float64Array(this.#perCarLongitudinalG);
  }
  public get perCarLateralG(): Float64Array {
    return new Float64Array(this.#perCarLateralG);
  }
  public get perCarVerticalG(): Float64Array {
    return new Float64Array(this.#perCarVerticalG);
  }
  public get perCarBankRad(): Float64Array {
    return new Float64Array(this.#perCarBankRad);
  }
  public get perCarRollRateRadPerSec(): Float64Array {
    return new Float64Array(this.#perCarRollRateRadPerSec);
  }
  public get perCarSpecificForceXYZ(): Float64Array {
    return new Float64Array(this.#perCarSpecificForceXYZ);
  }
  public get perCarJerkXYZ(): Float64Array {
    return new Float64Array(this.#perCarJerkXYZ);
  }
  public get frames(): readonly SimulationFrame[] {
    return this.#frames;
  }

  public toTransferable(): RideTimelineTransfer {
    return {
      sampleRateHz: this.#sampleRateHz,
      carCount: this.#carCount,
      length: this.length,
      buffers: [
        this.#timeSeconds.slice().buffer,
        this.#headDistanceM.slice().buffer,
        this.#speedMps.slice().buffer,
        this.#longitudinalG.slice().buffer,
        this.#lateralG.slice().buffer,
        this.#verticalG.slice().buffer,
        this.#jerkMps3.slice().buffer,
        this.#carPositionsXYZ.slice().buffer,
        this.#carTangentsXYZ.slice().buffer,
        this.#carNormalsXYZ.slice().buffer,
        this.#carBinormalsXYZ.slice().buffer,
        this.#launchActivity.slice().buffer,
        this.#brakeActivity.slice().buffer,
        this.#kineticEnergyJ.slice().buffer,
        this.#potentialEnergyJ.slice().buffer,
        this.#accumulatedDriveWorkJ.slice().buffer,
        this.#accumulatedLossWorkJ.slice().buffer,
        this.#energyErrorJ.slice().buffer,
        this.#bankRad.slice().buffer,
        this.#rollRateRadPerSec.slice().buffer,
        this.#specificForceXYZ.slice().buffer,
        this.#perCarLongitudinalG.slice().buffer,
        this.#perCarLateralG.slice().buffer,
        this.#perCarVerticalG.slice().buffer,
        this.#perCarBankRad.slice().buffer,
        this.#perCarRollRateRadPerSec.slice().buffer,
        this.#perCarSpecificForceXYZ.slice().buffer,
        this.#perCarJerkXYZ.slice().buffer,
      ],
      ...(this.#frames.length > 0 ? { frames: this.#frames } : {}),
    };
  }

  public static fromTransferable(transfer: RideTimelineTransfer): RideTimeline {
    if (transfer.buffers.length < 11)
      throw new RangeError(
        "RideTimeline transfer is missing typed-array buffers",
      );
    const values = transfer.buffers.map((buffer) => new Float64Array(buffer));
    const get = (index: number): Float64Array =>
      values[index] ?? new Float64Array();
    // Validate optional compact buffers finite and length correctness inside constructor
    return new RideTimeline({
      sampleRateHz: transfer.sampleRateHz,
      carCount: transfer.carCount,
      timeSeconds: get(0),
      headDistanceM: get(1),
      speedMps: get(2),
      longitudinalG: get(3),
      lateralG: get(4),
      verticalG: get(5),
      jerkMps3: get(6),
      carPositionsXYZ: get(7),
      carTangentsXYZ: get(8),
      carNormalsXYZ: get(9),
      carBinormalsXYZ: get(10),
      launchActivity: get(11),
      brakeActivity: get(12),
      kineticEnergyJ: get(13),
      potentialEnergyJ: get(14),
      accumulatedDriveWorkJ: get(15),
      accumulatedLossWorkJ: get(16),
      energyErrorJ: get(17),
      bankRad: get(18),
      rollRateRadPerSec: get(19),
      specificForceXYZ: get(20),
      perCarLongitudinalG: get(21),
      perCarLateralG: get(22),
      perCarVerticalG: get(23),
      perCarBankRad: get(24),
      perCarRollRateRadPerSec: get(25),
      perCarSpecificForceXYZ: get(26),
      perCarJerkXYZ: get(27),
      ...(transfer.frames ? { frames: transfer.frames } : {}),
    });
  }

  public transferables(): readonly ArrayBuffer[] {
    return this.toTransferable().buffers;
  }

  public toJSON(): Record<string, unknown> {
    return {
      sampleRateHz: this.#sampleRateHz,
      carCount: this.#carCount,
      timeSeconds: Array.from(this.#timeSeconds),
      headDistanceM: Array.from(this.#headDistanceM),
      speedMps: Array.from(this.#speedMps),
      longitudinalG: Array.from(this.#longitudinalG),
      lateralG: Array.from(this.#lateralG),
      verticalG: Array.from(this.#verticalG),
      jerkMps3: Array.from(this.#jerkMps3),
      carPositionsXYZ: Array.from(this.#carPositionsXYZ),
      carTangentsXYZ: Array.from(this.#carTangentsXYZ),
      carNormalsXYZ: Array.from(this.#carNormalsXYZ),
      carBinormalsXYZ: Array.from(this.#carBinormalsXYZ),
      launchActivity: Array.from(this.#launchActivity),
      brakeActivity: Array.from(this.#brakeActivity),
      kineticEnergyJ: Array.from(this.#kineticEnergyJ),
      potentialEnergyJ: Array.from(this.#potentialEnergyJ),
      accumulatedDriveWorkJ: Array.from(this.#accumulatedDriveWorkJ),
      accumulatedLossWorkJ: Array.from(this.#accumulatedLossWorkJ),
      energyErrorJ: Array.from(this.#energyErrorJ),
      bankRad: Array.from(this.#bankRad),
      rollRateRadPerSec: Array.from(this.#rollRateRadPerSec),
      specificForceXYZ: Array.from(this.#specificForceXYZ),
      perCarLongitudinalG: Array.from(this.#perCarLongitudinalG),
      perCarLateralG: Array.from(this.#perCarLateralG),
      perCarVerticalG: Array.from(this.#perCarVerticalG),
      perCarBankRad: Array.from(this.#perCarBankRad),
      perCarRollRateRadPerSec: Array.from(this.#perCarRollRateRadPerSec),
      perCarSpecificForceXYZ: Array.from(this.#perCarSpecificForceXYZ),
      perCarJerkXYZ: Array.from(this.#perCarJerkXYZ),
      frames: this.#frames,
    };
  }
}
