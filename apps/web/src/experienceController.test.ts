import { describe, expect, it, vi } from "vitest";
import { RideTimeline } from "@openvibecoaster/simulator";
import type { CompiledTrackData } from "@openvibecoaster/core";
import type { CoasterFileV1 } from "@openvibecoaster/core";
import {
  createExperienceController,
  type AuthoritativeExperienceResult,
} from "./experienceController.js";
import {
  compileTrack,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";

function makeTrack(): CompiledTrackData {
  const span = new SeventhOrderHermiteSpan({
    p0: vec3(0, 0, 0),
    d10: vec3(1, 0, 0),
    d20: vec3(0, 0, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(10, 0, 0),
    d11: vec3(1, 0, 0),
    d21: vec3(0, 0, 0),
    d31: vec3(0, 0, 0),
  });
  return compileTrack([
    {
      id: "a",
      span,
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      zones: [],
    },
  ]);
}

function makeFile(id = "station-000"): CoasterFileV1 {
  return {
    schemaVersion: 1,
    name: "test",
    seed: 7,
    design: {
      elements: [{ id, type: id.split("-")[0], kind: id.split("-")[0] }],
    } as unknown as CoasterFileV1["design"],
    intent: {
      schemaVersion: 1,
      generatorVersion: "v",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [{ id, kind: id.split("-")[0], type: id.split("-")[0] }],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    } as unknown as CoasterFileV1["intent"],
    solvedSpans: [
      {
        id: "a",
        kind: "station",
        positionCoefficients: [
          [0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0, 0, 0, 0],
        ],
        rollCoefficients: [0, 0, 0, 0, 0, 0],
        length: 10,
      },
    ],
    generatorVersion: "v",
    profileVersion: "p",
    researchSnapshotIds: [],
    compiledDataChecksum: "00000000",
  } as unknown as CoasterFileV1;
}

function makeResult(
  hash = "same",
  fileId = "station-000",
): AuthoritativeExperienceResult {
  return {
    file: makeFile(fileId),
    track: makeTrack(),
    timeline: new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1]),
      headDistanceM: new Float64Array([0, 10]),
      speedMps: new Float64Array([0, 10]),
    }),
    diagnostics: [],
    spanHashes: { "span-000": hash },
  };
}

