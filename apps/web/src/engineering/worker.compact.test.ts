import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker.js";
import { hydrateEngineeringSuccess } from "./hydrate.js";
import { collectTransferables } from "./transfer.js";

const flagshipIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "full-auto",
  family: "steel-sitdown-lsm-v1",
  elements: [],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
  terrainProfileId: "rolling-highlands-v1",
});

describe("worker compact transfer RED", () => {
  it(
    "flagship worker success hydrates compactly with expected properties",
    { timeout: 60000 },
    () => {
      const result = handleGenerate(
        "flagship-compact",
        flagshipIntent as unknown,
      );
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("flagship fail");
      expect(result.timeline.frames).toBeUndefined();
      expect(result.timeline.buffers.length).toBe(28);
      const hydrated = hydrateEngineeringSuccess(result);
      expect(hydrated.timeline.frames.length).toBe(0);
      expect(hydrated.timeline.sampleRateHz).toBe(120);
      expect(hydrated.timeline.length).toBeGreaterThan(15 * 120);
      expect(hydrated.track.checksum).toBe(result.track.checksum);
      expect(hydrated.track.positions.length).toBeGreaterThan(0);
      const head = hydrated.timeline.headDistanceM;
      expect(head[head.length - 1]! - head[0]!).toBeGreaterThan(100);
      expect(hydrated.timeline.launchActivity.length).toBe(
        hydrated.timeline.length,
      );
      expect(hydrated.timeline.brakeActivity.length).toBe(
        hydrated.timeline.length,
      );
      expect(hydrated.timeline.kineticEnergyJ.length).toBe(
        hydrated.timeline.length,
      );
      expect(hydrated.timeline.energyErrorJ.every(Number.isFinite)).toBe(true);
      const hasLaunch = Array.from(hydrated.timeline.launchActivity).some(
        (v) => v >= 0.5,
      );
      const hasBrake = Array.from(hydrated.timeline.brakeActivity).some(
        (v) => v >= 0.5,
      );
      expect(hasLaunch).toBe(true);
      expect(hasBrake).toBe(true);
      expect(hydrated.timeline.carPositionsXYZ.length).toBe(
        hydrated.timeline.length * hydrated.timeline.carCount * 3,
      );
    },
  );

  it(
    "compact payload transfer-list contract: timeline buffers are 28 ArrayBuffers and collectTransferables contains only buffers",
    { timeout: 20000 },
    () => {
      const intent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 99,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [
          {
            id: "station-0",
            kind: "station",
            type: "station",
            parameters: { length: 80, bank: 0, closed: false },
          },
          {
            id: "launch-1",
            kind: "launch",
            type: "launch",
            parameters: { length: 80, targetSpeed: 12, bank: 0 },
          },
          {
            id: "brake-2",
            kind: "brake",
            type: "brake",
            parameters: { length: 80, targetSpeed: 5, bank: 0 },
          },
          {
            id: "station-3",
            kind: "station",
            type: "station",
            parameters: { length: 80, bank: 0, closed: false },
          },
        ],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      });
      const result = handleGenerate("post-compact", intent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") return;
      expect(result.timeline.frames).toBeUndefined();
      expect(result.timeline.buffers.length).toBe(28);
      const transfers = collectTransferables({
        track: result.track,
        timeline: result.timeline,
      });
      // traverse object values to ensure no frame graph buffers traversed
      const json = JSON.stringify(result.timeline);
      expect(json).not.toContain("frame");
      expect(json).not.toContain("seat");
      // transfer list only contains ArrayBuffers from buffers, not from frames graph
      expect(transfers.every((b) => b instanceof ArrayBuffer)).toBe(true);
      // ensure no duplicate and no frame-derived buffers beyond timeline buffers + track
      const trackBuffers = Object.values(result.track)
        .filter((v) => v instanceof Float64Array || v instanceof Uint32Array)
        .map((a: unknown) => (a as Float64Array).buffer);
      expect(transfers.length).toBeGreaterThan(trackBuffers.length);
    },
  );
});
