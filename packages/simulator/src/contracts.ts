import type {
  CompiledTrackData,
  TrackSample,
  Vec3,
} from "@openvibecoaster/core";

export type OperationZoneKind =
  "station" | "block" | "launch" | "boost" | "brake";

export interface OperationZone {
  readonly id: string;
  readonly kind: OperationZoneKind;
  readonly startDistanceM: number;
  readonly endDistanceM: number;
  readonly targetSpeedMps?: number;
  readonly lsmForcePerCarN?: number;
  readonly lsmPowerPerCarW?: number;
  readonly brakeForcePerCarN?: number;
  readonly blockId?: string;
}

export interface CarConfiguration {
  readonly massKg: number;
  readonly seatCount: number;
  readonly seatPositionsM?: readonly Vec3[];
}

export interface TrainEnvelope {
  readonly halfWidthM: number;
  readonly aboveRailM: number;
  readonly belowRailM: number;
  readonly noseTailMarginM: number;
}

export interface TrainConfiguration {
  readonly cars: readonly CarConfiguration[];
  readonly spacingM: number;
  readonly envelope: TrainEnvelope;
}

export interface SimulatorConfig {
  readonly gravityMps2: number;
  readonly gravityDirection?: Vec3;
  readonly closedTrack?: boolean;
  readonly fixedStepSeconds: number;
  readonly timelineStepSeconds: number;
  readonly rollingResistanceCoefficient: number;
  readonly staticStictionCoefficient: number;
  readonly dragCdA: number;
  readonly airDensityKgPerM3: number;
  readonly lsmForcePerCarN: number;
  readonly lsmPowerPerCarW: number;
  readonly lsmTargetGainNPerMps: number;
  readonly maxBrakeForcePerCarN: number;
  readonly zones: readonly OperationZone[];
  readonly train: TrainConfiguration;
}

export interface PerCarForce {
  readonly gravity: number;
  readonly rolling: number;
  readonly drag: number;
  readonly drive: number;
  readonly brake: number;
  readonly net: number;
  readonly launchActive: boolean;
  readonly brakeActive: boolean;
}

export interface SimulationInitialState {
  readonly headDistanceM: number;
  readonly speedMps: number;
}

export interface SimulationDiagnostic {
  readonly code:
    "SIM_INVALID_STATE" | "SIM_INVALID_CONFIGURATION" | "SIM_NUMERICAL";
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly field?: string;
}

export interface CarState {
  readonly index: number;
  readonly distanceM: number;
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly frame: TrackSample;
  readonly seatOffsets: readonly Vec3[];
  readonly seatPositions: readonly Vec3[];
  readonly telemetry: CarTelemetry;
  readonly seats: readonly SeatState[];
}

export interface SeatState {
  readonly index: number;
  readonly distanceM: number;
  readonly position: Vec3;
  readonly frame: TrackSample;
  readonly telemetry: CarTelemetry;
}

export interface CarTelemetry {
  readonly longitudinalG: number;
  readonly lateralG: number;
  readonly verticalG: number;
  readonly specificForceMps2: Vec3;
  readonly jerkMps3: Vec3;
  readonly bankRad: number;
  readonly rollRateRadPerSec: number;
}

export interface RideTelemetry {
  readonly perCar: readonly CarTelemetry[];
  readonly longitudinalG: number;
  readonly lateralG: number;
  readonly verticalG: number;
  readonly specificForceMps2: Vec3;
  readonly bankRad: number;
  readonly rollRateRadPerSec: number;
  readonly jerkMps3: Vec3;
  readonly launchActivity: boolean;
  readonly brakeActivity: boolean;
  readonly kineticEnergyJ: number;
  readonly potentialEnergyJ: number;
  readonly accumulatedDriveWorkJ: number;
  readonly accumulatedLossWorkJ: number;
  readonly energyErrorJ: number;
}

export type SimulationStatus =
  "static-hold" | "rolling" | "stall" | "rollback" | "reversal";

export interface SimulationFrame {
  readonly timeSeconds: number;
  readonly headDistanceM: number;
  readonly speedMps: number;
  readonly status: SimulationStatus;
  readonly cars: readonly CarState[];
  readonly selection: {
    readonly front: CarState;
    readonly middle: CarState;
    readonly rear: CarState;
  };
  readonly telemetry: RideTelemetry;
}

export interface SimulationEvent {
  readonly timeSeconds: number;
  readonly type: "zone-entry" | "zone-exit";
  readonly zoneId: string;
  readonly operation: OperationZoneKind;
  readonly boundary: "start" | "end";
  readonly direction: "forward" | "reverse";
}

export interface OperationState {
  readonly trainCount: 1;
  readonly activeZoneIds: readonly string[];
  readonly occupiedBlockIds: readonly string[];
  readonly stationId?: string;
}

export interface SimulationRequest {
  readonly durationSeconds: number;
  readonly config: SimulatorConfig;
  readonly initial: SimulationInitialState;
}

export interface SimulationResult {
  readonly frames: readonly SimulationFrame[];
  readonly timeline: import("./timeline").RideTimeline;
  readonly events: readonly SimulationEvent[];
  readonly operationState: OperationState;
  readonly diagnostics: readonly SimulationDiagnostic[];
}

export interface SimulatorInput {
  readonly track: CompiledTrackData;
  readonly request: SimulationRequest;
}
