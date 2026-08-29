import { describe, expect, it } from "vitest";
import {
  resolveTerrainEnvironment,
  ROLLING_TERRAIN_PROFILE_ID,
  BLOCKING_TERRAIN_PROFILE_ID,
} from "./environment";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "../engineering/worker";

describe("terrain profiles deterministic", () => {
  it("seeded determinism – same profile returns identical heights", () => {
    const a = resolveTerrainEnvironment(ROLLING_TERRAIN_PROFILE_ID)!;
    const b = resolveTerrainEnvironment(ROLLING_TERRAIN_PROFILE_ID)!;
    expect(a.heights).toEqual(b.heights);
    expect(a.width).toBe(b.width);
    expect(a.depth).toBe(b.depth);
    expect(a.cellSize).toBe(b.cellSize);
    expect(a.origin).toEqual(b.origin);
    const c = resolveTerrainEnvironment(BLOCKING_TERRAIN_PROFILE_ID)!;
    const d = resolveTerrainEnvironment(BLOCKING_TERRAIN_PROFILE_ID)!;
    expect(c.heights).toEqual(d.heights);
  });

  it("useful bounds – rolling covers 520x360 footprint with low heights", () => {
    const env = resolveTerrainEnvironment(ROLLING_TERRAIN_PROFILE_ID)!;
    const bounds = env.bounds();
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[2] - bounds.min[2];
    expect(width).toBeGreaterThanOrEqual(520);
    expect(depth).toBeGreaterThanOrEqual(360);
    // rolling low: max height should be modest (<10)
    const maxH = bounds.max[1];
    const minH = bounds.min[1];
    expect(maxH).toBeLessThan(10);
    expect(maxH - minH).toBeLessThan(10);
  });

  it("rolling terrain allows generation success", () => {
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 42,
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
          parameters: { length: 80, targetSpeed: 20, bank: 0 },
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
      terrainProfileId: ROLLING_TERRAIN_PROFILE_ID,
    });
    const result = handleGenerate("terrain-rolling", intent as unknown);
    expect(result.type).toBe("success");
  });

  it("blocking terrain causes hard failure with terrain diagnostics", () => {
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 42,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 30, bank: 0, closed: false },
        },
        {
          id: "launch-1",
          kind: "launch",
          type: "launch",
          parameters: { length: 30, targetSpeed: 10, bank: 0 },
        },
        {
          id: "station-2",
          kind: "station",
          type: "station",
          parameters: { length: 30, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
      terrainProfileId: BLOCKING_TERRAIN_PROFILE_ID,
    });
    const result = handleGenerate("terrain-blocking", intent as unknown);
    expect(result.type).toBe("failure");
    if (result.type === "failure") {
      // Should contain TRACK_CLEARANCE or terrain diagnostics
      const hasTerrain = result.diagnostics.some(
        (d) =>
          d.code === "TRACK_CLEARANCE" ||
          d.message.toLowerCase().includes("terrain") ||
          d.message.toLowerCase().includes("clearance"),
      );
      expect(hasTerrain).toBe(true);
    }
  });

  it("unknown profile throws explicitly, never silently selects another", () => {
    expect(() => resolveTerrainEnvironment("unknown-profile-v1")).toThrow(
      /Unknown terrain profile/,
    );
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 1,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 10, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
      terrainProfileId: "unknown-profile-v1",
    });
    const result = handleGenerate("terrain-unknown", intent as unknown);
    expect(result.type).toBe("failure");
    if (result.type === "failure") {
      expect(result.diagnostics[0]!.code).toBe("TERRAIN_PROFILE_UNKNOWN");
    }
  });
});
