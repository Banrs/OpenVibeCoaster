import {
  describe,
  expect,
  it,
  beforeEach,
  vi,
  afterEach,
  beforeAll,
} from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import { EngineeringWorkerClient, type WorkerLike } from "./client";
import type { EngineeringWorkerSuccess } from "./protocol";
import { validateEngineeringWorkerResponse } from "./protocol";
import { handleGenerate } from "./worker";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 7,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 100, targetSpeed: 10, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 100, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

class MockWorker implements WorkerLike {
  public terminateCount = 0;
  public posted: unknown[] = [];
  private listeners = new Map<string, Set<EventListener>>();
  public terminate(): void {
    this.terminateCount += 1;
  }
  public postMessage(message: unknown): void {
    this.posted.push(message);
  }
  public addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  public removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  public emitMessage(data: unknown): void {
    const ev = { data } as MessageEvent;
    const set = this.listeners.get("message");
    if (set)
      for (const fn of set) (fn as unknown as (e: MessageEvent) => void)(ev);
    // also support onmessage
    if (
      (this as unknown as { onmessage?: (e: MessageEvent) => void }).onmessage
    ) {
      (this as unknown as { onmessage: (e: MessageEvent) => void }).onmessage(
        ev,
      );
    }
  }
  public emitError(message = "mock worker error"): void {
    const ev = new Event("error") as ErrorEvent & { message: string };
    (ev as { message: string }).message = message;
    const set = this.listeners.get("error");
    if (set) for (const fn of set) (fn as unknown as (e: Event) => void)(ev);
    if ((this as unknown as { onerror?: (e: Event) => void }).onerror) {
      (this as unknown as { onerror: (e: Event) => void }).onerror(ev);
    }
  }
  public emitMessageError(): void {
    const ev = new Event("messageerror");
    const set = this.listeners.get("messageerror");
    if (set) for (const fn of set) (fn as unknown as (e: Event) => void)(ev);
  }
}

let cachedSuccessTemplate: EngineeringWorkerSuccess | null = null;
function getSuccessTemplate(): EngineeringWorkerSuccess {
  if (cachedSuccessTemplate) return cachedSuccessTemplate;
  const hg = handleGenerate("template-req", validIntent as unknown);
  if (hg.type === "success") {
    cachedSuccessTemplate = hg as EngineeringWorkerSuccess;
    return cachedSuccessTemplate;
  }
  // Fallback to generateCoaster if handleGenerate failed (should not happen)
  const gen = generateCoaster(validIntent);
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const origin =
    typeof performance !== "undefined" &&
    typeof performance.timeOrigin === "number" &&
    Number.isFinite(performance.timeOrigin)
      ? performance.timeOrigin
      : Date.now() - now;
  cachedSuccessTemplate = {
    type: "success",
    requestId: "template",
    file: gen.file,
    track: {
      positions: gen.track.positions,
      tangents: gen.track.tangents,
      normals: gen.track.normals,
      binormals: gen.track.binormals,
      distances: gen.track.distances,
      curvature: gen.track.curvature,
      curvatureVector: gen.track.curvatureVector,
      bank: gen.track.bank,
      bankDerivative: gen.track.bankDerivative,
      zoneMasks: gen.track.zoneMasks,
      zoneNames: [...gen.track.zoneNames],
      elementIndices: gen.track.elementIndices,
      elementBoundaries: gen.track.elementBoundaries,
      parameters: gen.track.parameters,
      totalLength: gen.track.totalLength,
      checksum: gen.track.checksum,
    },
    timeline: {
      sampleRateHz: 120,
      length: 10,
      carCount: 1,
      buffers: [new ArrayBuffer(8)],
    } as unknown as EngineeringWorkerSuccess["timeline"],
    diagnostics: [],
    relaxations: [],
    spanHashes: gen.spanHashes ?? { test: "00000000" },
    timings: {
      simulationMs: 12.5,
      workerSendEpochMs: origin + now,
    },
  } as unknown as EngineeringWorkerSuccess;
  return cachedSuccessTemplate;
}

