import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  operationZonesFromCoasterFile,
  type SimulatorConfig,
} from "@openvibecoaster/simulator";
import * as simModule from "@openvibecoaster/simulator";
import {
  handleGenerate,
  handleRegenerate,
  handleCompileSimulate,
} from "./worker";

// Authored targets that mask-heuristic could not recover:
// launch target 27 (heuristic leaves undefined), brake target 7.5 (heuristic invents 5), boost 22 optional
const semanticIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 40, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 30, targetSpeed: 27, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 12, targetSpeed: 7.5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 40, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

function captureZones(): {
  spy: ReturnType<typeof vi.spyOn>;
  getZones: () => SimulatorConfig["zones"] | undefined;
} {
  const spy = vi.spyOn(simModule, "simulateRide");
  const getZones = (): SimulatorConfig["zones"] | undefined => {
    const call = spy.mock.calls[0] as unknown as
      | [unknown, { config: SimulatorConfig }]
      | undefined;
    return call?.[1]?.config?.zones;
  };
  return { spy, getZones };
}

describe("worker operation zones are semantic CoasterFileV1 authority", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "generate uses persisted semantic elements with exact span lengths and authored targets (launch 27, brake 7.5)",
    { timeout: 20000 },
    () => {
      const { spy, getZones } = captureZones();
      const result = handleGenerate("op-gen-1", semanticIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const expected = operationZonesFromCoasterFile(result.file);
      const actual = getZones();
      expect(actual).toBeDefined();
      expect(actual!).toEqual(expected);

      // semantic IDs, not heuristic kind-index
      const ids = actual!.map((z) => z.id);
      expect(ids).toContain("launch-1");
      expect(ids).toContain("brake-2");
      expect(ids).not.toContain("launch-0");
      expect(ids).not.toContain("brake-0");

      // heuristic would invent brake target 5 and leave launch undefined; semantic preserves authored values
      const launch = actual!.find((z) => z.id === "launch-1")!;
      expect(launch.kind).toBe("launch");
      expect(launch.targetSpeedMps).toBe(27);

      const brake = actual!.find((z) => z.id === "brake-2")!;
      expect(brake.targetSpeedMps).toBe(7.5);
      expect(brake.targetSpeedMps).not.toBe(5);

      // exact span lengths proven by equality to helper which uses cumulative solvedSpans lengths
      for (const z of expected) {
        const found = actual!.find((a) => a.id === z.id)!;
        expect(found.startDistanceM).toBe(z.startDistanceM);
        expect(found.endDistanceM).toBe(z.endDistanceM);
      }
      spy.mockRestore();
    },
  );

  it(
    "compile-simulate uses semantic file authority with exact lengths and authored brake target",
    { timeout: 20000 },
    () => {
      const gen = generateCoaster(semanticIntent);
      expect(gen.feasible).toBe(true);
      const { spy, getZones } = captureZones();
      const result = handleCompileSimulate("op-cs-1", gen.file as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const expected = operationZonesFromCoasterFile(gen.file);
      const actual = getZones();
      expect(actual).toEqual(expected);
      const brake = actual!.find((z) => z.id === "brake-2")!;
      expect(brake.targetSpeedMps).toBe(7.5);
      expect(brake.kind).toBe("brake");
      spy.mockRestore();
    },
  );

  it(
    "regenerate uses regenerated file semantic zones and preserves authored targets",
    { timeout: 20000 },
    () => {
      const gen = generateCoaster(semanticIntent);
      expect(gen.feasible).toBe(true);
      const { spy, getZones } = captureZones();
      const result = handleRegenerate("op-rg-1", gen.file as unknown, "station-0");
      // regeneration should remain feasible for this intent
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error(`regenerate failed: ${JSON.stringify(result.diagnostics)}`);
      const expected = operationZonesFromCoasterFile(result.file);
      const actual = getZones();
      expect(actual).toEqual(expected);
      const launch = actual!.find((z) => z.id === "launch-1")!;
      expect(launch.targetSpeedMps).toBe(27);
      const brake = actual!.find((z) => z.id === "brake-2")!;
      expect(brake.targetSpeedMps).toBe(7.5);
      spy.mockRestore();
    },
  );
});
