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

  public constructor(private readonly fail?: () => void) {}

  public setTargetAtTime(value: number): void {
    this.fail?.();
    this.value = value;
    this.targets.push(value);
  }
}

class FakeNode {
  public readonly connections: FakeNode[] = [];
  public disconnectCount = 0;

  public constructor(
    private readonly onConnect?: () => void,
    private readonly onDisconnect?: () => void,
  ) {}

  public connect(node: FakeNode): FakeNode {
    this.onConnect?.();
    this.connections.push(node);
    return node;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
    this.onDisconnect?.();
  }
}

class FakeGain extends FakeNode {
  public readonly gain: FakeParam;

  public constructor(
    onConnect?: () => void,
    onDisconnect?: () => void,
    onAutomation?: () => void,
  ) {
    super(onConnect, onDisconnect);
    this.gain = new FakeParam(onAutomation);
  }
}

class FakeFilter extends FakeNode {
  public readonly frequency: FakeParam;
  public type: BiquadFilterType = "lowpass";

  public constructor(
    onConnect?: () => void,
    onDisconnect?: () => void,
    onAutomation?: () => void,
  ) {
    super(onConnect, onDisconnect);
    this.frequency = new FakeParam(onAutomation);
  }
}

class FakeOscillator extends FakeNode {
  public readonly frequency: FakeParam;
  public type: OscillatorType = "sine";
  public startCount = 0;
  public stopCount = 0;

  public constructor(
    onConnect?: () => void,
    onDisconnect?: () => void,
    onAutomation?: () => void,
    private readonly onStart?: () => void,
    private readonly onStop?: () => void,
  ) {
    super(onConnect, onDisconnect);
    this.frequency = new FakeParam(onAutomation);
  }

  public start(): void {
    this.onStart?.();
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
    this.onStop?.();
  }
}

class FakeBufferSource extends FakeNode {
  public buffer: unknown = null;
  public loop = false;
  public startCount = 0;
  public stopCount = 0;

  public constructor(
    onConnect?: () => void,
    onDisconnect?: () => void,
    private readonly onStart?: () => void,
    private readonly onStop?: () => void,
  ) {
    super(onConnect, onDisconnect);
  }

  public start(): void {
    this.onStart?.();
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
    this.onStop?.();
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
  public readonly createdNodes: FakeNode[] = [];
  public resumeCount = 0;
  public closeCount = 0;
  public failCreate:
    "gain" | "filter" | "oscillator" | "source" | "buffer" | null = null;
  public failConnectAt: number | undefined;
  public failStartAt: number | undefined;
  public failAutomationAt: number | undefined;
  public failAutomation = false;
  public failDisconnectAt: number | undefined;
  public failStopAt: number | undefined;
  public closeReject = false;
  public resumeGate: Promise<void> | undefined;
  public resumeFailure: Error | undefined;
  private connectAttempts = 0;
  private startAttempts = 0;
  private automationAttempts = 0;
  private disconnectAttempts = 0;
  private stopAttempts = 0;

  private onConnect = (): void => {
    this.connectAttempts += 1;
    if (this.connectAttempts === this.failConnectAt)
      throw new Error("connect failed");
  };

  private onDisconnect = (): void => {
    this.disconnectAttempts += 1;
    if (this.disconnectAttempts === this.failDisconnectAt)
      throw new Error("disconnect failed");
  };

  private onAutomation = (): void => {
    this.automationAttempts += 1;
    if (
      this.failAutomation ||
      this.automationAttempts === this.failAutomationAt
    )
      throw new Error("automation failed");
  };

  private onStart = (): void => {
    this.startAttempts += 1;
    if (this.startAttempts === this.failStartAt)
      throw new Error("start failed");
  };

  private onStop = (): void => {
    this.stopAttempts += 1;
    if (this.stopAttempts === this.failStopAt) throw new Error("stop failed");
  };

  private register<T extends FakeNode>(node: T): T {
    this.createdNodes.push(node);
    return node;
  }

  public createGain(): FakeGain {
    if (this.failCreate === "gain") throw new Error("gain allocation failed");
    const node = this.register(
      new FakeGain(this.onConnect, this.onDisconnect, this.onAutomation),
    );
    this.gains.push(node);
    return node;
  }

  public createBiquadFilter(): FakeFilter {
    if (this.failCreate === "filter")
      throw new Error("filter allocation failed");
    const node = this.register(
      new FakeFilter(this.onConnect, this.onDisconnect, this.onAutomation),
    );
    this.filters.push(node);
    return node;
  }

  public createOscillator(): FakeOscillator {
    if (this.failCreate === "oscillator")
      throw new Error("oscillator allocation failed");
    const node = this.register(
      new FakeOscillator(
        this.onConnect,
        this.onDisconnect,
        this.onAutomation,
        this.onStart,
        this.onStop,
      ),
    );
    this.oscillators.push(node);
    return node;
  }

  public createBuffer(): { getChannelData: () => Float32Array } {
    if (this.failCreate === "buffer")
      throw new Error("buffer allocation failed");
    return { getChannelData: () => new Float32Array([0]) };
  }

  public createBufferSource(): FakeBufferSource {
    if (this.failCreate === "source")
      throw new Error("source allocation failed");
    const node = this.register(
      new FakeBufferSource(
        this.onConnect,
        this.onDisconnect,
        this.onStart,
        this.onStop,
      ),
    );
    this.sources.push(node);
    return node;
  }

  public async resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.resumeGate) await this.resumeGate;
    if (this.resumeFailure) throw this.resumeFailure;
    this.state = "running";
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeReject) throw new Error("close failed");
    this.state = "closed";
  }
}

