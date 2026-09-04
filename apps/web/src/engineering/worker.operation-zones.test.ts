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

function getZones(): SimulatorConfig["zones"] | undefined {
  const call = vi.mocked(simulateRide).mock.calls[0];
  return call?.[1]?.config?.zones;
}

function semanticOwnerOf(spanId: string): string {
  const match = spanId.match(/#\d+$/);
  return match ? spanId.slice(0, -match[0].length) : spanId;
}

function physicalOwnerLayout(file: CoasterFileV1): {
  boundaries: Set<number>;
  startByOwner: Map<string, number>;
  widthByOwner: Map<string, number>;
  totalLengthM: number;
} {
  let cumulative = 0;
  const boundaries = new Set<number>([0]);
  const startByOwner = new Map<string, number>();
  const widthByOwner = new Map<string, number>();
  for (const span of file.solvedSpans) {
    const start = cumulative;
    const end = start + span.length;
    boundaries.add(end);
    const owner = semanticOwnerOf(span.id);
    if (!startByOwner.has(owner)) startByOwner.set(owner, start);
    widthByOwner.set(owner, (widthByOwner.get(owner) ?? 0) + span.length);
    cumulative = end;
  }
  return { boundaries, startByOwner, widthByOwner, totalLengthM: cumulative };
}

function expectPhysicalOperationZoneAuthority(
  file: CoasterFileV1,
  zones: NonNullable<SimulatorConfig["zones"]>,
): void {
  const { boundaries, startByOwner, widthByOwner, totalLengthM } =
    physicalOwnerLayout(file);
  for (const zone of zones) {
    expect(boundaries.has(zone.startDistanceM)).toBe(true);
    expect(boundaries.has(zone.endDistanceM)).toBe(true);
    expect(zone.startDistanceM).toBe(startByOwner.get(zone.id));
    expect(zone.endDistanceM).toBe(
      startByOwner.get(zone.id)! + widthByOwner.get(zone.id)!,
    );
    expect(zone.endDistanceM - zone.startDistanceM).toBe(
      widthByOwner.get(zone.id),
    );
    expect(zone.startDistanceM).toBeGreaterThanOrEqual(0);
    expect(zone.endDistanceM).toBeLessThanOrEqual(totalLengthM);
    expect(zone.endDistanceM).toBeGreaterThan(zone.startDistanceM);
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

      // authored intent lengths as separate evidence, not physical boundaries
      for (const id of ["station-0", "launch-1", "brake-2", "station-3"]) {
        const element = result.file.intent.elements.find((e) => e.id === id);
        expect(element?.parameters?.length).toBe(100);
      }

      // physical authority: solved-span cumulative sums, owner widths, end within track
      expectPhysicalOperationZoneAuthority(result.file, actual!);

      // semantic owners resolve to physical sums without authored constants
      const layout = physicalOwnerLayout(result.file);
      const station0 = actual!.find((z) => z.id === "station-0")!;
      expect(station0.startDistanceM).toBe(
        layout.startByOwner.get("station-0"),
      );
      expect(station0.endDistanceM).toBe(
        layout.startByOwner.get("station-0")! +
          layout.widthByOwner.get("station-0")!,
      );
      expect(station0.targetSpeedMps).toBeUndefined();

      const launchZone = actual!.find((z) => z.id === "launch-1")!;
      expect(launchZone.startDistanceM).toBe(
        layout.startByOwner.get("launch-1"),
      );
      expect(launchZone.endDistanceM).toBe(
        layout.startByOwner.get("launch-1")! +
          layout.widthByOwner.get("launch-1")!,
      );

      const brakeZone = actual!.find((z) => z.id === "brake-2")!;
      expect(brakeZone.startDistanceM).toBe(
        layout.startByOwner.get("brake-2"),
      );
      expect(brakeZone.endDistanceM).toBe(
        layout.startByOwner.get("brake-2")! +
          layout.widthByOwner.get("brake-2")!,
      );

      const station3 = actual!.find((z) => z.id === "station-3")!;
      expect(station3.startDistanceM).toBe(
        layout.startByOwner.get("station-3"),
      );
      expect(station3.endDistanceM).toBe(
        layout.startByOwner.get("station-3")! +
          layout.widthByOwner.get("station-3")!,
      );
      expect(station3.targetSpeedMps).toBeUndefined();
      expect(station3.endDistanceM).toBeLessThanOrEqual(
        layout.totalLengthM,
      );

      // exact span lengths proven by equality to helper which uses cumulative solvedSpans lengths
      for (const z of expected) {
        const found = actual!.find((a) => a.id === z.id)!;
        expect(found.startDistanceM).toBe(z.startDistanceM);
        expect(found.endDistanceM).toBe(z.endDistanceM);
      }
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
      const expected = operationZonesFromCoasterFile(gen.file);
      const actual = getZones();
      expect(actual).toEqual(expected);
      expectPhysicalOperationZoneAuthority(gen.file, actual!);
      const brake = actual!.find((z) => z.id === "brake-2")!;
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
      const expected = operationZonesFromCoasterFile(result.file);
      const actual = getZones();
      expect(actual).toEqual(expected);
      expectPhysicalOperationZoneAuthority(result.file, actual!);
      const launch = actual!.find((z) => z.id === "launch-1")!;
      expect(launch.targetSpeedMps).toBe(27);
      const brake = actual!.find((z) => z.id === "brake-2")!;
      expect(brake.targetSpeedMps).toBe(7.5);
    },
  );
});
