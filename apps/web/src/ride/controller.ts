import type { Vec3 } from "@openvibecoaster/core";
import type {
  CarState,
  RideTimeline,
  SeatState,
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
  readonly isPlaying: boolean;
  readonly ended: boolean;
  readonly rate: RidePlaybackRate;
  readonly camera: RideCameraId;
  readonly selectedSeat: RideSelectionId;
  readonly reducedMotion: boolean;
  readonly disposed: boolean;
  readonly selections: Readonly<Record<RideSelectionId, RideSelection>>;
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
  readonly carCount: number;
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly frames: readonly {
    readonly cars: readonly CarState[];
    readonly selection: Readonly<Record<RideSelectionId, CarState>>;
  }[];
}

const selectionIds: readonly RideSelectionId[] = ["front", "middle", "rear"];

const isSelectionId = (value: string): value is RideSelectionId =>
  selectionIds.includes(value as RideSelectionId);

const isCameraId = (value: string): value is RideCameraId =>
  RIDE_CAMERA_IDS.includes(value as RideCameraId);

const isPlaybackRate = (value: number): value is RidePlaybackRate =>
  RIDE_PLAYBACK_RATES.includes(value as RidePlaybackRate);

const cloneVec = (x: number, y: number, z: number): Vec3 => [x, y, z];

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

  if (times.length !== distances.length || times.length !== speeds.length)
    throw new RangeError("RideTimeline scalar arrays must have equal lengths");
  if (!Number.isInteger(carCount) || carCount < 0)
    throw new RangeError(
      "RideTimeline car count must be a non-negative integer",
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
  }
  if (frames.length !== 0 && frames.length !== times.length)
    throw new RangeError("RideTimeline frames length must match time length");
  frames.forEach((frame, index) => {
    if (frame.cars.length !== carCount)
      throw new RangeError(`RideTimeline frame ${index} car count mismatch`);
  });
  return {
    times,
    distances,
    speeds,
    carCount,
    positions,
    tangents,
    normals,
    binormals,
    frames,
  };
};

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

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
    if (nextIndex === index || endTime === startTime) return values[index] ?? 0;
    const interpolation = (time - startTime) / (endTime - startTime);
    return (
      (values[index] ?? 0) * (1 - interpolation) +
      (values[nextIndex] ?? 0) * interpolation
    );
  };

  const selectionFor = (
    id: RideSelectionId,
    sampleIndex: number,
  ): RideSelection => {
    const frame = data.frames[sampleIndex];
    const carIndex =
      id === "front"
        ? 0
        : id === "rear"
          ? Math.max(0, data.carCount - 1)
          : Math.floor(Math.max(0, data.carCount - 1) / 2);
    const car = frame?.selection[id] ?? frame?.cars[carIndex];
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
    const offset = (sampleIndex * data.carCount + carIndex) * 3;
    const vector = (values: Float64Array): Vec3 | undefined =>
      data.carCount === 0
        ? undefined
        : cloneVec(
            values[offset] ?? 0,
            values[offset + 1] ?? 0,
            values[offset + 2] ?? 0,
          );
    return Object.freeze({
      id,
      carIndex,
      car: undefined,
      seatIndex,
      seat: undefined,
      position: vector(data.positions),
      tangent: vector(data.tangents),
      normal: vector(data.normals),
      binormal: vector(data.binormals),
    });
  };

  const getSnapshot = (): RidePlaybackSnapshot => {
    const sampleIndex = sampleIndexAtTime(timeSeconds);
    const selections = Object.freeze({
      front: selectionFor("front", sampleIndex),
      middle: selectionFor("middle", sampleIndex),
      rear: selectionFor("rear", sampleIndex),
    });
    return Object.freeze({
      timeSeconds,
      sampleIndex,
      headDistanceM: scalarAtTime(data.distances, timeSeconds),
      speedMps: scalarAtTime(data.speeds, timeSeconds),
      isPlaying,
      ended,
      rate,
      camera,
      selectedSeat,
      reducedMotion,
      disposed,
      selections,
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
