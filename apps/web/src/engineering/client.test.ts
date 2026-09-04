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
import {
  EngineeringWorkerClient,
  type WorkerFactory,
  type WorkerLike,
} from "./client";
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
    const withOnMessage = this as unknown as {
      onmessage?: (e: MessageEvent) => void;
    };
    if (withOnMessage.onmessage) {
      withOnMessage.onmessage(ev);
    }
  }
  public emitError(message = "mock worker error"): void {
    const ev = new Event("error") as ErrorEvent & { message: string };
    (ev as { message: string }).message = message;
    const set = this.listeners.get("error");
    if (set) for (const fn of set) (fn as unknown as (e: Event) => void)(ev);
    const withOnError = this as unknown as { onerror?: (e: Event) => void };
    if (withOnError.onerror) {
      withOnError.onerror(ev);
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
  if (hg.type !== "success") throw new Error("authoritative fixture failed");
  cachedSuccessTemplate = hg as EngineeringWorkerSuccess;
  return cachedSuccessTemplate;
}

function makeSuccess(
  requestId: string,
  opts?: { simulationMs?: number; workerSendEpochMs?: number },
): EngineeringWorkerSuccess {
  const template = getSuccessTemplate();
  return {
    ...template,
    requestId,
    timings: {
      simulationMs: opts?.simulationMs ?? template.timings.simulationMs,
      workerSendEpochMs: opts?.workerSendEpochMs ?? Date.now(),
    },
  } as EngineeringWorkerSuccess;
}

function epochMs(): number {
  return Date.now();
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
    // lock time: worker sent 8ms ago by epoch
    const fixedNow = 6000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const workerEpoch = fixedNow - 8;
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

  it("measures worker transfer with the shared wall clock when realm performance origins disagree", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    Object.defineProperty(performance, "timeOrigin", {
      value: 1000,
      configurable: true,
    });
    vi.spyOn(performance, "now").mockReturnValue(50);
    vi.spyOn(Date, "now").mockReturnValue(20050);
    const promise = client.generate("realm-clock", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("realm-clock", {
        simulationMs: 5,
        workerSendEpochMs: 20042,
      }),
    );
    await expect(promise).resolves.toBeDefined();
    const transferCall = measureSpy.mock.calls.find(
      (call) => call[0] === "ovc:worker-transfer",
    );
    expect((transferCall![1] as { duration: number }).duration).toBe(8);
  });

  it("uses the shared epoch rather than a realm-local monotonic clock", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    // Realm-local performance clocks are deliberately unrelated to the shared epoch.
    const clientNow = 50;
    Object.defineProperty(performance, "timeOrigin", {
      value: 900,
      configurable: true,
    });
    vi.spyOn(performance, "now").mockReturnValue(clientNow);
    const clientEpoch = 20050;
    vi.spyOn(Date, "now").mockReturnValue(clientEpoch);
    const workerEpoch = 1100;
    const expectedTransfer = clientEpoch - workerEpoch;
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
    // A realm-local performance timestamp would produce 950, not 18,950.
    expect(dur).not.toBe(0);
    expect(dur).not.toBe(900 + clientNow - workerEpoch);
  });

  it("clamps tiny clock skew to zero", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const clientNow = 1100;
    vi.spyOn(Date, "now").mockReturnValue(clientNow);
    // worker slightly ahead by 2ms (skew)
    const workerEpoch = clientNow + 2;
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
    // boundary: exactly tolerance still clamps to 0 and succeeds
    measureSpy.mockClear();
    const atToleranceEpoch = clientNow + 5;
    const pAt = client.generate("skew-at-tol", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("skew-at-tol", {
        simulationMs: 1,
        workerSendEpochMs: atToleranceEpoch,
      }),
    );
    await expect(pAt).resolves.toBeDefined();
    expect(measureSpy).toHaveBeenCalledTimes(2);
    const atTolTransfer = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect((atTolTransfer![1] as { duration: number }).duration).toBe(0);
  });

  it("rejects materially future worker timestamp beyond tolerance, no measures, pending removed", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const clientNow = 1200;
    vi.spyOn(Date, "now").mockReturnValue(clientNow);
    const futureEpoch = clientNow + 100;
    const p = client.generate("future", validIntent);
    expect(client.getPendingCount()).toBe(1);
    workers[0]!.emitMessage(
      makeSuccess("future", {
        simulationMs: 4,
        workerSendEpochMs: futureEpoch,
      }),
    );
    await expect(p).rejects.toThrow(/future|tolerance|clock-skew|skew/i);
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(0);
    // next valid request must still succeed with exactly one pair
    const pNext = client.generate("future-next", validIntent);
    workers[0]!.emitMessage(makeSuccess("future-next"));
    await expect(pNext).resolves.toBeDefined();
    expect(measureSpy).toHaveBeenCalledTimes(2);
    const sim = measureSpy.mock.calls.find((c) => c[0] === "ovc:simulation");
    const tr = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect(sim).toBeDefined();
    expect(tr).toBeDefined();
  });

  it("performance measure failure remains non-fatal to valid success", async () => {
    const client = new EngineeringWorkerClient(factory);
    vi.spyOn(performance, "measure").mockImplementation(() => {
      throw new Error("measure fail");
    });
    const p = client.generate("measure-fail", validIntent);
    workers[0]!.emitMessage(makeSuccess("measure-fail"));
    await expect(p).resolves.toBeDefined();
    expect(client.getPendingCount()).toBe(0);
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
    const clientEpoch = 6000;
    vi.spyOn(Date, "now").mockReturnValue(clientEpoch);
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

  it("transfer duration is defined by entry receipt epoch, not later clock", async () => {
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const workerEpoch = 10900;
    const success = makeSuccess("receipt-boundary", {
      simulationMs: 7,
      workerSendEpochMs: workerEpoch,
    });
    const nowMock = vi.spyOn(Date, "now");
    let call = 0;
    nowMock.mockImplementation(() => {
      call++;
      if (call === 1) return 11000; // receipt entry
      return 15000; // any later sampling would be much later
    });
    const p = client.generate("receipt-boundary", validIntent);
    workers[0]!.emitMessage(success);
    await p;
    const transferCall = measureSpy.mock.calls.find(
      (c) => c[0] === "ovc:worker-transfer",
    );
    expect(transferCall).toBeDefined();
    expect((transferCall![1] as { duration: number }).duration).toBe(100);
    expect((transferCall![1] as { duration: number }).duration).not.toBe(4100);
    // Exactly one epoch sample should have been taken for this delivery
    expect(call).toBe(1);
    expect(measureSpy).toHaveBeenCalledTimes(2);
  });

  it("chromium User Timing — duration-only without start/end must throw (Chromium emulation) and both ovc measures must be accepted with authoritative durations", async () => {
    const client = new EngineeringWorkerClient(factory);
    const accepted: Array<{
      name: string;
      duration: number;
      options: unknown;
    }> = [];
    const chromiumMeasure = vi
      .spyOn(performance, "measure")
      .mockImplementation(
        (
          ...args: Parameters<typeof performance.measure>
        ): PerformanceMeasure => {
          const [name, startOrOptions] = args;
          const opts = startOrOptions as Record<string, unknown> | undefined;
          // Chromium rule: non-empty options without start or end throws
          if (
            opts &&
            typeof opts === "object" &&
            Object.keys(opts).length > 0 &&
            !("start" in opts) &&
            !("end" in opts)
          ) {
            throw new TypeError(
              "If a non-empty PerformanceMeasureOptions object was passed, at least one of its 'start' or 'end' properties must be present.",
            );
          }
          // Chromium accepts { start: 0, duration: N } and records duration N
          if (opts && typeof opts === "object" && "duration" in opts) {
            accepted.push({
              name,
              duration: (opts as { duration: number }).duration,
              options: opts,
            });
          }
          return {} as PerformanceMeasure;
        },
      );
    // lock current-epoch clock: receipt at fixedOrigin+fixedNow, worker 8ms earlier
    const fixedNow = 6000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const authoritativeSimMs = 22.5;
    const workerEpoch = fixedNow - 8;
    const expectedTransferMs = 8;
    const promise = client.generate("chromium-timing", validIntent);
    workers[0]!.emitMessage(
      makeSuccess("chromium-timing", {
        simulationMs: authoritativeSimMs,
        workerSendEpochMs: workerEpoch,
      }),
    );
    const result = await promise;
    expect(result.timings.simulationMs).toBe(authoritativeSimMs);
    // Record accepted measure entries only after the Chromium rule is satisfied
    expect(chromiumMeasure).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveLength(2);
    const simEntry = accepted.find((e) => e.name === "ovc:simulation");
    const transferEntry = accepted.find(
      (e) => e.name === "ovc:worker-transfer",
    );
    expect(simEntry).toBeDefined();
    expect(transferEntry).toBeDefined();
    // Consumers claim and read only duration; anchor is required only by User Timing API
    expect(simEntry!.duration).toBe(authoritativeSimMs);
    expect(transferEntry!.duration).toBe(expectedTransferMs);
  });
});

