import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  generateCoaster,
  regenerateLocal,
  validateClearance,
} from "./index";
import { HeightfieldEnvironment, vec3 } from "@openvibecoaster/core";

const directedIntent = {
  schemaVersion: 1 as const,
  generatorVersion: "generator-v1",
  seed: 7,
  mode: "directed" as const,
  family: "steel-sitdown-lsm-v1" as const,
  elements: [
    {
      id: "station-000",
      kind: "station",
      type: "station",
      parameters: { length: 12, bank: 0, closed: false },
    },
    {
      id: "stall-001",
      kind: "stall",
      type: "stall",
      parameters: { length: 32, height: 18, bank: 0 },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: ["station-000"],
};

describe("wave 3 deterministic generator", () => {
  it("builds the flagship semantic sequence for automatic modes", () => {
    const result = generateCoaster({
      ...directedIntent,
      mode: "full-auto",
      elements: [],
    });
    expect(result.elements.map((element) => element.type)).toEqual([
      "station",
      "launch",
      "topHat",
      "overbankedTurn",
      "airtimeHill",
      "boost",
      "zeroGRoll",
      "stall",
      "brake",
      "brake",
      "station",
    ]);
    const topHat = result.elements[2];
    expect(topHat).toBeDefined();
    expect((topHat!.parameters as { readonly height: number }).height).toBe(80);
    expect(result.track.totalLength).toBeGreaterThanOrEqual(1600);
    expect(result.track.totalLength).toBeLessThanOrEqual(2200);
  });

  it("keeps candidate search bounded and byte deterministic", () => {
    const first = generateCoaster(directedIntent);
    const second = generateCoaster(directedIntent);
    expect(first.candidatesTested).toBeLessThanOrEqual(48);
    expect(first.lmIterations).toBeLessThanOrEqual(32);
    expect(first.serializedFile).toBe(second.serializedFile);
    expect(first.track.checksum).toBe(second.track.checksum);
    expect(
      compileCoasterFile(first.file, { samples: 128 }).track.checksum,
    ).toBe(first.track.checksum);
    expect(
      compileCoasterFile(first.serializedFile, { samples: 32 }).track.checksum,
    ).toBe(
      compileCoasterFile(second.serializedFile, { samples: 32 }).track.checksum,
    );
    expect(first.diagnostics).toEqual(second.diagnostics);
  });

  it("reports exact clearance locations and margins", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 100,
      heights: [0, 0, 0, 0],
    });
    const generated = generateCoaster(directedIntent, {
      environment,
      samples: 32,
    });
    const diagnostics = validateClearance(generated.solvedSpans, environment, {
      trainEnvelopeRadius: 2,
    });
    expect(
      diagnostics.every((diagnostic) => diagnostic.location?.s !== undefined),
    ).toBe(true);
    expect(
      diagnostics.every(
        (diagnostic) =>
          diagnostic.actual !== undefined && diagnostic.limit !== undefined,
      ),
    ).toBe(true);
  });

  it("regenerates only the selected neighborhood and keeps pinned spans bitwise stable", () => {
    const generated = generateCoaster(directedIntent);
    const result = regenerateLocal(generated, "stall-001", {
      pinnedElementIds: ["station-000"],
    });
    expect(result.feasible).toBe(true);
    expect(result.untouchedSpanHashes["station-000"]).toBe(
      generated.spanHashes["station-000"],
    );
  });

  it("widens a changed local solve without changing an upstream pin", () => {
    const generated = generateCoaster(directedIntent);
    const result = regenerateLocal(generated, "stall-001", {
      changes: { "stall-001": { length: 40 } },
      pinnedElementIds: ["station-000"],
    });
    expect(result.feasible).toBe(true);
    expect(result.untouchedSpanHashes["station-000"]).toBe(
      generated.spanHashes["station-000"],
    );
    expect(result.generation.spanHashes["stall-001"]).not.toBe(
      generated.spanHashes["stall-001"],
    );
  });

  it("uses positive signed distance as free terrain space", () => {
    const environment = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: [0, 0, 0, 0],
    });
    expect(environment.sampleSolid(vec3(0.5, 1, 0.5))).toBeGreaterThan(0);
  });
});