function makeSuccess(
  requestId: string,
  opts?: { simulationMs?: number; workerSendEpochMs?: number },
): EngineeringWorkerSuccess {
  const template = getSuccessTemplate();
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const origin =
    typeof performance !== "undefined" &&
    typeof performance.timeOrigin === "number" &&
    Number.isFinite(performance.timeOrigin)
      ? performance.timeOrigin
      : Date.now() - now;
  const defaultEpoch = origin + now;
  return {
    ...template,
    requestId,
    timings: {
      simulationMs: opts?.simulationMs ?? template.timings.simulationMs,
      workerSendEpochMs: opts?.workerSendEpochMs ?? defaultEpoch,
    },
  } as EngineeringWorkerSuccess;
}

function epochMs(): number {
  const now = performance.now();
  const origin = performance.timeOrigin;
  return origin + now;
}

beforeAll(() => {
  getSuccessTemplate();
}, 20000);

describe("EngineeringWorkerClient lifecycle", () => {
  let workers: MockWorker[];
  let factory: () => WorkerLike;

  beforeEach(() => {
    workers = [];
    factory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
  });

  it("proves lifecycle ownership via injected factory", () => {
    const client = new EngineeringWorkerClient(factory);
    expect(workers).toHaveLength(1);
    expect(client.getWorker()).toBe(workers[0]!);
    expect(client.getEpoch()).toBe(0);
  });

  it("sends generate and resolves on success", { timeout: 20000 }, async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-1", validIntent);
    expect(workers[0]!.posted[0]).toMatchObject({
      type: "generate",
      requestId: "req-1",
    });
    workers[0]!.emitMessage(makeSuccess("req-1"));
    const result = await promise;
    expect(result.requestId).toBe("req-1");
    expect(result.type).toBe("success");
  });

  it("rejects on failure diagnostics", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-fail", validIntent);
    workers[0]!.emitMessage({
      type: "failure",
      requestId: "req-fail",
      diagnostics: [{ code: "FAIL", severity: "error", message: "boom" }],
      relaxations: [],
    });
    await expect(promise).rejects.toThrow(/boom/);
  });

  it("active cancellation terminates worker, rejects exactly that request, advances epoch, fresh worker", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-active", validIntent);
    expect(client.getPendingCount()).toBe(1);
    expect(client.getEpoch()).toBe(0);
    client.cancel("req-active");
    expect(workers[0]!.terminateCount).toBe(1);
    expect(client.getEpoch()).toBe(1);
    expect(workers).toHaveLength(2); // fresh worker
    expect(client.getWorker()).toBe(workers[1]!);
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(client.getPendingCount()).toBe(0);
    // Cancel rejects exactly that request — no other pending to reject
  });

  it("cancel-after-response is ignored (does not terminate)", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-done", validIntent);
    workers[0]!.emitMessage(makeSuccess("req-done"));
    await promise;
    const epochBefore = client.getEpoch();
    client.cancel("req-done");
    expect(workers[0]!.terminateCount).toBe(0);
    expect(client.getEpoch()).toBe(epochBefore);
  });

  it("rejects stale response IDs", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-real", validIntent);
    // Emit stale id
    workers[0]!.emitMessage(makeSuccess("req-stale"));
    // Real still pending
    expect(client.getPendingCount()).toBe(1);
    workers[0]!.emitMessage(makeSuccess("req-real"));
    const result = await promise;
    expect(result.requestId).toBe("req-real");
  });

  it("rejects old worker epoch responses after active cancel", async () => {
    const client = new EngineeringWorkerClient(factory);
    const first = client.generate("req-first", validIntent);
    client.cancel("req-first");
    await expect(first).rejects.toThrow(/cancelled/);
    const epochAfterCancel = client.getEpoch();
    expect(epochAfterCancel).toBe(1);
    // Old worker (workers[0]) emits late response for first — should be ignored
    workers[0]!.emitMessage(makeSuccess("req-first"));
    // Ensure pending still 0 and new generation works on fresh worker
    const second = client.generate("req-second", validIntent);
    expect(workers[1]!.posted[workers[1]!.posted.length - 1]).toMatchObject({
      requestId: "req-second",
    });
    workers[1]!.emitMessage(makeSuccess("req-second"));
    const result = await second;
    expect(result.requestId).toBe("req-second");
    expect(client.getEpoch()).toBe(1);
  });

  it("handles worker failure (error event) and message error", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-err", validIntent);
    workers[0]!.emitError("simulated worker crash");
    await expect(promise).rejects.toThrow(/simulated worker crash/);
    expect(client.getEpoch()).toBe(1);
    expect(workers).toHaveLength(2);
    // Next work should succeed on fresh worker
    const next = client.generate("req-after-error", validIntent);
    workers[1]!.emitMessage(makeSuccess("req-after-error"));
    await expect(next).resolves.toMatchObject({ requestId: "req-after-error" });
  });

  it("messageerror is treated as worker failure", async () => {
    const client = new EngineeringWorkerClient(factory);
    const promise = client.generate("req-msgerr", validIntent);
    workers[0]!.emitMessageError();
    await expect(promise).rejects.toThrow();
    expect(workers).toHaveLength(2);
  });

  it("teardown terminates once and rejects all pending", async () => {
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("r1", validIntent);
    const p2 = client.generate("r2", validIntent);
    expect(client.getPendingCount()).toBe(2);
    client.teardown();
    expect(workers[0]!.terminateCount).toBe(1);
    client.teardown(); // second call should not double-terminate
    expect(workers[0]!.terminateCount).toBe(1);
    await expect(p1).rejects.toThrow(/teardown/);
    await expect(p2).rejects.toThrow(/teardown/);
    expect(client.isTerminated()).toBe(true);
    expect(client.getPendingCount()).toBe(0);
    // New work after teardown should reject immediately
    await expect(client.generate("r3", validIntent)).rejects.toThrow(
      /terminated/,
    );
  });

  it("new work after cancellation succeeds on fresh worker", async () => {
    const client = new EngineeringWorkerClient(factory);
    const first = client.generate("c1", validIntent);
    client.cancel("c1");
    await expect(first).rejects.toThrow(/cancelled/);
    const second = client.generate("c2", validIntent);
    expect(client.getWorker()).toBe(workers[1]!);
    expect(
      workers[1]!.posted.some(
        (m) => (m as { requestId: string }).requestId === "c2",
      ),
    ).toBe(true);
    workers[1]!.emitMessage(makeSuccess("c2"));
    const res = await second;
    expect(res.requestId).toBe("c2");
  });

  it("supports compile-simulate and regenerate via client", async () => {
    const { generateCoaster } = await import("@openvibecoaster/generator");
    const file = generateCoaster(validIntent).file;
    const client = new EngineeringWorkerClient(factory);
    const cs = client.compileSimulate("cs-1", file);
    expect(workers[0]!.posted[0]).toMatchObject({
      type: "compile-simulate",
      requestId: "cs-1",
    });
    workers[0]!.emitMessage(makeSuccess("cs-1"));
    await expect(cs).resolves.toMatchObject({ requestId: "cs-1" });

    const rg = client.regenerate("rg-1", file, "station-0");
    expect(workers[0]!.posted[1]).toMatchObject({
      type: "regenerate",
      requestId: "rg-1",
      elementId: "station-0",
    });
    workers[0]!.emitMessage(makeSuccess("rg-1"));
    await expect(rg).resolves.toMatchObject({ requestId: "rg-1" });
  });

  it("validates exact request on client (duplicate/empty id)", async () => {
    const client = new EngineeringWorkerClient(factory);
    await expect(client.generate("", validIntent)).rejects.toThrow();
    const p1 = client.generate("dup", validIntent);
    await expect(client.generate("dup", validIntent)).rejects.toThrow(
      /Duplicate/,
    );
    workers[0]!.emitMessage(makeSuccess("dup"));
    await p1;
  });

  it("cancel of queued (non-active) rejects exactly that request without terminating active", async () => {
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    // q1 is active, q2 is queued
    client.cancel("q2");
    await expect(p2).rejects.toThrow(/cancelled/);
    expect(workers[0]!.terminateCount).toBe(0); // not active, so no terminate
    expect(client.getPendingCount()).toBe(1); // q1 still pending
    workers[0]!.emitMessage(makeSuccess("q1"));
    await expect(p1).resolves.toMatchObject({ requestId: "q1" });
  });

  it("factory throw during recreate after active cancel never retains terminated worker and allows retry", async () => {
    const localWorkers: MockWorker[] = [];
    let calls = 0;
    const throwingFactory = (): WorkerLike => {
      calls += 1;
      if (calls === 2) throw new Error("factory boom");
      const w = new MockWorker();
      localWorkers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(throwingFactory);
    expect(localWorkers).toHaveLength(1);
    const firstWorker = localWorkers[0]!;
    const p1 = client.generate("f1", validIntent);
    // Active cancel will terminate w1, advance epoch to 1, then factory throws on recreate
    client.cancel("f1");
    await expect(p1).rejects.toThrow(/cancelled/);
    expect(firstWorker.terminateCount).toBe(1);
    expect(client.getWorker()).toBeNull();
    expect(client.getEpoch()).toBe(1);
    // Never retain terminated worker
    expect(client.getWorker()).not.toBe(firstWorker);
    // Next operation should attempt fresh creation (calls ===3) and succeed with new epoch
    const p2 = client.generate("f2", validIntent);
    // This should have triggered a retry creation; localWorkers should now have 2 (initial + retry)
    expect(localWorkers).toHaveLength(2);
    expect(client.getWorker()).toBe(localWorkers[1]!);
    expect(client.getEpoch()).toBe(1);
    localWorkers[1]!.emitMessage(makeSuccess("f2"));
    await expect(p2).resolves.toMatchObject({ requestId: "f2" });
  });

  it("factory throw during recreate after error never retains terminated worker and rejects exactly once", async () => {
    const localWorkers: MockWorker[] = [];
    let calls = 0;
    const throwingFactory = (): WorkerLike => {
      calls += 1;
      if (calls === 2) throw new Error("factory boom 2");
      const w = new MockWorker();
      localWorkers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(throwingFactory);
    const p1 = client.generate("e1", validIntent);
    // Trigger worker error – handleError will terminate, epoch++ and try recreate (throws)
    localWorkers[0]!.emitError("boom");
    await expect(p1).rejects.toThrow(/boom/);
    expect(client.getWorker()).toBeNull();
    expect(client.getEpoch()).toBe(1);
    // No uncaught from event handler (would have failed test)
    // Next operation retries
    const p2 = client.generate("e2", validIntent);
    expect(localWorkers).toHaveLength(2);
    localWorkers[1]!.emitMessage(makeSuccess("e2"));
    await expect(p2).resolves.toMatchObject({ requestId: "e2" });
  });

  it("cancel is synchronous void and never throws", () => {
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("sync1", validIntent);
    const ret = client.cancel("sync1");
    expect(ret).toBeUndefined();
    // Must be synchronous – pending rejected immediately, epoch advanced before next tick
    expect(client.getEpoch()).toBe(1);
    expect(client.getWorker()).not.toBe(workers[0]!);
    // Even with invalid id, cancel is void sync
    expect(client.cancel("nope")).toBeUndefined();
    expect(client.cancel("")).toBeUndefined();
    return expect(p1).rejects.toThrow(/cancelled/);
  });
});

