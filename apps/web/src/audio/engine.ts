export interface AudioParamLike {
  value: number;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: unknown;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}

interface OscillatorLike extends AudioNodeLike {
  type: OscillatorType;
  frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

interface FilterLike extends AudioNodeLike {
  type: BiquadFilterType;
  frequency: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: AudioContextState;
  readonly destination: AudioNodeLike;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createBiquadFilter(): FilterLike;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type RideAudioLayerId = "wind" | "rail" | "lsm" | "brake";
export type RideAudioEngineStatus =
  "locked" | "ready" | "unsupported" | "failed" | "disposed";

export interface RideAudioUpdate {
  readonly speedMps: number;
  readonly zoneMask: number;
  readonly paused?: boolean;
}

export interface RideAudioLayerState {
  readonly active: boolean;
  readonly gain: number;
  readonly frequency: number;
}

export interface RideAudioState {
  readonly status: RideAudioEngineStatus;
  readonly muted: boolean;
  readonly lastUpdate: RideAudioUpdate | null;
  readonly layers: Readonly<Record<RideAudioLayerId, RideAudioLayerState>>;
}

export interface RideAudioEngine {
  getState(): RideAudioState;
  unlock(): Promise<boolean>;
  setMuted(muted: boolean): void;
  update(update: RideAudioUpdate): boolean;
  dispose(): void;
}

export class AudioUnavailableError extends Error {
  public constructor(message = "Web Audio is unavailable") {
    super(message);
    this.name = "AudioUnavailableError";
  }
}

interface LayerNodes {
  readonly source: AudioBufferSourceLike | OscillatorLike;
  readonly filter: FilterLike;
  readonly gain: GainLike;
}

interface LayerValues {
  active: boolean;
  gain: number;
  frequency: number;
}

const layerIds: readonly RideAudioLayerId[] = ["wind", "rail", "lsm", "brake"];
const defaultZoneNames = [
  "station",
  "block",
  "launch",
  "boost",
  "brake",
] as const;
const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

const defaultAudioContextFactory = (): AudioContextLike => {
  const constructor = globalThis.AudioContext as
    (new () => AudioContextLike) | undefined;
  if (!constructor) throw new AudioUnavailableError();
  return new constructor();
};

const emptyLayers = (): Record<RideAudioLayerId, LayerValues> => ({
  wind: { active: false, gain: 0, frequency: 0 },
  rail: { active: false, gain: 0, frequency: 0 },
  lsm: { active: false, gain: 0, frequency: 0 },
  brake: { active: false, gain: 0, frequency: 0 },
});

export function createRideAudioEngine(
  options: {
    readonly audioContextFactory?: () => AudioContextLike;
    readonly zoneNames?: readonly string[];
    readonly lsmZoneMask?: number;
    readonly brakeZoneMask?: number;
  } = {},
): RideAudioEngine {
  const contextFactory =
    options.audioContextFactory ?? defaultAudioContextFactory;
  const zoneNames = options.zoneNames ?? defaultZoneNames;
  const namedMask = (names: readonly string[]): number =>
    names.reduce((mask, name) => {
      const index = zoneNames.indexOf(name);
      return index >= 0 && index < 32 ? mask | (1 << index) : mask;
    }, 0);
  const lsmZoneMask = options.lsmZoneMask ?? namedMask(["launch", "boost"]);
  const brakeZoneMask = options.brakeZoneMask ?? namedMask(["brake"]);
  let status: RideAudioEngineStatus = "locked";
  let muted = false;
  let disposed = false;
  let context: AudioContextLike | undefined;
  let unlockPromise: Promise<boolean> | undefined;
  let master: GainLike | undefined;
  let nodes: Partial<Record<RideAudioLayerId, LayerNodes>> = {};
  let startedSources: (AudioBufferSourceLike | OscillatorLike)[] = [];
  let lastUpdate: RideAudioUpdate | null = null;
  let paused = false;
  const layers = emptyLayers();

  const getState = (): RideAudioState => {
    const result = {} as Record<RideAudioLayerId, RideAudioLayerState>;
    for (const id of layerIds) {
      const layer = layers[id];
      result[id] = Object.freeze({
        active: layer.active,
        gain: muted || paused ? 0 : layer.gain,
        frequency: layer.frequency,
      });
    }
    return Object.freeze({
      status,
      muted,
      lastUpdate,
      layers: Object.freeze(result),
    });
  };

  const automate = (param: AudioParamLike, value: number): void => {
    param.setTargetAtTime(value, context?.currentTime ?? 0, 0.03);
  };

  const applyNodeValues = (): void => {
    if (!context) return;
    for (const id of layerIds) {
      const layer = layers[id];
      const layerNodes = nodes[id];
      if (!layerNodes) continue;
      automate(layerNodes.gain.gain, muted || paused ? 0 : layer.gain);
      if (id !== "wind")
        automate(
          (layerNodes.source as OscillatorLike).frequency,
          layer.frequency,
        );
      automate(layerNodes.filter.frequency, layer.frequency);
    }
    if (master) automate(master.gain, muted ? 0 : 1);
  };

  const disconnectAll = (): void => {
    for (const source of startedSources) source.stop();
    startedSources = [];
    const disconnect = (node: AudioNodeLike | undefined): void => {
      if (node) node.disconnect();
    };
    for (const id of layerIds) {
      const layerNodes = nodes[id];
      if (!layerNodes) continue;
      disconnect(layerNodes.source);
      disconnect(layerNodes.filter);
      disconnect(layerNodes.gain);
    }
    disconnect(master);
    nodes = {};
    master = undefined;
  };

  const closeContext = (): void => {
    if (!context) return;
    const ownedContext = context;
    context = undefined;
    void ownedContext.close().catch(() => undefined);
  };

  const makeNoiseBuffer = (audioContext: AudioContextLike): AudioBufferLike => {
    const buffer = audioContext.createBuffer(1, 2048, 44100);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1)
      data[index] = (index % 31) / 15.5 - 1;
    return buffer;
  };

