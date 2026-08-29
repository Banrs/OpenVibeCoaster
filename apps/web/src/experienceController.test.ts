import { describe, expect, it, vi } from "vitest";
import { RideTimeline } from "@openvibecoaster/simulator";
import type { CompiledTrackData, Diagnostic } from "@openvibecoaster/core";
import type { CoasterFileV1 } from "@openvibecoaster/core";
import {
  createExperienceController,
  type AuthoritativeExperienceResult,
} from "./experienceController.js";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  compileCoasterFile,
  compileTrack,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
  createDesignIntentV1,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
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
  const kind = id.split("-")[0] ?? "station";
  const intent = createDesignIntentV1({
    generatorVersion: "test",
    seed: 7,
    mode: "directed",
    family: "steel-sitdown-lsm-v1",
    elements: [{ id, kind, type: kind }],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });
  const result = generateCoaster(intent, { name: "test" });
  return result.file;
}

function makeResult(
  hash = "same",
  fileId = "station-000",
): AuthoritativeExperienceResult {
  const file = makeFile(fileId);
  const track = compileCoasterFile(file).track;
  return {
    file,
    track,
    timeline: new RideTimeline({
      sampleRateHz: 10,
      timeSeconds: new Float64Array([0, 1]),
      headDistanceM: new Float64Array([0, 10]),
      speedMps: new Float64Array([0, 10]),
    }),
    diagnostics: [],
    spanHashes: { [fileId]: hash, a: hash },
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
      a: "mutated",
    };
    expect(
      (ctrl.getState().result!.spanHashes as Record<string, string>)["a"],
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

  it("isolates throwing subscriber, uses snapshot, and supports reentrant mutations", () => {
    const onError = vi.fn();
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
      onError,
    } as unknown as never);
    const calls: string[] = [];
    const throwing = vi.fn(() => {
      calls.push("throwing");
      throw new Error("boom");
    });
    const second = vi.fn(() => calls.push("second"));
    const unsubThrowing = ctrl.subscribe(throwing);
    const unsubSecond = ctrl.subscribe(second);
    // initial subscribe already called both once (throwing isolated)
    expect(onError).toHaveBeenCalled();
    onError.mockClear();
    calls.length = 0;
    throwing.mockClear();
    second.mockClear();
    // trigger publish via requestGenerate
    ctrl.requestGenerate({ mode: "insta", seed: 10 });
    expect(throwing).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(calls).toEqual(["throwing", "second"]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "subscriber");

    // self-removal during publish: listener removes itself, snapshot still notifies later in same publish
    const ctrl2 = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const calls2: string[] = [];
    let unsubSelf2: () => void = () => {};
    const self2 = vi.fn(() => {
      unsubSelf2();
      calls2.push("self");
    });
    unsubSelf2 = ctrl2.subscribe(self2);
    const later2 = vi.fn(() => calls2.push("later"));
    const unsubLater2 = ctrl2.subscribe(later2);
    const remover2 = vi.fn(() => {
      unsubLater2();
      calls2.push("remover");
    });
    ctrl2.subscribe(remover2);
    // snapshot should notify later even though remover removes it in same publish (remover after later)
    ctrl2.requestGenerate({ mode: "insta", seed: 11 });
    expect(calls2).toContain("later");
    expect(calls2).toContain("remover");
    // next publish, later should not be called
    calls2.length = 0;
    ctrl2.requestGenerate({ mode: "insta", seed: 12 });
    expect(calls2).not.toContain("later");
    expect(calls2).toContain("remover");

    // subscribing during publish: new listener not notified in same publish
    const ctrl3 = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const calls3: string[] = [];
    const newListener = vi.fn(() => {
      calls3.push("new");
    });
    const adder = vi.fn(() => {
      // Only subscribe newListener when generating, not on initial pending notification
      if (ctrl3.getState().status === "generating") {
        ctrl3.subscribe(newListener);
      }
      calls3.push("adder");
    });
    ctrl3.subscribe(adder);
    // Clear initial adder call
    calls3.length = 0;
    newListener.mockClear();
    adder.mockClear();
    ctrl3.requestGenerate({ mode: "insta", seed: 13 });
    expect(calls3).toContain("adder");
    expect(newListener).not.toHaveBeenCalled();
    // next publish, newListener should be called
    calls3.length = 0;
    newListener.mockClear();
    ctrl3.requestGenerate({ mode: "insta", seed: 14 });
    expect(newListener).toHaveBeenCalled();

    // repeated unsubscribe idempotent
    const ctrl4 = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const l = vi.fn();
    const unsub = ctrl4.subscribe(l);
    unsub();
    unsub();
    const calls4: string[] = [];
    const watcher = vi.fn(() => calls4.push("watcher"));
    ctrl4.subscribe(watcher);
    ctrl4.requestGenerate({ mode: "insta", seed: 15 });
    expect(l).toHaveBeenCalledTimes(1); // only initial, not after
    expect(calls4).toContain("watcher");

    // nested publish: listener triggers another publish synchronously
    const nestedCalls: string[] = [];
    let nestedCtrl: ReturnType<typeof createExperienceController> | null = null;
    nestedCtrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const outer = vi.fn(() => {
      nestedCalls.push("outer");
      nestedCtrl!.requestGenerate({ mode: "insta", seed: 99 });
    });
    const innerWatcher = vi.fn(() => nestedCalls.push("innerWatcher"));
    nestedCtrl.subscribe(outer);
    nestedCtrl.subscribe(innerWatcher);
    nestedCtrl.requestGenerate({ mode: "insta", seed: 20 });
    // outer triggered nested publish, both should be notified deterministically
    expect(
      nestedCalls.filter((c) => c === "outer").length,
    ).toBeGreaterThanOrEqual(1);

    // initial subscription throw does not destabilize
    const badInitial = vi.fn(() => {
      throw new Error("initial boom");
    });
    const goodInitial = vi.fn();
    const ctrl5 = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
      onError,
    } as unknown as never);
    // subscribing badInitial should not throw outward
    expect(() => ctrl5.subscribe(badInitial)).not.toThrow();
    expect(() => ctrl5.subscribe(goodInitial)).not.toThrow();
    expect(goodInitial).toHaveBeenCalled();
    void unsubThrowing;
    void unsubSecond;
    void unsub;
  });

  it("does not freeze caller-owned objects and does not expose mutable nested aliases", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const original = makeResult("hash1");
    const originalIntent = original.file.intent;
    const originalSpans = original.file.solvedSpans;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(original, id);
    const state = ctrl.getState();
    // caller result object not frozen by controller (file is frozen by createCoasterFileV1 as expected)
    expect(Object.isFrozen(original)).toBe(false);
    expect(state.result!.file).not.toBe(original.file);
    // owned copies frozen, not same reference (no alias exposure)
    expect(state.result!.file.intent).not.toBe(originalIntent);
    expect(state.result!.file.solvedSpans).not.toBe(originalSpans);
    expect(Object.isFrozen(state.result!.file)).toBe(true);
    // diagnostics/hashes not shared mutable
    const diag = state.result!.diagnostics;
    expect(Object.isFrozen(diag)).toBe(true);
    // mutate returned diagnostics should not affect next state (copy)
    const before = state.result!.diagnostics.length;
    try {
      (state.result!.diagnostics as unknown as string[]).push({} as never);
    } catch {}
    expect(ctrl.getState().result!.diagnostics.length).toBe(before);
    // clearance typed array not duplicated unnecessarily but ownership transferred: original clearance not frozen, owned is new copy
    const clearance = new Float64Array([1, 2]);
    const withClearance = {
      ...makeResult("hash2"),
      clearanceM: clearance,
    } as AuthoritativeExperienceResult;
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    ctrl.setResult(withClearance, id2);
    expect(ctrl.getState().result!.clearanceM).not.toBe(clearance);
    expect(ctrl.getState().result!.clearanceM![0]).toBe(1);
    clearance[0] = 99;
    expect(ctrl.getState().result!.clearanceM![0]).toBe(1);
    // timeline selection not exposed mutable
    ctrl.selectTimelineIndex(0);
    const sel1 = ctrl.getState().timelineSelection!;
    try {
      (sel1 as unknown as Record<string, unknown>).index = 999;
    } catch {}
    expect(ctrl.getState().timelineSelection!.index).toBe(0);
  });

  it("mutating caller intent/gates/targets/constraints/pins/coefficients/diagnostics after setResult does not affect controller", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const original = makeResult("hash1");
    // Create diagnostic with nested mutable fields
    const diag = {
      code: "TEST",
      severity: "info" as const,
      message: "original",
      location: {
        s: 1,
        position: [1, 2, 3] as unknown as [number, number, number],
      },
      relatedIds: ["a", "b"],
      actual: 1,
      limit: 2,
      margin: 1,
    } as unknown as Diagnostic;
    const withDiag = {
      ...original,
      diagnostics: [diag],
    } as AuthoritativeExperienceResult;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(withDiag, id);
    const beforeIntentId = ctrl.getState().result!.file.intent.elements[0]!.id;
    const beforeDiagMessage = ctrl.getState().result!.diagnostics[0]!.message;
    // Mutate caller objects – tolerate frozen fixtures (generateCoaster deeply freezes)
    try {
      (
        original.file.intent.elements[0] as unknown as Record<string, unknown>
      ).id = "mutated";
    } catch {}
    try {
      (
        original.file.intent.elements[0] as unknown as Record<string, unknown>
      ).parameters = { mutated: true };
    } catch {}
    try {
      (original.file.intent.gates as unknown as unknown[]).push({
        id: "evil",
        position: [0, 0, 0],
      } as never);
    } catch {}
    try {
      (original.file.intent.targets as unknown as unknown[]).push({
        id: "evil",
        kind: "end-y",
        target: 999,
        hard: true,
      } as never);
    } catch {}
    try {
      (original.file.intent.constraints as unknown as unknown[]).push({
        id: "evil",
        kind: "x",
        hard: true,
      } as never);
    } catch {}
    try {
      (original.file.intent.pinnedElementIds as unknown as unknown[]).push(
        "evil",
      );
    } catch {}
    try {
      (
        original.file.solvedSpans[0] as unknown as Record<string, unknown>
      ).positionCoefficients = [[999]] as never;
    } catch {}
    try {
      (diag as unknown as Record<string, unknown>).message = "mutated";
    } catch {}
    try {
      (
        (diag.location as unknown as Record<string, unknown>)
          .position as unknown as number[]
      )[0] = 999;
    } catch {}
    try {
      (diag.relatedIds as unknown as string[]).push("evil");
    } catch {}
    // Verify controller state unchanged
    expect(ctrl.getState().result!.file.intent.elements[0]!.id).toBe(
      beforeIntentId,
    );
    expect(ctrl.getState().result!.diagnostics[0]!.message).toBe(
      beforeDiagMessage,
    );
    expect(ctrl.getState().result!.diagnostics[0]!.location!.position![0]).toBe(
      1,
    );
    expect(ctrl.getState().result!.diagnostics[0]!.relatedIds).not.toContain(
      "evil",
    );
    // Caller result object remains unfrozen (file/intent are frozen by createCoasterFileV1 as expected, but not by controller)
    expect(Object.isFrozen(original)).toBe(false);
    expect(ctrl.getState().result!.file).not.toBe(original.file);
    // Prove track/timeline getters are immutable/copying – mutating returned arrays does not affect controller
    const trackPositions = ctrl.getState().result!.track.positions;
    const originalFirst = trackPositions[0];
    trackPositions[0] = 9999;
    expect(ctrl.getState().result!.track.positions[0]).toBe(originalFirst);
    const timelineDistances = ctrl.getState().result!.timeline.headDistanceM;
    const origDist = timelineDistances[0];
    timelineDistances[0] = 9999;
    expect(ctrl.getState().result!.timeline.headDistanceM[0]).toBe(origDist);
  });

  it("compile-load remains generating until authoritative result, no misleading success", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const loadId = ctrl.requestLoad(new File([""], "test.json"));
    expect(ctrl.getState().status).toBe("generating");
    // resolveCompileLoad validates syntax only; invalid goes to error, not ready
    ctrl.resolveCompileLoad(JSON.stringify({ invalid: true }), loadId);
    expect(ctrl.getState().status).toBe("error");
    // new load returns to generating
    const newLoadId = ctrl.requestLoad(new File([""], "test2.json"));
    expect(ctrl.getState().status).toBe("generating");
    ctrl.setResult(makeResult("loaded"), newLoadId);
    expect(ctrl.getState().status).toBe("ready");
    // stale resolve should be ignored (no transition, stays ready)
    ctrl.resolveCompileLoad("{}", loadId); // stale
    expect(ctrl.getState().requestId).toBe(newLoadId);
    expect(ctrl.getState().status).toBe("ready");
  });
  it("rejects enumerable-design and bad-checksum and never becomes ready", () => {
    const ctrl = createExperienceController({
      onGenerate: () => {},
      onLocalRegenerate: () => {},
      onCompileLoad: () => {},
    });
    const valid = makeFile("station-000");
    // Create bad file with enumerable design and bad checksum
    const bad = {
      ...valid,
      design: { elements: [{ id: "evil", type: "station", kind: "station" }] },
      compiledDataChecksum: "badbadba",
    } as unknown as CoasterFileV1;
    // Ensure design is enumerable (Object.keys will include it)
    expect(Object.keys(bad as unknown as Record<string, unknown>)).toContain(
      "design",
    );
    const badResult = {
      file: bad,
      track: makeTrack(),
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "x" },
    } as unknown as AuthoritativeExperienceResult;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    expect(ctrl.setResult(badResult, id)).toBe(false);
    expect(ctrl.getState().status).not.toBe("ready");
    expect(ctrl.getState().status).toBe("error");
    // Valid file should succeed – use matching track for valid file
    const validTrack = compileCoasterFile(valid).track;
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    expect(
      ctrl.setResult({ ...badResult, file: valid, track: validTrack }, id2),
    ).toBe(true);
    expect(ctrl.getState().status).toBe("ready");
  });
  it("edit then pin then localRegenerate payload is canonical, preserves coefficients/checksum, and exposes intent", () => {
    const onLocal = vi.fn();
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: onLocal,
      onCompileLoad: vi.fn(),
    });
    const baseFile = makeFile("station-000");
    const baseTrack = compileCoasterFile(baseFile).track;
    const baseResult = {
      file: baseFile,
      track: baseTrack,
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "hash-a", b: "hash-b" },
    } as unknown as AuthoritativeExperienceResult;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(baseResult, id);
    expect(ctrl.editElementParameter("station-000", "length", 99)).toBe(true);
    const twoFile = (() => {
      const intent = createDesignIntentV1({
        generatorVersion: "test",
        seed: 7,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [
          { id: "station-000", kind: "station", type: "station" },
          { id: "stall-001", kind: "stall", type: "stall" },
        ],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      });
      return generateCoaster(intent, { name: "test2" }).file;
    })();
    const twoTrack = compileCoasterFile(twoFile).track;
    const twoResult = {
      file: twoFile,
      track: twoTrack,
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "hash-a", b: "hash-b" },
    } as unknown as AuthoritativeExperienceResult;
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    ctrl.setResult(twoResult, id2);
    ctrl.selectElement("station-000");
    expect(ctrl.editElementParameter("station-000", "length", 123)).toBe(true);
    expect(ctrl.togglePin("stall-001")).toBe(true);
    const draft = ctrl.getState().draftFile!;
    expect(
      Object.keys(draft as unknown as Record<string, unknown>),
    ).not.toContain("design");
    expect(Object.keys(draft)).not.toContain("design");
    expect((draft as unknown as Record<string, unknown>).design).toBeDefined();
    const editedIntent = draft.intent;
    const editedEl = editedIntent.elements.find((e) => e.id === "station-000")!;
    expect((editedEl.parameters as Record<string, unknown>).length).toBe(123);
    expect(editedIntent.pinnedElementIds).toEqual(["stall-001"]);
    expect(draft.solvedSpans[0]!.positionCoefficients).not.toBe(
      twoFile.solvedSpans[0]!.positionCoefficients,
    );
    expect(JSON.stringify(draft.solvedSpans[0]!.positionCoefficients)).toBe(
      JSON.stringify(twoFile.solvedSpans[0]!.positionCoefficients),
    );
    expect(draft.compiledDataChecksum).toBe(twoFile.compiledDataChecksum);
    ctrl.selectElement("station-000");
    ctrl.requestLocalRegenerate();
    expect(onLocal).toHaveBeenCalled();
    const payloadFile = (
      onLocal.mock.calls[0]![0] as unknown as { file: CoasterFileV1 }
    ).file;
    expect(
      Object.keys(payloadFile as unknown as Record<string, unknown>),
    ).not.toContain("design");
    const serialized = serializeCoasterFileV1(payloadFile);
    const parsed = deserializeCoasterFileV1(serialized);
    expect(
      parsed.intent.elements.find((e) => e.id === "station-000")!.parameters,
    ).toHaveProperty("length", 123);
    expect(parsed.intent.pinnedElementIds).toEqual(["stall-001"]);
    expect(() => serializeCoasterFileV1(payloadFile)).not.toThrow();
    expect(() =>
      deserializeCoasterFileV1(serializeCoasterFileV1(payloadFile)),
    ).not.toThrow();
    const beforeParams = JSON.stringify(
      twoFile.intent.elements.find((e) => e.id === "station-000")!.parameters,
    );
    expect(ctrl.editElementParameter("station-000", "length", Number.NaN)).toBe(
      false,
    );
    expect(
      ctrl.editElementParameter(
        "station-000",
        "length",
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(false);
    expect(
      JSON.stringify(
        twoFile.intent.elements.find((e) => e.id === "station-000")!.parameters,
      ),
    ).toBe(beforeParams);
    expect(
      ctrl
        .getState()
        .draftFile!.intent.elements.find((e) => e.id === "station-000")!
        .parameters,
    ).toHaveProperty("length", 123);
  });
  it("selecting and local-regenerating works from canonical intent without relying on design", () => {
    const ctrl = createExperienceController({
      onGenerate: () => {},
      onLocalRegenerate: () => {},
      onCompileLoad: () => {},
    });
    const baseFile = makeFile("station-000");
    const baseTrack = compileCoasterFile(baseFile).track;
    const baseResult = {
      file: baseFile,
      track: baseTrack,
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "hash-a" },
    } as unknown as AuthoritativeExperienceResult;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(baseResult, id);
    expect(ctrl.selectElement("station-000")).toBe(true);
    expect(ctrl.getState().selectedElementId).toBe("station-000");
    const onLocal = vi.fn();
    const ctrl2 = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: onLocal,
      onCompileLoad: vi.fn(),
    });
    const id2 = ctrl2.requestGenerate({ mode: "insta", seed: 2 });
    ctrl2.setResult(baseResult, id2);
    ctrl2.selectElement("station-000");
    const regId = ctrl2.requestLocalRegenerate();
    expect(regId).not.toBeNull();
    expect(onLocal).toHaveBeenCalled();
    const payload = (
      onLocal.mock.calls[0]![0] as unknown as { file: CoasterFileV1 }
    ).file;
    expect(payload.intent.elements.some((e) => e.id === "station-000")).toBe(
      true,
    );
  });

  it("mutating nested coefficient arrays from edited/pinned draft cannot mutate accepted result", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const baseFile = makeFile("station-000");
    const baseTrack = compileCoasterFile(baseFile).track;
    const baseResult = {
      file: baseFile,
      track: baseTrack,
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "hash-a" },
    } as unknown as AuthoritativeExperienceResult;
    const id = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    ctrl.setResult(baseResult, id);
    const beforeCoeff =
      ctrl.getState().result!.file.solvedSpans[0]!.positionCoefficients[0]![0];
    ctrl.selectElement("station-000");
    ctrl.editElementParameter("station-000", "length", 99);
    const draft1 = ctrl.getState().draftFile!;
    (
      draft1.solvedSpans[0] as unknown as { positionCoefficients: number[][] }
    ).positionCoefficients[0]![0] = 9999;
    (
      draft1.solvedSpans[0] as unknown as { rollCoefficients: number[] }
    ).rollCoefficients[0] = 9999;
    expect(
      ctrl.getState().result!.file.solvedSpans[0]!.positionCoefficients[0]![0],
    ).toBe(beforeCoeff);
    expect(
      ctrl.getState().result!.file.solvedSpans[0]!.positionCoefficients[0]![0],
    ).not.toBe(9999);
    const draftBefore =
      ctrl.getState().draftFile!.solvedSpans[0]!.positionCoefficients[0]![0];
    (
      ctrl.getState().result!.file.solvedSpans[0] as unknown as {
        positionCoefficients: number[][];
      }
    ).positionCoefficients[0]![0] = 8888;
    expect(
      ctrl.getState().draftFile!.solvedSpans[0]!.positionCoefficients[0]![0],
    ).toBe(draftBefore);
  });

  it("bad file checksum and file/track checksum disagreement are both rejected by setResult, preserve last-good", () => {
    const ctrl = createExperienceController({
      onGenerate: vi.fn(),
      onLocalRegenerate: vi.fn(),
      onCompileLoad: vi.fn(),
    });
    const goodFile = makeFile("station-000");
    const goodTrack = compileCoasterFile(goodFile).track;
    const goodResult = {
      file: goodFile,
      track: goodTrack,
      timeline: new RideTimeline({
        sampleRateHz: 10,
        timeSeconds: new Float64Array([0, 1]),
        headDistanceM: new Float64Array([0, 10]),
        speedMps: new Float64Array([5, 6]),
      }),
      diagnostics: [],
      spanHashes: { a: "hash-a" },
    } as unknown as AuthoritativeExperienceResult;
    const id1 = ctrl.requestGenerate({ mode: "insta", seed: 1 });
    expect(ctrl.setResult(goodResult, id1)).toBe(true);
    expect(ctrl.getState().status).toBe("ready");
    const lastGood = ctrl.getState().result;
    const badFile = {
      ...goodFile,
      compiledDataChecksum: "00000000",
    } as unknown as CoasterFileV1;
    const badResult = {
      ...goodResult,
      file: badFile,
    } as unknown as AuthoritativeExperienceResult;
    const id2 = ctrl.requestGenerate({ mode: "insta", seed: 2 });
    expect(ctrl.setResult(badResult, id2)).toBe(false);
    expect(ctrl.getState().status).toBe("error");
    expect(ctrl.getState().result).toBe(lastGood);
    expect(ctrl.getState().result!.file.compiledDataChecksum).toBe(
      goodFile.compiledDataChecksum,
    );
    const otherTrack = compileTrack([
      {
        id: "a",
        span: new SeventhOrderHermiteSpan({
          p0: vec3(0, 0, 0),
          d10: vec3(2, 0, 0),
          d20: vec3(0, 0, 0),
          d30: vec3(0, 0, 0),
          p1: vec3(20, 0, 0),
          d11: vec3(2, 0, 0),
          d21: vec3(0, 0, 0),
          d31: vec3(0, 0, 0),
        }),
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
    const mismatchResult = {
      ...goodResult,
      track: otherTrack,
    } as unknown as AuthoritativeExperienceResult;
    const id3 = ctrl.requestGenerate({ mode: "insta", seed: 3 });
    expect(ctrl.setResult(mismatchResult, id3)).toBe(false);
    expect(ctrl.getState().status).toBe("error");
    expect(ctrl.getState().result).toBe(lastGood);
  });
});
