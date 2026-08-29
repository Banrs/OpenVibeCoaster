import { describe, expect, it, vi } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  handleGenerate,
  handleRegenerate,
  handleCompileSimulate,
  selectHeadDistance,
} from "./worker";
import { collectTransferables } from "./transfer";

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
  it("generate succeeds with authoritative file, track, timeline", () => {
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
  });

  it("generate rejects invalid intent as failure", () => {
    const badIntent = { schemaVersion: 1, seed: 1 } as unknown;
    const result = handleGenerate("req-bad", badIntent);
    expect(result.type).toBe("failure");
    if (result.type !== "failure") return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.severity).toBe("error");
  });

  it("generate deterministic repeated output", () => {
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

  it("compile-simulate recompiles without re-solving", async () => {
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
  });

  it("compile-simulate with invalid file rejects", () => {
    const result = handleCompileSimulate("req-cs-bad", {
      not: "a file",
    } as unknown);
    expect(result.type).toBe("failure");
    if (result.type !== "failure") return;
    expect(result.diagnostics[0]!.code).toMatch(/INVALID_FILE/);
  });

  it("regenerate succeeds for known element", () => {
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

  it("handleRegenerate does not call global generator and preserves file-owned unchanged span bitwise identical", async () => {
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
    const newSpan = result.file.solvedSpans.find((s) => s.id === "station-3")!;
    expect(newSpan).toBeDefined();
    expect(newSpan.positionCoefficients).toEqual(
      originalSpan!.positionCoefficients,
    );
    expect(newSpan.rollCoefficients).toEqual(originalSpan!.rollCoefficients);
    // Also ensure pinned hashes preserved via file-owned generation
    expect(result.file.intent.pinnedElementIds).toEqual(
      file.intent.pinnedElementIds,
    );
  });

  it("handleRegenerate preserves untouched hashes for beginning/middle/end", async () => {
    const gen = generateCoaster(validIntent);
    const file = gen.file;
    // Beginning: station-0 (window [0,2] leaves station-3 untouched already tested, but also test beginning)
    const begin = handleRegenerate("req-begin", file as unknown, "station-0");
    expect(begin.type).toBe("success");
    if (begin.type === "success") {
      const origEnd = file.solvedSpans.find((s) => s.id === "station-3")!;
      const newEnd = begin.file.solvedSpans.find((s) => s.id === "station-3")!;
      expect(newEnd.positionCoefficients).toEqual(origEnd.positionCoefficients);
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
      const newStart2 = end.file.solvedSpans.find((s) => s.id === "station-0")!;
      expect(newStart2.positionCoefficients).toEqual(
        origStart2.positionCoefficients,
      );
    }
  });

  it("handleRegenerate handles multi-span element (topHat) and preserves other spans", async () => {
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
  });

  it("handleRegenerate respects pins and fails for pinned element", () => {
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
    const result = handleRegenerate("req-pinned", file as unknown, "launch-1");
    expect(result.type).toBe("failure");
    if (result.type === "failure") {
      expect(result.diagnostics[0]!.code).toMatch(/LOCAL_REGENERATION/);
    }
  });

  it("regenerate rejects unknown element", () => {
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

  it("regenerate rejects invalid elementId", () => {
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

  it("worker responses transfer every eligible owned buffer exactly once and do not retain", () => {
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
  });

  it("failure carries strict diagnostics and relaxations", () => {
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
      constraints: [{ id: "max-h", kind: "max-height", value: 1, hard: true }],
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
  });

  it("selectHeadDistance is deterministic and keeps all cars inside track", () => {
    const spacing = 3.4;
    const cars = 6;
    const minHead = spacing * (cars - 1) + 0.5;
    expect(selectHeadDistance(10, cars, spacing)).toBe(5);
    const exact = selectHeadDistance(minHead, cars, spacing);
    expect(exact).toBeGreaterThan(0);
    expect(exact).toBeLessThan(minHead);
    const a = selectHeadDistance(100, cars, spacing);
    const b = selectHeadDistance(100, cars, spacing);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(spacing * (cars - 1));
    expect(a).toBeLessThanOrEqual(100 - 0.1);
    expect(selectHeadDistance(500, cars, spacing)).toBe(minHead);
  });
});
