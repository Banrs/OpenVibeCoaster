import { describe, expect, it } from "vitest";
import {
  CLIFF_VALLEY_TERRAIN_PROFILE_ID,
  resolveTerrainEnvironment,
  ROLLING_TERRAIN_PROFILE_ID,
  BLOCKING_TERRAIN_PROFILE_ID,
} from "./environment";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "../engineering/worker";

describe("terrain profiles deterministic", () => {
  it("delegates cliff-valley to the pure core profile", () => {
    const environment = resolveTerrainEnvironment(
      CLIFF_VALLEY_TERRAIN_PROFILE_ID,
    )!;
    expect(environment.width).toBe(420);
    expect(environment.depth).toBe(280);
    expect(environment.cellSize).toBe(10);
    expect(environment.origin).toEqual([-2095, -1395]);
    expect(environment.heightAt(0, 980)).toBeGreaterThanOrEqual(224.4);
  });

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
    expect(env.width).toBe(66);
    expect(env.depth).toBe(46);
    expect(env.cellSize).toBe(8);
    expect(env.origin[0]).toBe(-260);
    expect(env.origin[1]).toBe(-180);
    const bounds = env.bounds();
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[2] - bounds.min[2];
    expect(width).toBe(520);
    expect(depth).toBe(360);
    const maxH = bounds.max[1];
    const minH = bounds.min[1];
    // Procedural low hills roughly in [-11,-5], safely below station y~0
    expect(minH).toBeGreaterThanOrEqual(-11);
    expect(maxH).toBeLessThanOrEqual(-5);
    expect(maxH).toBeGreaterThan(minH);
    expect(maxH - minH).toBeGreaterThan(1);
    expect(maxH - minH).toBeLessThan(6);
    // Coherence: adjacent cells differ smoothly (<1.5)
    const idx = 22 * env.width + 33;
    const h0 = env.heights[idx]!;
    const h1 = env.heights[idx + 1]!;
    const h2 = env.heights[idx + env.width]!;
    expect(Math.abs(h0 - h1)).toBeLessThan(1.5);
    expect(Math.abs(h0 - h2)).toBeLessThan(1.5);
    // Not flat
    expect(new Set(env.heights).size).toBeGreaterThan(10);
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
      const diag = result.diagnostics.find(
        (d) => d.code === "TERRAIN_CLEARANCE",
      )!;
      expect(diag).toBeDefined();
      expect(diag.severity).toMatch(/error|fatal/);
      expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
      expect(diag.location).toBeDefined();
      expect(diag.location!.s).toBeDefined();
      expect(diag.location!.position).toBeDefined();
      expect(diag.actual).toBeDefined();
      expect(diag.limit).toBe(0.5);
      expect(diag.margin).toBeLessThan(0);
      expect(diag.actual).toBeLessThan(0);
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