const expectTransactionClean = (context: FakeContext): void => {
  expect(context.closeCount).toBe(1);
  expect(context.createdNodes.every((node) => node.disconnectCount === 1)).toBe(
    true,
  );
  expect(
    [...context.sources, ...context.oscillators].every(
      (source) => source.startCount === 0 || source.stopCount === 1,
    ),
  ).toBe(true);
};

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
    const engine = createRideAudioEngine({
      audioContextFactory: factory,
      lsmZoneMask: 1 << 5,
      brakeZoneMask: 1 << 9,
    });

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

  it("derives operation masks from reordered names and accepts sparse explicit masks", async () => {
    const reorderedContext = new FakeContext();
    const reordered = createRideAudioEngine({
      audioContextFactory: () => reorderedContext,
      zoneNames: ["brake", "station", "boost", "launch"],
    });
    await reordered.unlock();
    expect(reordered.update({ speedMps: 10, zoneMask: 0b0001 })).toBe(true);
    expect(reordered.getState().layers.brake.active).toBe(true);
    expect(reordered.getState().layers.lsm.active).toBe(false);
    expect(reordered.update({ speedMps: 10, zoneMask: 0b1100 })).toBe(true);
    expect(reordered.getState().layers.lsm.active).toBe(true);
    expect(reordered.getState().layers.brake.active).toBe(false);

    const sparseContext = new FakeContext();
    const sparse = createRideAudioEngine({
      audioContextFactory: () => sparseContext,
      lsmZoneMask: 1 << 5,
      brakeZoneMask: 1 << 9,
    });
    await sparse.unlock();
    expect(sparse.update({ speedMps: 10, zoneMask: 1 << 5 })).toBe(true);
    expect(sparse.getState().layers.lsm.active).toBe(true);
    expect(sparse.getState().layers.brake.active).toBe(false);
    expect(sparse.update({ speedMps: 10, zoneMask: 1 << 9 })).toBe(true);
    expect(sparse.getState().layers.brake.active).toBe(true);
  });

  it("requires valid authoritative zone names or explicit masks", () => {
    expect(() => createRideAudioEngine()).toThrow(RangeError);
    expect(() =>
      createRideAudioEngine({ zoneNames: ["launch", "launch"] }),
    ).toThrow(RangeError);
    expect(() =>
      createRideAudioEngine({ lsmZoneMask: -1, brakeZoneMask: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createRideAudioEngine({ lsmZoneMask: 0, brakeZoneMask: 0x1_0000_0000 }),
    ).toThrow(RangeError);
    const context = new FakeContext();
    const engine = createRideAudioEngine({
      audioContextFactory: () => context,
      zoneNames: ["launch", "brake"],
    });
    expect(engine.update({ speedMps: 1, zoneMask: 1 << 2 })).toBe(false);
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
    expect(context.createdNodes).toHaveLength(13);
    expect(new Set(context.createdNodes).size).toBe(13);

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
      lsmZoneMask: 0,
      brakeZoneMask: 0,
      audioContextFactory: () => {
        throw new AudioUnavailableError();
      },
    });
    expect(await unsupported.unlock()).toBe(false);
    expect(unsupported.getState().status).toBe("unsupported");
    expect(unsupported.update({ speedMps: 1, zoneMask: 0 })).toBe(false);

    const failed = createRideAudioEngine({
      lsmZoneMask: 0,
      brakeZoneMask: 0,
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

  it.each(["gain", "filter", "oscillator", "source", "buffer"] as const)(
    "rolls back a %s allocation failure",
    async (failCreate) => {
      const context = new FakeContext();
      context.failCreate = failCreate;
      const engine = createRideAudioEngine({
        audioContextFactory: () => context,
        lsmZoneMask: 0,
        brakeZoneMask: 0,
      });

      expect(await engine.unlock()).toBe(false);
      expect(engine.getState().status).toBe("failed");
      expectTransactionClean(context);
    },
  );

  it.each(["connect", "start", "automation"] as const)(
    "rolls back a %s failure after partial graph construction",
    async (failure) => {
      const context = new FakeContext();
      if (failure === "connect") context.failConnectAt = 2;
      if (failure === "start") context.failStartAt = 1;
      if (failure === "automation") context.failAutomationAt = 1;
      const engine = createRideAudioEngine({
        audioContextFactory: () => context,
        lsmZoneMask: 0,
        brakeZoneMask: 0,
      });

      expect(await engine.unlock()).toBe(false);
      expect(engine.getState().status).toBe("failed");
      expectTransactionClean(context);
    },
  );

  it("turns a runtime automation failure into a cleaned failed engine", async () => {
    const context = new FakeContext();
    const engine = createRideAudioEngine({
      audioContextFactory: () => context,
      lsmZoneMask: 0,
      brakeZoneMask: 0,
    });
    expect(await engine.unlock()).toBe(true);
    context.failAutomation = true;

    expect(engine.update({ speedMps: 10, zoneMask: 0 })).toBe(false);
    expect(engine.getState().status).toBe("failed");
    expectTransactionClean(context);
  });

  it("keeps disposed status through pending and rejected resume and never rebuilds", async () => {
    let resolveResume!: () => void;
    const pendingResume = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });
    const pendingContext = new FakeContext();
    pendingContext.resumeGate = pendingResume;
    const pending = createRideAudioEngine({
      audioContextFactory: () => pendingContext,
      lsmZoneMask: 0,
      brakeZoneMask: 0,
    });
    const pendingUnlock = pending.unlock();
    pending.dispose();
    resolveResume();
    expect(await pendingUnlock).toBe(false);
    expect(pending.getState().status).toBe("disposed");
    expectTransactionClean(pendingContext);
    expect(await pending.unlock()).toBe(false);
    expect(pendingContext.closeCount).toBe(1);

    const rejectedContext = new FakeContext();
    rejectedContext.resumeFailure = new Error("resume rejected");
    const rejected = createRideAudioEngine({
      audioContextFactory: () => rejectedContext,
      lsmZoneMask: 0,
      brakeZoneMask: 0,
    });
    const rejectedUnlock = rejected.unlock();
    rejected.dispose();
    expect(await rejectedUnlock).toBe(false);
    expect(rejected.getState().status).toBe("disposed");
    expectTransactionClean(rejectedContext);
  });

  it("continues defensive cleanup and handles close rejection exactly once", async () => {
    const context = new FakeContext();
    context.failDisconnectAt = 1;
    context.failStopAt = 1;
    context.closeReject = true;
    const engine = createRideAudioEngine({
      audioContextFactory: () => context,
      lsmZoneMask: 0,
      brakeZoneMask: 0,
    });
    await engine.unlock();
    engine.dispose();
    engine.dispose();
    await Promise.resolve();
    expect(context.closeCount).toBe(1);
    expect(
      context.createdNodes.every((node) => node.disconnectCount === 1),
    ).toBe(true);
    expect(
      [...context.sources, ...context.oscillators].every(
        (source) => source.stopCount === 1,
      ),
    ).toBe(true);
  });
});