describe("EngineeringWorkerClient cancellation races (RED packet)", () => {
  it("factory cancel replays remaining queue", async () => {
    const workers: MockWorker[] = [];
    let client!: EngineeringWorkerClient;
    const factory = (): WorkerLike => {
      const w = new MockWorker();
      workers.push(w);
      if (workers.length === 2) client.cancel("q2");
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    const p3 = client.generate("q3", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    await expect(p2).rejects.toThrow(/cancelled/);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted.map((m: any) => m.requestId)).toEqual(["q3"]);
    workers[1]!.emitMessage(makeSuccess("q3"));
    await expect(p3).resolves.toMatchObject({ requestId: "q3" });
  });
  it("factory generate keeps order and no zombie", async () => {
    const workers: MockWorker[] = [];
    let client!: EngineeringWorkerClient;
    let pNew: Promise<EngineeringWorkerSuccess> | null = null;
    const factory = (): WorkerLike => {
      const w = new MockWorker();
      workers.push(w);
      if (workers.length === 2) pNew = client.generate("qNew", validIntent);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    const p3 = client.generate("q3", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    expect(pNew).not.toBeNull();
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q2"]);
    workers[1]!.emitMessage(makeSuccess("q2"));
    await expect(p2).resolves.toMatchObject({ requestId: "q2" });
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q2", "q3"]);
    workers[1]!.emitMessage(makeSuccess("q3"));
    await expect(p3).resolves.toMatchObject({ requestId: "q3" });
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q2", "q3", "qNew"]);
    workers[1]!.emitMessage(makeSuccess("qNew"));
    await expect(pNew!).resolves.toMatchObject({ requestId: "qNew" });
  });
  it("terminate hook cancel+generate settles coherently", async () => {
    const workers: MockWorker[] = [];
    let client!: EngineeringWorkerClient;
    let pHook: Promise<EngineeringWorkerSuccess> | null = null;
    const factory = (): WorkerLike => {
      const w = new MockWorker();
      const orig = w.terminate.bind(w);
      w.terminate = () => {
        orig();
        if (workers.length === 1) {
          client.cancel("q2");
          pHook = client.generate("qHook", validIntent);
        }
      };
      workers.push(w);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    const p3 = client.generate("q3", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    await expect(p2).rejects.toThrow(/cancelled/);
    expect(pHook).not.toBeNull();
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q3"]);
    workers[1]!.emitMessage(makeSuccess("q3"));
    await expect(p3).resolves.toMatchObject({ requestId: "q3" });
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q3", "qHook"]);
    workers[1]!.emitMessage(makeSuccess("qHook"));
    await expect(pHook!).resolves.toMatchObject({ requestId: "qHook" });
  });
  it("sticky old listeners cannot settle replayed work", async () => {
    const workers: MockWorker[] = [];
    const factory = (): WorkerLike => {
      const w = new MockWorker();
      if (workers.length === 0) w.removeEventListener = () => {};
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    workers[0]!.emitMessage(makeSuccess("q2"));
    expect(client.getPendingCount()).toBe(1);
    let settled = false;
    p2.then(() => (settled = true)).catch(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[1]!.emitMessage(makeSuccess("q2"));
    await expect(p2).resolves.toMatchObject({ requestId: "q2" });
  });
  it("property fallback restores exact prior values including undefined", async () => {
    const pm = () => {};
    const pe = () => {};
    let addCalls = 0;
    const workers: WorkerLike[] = [];
    let client!: EngineeringWorkerClient;
    const factory = (): WorkerLike => {
      const w = new MockWorker() as unknown as WorkerLike & {
        removeEventListener?: unknown;
      };
      const origAdd = w.addEventListener!.bind(w);
      w.addEventListener = (t: string, l: EventListener) => {
        addCalls += 1;
        return origAdd(t, l);
      };
      (w as unknown as { removeEventListener: unknown }).removeEventListener =
        undefined;
      w.onmessage = pm as unknown as (ev: MessageEvent) => void;
      w.onerror = pe as unknown as (ev: Event) => void;
      (w as unknown as { onmessageerror?: unknown }).onmessageerror = undefined;
      workers.push(w);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    expect(addCalls).toBe(0);
    expect((workers[0] as unknown as WorkerLike).onmessage).toBe(
      pm as unknown as (ev: MessageEvent) => void,
    );
    expect((workers[0] as unknown as WorkerLike).onerror).toBe(
      pe as unknown as (ev: Event) => void,
    );
    expect((workers[0] as unknown as WorkerLike).onmessageerror).toBe(
      undefined,
    );
    const w2 = workers[1] as WorkerLike & { posted: unknown[] };
    expect(
      w2.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q2"]);
    client.cancel("q2");
    await expect(p2).rejects.toThrow(/cancelled/);
  });
  it("partial attach rollback terminates candidate and settles survivors", async () => {
    const workers: MockWorker[] = [];
    let n = 0;
    let client!: EngineeringWorkerClient;
    const factory = (): WorkerLike => {
      n += 1;
      if (n === 2) {
        const w = new MockWorker();
        const origAdd = w.addEventListener.bind(w);
        w.addEventListener = (t: string, l: EventListener) => {
          if (t === "error") throw new Error("attach boom");
          return origAdd(t, l);
        };
        workers.push(w);
        return w;
      }
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    const p3 = client.generate("q3", validIntent);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    await expect(p2).rejects.toThrow(/worker-factory|factory/i);
    await expect(p3).rejects.toThrow(/worker-factory|factory/i);
    expect(workers[1]!.terminateCount).toBe(1);
    expect(client.getWorker()).toBeNull();
    workers[1]!.emitMessage(makeSuccess("q2"));
    await Promise.resolve();
    expect(client.getPendingCount()).toBe(0);
  });
  it("first replay error rejects survivors exactly once no zombie", async () => {
    const workers: MockWorker[] = [];
    let client!: EngineeringWorkerClient;
    let shouldError = true;
    const factory = (): WorkerLike => {
      if (workers.length === 0) {
        const w = new MockWorker();
        workers.push(w);
        return w;
      }
      const w = new MockWorker();
      const orig = w.postMessage.bind(w);
      w.postMessage = (msg: unknown) => {
        orig(msg);
        if (shouldError) {
          shouldError = false;
          w.emitError("replay crash");
        }
      };
      workers.push(w);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    const p3 = client.generate("q3", validIntent);
    void p2.catch(() => {});
    void p3.catch(() => {});
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    await expect(p2).rejects.toThrow(/worker-error/i);
    const crashing = workers[1]!;
    expect(
      crashing.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q2"]);
    expect(client.getPendingCount()).toBe(1);
    expect(client.getWorker()).not.toBe(crashing);
    const fresh = workers[2]!;
    expect(fresh).toBeDefined();
    expect(
      fresh.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["q3"]);
    fresh.emitMessage(makeSuccess("q3"));
    await expect(p3).resolves.toMatchObject({ requestId: "q3" });
  });
  it("replay success then throw resolves exactly once", async () => {
    const workers: MockWorker[] = [];
    let client!: EngineeringWorkerClient;
    const factory = (): WorkerLike => {
      if (workers.length === 0) {
        const w = new MockWorker();
        workers.push(w);
        return w;
      }
      const w = new MockWorker();
      w.postMessage = (msg: unknown) => {
        const id = (msg as { requestId: string }).requestId;
        w.posted.push(msg);
        w.emitMessage(makeSuccess(id));
        throw new Error("post boom");
      };
      workers.push(w);
      return w;
    };
    client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("q1", validIntent);
    const p2 = client.generate("q2", validIntent);
    let rc = 0;
    let rj = 0;
    p2.then(() => rc++).catch(() => rj++);
    client.cancel("q1");
    await expect(p1).rejects.toThrow(/cancelled/);
    await p2;
    await Promise.resolve();
    expect(rc).toBe(1);
    expect(rj).toBe(0);
    await expect(p2).resolves.toMatchObject({ requestId: "q2" });
  });
});

describe("EngineeringWorkerClient single-active adversarial proofs", () => {
  it("single-active FIFO posts exactly one at a time and drains in order", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("sa1", validIntent);
    const p2 = client.generate("sa2", validIntent);
    const p3 = client.generate("sa3", validIntent);
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["sa1"]);
    expect(client.getPendingCount()).toBe(3);
    workers[0]!.emitMessage(makeSuccess("sa1"));
    await expect(p1).resolves.toMatchObject({ requestId: "sa1" });
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["sa1", "sa2"]);
    workers[0]!.emitMessage(makeSuccess("sa2"));
    await expect(p2).resolves.toMatchObject({ requestId: "sa2" });
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["sa1", "sa2", "sa3"]);
    workers[0]!.emitMessage(makeSuccess("sa3"));
    await expect(p3).resolves.toMatchObject({ requestId: "sa3" });
    expect(client.getPendingCount()).toBe(0);
  });

  it("queued response is ignored without settlement or timing", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const p1 = client.generate("qa1", validIntent);
    const p2 = client.generate("qa2", validIntent);
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["qa1"]);
    workers[0]!.emitMessage(makeSuccess("qa2"));
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(2);
    let p2Settled = false;
    p2.then(() => (p2Settled = true)).catch(() => (p2Settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Settled).toBe(false);
    workers[0]!.emitMessage(makeSuccess("qa1"));
    await expect(p1).resolves.toMatchObject({ requestId: "qa1" });
    expect(measureSpy).toHaveBeenCalledTimes(2);
    measureSpy.mockClear();
    workers[0]!.emitMessage(makeSuccess("qa2"));
    await expect(p2).resolves.toMatchObject({ requestId: "qa2" });
    expect(measureSpy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("duplicate success response is ignored without double settlement", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const p1 = client.generate("dup1", validIntent);
    workers[0]!.emitMessage(makeSuccess("dup1"));
    await expect(p1).resolves.toMatchObject({ requestId: "dup1" });
    expect(measureSpy).toHaveBeenCalledTimes(2);
    measureSpy.mockClear();
    workers[0]!.emitMessage(makeSuccess("dup1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it("cancel-after-response is ignored and does not terminate", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("car1", validIntent);
    workers[0]!.emitMessage(makeSuccess("car1"));
    await expect(p1).resolves.toMatchObject({ requestId: "car1" });
    const epochBefore = client.getEpoch();
    client.cancel("car1");
    expect(workers[0]!.terminateCount).toBe(0);
    expect(client.getEpoch()).toBe(epochBefore);
    expect(client.getPendingCount()).toBe(0);
  });

  it("error-after-response is ignored without state corruption", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("ear1", validIntent);
    workers[0]!.emitMessage(makeSuccess("ear1"));
    await p1;
    const epochBefore = client.getEpoch();
    workers[0]!.emitError("late error");
    expect(client.getEpoch()).toBe(epochBefore);
    expect(workers).toHaveLength(1);
    expect(client.getPendingCount()).toBe(0);
    const p2 = client.generate("ear2", validIntent);
    workers[0]!.emitMessage(makeSuccess("ear2"));
    await expect(p2).resolves.toMatchObject({ requestId: "ear2" });
  });

  it("worker error rejects only active and preserves queued FIFO", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("we1", validIntent);
    const p2 = client.generate("we2", validIntent);
    const p3 = client.generate("we3", validIntent);
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["we1"]);
    workers[0]!.emitError("crash active");
    await expect(p1).rejects.toThrow(/worker-error/i);
    expect(client.getPendingCount()).toBe(2);
    expect(client.getEpoch()).toBe(1);
    expect(workers).toHaveLength(2);
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["we2"]);
    workers[1]!.emitMessage(makeSuccess("we2"));
    await expect(p2).resolves.toMatchObject({ requestId: "we2" });
    expect(
      workers[1]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["we2", "we3"]);
    workers[1]!.emitMessage(makeSuccess("we3"));
    await expect(p3).resolves.toMatchObject({ requestId: "we3" });
  });

  it("stale epoch response after active cancel is ignored without measure", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const measureSpy = vi
      .spyOn(performance, "measure")
      .mockImplementation(() => ({}) as PerformanceMeasure);
    const p1 = client.generate("se1", validIntent);
    const p2 = client.generate("se2", validIntent);
    client.cancel("se1");
    await expect(p1).rejects.toThrow(/cancelled/);
    expect(client.getEpoch()).toBe(1);
    workers[0]!.emitMessage(makeSuccess("se1"));
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(1);
    workers[0]!.emitMessage(makeSuccess("se2"));
    expect(measureSpy).not.toHaveBeenCalled();
    expect(client.getPendingCount()).toBe(1);
    workers[1]!.emitMessage(makeSuccess("se2"));
    await expect(p2).resolves.toMatchObject({ requestId: "se2" });
    expect(measureSpy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("reentrant replay with synchronous success drains exactly next survivor", async () => {
    const workers: MockWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new MockWorker();
      if (workers.length === 1) {
        const origPost = w.postMessage.bind(w);
        w.postMessage = (msg: unknown) => {
          const rid = (msg as { requestId: string }).requestId;
          origPost(msg);
          if (rid === "rrs2") w.emitMessage(makeSuccess(rid));
        };
      }
      workers.push(w);
      return w;
    };
    const client = new EngineeringWorkerClient(factory);
    const p1 = client.generate("rrs1", validIntent);
    const p2 = client.generate("rrs2", validIntent);
    const p3 = client.generate("rrs3", validIntent);
    expect(
      workers[0]!.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["rrs1"]);
    client.cancel("rrs1");
    await expect(p1).rejects.toThrow(/cancelled/);
    expect(workers).toHaveLength(2);
    const repl = workers[1]!;
    expect(
      repl.posted.map((m) => (m as { requestId: string }).requestId),
    ).toEqual(["rrs2", "rrs3"]);
    await expect(p2).resolves.toMatchObject({ requestId: "rrs2" });
    expect(client.getPendingCount()).toBe(1);
    repl.emitMessage(makeSuccess("rrs3"));
    await expect(p3).resolves.toMatchObject({ requestId: "rrs3" });
    expect(client.getPendingCount()).toBe(0);
    expect(
      repl.posted.filter(
        (m) => (m as { requestId: string }).requestId === "rrs2",
      ),
    ).toHaveLength(1);
    expect(
      repl.posted.filter(
        (m) => (m as { requestId: string }).requestId === "rrs3",
      ),
    ).toHaveLength(1);
  });
});
