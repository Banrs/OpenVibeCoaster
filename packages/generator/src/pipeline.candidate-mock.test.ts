import { describe, it, expect, vi } from "vitest";
import {
  createDesignIntentV1,
  vec3,
  compileTrack,
  SeventhOrderHermiteSpan,
} from "@openvibecoaster/core";
import { generateCoaster } from "./pipeline";
import type { ClearanceField } from "./clearance-field";

function realTrack(): ClearanceField["track"] {
  const t = compileTrack(
    [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
      },
    ],
    { samples: 2 },
  );
  return t;
}
function mockField(overrides: Partial<ClearanceField>): ClearanceField {
  const track = realTrack();
  return {
    track,
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
    ...overrides,
    track,
  };
}

describe("pipeline candidate skip mocked", () => {
  it("candidate0 fails then later passes with soft harmless", async () => {
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
    const failingField = mockField({
      globalLowerM: 0.2,
      globalUpperM: 0.3,
      diagnostics: [],
      effectiveCap: 10,
    });
    const passingField = mockField({
      globalLowerM: 0.7,
      globalUpperM: 0.8,
      diagnostics: [],
      effectiveCap: 10,
    });
    const mod = await import("./clearance-field.js");
    const spy = vi
      .spyOn(mod, "computeClearanceField")
      .mockReturnValueOnce(failingField)
      .mockReturnValueOnce(passingField)
      .mockReturnValue(passingField);
    const softHarmless = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "full-auto",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [
        { id: "soft-len", kind: "total-length", target: 9999, hard: false },
      ],
      constraints: [],
      pinnedElementIds: [],
    });
    const r = generateCoaster(softHarmless);
    expect(r.candidatesTested).toBe(2);
    expect(r.feasible).toBe(true);
    spy.mockClear();
    spy
      .mockReturnValueOnce(failingField)
      .mockReturnValueOnce(passingField)
      .mockReturnValue(passingField);
    const r2 = generateCoaster(softHarmless);
    expect(r2.candidatesTested).toBe(2);
    spy.mockRestore();
  });
});
