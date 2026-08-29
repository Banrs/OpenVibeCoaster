import { describe, expect, it, beforeEach } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { EngineeringWorkerClient, type WorkerLike } from "./client";
import type { EngineeringWorkerSuccess } from "./protocol";

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

function makeSuccess(requestId: string): EngineeringWorkerSuccess {
  return {
    type: "success",
    requestId,
    file: {
      schemaVersion: 1,
      name: "test",
      intent: validIntent,
      solvedSpans: [],
      seed: 7,
      generatorVersion: "test-v1",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: "00000000",
      design: { elements: [], gates: [] },
    } as unknown as EngineeringWorkerSuccess["file"],
    track: {
      positions: new Float64Array([0, 0, 0]),
      tangents: new Float64Array([1, 0, 0]),
      normals: new Float64Array([0, 1, 0]),
      binormals: new Float64Array([0, 0, 1]),
      distances: new Float64Array([0, 1]),
      curvature: new Float64Array([0, 0]),
      curvatureVector: new Float64Array([0, 0, 0, 0, 0, 0]),
      bank: new Float64Array([0, 0]),
      bankDerivative: new Float64Array([0, 0]),
      zoneMasks: new Uint32Array([0, 0]),
      zoneNames: [],
      elementIndices: new Uint32Array([0, 0]),
      elementBoundaries: new Uint32Array([0, 1]),
      parameters: new Float64Array([0, 1]),
      totalLength: 1,
      checksum: "00000000",
    },
    timeline: {
      sampleRateHz: 60,
      carCount: 1,
      length: 1,
      buffers: [
        new Float64Array([0]).buffer,
        new Float64Array([0]).buffer,
        new Float64Array([0]).buffer,
      ],
    } as unknown as EngineeringWorkerSuccess["timeline"],
    diagnostics: [],
    relaxations: [],
  };
}

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

  it("sends generate and resolves on success", async () => {
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
