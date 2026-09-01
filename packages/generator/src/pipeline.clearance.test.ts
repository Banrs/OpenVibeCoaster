import { describe, it, expect, vi } from "vitest";
import { createDesignIntentV1, vec3 } from "@openvibecoaster/core";
import { generateCoaster, regenerateCoasterFileLocal } from "./pipeline";
import rawProfile from "../../../data/profiles/engineering-limits-v1.json";
import { parseEngineeringLimitsProfile } from "@openvibecoaster/core";
import type { ClearanceField } from "./clearance-field";

function planeEnv(planeY: number) {
  return {
    signedDistance: (p: readonly [number, number, number]) => p[1] - planeY,
    raycast: () => undefined,
  };
}

describe("pipeline authoritative clearance", () => {
  it("explicit hard clearance via mock field bracket 0.7/0.75", async () => {
    const { compileTrack, SeventhOrderHermiteSpan } = await import("@openvibecoaster/core");
    const mkTrack = () => compileTrack([{ id: "seg-0", span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)) }], { samples: 2 });
    const mockTrack = mkTrack();
    const mockField: ClearanceField = {
      track: mockTrack,
      segments: [],
      globalLowerM: 0.7,
      globalUpperM: 0.75,
      globalWitnessS: 0,
      globalWitnessPosition: vec3(0, 0, 0),
      globalRelatedIds: ["seg-0"],
      globalSource: "self",
      globalLowerRelatedIds: ["seg-0"],
      globalLowerSource: "self",
      globalLowerWitnessS: 0,
      globalLowerWitnessPosition: vec3(0, 0, 0),
      effectiveCap: 10,
      diagnostics: [],
      work: 10,
      closed: false,
    };
    const { projectClearanceDiagnostics } =
      await import("./clearance-field.js");
    const hard = projectClearanceDiagnostics(mockField, [
      { id: "hard-1", hard: true, threshold: 1.0 },
    ]);
    expect(hard.length).toBe(1);
    expect(hard[0]!.code).toBe("TRACK_CLEARANCE");
    expect(hard[0]!.severity).toBe("error");
    expect(hard[0]!.relatedIds).toContain("hard-1");
    // Also test via pipeline with mock
    const base = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 10, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [
        { id: "hard-1", kind: "track-clearance", value: 1.0, hard: true },
      ],
      pinnedElementIds: [],
    });
    const mod = await import("./clearance-field.js");
    const spy = vi
      .spyOn(mod, "computeClearanceField")
      .mockReturnValue(mockField);
    const rHard = generateCoaster(base);
    expect(rHard.feasible).toBe(false);
    expect(
      rHard.diagnostics.some(
        (d) => d.relatedIds?.includes("hard-1") && d.severity === "error",
      ),
    ).toBe(true);
    expect(
      rHard.relaxationEvidence.some((e) => e.change.includes("hard-1")),
    ).toBe(true);
    spy.mockRestore();
  });

  it("soft clearance same bracket gives warning and feasible", async () => {
    const { compileTrack, SeventhOrderHermiteSpan } = await import("@openvibecoaster/core");
    const mkTrack = () => compileTrack([{ id: "seg-0", span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)) }], { samples: 2 });
    const mockTrack = mkTrack();
    const mockField: ClearanceField = {
      track: mockTrack,
      segments: [],
      globalLowerM: 0.7,
      globalUpperM: 0.75,
      globalWitnessS: 0,
      globalWitnessPosition: vec3(0, 0, 0),
      globalRelatedIds: ["seg-0"],
      globalSource: "self",
      globalLowerRelatedIds: ["seg-0"],
      globalLowerSource: "self",
      globalLowerWitnessS: 0,
      globalLowerWitnessPosition: vec3(0, 0, 0),
      effectiveCap: 10,
      diagnostics: [],
      work: 10,
      closed: false,
    };
    const { projectClearanceDiagnostics } =
      await import("./clearance-field.js");
    const soft = projectClearanceDiagnostics(mockField, [
      { id: "soft-1", hard: false, threshold: 1.0 },
    ]);
    expect(soft.length).toBe(1);
    expect(soft[0]!.severity).toBe("warning");
    const base = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 10, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [
        { id: "soft-1", kind: "track-clearance", value: 1.0, hard: false },
      ],
      pinnedElementIds: [],
    });
    const mod = await import("./clearance-field.js");
    const spy = vi
      .spyOn(mod, "computeClearanceField")
      .mockReturnValue(mockField);
    const rSoft = generateCoaster(base);
    expect(rSoft.feasible).toBe(true);
    expect(
      rSoft.diagnostics.some(
        (d) => d.relatedIds?.includes("soft-1") && d.severity === "warning",
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it("selected field aligns with returned track", () => {
    const base = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "full-auto",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const r = generateCoaster(base, { samples: 2 });
    expect(r.clearanceField).toBeDefined();
    expect(r.clearanceField!.track.checksum).toBe(r.track.checksum);
  });

  it("local regeneration envelope-only failure propagates", () => {
    const seams = parseEngineeringLimitsProfile(rawProfile).seams;
    const base = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 42,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 30, closed: false },
        },
        {
          id: "launch-1",
          kind: "launch",
          type: "launch",
          parameters: { length: 30, targetSpeed: 10 },
        },
        {
          id: "brake-2",
          kind: "brake",
          type: "brake",
          parameters: { length: 30, targetSpeed: 5 },
        },
        {
          id: "station-3",
          kind: "station",
          type: "station",
          parameters: { length: 30, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const genRes = generateCoaster(base);
    const railY = genRes.track.positions[1]!;
    const planeY = railY - 1.0;
    const plane = planeEnv(planeY);
    const local = regenerateCoasterFileLocal(genRes.file, "launch-1", {
      environment: plane,
      seams,
      referenceSpeed: 44,
    });
    expect(local.feasible).toBe(false);
    expect(local.generation.feasible).toBe(false);
    expect(
      local.diagnostics.slice(0, local.generation.diagnostics.length),
    ).toEqual(local.generation.diagnostics);
    expect(local.diagnostics[local.diagnostics.length - 1]!.code).toBe(
      "LOCAL_REGENERATION",
    );
    expect(local.generation).not.toBe(genRes);
  });
});
