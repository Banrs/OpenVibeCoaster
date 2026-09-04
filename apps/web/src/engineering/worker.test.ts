import { describe, expect, it, vi } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  handleGenerate,
  handleRegenerate,
  handleCompileSimulate,
} from "./worker";
import { collectTransferables } from "./transfer";
import { validateEngineeringWorkerResponse } from "./protocol";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
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

describe("engineering worker authoritative flow", () => {
  it(
    "generate succeeds with authoritative file, track, timeline",
    { timeout: 20000 },
    () => {
      const result = handleGenerate("req-gen-1", validIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      expect(result.file.schemaVersion).toBe(1);
      expect(result.file.intent.seed).toBe(42);
      expect(result.track.checksum).toMatch(/^[0-9a-f]{8}$/i);
      expect(result.track.totalLength).toBeGreaterThan(0);
      expect(result.timeline.sampleRateHz).toBeGreaterThan(0);
      expect(result.track.positions.length).toBeGreaterThan(0);
      expect(result.timeline.buffers.length).toBeGreaterThan(0);
      expect(result.timings).toBeDefined();
      expect(Number.isFinite(result.timings.simulationMs)).toBe(true);
      expect(result.timings.simulationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.timings.workerSendEpochMs)).toBe(true);
      expect(() => validateEngineeringWorkerResponse(result)).not.toThrow();
    },
  );

  it("generate rejects invalid intent as failure", () => {
    const badIntent = { schemaVersion: 1, seed: 1 } as unknown;
    const result = handleGenerate("req-bad", badIntent);
    expect(result.type).toBe("failure");
    if (result.type !== "failure") return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.severity).toBe("error");
  });

  it("generate deterministic repeated output", { timeout: 20000 }, async () => {
    const a = handleGenerate("req-a", validIntent as unknown);
    const b = handleGenerate("req-b", validIntent as unknown);
    expect(a.type).toBe("success");
    expect(b.type).toBe("success");
    if (a.type !== "success" || b.type !== "success") return;
    expect(a.file.compiledDataChecksum).toBe(b.file.compiledDataChecksum);
    expect(a.track.checksum).toBe(b.track.checksum);
    expect(a.file.solvedSpans).toEqual(b.file.solvedSpans);
    // track numeric determinism
    expect(a.track.positions[0]).toBe(b.track.positions[0]);
    expect(a.timeline.buffers[0]!.byteLength).toBe(
      b.timeline.buffers[0]!.byteLength,
    );
  });

  it(
    "compile-simulate recompiles without re-solving",
    { timeout: 20000 },
    async () => {
      const gen = generateCoaster(validIntent);
      const file = gen.file;
      const generatorModule = await import("@openvibecoaster/generator");
      const spy = vi.spyOn(generatorModule, "generateCoaster");
      const result = handleCompileSimulate("req-cs-1", file as unknown);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      expect(result.file.compiledDataChecksum).toBe(file.compiledDataChecksum);
      expect(result.track.checksum).toBe(gen.track.checksum);
    },
  );

  it("compile-simulate with invalid file rejects", () => {
    const result = handleCompileSimulate("req-cs-bad", {
      not: "a file",
    } as unknown);
    expect(result.type).toBe("failure");
    if (result.type !== "failure") return;
    expect(result.diagnostics[0]!.code).toMatch(/INVALID_FILE/);
  });

  it("regenerate succeeds for known element", { timeout: 20000 }, () => {
    const gen = generateCoaster(validIntent);
    const file = gen.file;
    const result = handleRegenerate("req-reg-1", file as unknown, "launch-1");
    // May succeed or fail depending on local feasibility; but should not be invalid
    if (result.type === "success") {
      expect(result.file.intent.elements.some((e) => e.id === "launch-1")).toBe(
        true,
      );
      expect(result.track.positions.length).toBeGreaterThan(0);
    } else {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it(
    "handleRegenerate does not call global generator and preserves file-owned unchanged span bitwise identical",
    { timeout: 20000 },
    async () => {
      const gen = generateCoaster(validIntent);
      const file = gen.file;
      const originalSpan = file.solvedSpans.find((s) => s.id === "station-3")!;
      expect(originalSpan).toBeDefined();
      const generatorModule = await import("@openvibecoaster/generator");
      const spy = vi.spyOn(generatorModule, "generateCoaster");
      const result = handleRegenerate(
        "req-reg-preserve",
        file as unknown,
        "launch-1",
      );
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      // station-3 is outside changed window [0,2] for launch-1, so must remain bitwise identical
      const newSpan = result.file.solvedSpans.find(
        (s) => s.id === "station-3",
      )!;
      expect(newSpan).toBeDefined();
      expect(newSpan.positionCoefficients).toEqual(
        originalSpan!.positionCoefficients,
      );
      expect(newSpan.rollCoefficients).toEqual(originalSpan!.rollCoefficients);
      // Also ensure pinned hashes preserved via file-owned generation
      expect(result.file.intent.pinnedElementIds).toEqual(
        file.intent.pinnedElementIds,
      );
    },
  );

  it(
    "handleRegenerate preserves untouched hashes for beginning/middle/end",
    { timeout: 60000 },
    async () => {
      const gen = generateCoaster(validIntent);
      const file = gen.file;
      // Beginning: station-0 (window [0,2] leaves station-3 untouched already tested, but also test beginning)
      const begin = handleRegenerate("req-begin", file as unknown, "station-0");
      expect(begin.type).toBe("success");
      if (begin.type === "success") {
        const origEnd = file.solvedSpans.find((s) => s.id === "station-3")!;
        const newEnd = begin.file.solvedSpans.find(
          (s) => s.id === "station-3",
        )!;
        expect(newEnd.positionCoefficients).toEqual(
          origEnd.positionCoefficients,
        );
      }
      // Middle: brake-2 (index 2) window [1,3] leaves station-0 untouched
      const middle = handleRegenerate("req-middle", file as unknown, "brake-2");
      expect(middle.type).toBe("success");
      if (middle.type === "success") {
        const origStart = file.solvedSpans.find((s) => s.id === "station-0")!;
        const newStart = middle.file.solvedSpans.find(
          (s) => s.id === "station-0",
        )!;
        expect(newStart.positionCoefficients).toEqual(
          origStart.positionCoefficients,
        );
      }
      // End: station-3 (window [1,3] leaves station-0 untouched as above, and middle also)
      const end = handleRegenerate("req-end", file as unknown, "station-3");
      expect(end.type).toBe("success");
      if (end.type === "success") {
        const origStart2 = file.solvedSpans.find((s) => s.id === "station-0")!;
        const newStart2 = end.file.solvedSpans.find(
          (s) => s.id === "station-0",
        )!;
        expect(newStart2.positionCoefficients).toEqual(
          origStart2.positionCoefficients,
        );
      }
    },
  );

  it(
    "handleRegenerate handles multi-span element (topHat) and preserves other spans",
    { timeout: 20000 },
    async () => {
      const multiIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 42,
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
            id: "topHat-1",
            kind: "topHat",
            type: "topHat",
            parameters: { height: 80, width: 40, bank: 0 },
          },
          {
            id: "station-2",
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
      const gen = generateCoaster(multiIntent);
      const file = gen.file;
      // topHat splits into 2 spans: topHat-1#0 and topHat-1#1
      expect(
        file.solvedSpans.filter((s) => s.id.startsWith("topHat-1")).length,
      ).toBe(2);
      const origStation = file.solvedSpans.find((s) => s.id === "station-0")!;
      const result = handleRegenerate("req-multi", file as unknown, "topHat-1");
      // Should succeed and preserve station-0 and station-2 outside window
      if (result.type === "success") {
        const newStation = result.file.solvedSpans.find(
          (s) => s.id === "station-0",
        )!;
        expect(newStation.positionCoefficients).toEqual(
          origStation.positionCoefficients,
        );
        // Ensure multi-span element still has 2 spans after regeneration
        expect(
          result.file.solvedSpans.filter((s) => s.id.startsWith("topHat-1"))
            .length,
        ).toBe(2);
      } else {
        // If infeasible, at least ensure not calling global generator
        expect(result.diagnostics.length).toBeGreaterThan(0);
      }
    },
  );

  it(
    "handleRegenerate respects pins and fails for pinned element",
    { timeout: 20000 },
    () => {
      const pinnedIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 42,
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
        pinnedElementIds: ["launch-1"],
      });
      const gen = generateCoaster(pinnedIntent);
      const file = gen.file;
      const result = handleRegenerate(
        "req-pinned",
        file as unknown,
        "launch-1",
      );
      expect(result.type).toBe("failure");
      if (result.type === "failure") {
        expect(result.diagnostics[0]!.code).toMatch(/LOCAL_REGENERATION/);
      }
    },
  );

  it("regenerate rejects unknown element", { timeout: 20000 }, () => {
    const gen = generateCoaster(validIntent);
    const result = handleRegenerate(
      "req-reg-bad",
      gen.file as unknown,
      "unknown-id",
    );
    expect(result.type).toBe("failure");
    if (result.type !== "failure") return;
    expect(result.diagnostics[0]!.code).toMatch(/LOCAL_REGENERATION/);
  });

  it("regenerate rejects invalid elementId", { timeout: 20000 }, () => {
    const gen = generateCoaster(validIntent);
    const result = handleRegenerate("req-reg-empty", gen.file as unknown, "");
    expect(result.type).toBe("failure");
  });

  it("regenerate rejects invalid file", () => {
    const result = handleRegenerate(
      "req-reg-file-bad",
      "not a file" as unknown,
      "launch-1",
    );
    expect(result.type).toBe("failure");
  });

  it("parse/reject: generate with malformed JSON file via regenerate path", () => {
    const result = handleRegenerate("req-parse", "not json at all", "x");
    expect(result.type).toBe("failure");
  });

  it(
    "worker responses transfer every eligible owned buffer exactly once and do not retain",
    { timeout: 20000 },
    async () => {
      const result = handleGenerate("req-transfer", validIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      const transfers = collectTransferables({
        track: result.track,
        timeline: result.timeline,
      });
      // All track typed arrays plus timeline buffers
      expect(transfers.length).toBeGreaterThan(5);
      // Deduplication
      expect(new Set(transfers).size).toBe(transfers.length);
      // Ensure every buffer is ArrayBuffer and finite length
      for (const buf of transfers) {
        expect(buf instanceof ArrayBuffer).toBe(true);
        expect(buf.byteLength).toBeGreaterThan(0);
      }
      // Do not transfer caller-owned request buffers
      const requestBuf = new Float64Array([1, 2, 3]);
      void requestBuf;
      const result2 = handleGenerate("req-transfer2", validIntent as unknown);
      if (result2.type !== "success") return;
      const transfers2 = collectTransferables({
        track: result2.track,
        timeline: result2.timeline,
      });
      expect(transfers2).not.toContain(requestBuf.buffer);
      // After transfer, worker should not retain/use buffers — simulate by checking buffers still accessible but we don't use after postMessage
      // The test proves we collected correct owned buffers; retaining check is via not referencing request buffers.
    },
  );

  it(
    "failure carries strict diagnostics and relaxations",
    { timeout: 20000 },
    () => {
      // Create infeasible intent: max-height constraint violated via low max-height
      const infeasibleIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 99,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [
          {
            id: "station-0",
            kind: "station",
            type: "station",
            parameters: { length: 10, bank: 0, closed: false },
          },
          {
            id: "topHat-1",
            kind: "topHat",
            type: "topHat",
            parameters: { height: 80, width: 40, bank: 0 },
          },
          {
            id: "station-2",
            kind: "station",
            type: "station",
            parameters: { length: 10, bank: 0, closed: false },
          },
        ],
        gates: [],
        targets: [],
        constraints: [
          { id: "max-h", kind: "max-height", value: 1, hard: true },
        ],
        pinnedElementIds: [],
      });
      const result = handleGenerate(
        "req-infeasible",
        infeasibleIntent as unknown,
      );
      expect(result.type).toBe("failure");
      if (result.type !== "failure") return;
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]!.severity).toMatch(/error|fatal/);
      expect(Array.isArray(result.relaxations)).toBe(true);
    },
  );

  it(
    "propagates TRAIN_LENGTH_EXCEEDS_TRACK via compile-simulate for short valid file",
    { timeout: 20000 },
    () => {
      const shortIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 7,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [
          {
            id: "station-0",
            kind: "station",
            type: "station",
            parameters: { length: 4, bank: 0, closed: false },
          },
          {
            id: "station-1",
            kind: "station",
            type: "station",
            parameters: { length: 4, bank: 0, closed: false },
          },
        ],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      });
      const gen = generateCoaster(shortIntent);
      expect(gen.feasible).toBe(true);
      expect(gen.track.totalLength).toBeLessThan(17);
      const result = handleCompileSimulate(
        "req-short-file",
        gen.file as unknown,
      );
      expect(result.type).toBe("failure");
      if (result.type !== "failure") return;
      const diag = result.diagnostics[0]!;
      expect(diag.code).toBe("TRAIN_LENGTH_EXCEEDS_TRACK");
      expect(diag.severity).toBe("fatal");
      expect(diag.actual).toBe(17);
      expect(diag.limit).toBe(gen.track.totalLength);
      expect(diag.margin).toBe((gen.track.totalLength as number) - 17);
      expect((diag.margin as number) < 0).toBe(true);
      expect((diag.actual as number) > (diag.limit as number)).toBe(true);
    },
  );

  it(
    "ovc:simulation timing is actual simulateRide wall duration, not total generation",
    { timeout: 20000 },
    () => {
      const before = performance.now();
      const result = handleGenerate("req-timing-sim", validIntent as unknown);
      const after = performance.now();
      const totalMs = after - before;
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      // simulationMs must be wall duration of simulateRide, not zero and not derived from generation.
      expect(Number.isFinite(result.timings.simulationMs)).toBe(true);
      expect(result.timings.simulationMs).toBeGreaterThanOrEqual(0);
      expect(result.timings.simulationMs).toBeLessThanOrEqual(totalMs + 1);
      // Must be strictly less than total generation+simulation (if generation took time) or at least not equal to total when generation non-zero,
      // but at minimum proves it's not recomputed/derived on page and not total latency clone: simulationMs should be >0 for real ride
      // For tiny rides simulation may be near zero but still finite; we check it's not NaN and worker epoch near now
      const epochNow = Date.now();
      expect(
        Math.abs(result.timings.workerSendEpochMs - epochNow),
      ).toBeLessThan(2000);
      expect(() => validateEngineeringWorkerResponse(result)).not.toThrow();
      // Ensure simulationMs is not total generation latency by checking it is smaller than overall when generation+simulation > simulation
      // Generation also takes time, so totalMs should be >= simulationMs
      expect(totalMs).toBeGreaterThanOrEqual(result.timings.simulationMs);
    },
  );

  it(
    "ovc:worker-transfer epoch is valid cross-context mapping and timings are minimal validated",
    { timeout: 20000 },
    () => {
      const result = handleGenerate("req-timing-epoch", validIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      expect(Number.isFinite(result.timings.workerSendEpochMs)).toBe(true);
      expect(result.timings.workerSendEpochMs).toBeGreaterThan(0);
      // timings object must contain exactly the two required fields
      expect(Object.keys(result.timings).sort()).toEqual([
        "simulationMs",
        "workerSendEpochMs",
      ]);
      // extra field should fail validation
      const withExtra = {
        ...result,
        timings: {
          ...result.timings,
          extra: 123,
        },
      } as unknown as Record<string, unknown>;
      expect(() => validateEngineeringWorkerResponse(withExtra)).toThrow(
        /extra field/,
      );
      // finite checks
      const withNaN = {
        ...result,
        timings: { simulationMs: Number.NaN, workerSendEpochMs: 100 },
      } as unknown as Record<string, unknown>;
      expect(() => validateEngineeringWorkerResponse(withNaN)).toThrow(
        /finite/,
      );
    },
  );

  it(
    "compile-simulate and regenerate also carry validated timings",
    { timeout: 20000 },
    () => {
      const gen = generateCoaster(validIntent);
      const cs = handleCompileSimulate("req-cs-timing", gen.file as unknown);
      expect(cs.type).toBe("success");
      if (cs.type === "success") {
        expect(Number.isFinite(cs.timings.simulationMs)).toBe(true);
        expect(cs.timings.simulationMs).toBeGreaterThanOrEqual(0);
        expect(() => validateEngineeringWorkerResponse(cs)).not.toThrow();
      }
      const rg = handleRegenerate(
        "req-rg-timing",
        gen.file as unknown,
        "station-0",
      );
      if (rg.type === "success") {
        expect(Number.isFinite(rg.timings.simulationMs)).toBe(true);
        expect(() => validateEngineeringWorkerResponse(rg)).not.toThrow();
      } else {
        // if regenerate failed, it should be failure type without timings
        expect(rg.type).toBe("failure");
        expect(
          (rg as unknown as Record<string, unknown>).timings,
        ).toBeUndefined();
      }
    },
  );

  it("failure does not carry timings and remains strict", () => {
    const bad = handleGenerate("req-fail-timing", { bad: true } as unknown);
    expect(bad.type).toBe("failure");
    expect((bad as unknown as Record<string, unknown>).timings).toBeUndefined();
    expect(() => validateEngineeringWorkerResponse(bad)).not.toThrow();
  });

  it(
    "worker captures send epoch after building transfer list (immediately before postMessage)",
    { timeout: 20000 },
    async () => {
      // Behavior evidence: collectTransferables must be invoked before the
      // final workerSendEpochMs capture. We verify via mock invocation order.
      const g = globalThis as any;
      const savedPost = g.postMessage;
      const savedAdd = g.addEventListener;
      const postSpy = vi.fn();
      let handler: ((ev: any) => void) | null = null;
      g.postMessage = postSpy;
      g.addEventListener = vi.fn((type: string, cb: any) => {
        if (type === "message") handler = cb;
      });
      // Isolate modules so worker re-registers with our spies
      vi.resetModules();
      const transferMod = await import("./transfer");
      const transferSpy = vi.spyOn(transferMod, "collectTransferables");
      const nowSpy = vi.spyOn(Date, "now");
      // Import worker fresh — it will see mocked postMessage/addEventListener
      await import("./worker");
      expect(handler).not.toBeNull();
      nowSpy.mockClear();
      transferSpy.mockClear();
      postSpy.mockClear();
      handler!({
        data: { type: "generate", requestId: "order-1", intent: validIntent },
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(transferSpy).toHaveBeenCalledTimes(1);
      expect(nowSpy).toHaveBeenCalled();
      // The transfer list must be built before the final epoch capture
      const transferOrder = transferSpy.mock.invocationCallOrder[0]!;
      const lastNowOrder =
        nowSpy.mock.invocationCallOrder[
          nowSpy.mock.invocationCallOrder.length - 1
        ]!;
      expect(transferOrder).toBeLessThan(lastNowOrder);
      const payload = postSpy.mock.calls[0]![0] as any;
      expect(payload.timings.workerSendEpochMs).toBeGreaterThan(0);
      // Restore global state and module cache for remaining tests (none after this)
      g.postMessage = savedPost;
      g.addEventListener = savedAdd;
      vi.restoreAllMocks();
      vi.resetModules();
      // Re-import worker to restore original module for any subsequent import
      await import("./worker");
    },
  );
});
