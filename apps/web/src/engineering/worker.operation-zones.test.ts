import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import type { CoasterFileV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  operationZonesFromCoasterFile,
  simulateRide,
} from "@openvibecoaster/simulator";
import type { SimulatorConfig } from "@openvibecoaster/simulator";
import {
  handleCompileSimulate,
  handleGenerate,
  handleRegenerate,
} from "./worker";

vi.mock("@openvibecoaster/simulator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@openvibecoaster/simulator")>();
  return {
    ...actual,
    simulateRide: vi.fn(actual.simulateRide),
  };
});

// Authored targets that mask-heuristic could not recover:
// launch target 27 (heuristic leaves undefined), brake target 7.5 (heuristic invents 5)
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
      parameters: { length: 100, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 100, targetSpeed: 27, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 100, targetSpeed: 7.5, bank: 0 },
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

function getZones(): NonNullable<SimulatorConfig["zones"]> {
  const calls = vi.mocked(simulateRide).mock.calls;
  if (calls.length !== 1) throw new Error("expected one simulateRide call");
  const call = calls[0];
  if (call === undefined) throw new Error("expected simulateRide call");
  const request = call[1];
  if (request === undefined) throw new Error("expected simulateRide request");
  const zones = request.config.zones;
  if (zones === undefined) throw new Error("expected simulateRide zones");
  return zones;
}

// Single `#digits` owner contract, matching operationZonesFromCoasterFile.
function semanticOwnerOf(spanId: string): string {
  const match = spanId.match(/#\d+$/);
  return match ? spanId.slice(0, -match[0].length) : spanId;
}

function expectPhysicalOperationZones(
  file: CoasterFileV1,
  zones: NonNullable<SimulatorConfig["zones"]>,
  totalLengthM: number,
): void {
  let cumulative = 0;
  const startByOwner = new Map<string, number>();
  const endByOwner = new Map<string, number>();
  for (const span of file.solvedSpans) {
    const start = cumulative;
    const end = start + span.length;
    const owner = semanticOwnerOf(span.id);
    if (!startByOwner.has(owner)) startByOwner.set(owner, start);
    endByOwner.set(owner, end);
    cumulative = end;
  }
  expect(Math.abs(cumulative - totalLengthM)).toBeLessThan(1e-9);
  for (const zone of zones) {
    const expectedStart = startByOwner.get(zone.id);
    const expectedEnd = endByOwner.get(zone.id);
    expect(
      expectedStart,
      `missing physical start for ${zone.id}`,
    ).toBeDefined();
    expect(expectedEnd, `missing physical end for ${zone.id}`).toBeDefined();
    if (expectedStart === undefined || expectedEnd === undefined) {
      throw new Error(`missing physical range for ${zone.id}`);
    }
    expect(zone.startDistanceM).toBe(expectedStart);
    expect(zone.endDistanceM).toBe(expectedEnd);
    expect(zone.startDistanceM).toBeGreaterThanOrEqual(0);
    expect(zone.endDistanceM).toBeGreaterThan(zone.startDistanceM);
    expect(zone.endDistanceM).toBeLessThanOrEqual(totalLengthM);
  }
}

describe("worker operation zones are semantic CoasterFileV1 authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    "generate uses persisted semantic elements with exact span lengths and authored targets (launch 27, brake 7.5)",
    { timeout: 20000 },
    () => {
      const result = handleGenerate("op-gen-1", semanticIntent);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      expect(vi.mocked(simulateRide).mock.calls).toHaveLength(1);
      const actual = getZones();
      // Worker-wiring assertion only (not independent physical authority).
      expect(actual).toEqual(operationZonesFromCoasterFile(result.file));
      expectPhysicalOperationZones(
        result.file,
        actual,
        result.track.totalLength,
      );

      // semantic IDs, not heuristic kind-index
      const ids = actual.map((z) => z.id);
      expect(ids).toContain("launch-1");
      expect(ids).toContain("brake-2");
      expect(ids).not.toContain("launch-0");
      expect(ids).not.toContain("brake-0");

      // heuristic would invent brake target 5 and leave launch undefined; semantic preserves authored values
      const launch = actual.find((z) => z.id === "launch-1");
      if (launch === undefined) throw new Error("expected launch-1 zone");
      expect(launch.kind).toBe("launch");
      expect(launch.targetSpeedMps).toBe(27);

      const brake = actual.find((z) => z.id === "brake-2");
      if (brake === undefined) throw new Error("expected brake-2 zone");
      expect(brake.targetSpeedMps).toBe(7.5);
      expect(brake.targetSpeedMps).not.toBe(5);
    },
  );

  it(
    "compile-simulate uses semantic file authority with exact lengths and authored brake target",
    { timeout: 20000 },
    () => {
      const gen = generateCoaster(semanticIntent);
      expect(gen.feasible).toBe(true);
      const result = handleCompileSimulate("op-cs-1", gen.file);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      expect(vi.mocked(simulateRide).mock.calls).toHaveLength(1);
      const actual = getZones();
      // Worker-wiring assertion only (not independent physical authority).
      expect(actual).toEqual(operationZonesFromCoasterFile(gen.file));
      expectPhysicalOperationZones(gen.file, actual, result.track.totalLength);
      const brake = actual.find((z) => z.id === "brake-2");
      if (brake === undefined) throw new Error("expected brake-2 zone");
      expect(brake.targetSpeedMps).toBe(7.5);
      expect(brake.kind).toBe("brake");
    },
  );

  it(
    "regenerate uses regenerated file semantic zones and preserves authored targets",
    { timeout: 20000 },
    () => {
      const gen = generateCoaster(semanticIntent);
      expect(gen.feasible).toBe(true);
      const result = handleRegenerate("op-rg-1", gen.file, "launch-1");
      expect(result.type).toBe("success");
      if (result.type !== "success")
        throw new Error(
          `regenerate failed: ${JSON.stringify(result.diagnostics)}`,
        );
      expect(vi.mocked(simulateRide).mock.calls).toHaveLength(1);
      const actual = getZones();
      // Worker-wiring assertion only (not independent physical authority).
      expect(actual).toEqual(operationZonesFromCoasterFile(result.file));
      expectPhysicalOperationZones(
        result.file,
        actual,
        result.track.totalLength,
      );
      const launch = actual.find((z) => z.id === "launch-1");
      if (launch === undefined) throw new Error("expected launch-1 zone");
      expect(launch.targetSpeedMps).toBe(27);
      const brake = actual.find((z) => z.id === "brake-2");
      if (brake === undefined) throw new Error("expected brake-2 zone");
      expect(brake.targetSpeedMps).toBe(7.5);
    },
  );
});