describe("EngineeringWorkerClient User Timing", () => {
  let workers: MockWorker[];
  let factory: () => WorkerLike;

  beforeEach(() => {
    workers = [];
    factory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records ovc:simulation and ovc:worker-transfer on validated current-epoch success", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const nowSpy = vi.spyOn(performance, "now");
    // lock time: worker sent 8ms ago by epoch
    const fixedNow = 1000;
    const fixedOrigin = 5000;
    Object.defineProperty(performance, "timeOrigin", {
      value: fixedOrigin,
      configurable: true,
    });
    nowSpy.mockReturnValue(fixedNow);
    const workerEpoch = fixedOrigin + fixedNow - 8; // 8ms transfer
    const simMs = 22.5;
    const promise = client.generate("timing-1", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("timing-1", {
        simulationMs: simMs,
        workerSendEpochMs: workerEpoch,
      }),
    );
    const result = await promise;
    expect(result.timings.simulationMs).toBe(simMs);
    // exactly one measure per successful response per stage -> two calls
    expect(measureSpy).toHaveBeenCalledTimes(2);
    const simCall = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:simulation",
    );
    const transferCall = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect(simCall).toBeDefined();
    expect(transferCall).toBeDefined();
    expect((simCall![1] as { duration: number }).duration).toBe(simMs);
    // transfer uses epoch-normalized mapping, not derived by subtracting other stages
    const transferDuration = (transferCall![1] as { duration: number })
      .duration;
    expect(transferDuration).toBeGreaterThanOrEqual(7);
    expect(transferDuration).toBeLessThan(15);
    // ensure real durations - simulation is worker-authoritative, not zero
    expect(simCall![1]).not.toEqual({ duration: 0 });
  });

  it("uses cross-context epoch normalization, not naive now delta", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    // Simulate different origins to prove mapping: worker origin far from client
    const clientNow = 50;
    const clientOrigin = 20000;
    Object.defineProperty(performance, "timeOrigin", {
      value: clientOrigin,
      configurable: true,
    });
    vi.spyOn(performance, "now").mockReturnValue(clientNow);
    const workerOrigin = 1000;
    const workerNow = 100;
    const workerEpoch = workerOrigin + workerNow; // 1100
    const clientEpoch = clientOrigin + clientNow; // 20050
    const expectedTransfer = clientEpoch - workerEpoch; // 18950
    const promise = client.generate("epoch-norm", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("epoch-norm", {
        simulationMs: 5,
        workerSendEpochMs: workerEpoch,
      }),
    );
    await promise;
    const transferCall = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect(transferCall).toBeDefined();
    const dur = (transferCall![1] as { duration: number }).duration;
    expect(dur).toBe(expectedTransfer);
    // naive delta would be clientNow - workerNow = -50 -> clamped 0, not 18950, so we prove epoch mapping
    expect(dur).not.toBe(0);
    expect(dur).not.toBe(Math.max(0, clientNow - workerNow));
  });

  it("clamps tiny clock skew to zero", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const clientNow = 100;
    const clientOrigin = 1000;
    Object.defineProperty(performance, "timeOrigin", {
      value: clientOrigin,
      configurable: true,
    });
    vi.spyOn(performance, "now").mockReturnValue(clientNow);
    // worker slightly ahead by 2ms (skew)
    const workerEpoch = clientOrigin + clientNow + 2;
    const promise = client.generate("skew", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("skew", {
        simulationMs: 3,
        workerSendEpochMs: workerEpoch,
      }),
    );
    await promise;
    const transferCall = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect((transferCall![1] as { duration: number }).duration).toBe(0);
  });

  it("does not emit measures for stale or cancelled responses", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    // stale: send two, first stale second real
    const pReal = client.generate("real", validIntent);
    workers[0]!.emitMessage(makeSuccess("stale-id"));
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(1);
    workers[0]!.emitMessage(makeSuccess("real"));
    await pReal;
    expect(measureSpy).toHaveBeenCalledTimes(2);
    measureSpy.mockClear();
    // cancelled: new request then cancel
    const pCancel = client.generate("to-cancel", validIntent);
    client.cancel("to-cancel");
    await expect(pCancel).rejects.toThrow(/cancelled/);
    // late arrival for cancelled should not emit
    const workerForCancelled = workers[0]!;
    // after cancel, fresh worker is workers[1]; old worker late message
    workerForCancelled.emitMessage(makeSuccess("to-cancel"));
    expect(measureSpy).not.toHaveBeenCalled();
    // also cancelled epoch: ensure next success still emits once
    const pNext = client.generate("next-ok", validIntent);
    const fresh = workers[1] ?? workers[0]!;
    fresh.emitMessage(makeSuccess("next-ok"));
    await pNext;
    expect(measureSpy).toHaveBeenCalledTimes(2);
  });

  it("finite validation rejects malformed timings and does not emit measures", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const base = makeSuccess("bad-finite");
    const badNaN = {
      ...base,
      timings: { simulationMs: Number.NaN, workerSendEpochMs: epochMs() },
    };
    const p1 = client.generate("bad-finite", validIntent);
    workers[0]!.emitMessage(badNaN);
    await expect(p1).rejects.toThrow(/finite/);
    expect(measureSpy).not.toHaveBeenCalled();
    measureSpy.mockClear();
    const badInf = {
      ...makeSuccess("bad-inf"),
      timings: {
        simulationMs: Number.POSITIVE_INFINITY,
        workerSendEpochMs: epochMs(),
      },
    };
    const p2 = client.generate("bad-inf", validIntent);
    workers[0]!.emitMessage(badInf);
    await expect(p2).rejects.toThrow(/finite/);
    expect(measureSpy).not.toHaveBeenCalled();
    const badExtra = {
      ...makeSuccess("bad-extra"),
      timings: {
        simulationMs: 1,
        workerSendEpochMs: epochMs(),
        extraField: 123,
      },
    } as unknown as EngineeringWorkerSuccess;
    const p3 = client.generate("bad-extra", validIntent);
    workers[0]!.emitMessage(badExtra);
    await expect(p3).rejects.toThrow(/extra field/);
    expect(measureSpy).not.toHaveBeenCalled();
    const badNegative = {
      ...makeSuccess("bad-neg"),
      timings: { simulationMs: -5, workerSendEpochMs: epochMs() },
    };
    const p4 = client.generate("bad-neg", validIntent);
    workers[0]!.emitMessage(badNegative);
    await expect(p4).rejects.toThrow(/non-negative/);
    expect(measureSpy).not.toHaveBeenCalled();
  });

  it("no measure on failure or malformed extra field", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const pFail = client.generate("fail-no-measure", validIntent);
    workers[0]!.emitMessage({
      type: "failure",
      requestId: "fail-no-measure",
      diagnostics: [{ code: "X", severity: "error", message: "fail" }],
      relaxations: [],
    });
    await expect(pFail).rejects.toThrow(/fail/);
    expect(measureSpy).not.toHaveBeenCalled();
    const malformed = {
      ...makeSuccess("malformed"),
      extraTop: 1,
    } as unknown as EngineeringWorkerSuccess;
    const pMal = client.generate("malformed", validIntent);
    workers[0]!.emitMessage(malformed);
    await expect(pMal).rejects.toThrow(/extra field/);
    expect(measureSpy).not.toHaveBeenCalled();
  });

  it("monotonic epoch normalization: later send yields smaller transfer", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const clientNow = 1000;
    const clientOrigin = 5000;
    Object.defineProperty(performance, "timeOrigin", {
      value: clientOrigin,
      configurable: true,
    });
    vi.spyOn(performance, "now").mockReturnValue(clientNow);
    const clientEpoch = clientOrigin + clientNow;
    const earlyEpoch = clientEpoch - 100;
    const lateEpoch = clientEpoch - 10;
    const p1 = client.generate("mono-early", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("mono-early", {
        simulationMs: 1,
        workerSendEpochMs: earlyEpoch,
      }),
    );
    await p1;
    const firstTransfer = (
      measureSpy.mock.calls.find((c) => c[0] === "ovc:worker-transfer")![1] as {
        duration: number;
      }
    ).duration;
    measureSpy.mockClear();
    const p2 = client.generate("mono-late", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("mono-late", {
        simulationMs: 1,
        workerSendEpochMs: lateEpoch,
      }),
    );
    await p2;
    const secondTransfer = (
      measureSpy.mock.calls.find((c) => c[0] === "ovc:worker-transfer")![1] as {
        duration: number;
      }
    ).duration;
    expect(secondTransfer).toBeLessThan(firstTransfer);
    expect(firstTransfer).toBe(100);
    expect(secondTransfer).toBe(10);
  });

  it("exactly one measure per stage per successful response", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const p1 = client.generate("exactly-one-1", validIntent);
    workers[0]!.emitMessage(makeSuccess("exactly-one-1", { simulationMs: 7 }));
    await p1;
    expect(
      measureSpy.mock.calls.filter((c) => c[0] === "ovc:simulation").length,
    ).toBe(1);
    expect(
      measureSpy.mock.calls.filter((c) => c[0] === "ovc:worker-transfer")
        .length,
    ).toBe(1);
    measureSpy.mockClear();
    const p2 = client.generate("exactly-one-2", validIntent);
    workers[0]!.emitMessage(makeSuccess("exactly-one-2", { simulationMs: 9 }));
    await p2;
    expect(
      measureSpy.mock.calls.filter((c) => c[0] === "ovc:simulation").length,
    ).toBe(1);
    expect(
      measureSpy.mock.calls.filter((c) => c[0] === "ovc:worker-transfer")
        .length,
    ).toBe(1);
    // total across two successes = 4, not cumulative leak
    expect(measureSpy).toHaveBeenCalledTimes(2);
  });

  it("validates timings through response contract", () => {
    const valid = makeSuccess("validate-ok");
    expect(() => validateEngineeringWorkerResponse(valid)).not.toThrow();
    const missingTimings = { ...valid } as Record<string, unknown>;
    delete (missingTimings as { timings?: unknown }).timings;
    expect(() => validateEngineeringWorkerResponse(missingTimings)).toThrow(
      /timings/,
    );
  });
});