  const createLayer = (
    id: RideAudioLayerId,
    audioContext: AudioContextLike,
    masterNode: GainLike,
  ): LayerNodes => {
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();
    filter.type = id === "wind" ? "bandpass" : "lowpass";
    const source: AudioBufferSourceLike | OscillatorLike =
      id === "wind"
        ? audioContext.createBufferSource()
        : audioContext.createOscillator();
    if (id === "wind") {
      const noise = source as AudioBufferSourceLike;
      noise.buffer = makeNoiseBuffer(audioContext);
      noise.loop = true;
      noise.connect(filter);
    } else {
      const oscillator = source as OscillatorLike;
      oscillator.type =
        id === "rail" ? "triangle" : id === "lsm" ? "sawtooth" : "sine";
      oscillator.connect(filter);
    }
    filter.connect(gain);
    gain.connect(masterNode);
    source.start();
    startedSources.push(source);
    return { source, filter, gain };
  };

  const createGraph = (audioContext: AudioContextLike): void => {
    const masterNode = audioContext.createGain();
    masterNode.connect(audioContext.destination);
    master = masterNode;
    for (const id of layerIds)
      nodes[id] = createLayer(id, audioContext, masterNode);
    applyNodeValues();
  };

  const applyUpdate = (update: RideAudioUpdate): void => {
    const magnitude = Math.abs(update.speedMps);
    const boundedSpeed = clamp(magnitude, 0, 120);
    paused = update.paused ?? false;
    layers.wind = {
      active: boundedSpeed > 0,
      gain: clamp((boundedSpeed / 40) * 0.35, 0, 0.35),
      frequency: clamp(80 + boundedSpeed * 5, 80, 500),
    };
    layers.rail = {
      active: true,
      gain: clamp(0.03 + (boundedSpeed / 60) * 0.18, 0, 0.24),
      frequency: clamp(45 + boundedSpeed * 7, 45, 360),
    };
    const lsmActive = (update.zoneMask & lsmZoneMask) !== 0;
    layers.lsm = {
      active: lsmActive,
      gain: lsmActive ? clamp(0.08 + (boundedSpeed / 35) * 0.24, 0, 0.32) : 0,
      frequency: clamp(110 + boundedSpeed * 3, 110, 470),
    };
    const brakeActive = (update.zoneMask & brakeZoneMask) !== 0;
    layers.brake = {
      active: brakeActive,
      gain: brakeActive ? clamp(0.1 + (boundedSpeed / 30) * 0.26, 0, 0.36) : 0,
      frequency: clamp(90 + boundedSpeed * 2, 90, 330),
    };
    applyNodeValues();
  };

  const unlock = (): Promise<boolean> => {
    if (
      disposed ||
      status === "disposed" ||
      status === "unsupported" ||
      status === "failed"
    )
      return Promise.resolve(false);
    if (status === "ready") return Promise.resolve(true);
    if (unlockPromise) return unlockPromise;
    unlockPromise = (async () => {
      try {
        const audioContext = contextFactory();
        context = audioContext;
        createGraph(audioContext);
        await audioContext.resume();
        if (disposed) return false;
        status = "ready";
        if (lastUpdate) applyUpdate(lastUpdate);
        return true;
      } catch (error) {
        disconnectAll();
        closeContext();
        status =
          error instanceof AudioUnavailableError ? "unsupported" : "failed";
        return false;
      } finally {
        unlockPromise = undefined;
      }
    })();
    return unlockPromise;
  };

  return {
    getState,
    unlock,
    setMuted: (nextMuted) => {
      if (disposed) return;
      muted = nextMuted;
      applyNodeValues();
    },
    update: (update) => {
      if (disposed) return false;
      if (
        !Number.isFinite(update.speedMps) ||
        !Number.isInteger(update.zoneMask) ||
        update.zoneMask < 0 ||
        update.zoneMask > 0xffffffff ||
        (update.paused !== undefined && typeof update.paused !== "boolean")
      )
        return false;
      lastUpdate = Object.freeze({
        speedMps: update.speedMps,
        zoneMask: update.zoneMask,
        ...(update.paused === undefined ? {} : { paused: update.paused }),
      });
      if (status !== "ready") return false;
      applyUpdate(lastUpdate);
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      status = "disposed";
      disconnectAll();
      closeContext();
    },
  };
}