describe("ExperienceController – injection and epochs", () => {
  it("requires injected real operation functions (no placeholder defaults)", () => {
    expect(() => createExperienceController({} as unknown as never)).toThrow(
      /requires injected/,
    );
    expect(() =>
      createExperienceController({ onGenerate: vi.fn() } as unknown as never),
    ).toThrow();
  });

  it("owns monotonically increasing request IDs and invokes callbacks with payload", () => {
    const onGenerate = vi.fn();
    const onLocal = vi.fn();
    const onLoad = vi.fn();
    const ctrl = createExperienceController({
      onGenerate,
      onLocalRegenerate: onLocal,
      onCompileLoad: onLoad,
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 7 });
    const id2 = ctrl.requestGenerate({ mode: "full-auto", seed: 8 });
    expect(id2).toBeGreaterThan(id1);
    expect(onGenerate).toHaveBeenCalledWith({ mode: "insta", seed: 7 }, id1);
    expect(onGenerate).toHaveBeenCalledWith(
      { mode: "full-auto", seed: 8 },
      id2,
    );
    expect(ctrl.getState().requestId).toBe(id2);
    expect(ctrl.getState().epoch).toBe(id2);
  });

  it("rejects stale results and supports generate/local-regenerate/compile-load", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    // stale id1 should be rejected
    expect(ctrl.setResult(makeResult("a"), id1)).toBe(false);
    expect(ctrl.getState().status).not.toBe("ready");
    // current id2 accepted
    expect(ctrl.setResult(makeResult("b"), id2)).toBe(true);
    expect(ctrl.getState().status).toBe("ready");
    // local regenerate increments epoch
    const id3 = ctrl.requestLocalRegenerate()!;
    expect(id3).toBeGreaterThan(id2);
    // compile-load increments
    const id4 = ctrl.requestLoad(new File([""], "f.json"));
    expect(id4).toBeGreaterThan(id3);
    // stale local result rejected
    expect(ctrl.setResult(makeResult("c"), id3)).toBe(false);
  });

  it("preserves last known good state on failure and never treats rejected/invalid as ready", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(makeResult("good"), id1);
    expect(ctrl.getState().status).toBe("ready");
    const lastGood = ctrl.getState().lastGoodResult;
    // failure keeps last good
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    ctrl.setError("worker failed", id2);
    expect(ctrl.getState().status).toBe("error");
    expect(ctrl.getState().lastGoodResult).toBe(lastGood);
    expect(ctrl.getState().result).toBe(lastGood); // preserved, not null
    // invalid result never becomes ready (construct invalid timeline without triggering constructor validation)
    const id3 = ctrl.requestGenerate({ mode: "insta", seed: 3 });
    const badBase = makeResult("bad");
    const fakeTimeline = {
      length: 1,
      headDistanceM: new Float64Array([Number.NaN]),
      timeSeconds: new Float64Array([0]),
      speedMps: new Float64Array([Number.NaN]),
      verticalG: new Float64Array(),
      lateralG: new Float64Array(),
      longitudinalG: new Float64Array(),
      jerkMps3: new Float64Array(),
      frames: [],
    } as unknown as RideTimeline;
    const invalid = {
      ...badBase,
      timeline: fakeTimeline,
    } as unknown as AuthoritativeExperienceResult;
    expect(ctrl.setResult(invalid, id3)).toBe(false);
    expect(ctrl.getState().status).not.toBe("ready");
    expect(ctrl.getState().result).toBe(lastGood);
  });

  it("pinning preserves stable semantic element IDs and local regeneration sends selected real id", () => {
    const onLocal = vi.fn();
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: onLocal,
      onCompileLoad: vi.fn(),
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(makeResult("same", "station-000"), id1);
    ctrl.selectElement("station-000");
    ctrl.togglePin("station-000");
    expect(ctrl.getState().pinnedElementIds).toEqual(["station-000"]);
    const localId = ctrl.requestLocalRegenerate()!;
    expect(onLocal).toHaveBeenCalledWith(
      expect.objectContaining({ selectedElementId: "station-000" }),
      localId,
    );
    // ensure not index-derived: should be exact string, not "0" or "element-0"
    const sentId = onLocal.mock.calls[0]?.[0]?.selectedElementId;
    expect(sentId).toBe("station-000");
    // toggling again removes
    ctrl.togglePin("station-000");
    expect(ctrl.getState().pinnedElementIds).toEqual([]);
  });

  it("never fabricates index-derived IDs and validates element existence", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(makeResult("same", "station-000"), id1);
    expect(ctrl.selectElement("nonexistent")).toBe(false);
    expect(ctrl.togglePin("nonexistent")).toBe(false);
    expect(ctrl.editElementParameter("nonexistent", "length", 10)).toBe(false);
  });

  it("freezes returned state graphs and deep-copies typed data ownership", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    const clearance = new Float64Array([1, 2]);
    const result = { ...makeResult("a"), clearanceM: clearance };
    ctrl.setResult(result, id1);
    const state = ctrl.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.pinnedElementIds)).toBe(true);
    // caller mutation of clearance shouldn't affect stored
    clearance[0] = 99;
    expect(state.result!.clearanceM![0]).toBe(1);
    // mutating caller result after set should not affect stored
    (result as unknown as Record<string, unknown>).spanHashes = {
      "span-000": "mutated",
    };
    expect(
      (ctrl.getState().result!.spanHashes as Record<string, string>)[
        "span-000"
      ],
    ).toBe("a");
  });

  it("emits typed operation payloads and preserves determinism", () => {
    const onGenerate = vi.fn();
    const onSave = vi.fn();
    const ctrl = createExperienceController({
      onGenerate,
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
      onSave,
    });
    const id1 = ctrl.requestGenerate({
      mode: "directed",
      input: {
        seed: 1,
        gates: [],
        footprint: {
          polygon: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
          maxHeightM: 50,
        },
        terrainProfileId: "plains",
        requiredElements: ["station"],
        hardTargets: [],
        softTargets: [],
      } as unknown as never,
    });
    ctrl.setResult(makeResult("a"), id1);
    ctrl.selectElement("station-000");
    ctrl.editElementParameter("station-000", "length", 20);
    ctrl.requestSave();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({
          design: expect.objectContaining({ elements: expect.any(Array) }),
        }),
      }),
    );
    // second run same inputs -> same state
    const secondCtrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const id = secondCtrl.requestGenerate({ mode: "insta", seed: 5 });
    secondCtrl.setResult(makeResult("same"), id);
    expect(secondCtrl.getState().status).toBe("ready");
  });

  it("does not leak and supports subscribe cleanup", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const listener = vi.fn();
    const unsub = ctrl.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    ctrl.setResult(makeResult("a"), id1);
    expect(listener).toHaveBeenCalledTimes(2); // no longer called
  });
});
