import { describe, expect, it, vi } from "vitest";
import {
  AudioUnavailableError,
  createRideAudioEngine,
  type AudioContextLike,
  type AudioParamLike,
} from "./engine.js";

class FakeParam implements AudioParamLike {
  public value = 0;
  public readonly targets: number[] = [];

  public setTargetAtTime(value: number): void {
    this.value = value;
    this.targets.push(value);
  }
}

class FakeNode {
  public readonly connections: FakeNode[] = [];
  public disconnectCount = 0;

  public connect(node: FakeNode): FakeNode {
    this.connections.push(node);
    return node;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeGain extends FakeNode {
  public readonly gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  public readonly frequency = new FakeParam();
  public type: BiquadFilterType = "lowpass";
}

class FakeOscillator extends FakeNode {
  public readonly frequency = new FakeParam();
  public type: OscillatorType = "sine";
  public startCount = 0;
  public stopCount = 0;

  public start(): void {
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
  }
}

class FakeBufferSource extends FakeNode {
  public buffer: unknown = null;
  public loop = false;
  public startCount = 0;
  public stopCount = 0;

  public start(): void {
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
  }
}

class FakeContext implements AudioContextLike {
  public currentTime = 10;
  public state: AudioContextState = "suspended";
  public readonly destination = new FakeNode();
  public readonly gains: FakeGain[] = [];
  public readonly filters: FakeFilter[] = [];
  public readonly oscillators: FakeOscillator[] = [];
  public readonly sources: FakeBufferSource[] = [];
  public resumeCount = 0;
  public closeCount = 0;

  public createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  public createBiquadFilter(): FakeFilter {
    const node = new FakeFilter();
    this.filters.push(node);
    return node;
  }

  public createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  public createBuffer(): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array([0]) };
  }

  public createBufferSource(): FakeBufferSource {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node;
  }

  public async resume(): Promise<void> {
    this.resumeCount += 1;
    this.state = "running";
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    this.state = "closed";
  }
}

describe("RideAudioEngine", () => {
  it("starts locked and does not create or unlock Web Audio until explicit unlock", async () => {
    const context = new FakeContext();
    const factory = vi.fn(() => context);
    const engine = createRideAudioEngine({
      audioContextFactory: factory,
      zoneNames: ["launch", "brake"],
    });

    expect(engine.getState().status).toBe("locked");
    expect(factory).not.toHaveBeenCalled();
    expect(engine.update({ speedMps: 10, zoneMask: 1 })).toBe(false);
    expect(engine.getState().lastUpdate).toEqual({ speedMps: 10, zoneMask: 1 });
    expect(await engine.unlock()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resumeCount).toBe(1);
    expect(engine.getState().status).toBe("ready");
    expect(engine.getState().layers.lsm.active).toBe(true);
  });

  it("coalesces concurrent explicit unlock calls into one owned graph", async () => {
    const context = new FakeContext();
    const factory = vi.fn(() => context);
    const engine = createRideAudioEngine({ audioContextFactory: factory });

    const first = engine.unlock();
    const second = engine.unlock();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resumeCount).toBe(1);
  });

  it("creates four deterministic layers from signed speed magnitude and zone masks", async () => {
    const context = new FakeContext();
    const engine = createRideAudioEngine({
      audioContextFactory: () => context,
      zoneNames: ["launch", "brake"],
    });
    await engine.unlock();

    expect(engine.update({ speedMps: -20, zoneMask: 0b11 })).toBe(true);
    const negative = engine.getState();
    expect(negative.layers.wind.active).toBe(true);
    expect(negative.layers.rail.active).toBe(true);
    expect(negative.layers.lsm.active).toBe(true);
    expect(negative.layers.brake.active).toBe(true);
    expect(negative.layers.wind.gain).toBeGreaterThan(0);

    engine.update({ speedMps: 20, zoneMask: 0b11 });
    const positive = engine.getState();
    expect(positive.layers.wind.gain).toBe(negative.layers.wind.gain);
    expect(positive.layers.rail.frequency).toBe(negative.layers.rail.frequency);
    expect(positive.layers.lsm.frequency).toBe(negative.layers.lsm.frequency);
    expect(positive.layers.brake.frequency).toBe(
      negative.layers.brake.frequency,
    );
    expect(positive.layers.wind.gain).toBeLessThanOrEqual(1);
    expect(positive.layers.brake.gain).toBeLessThanOrEqual(1);

    engine.update({ speedMps: 20, zoneMask: 0 });
    expect(engine.getState().layers.lsm.active).toBe(false);
    expect(engine.getState().layers.brake.active).toBe(false);
  });

  it("handles pause, mute/unmute, bounded automation, repeated unlock, and exact cleanup", async () => {
    const context = new FakeContext();
    const engine = createRideAudioEngine({
      audioContextFactory: () => context,
      zoneNames: ["launch", "brake"],
    });
    await engine.unlock();
    const nodeCounts = {
      gains: context.gains.length,
      filters: context.filters.length,
      oscillators: context.oscillators.length,
      sources: context.sources.length,
    };
    await engine.unlock();
    expect({
      gains: context.gains.length,
      filters: context.filters.length,
      oscillators: context.oscillators.length,
      sources: context.sources.length,
    }).toEqual(nodeCounts);

    engine.update({ speedMps: 1000, zoneMask: 3, paused: true });
    expect(engine.getState().layers.wind.gain).toBe(0);
    engine.setMuted(true);
    expect(engine.getState().muted).toBe(true);
    engine.setMuted(false);
    expect(engine.getState().muted).toBe(false);

    engine.dispose();
    engine.dispose();
    expect(context.closeCount).toBe(1);
    expect(context.sources.every((source) => source.stopCount === 1)).toBe(
      true,
    );
    expect(
      context.oscillators.every((oscillator) => oscillator.stopCount === 1),
    ).toBe(true);
    expect(context.gains.every((gain) => gain.disconnectCount === 1)).toBe(
      true,
    );
    expect(
      context.filters.every((filter) => filter.disconnectCount === 1),
    ).toBe(true);
    expect(
      context.oscillators.every(
        (oscillator) => oscillator.disconnectCount === 1,
      ),
    ).toBe(true);
    expect(engine.update({ speedMps: 1, zoneMask: 0 })).toBe(false);
    expect(await engine.unlock()).toBe(false);
    expect(engine.getState().status).toBe("disposed");
  });

  it("reports unsupported and failed contexts without throwing or pretending to run", async () => {
    const unsupported = createRideAudioEngine({
      audioContextFactory: () => {
        throw new AudioUnavailableError();
      },
    });
    expect(await unsupported.unlock()).toBe(false);
    expect(unsupported.getState().status).toBe("unsupported");
    expect(unsupported.update({ speedMps: 1, zoneMask: 0 })).toBe(false);

    const failed = createRideAudioEngine({
      audioContextFactory: () => {
        throw new TypeError("context construction failed");
      },
    });
    expect(await failed.unlock()).toBe(false);
    expect(failed.getState().status).toBe("failed");
    expect(() =>
      failed.update({ speedMps: Number.NaN, zoneMask: 0 }),
    ).not.toThrow();
  });
});
