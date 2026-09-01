import { describe, it, expect, beforeAll } from "vitest";
import {
  createDesignIntentV1,
  vec3,
  compileTrack,
  SeventhOrderHermiteSpan,
  type Diagnostic,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
} from "@openvibecoaster/generator";
import {
  handleGenerate,
  handleRegenerate,
  handleCompileSimulate,
} from "./worker";
import { collectTransferables } from "./transfer";
import { hydrateEngineeringSuccess } from "./hydrate";
import { validateEngineeringWorkerResponse } from "./protocol";

const baseIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 7,
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
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 30, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 30, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("worker clearanceM and diagnostics", () => {
  let handle1: ReturnType<typeof handleGenerate>;
  let regenResult: ReturnType<typeof handleRegenerate>;
  let compileResult: ReturnType<typeof handleCompileSimulate>;

  beforeAll(() => {
    const h = handleGenerate("req-gen-clear-1", baseIntent);
    if (h.type !== "success")
      throw new Error(
        `handleGenerate failed: ${JSON.stringify(h.diagnostics)}`,
      );
    handle1 = h;
    const r = handleRegenerate("req-reg-clear", handle1.file, "launch-1");
    if (r.type !== "success")
      throw new Error(
        `handleRegenerate failed: ${JSON.stringify(r.diagnostics)}`,
      );
    regenResult = r;
    const c = handleCompileSimulate("req-cs-clear", handle1.file);
    if (c.type !== "success")
      throw new Error(
        `handleCompileSimulate failed: ${JSON.stringify(c.diagnostics)}`,
      );
    compileResult = c;
  });

  it("generate returns required clearanceM diagnostics transfer hydration determinism", () => {
    expect(handle1.type).toBe("success");
    if (handle1.type !== "success") throw new Error("expected success");
    expect(handle1.clearanceM instanceof Float64Array).toBe(true);
    expect(handle1.clearanceM.length).toBe(handle1.timeline.length);
    for (let i = 0; i < handle1.clearanceM.length; i++)
      expect(Number.isFinite(handle1.clearanceM[i]!)).toBe(true);
    expect(() => validateEngineeringWorkerResponse(handle1)).not.toThrow();
    const transfers = collectTransferables(handle1);
    const clearanceBuf = handle1.clearanceM.buffer as ArrayBuffer;
    expect(transfers.includes(clearanceBuf)).toBe(true);
    expect(transfers.filter((b) => b === clearanceBuf).length).toBe(1);
    const hydrated = hydrateEngineeringSuccess(handle1);
    expect(hydrated.clearanceM instanceof Float64Array).toBe(true);
    expect(hydrated.clearanceM.length).toBe(handle1.clearanceM.length);
    expect(hydrated.clearanceM.buffer).not.toBe(handle1.clearanceM.buffer);
    expect(hydrated.clearanceM[0]).toBe(handle1.clearanceM[0]);
    // determinism via cheap compile-simulate twice on same file
    const c1 = handleCompileSimulate("req-cs-det-1", handle1.file);
    const c2 = handleCompileSimulate("req-cs-det-2", handle1.file);
    expect(c1.type).toBe("success");
    expect(c2.type).toBe("success");
    if (c1.type !== "success" || c2.type !== "success")
      throw new Error("expected success");
    expect(c1.clearanceM.length).toBe(c2.clearanceM.length);
    for (let i = 0; i < c1.clearanceM.length; i++)
      expect(c1.clearanceM[i]).toBe(c2.clearanceM[i]!);
    expect(c1.track.checksum).toBe(c2.track.checksum);
    for (const d of handle1.diagnostics) {
      expect(typeof d.code).toBe("string");
      expect(["info", "warning", "error", "fatal"]).toContain(d.severity);
      if (d.provenance)
        expect([
          "SOURCE_VERIFIED",
          "PROJECT_ENGINEERING_LIMIT",
          "DESIGN_ASSUMPTION",
          "UNKNOWN_UNCONFIGURED",
        ]).toContain(d.provenance);
    }
  });

  it("regenerate returns clearanceM with preservedDiagnostics", () => {
    expect(regenResult.type).toBe("success");
    if (regenResult.type !== "success") throw new Error("expected success");
    expect(regenResult.clearanceM instanceof Float64Array).toBe(true);
    expect(regenResult.clearanceM.length).toBe(regenResult.timeline.length);
    expect(() => validateEngineeringWorkerResponse(regenResult)).not.toThrow();
    const hydrated = hydrateEngineeringSuccess(regenResult);
    expect(hydrated.clearanceM.length).toBe(regenResult.clearanceM.length);
    expect(hydrated.clearanceM[0]).toBe(regenResult.clearanceM[0]);
    for (const d of regenResult.diagnostics) {
      expect(typeof d.code).toBe("string");
      expect(["info", "warning", "error", "fatal"]).toContain(d.severity);
    }
    const transfers = collectTransferables(regenResult);
    const buf = regenResult.clearanceM.buffer as ArrayBuffer;
    expect(transfers.includes(buf)).toBe(true);
    expect(transfers.filter((b) => b === buf).length).toBe(1);
  });

  it("compile-simulate returns clearanceM and projects diagnostics", () => {
    expect(compileResult.type).toBe("success");
    if (compileResult.type !== "success") throw new Error("expected success");
    expect(compileResult.clearanceM instanceof Float64Array).toBe(true);
    expect(compileResult.clearanceM.length).toBe(compileResult.timeline.length);
    expect(() =>
      validateEngineeringWorkerResponse(compileResult),
    ).not.toThrow();
    const hydrated = hydrateEngineeringSuccess(compileResult);
    expect(hydrated.clearanceM.length).toBe(compileResult.clearanceM.length);
  });

  it("diagnostics preservation/projection asserts code severity provenance relatedIds", () => {
    const railY = handle1.type === "success" ? handle1.track.positions[1]! : 2;
    const planeY = railY - 1.0;
    const planeEnv: import("@openvibecoaster/core").EnvironmentQuery = {
      signedDistance: (p) => p[1] - planeY,
      raycast: () => undefined,
    };
    const track = compileTrack(
      [
        {
          id: "seg-0",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
        },
        {
          id: "seg-1",
          span: SeventhOrderHermiteSpan.line(vec3(10, 0, 0), vec3(20, 0, 0)),
        },
      ],
      { samples: 2 },
    );
    const field = computeClearanceField(track, {
      environment: planeEnv,
      hardClearanceM: 0.5,
      explicitThresholds: [1.0],
      softThresholds: [1.0],
      displayCapM: 10,
      segmentIds: ["seg-0", "seg-1"],
    });
    const hardProj = projectClearanceDiagnostics(field, [
      { id: "hard-1", hard: true, threshold: 1.0 },
    ]);
    expect(hardProj.length).toBeGreaterThan(0);
    const hardDiag = hardProj.find((d: Diagnostic) =>
      d.relatedIds?.includes("hard-1"),
    );
    expect(hardDiag).toBeDefined();
    expect(hardDiag!.code).toBe("TERRAIN_CLEARANCE");
    expect(hardDiag!.severity).toBe("error");
    expect(hardDiag!.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(hardDiag!.relatedIds).toContain("hard-1");
    expect(hardDiag!.actual).toBeDefined();
    expect(hardDiag!.limit).toBe(1.0);
    const softProj = projectClearanceDiagnostics(field, [
      { id: "soft-1", hard: false, threshold: 1.0 },
    ]);
    const softDiag = softProj.find((d: Diagnostic) =>
      d.relatedIds?.includes("soft-1"),
    );
    expect(softDiag).toBeDefined();
    expect(softDiag!.code).toBe("TERRAIN_CLEARANCE");
    expect(softDiag!.severity).toBe("warning");
    expect(softDiag!.provenance).toBe("DESIGN_ASSUMPTION");
    expect(softDiag!.relatedIds).toContain("soft-1");
  });

  it("worker validates clearanceM length and finiteness", () => {
    expect(handle1.type).toBe("success");
    if (handle1.type !== "success") throw new Error("expected success");
    const badLength = {
      ...handle1,
      clearanceM: new Float64Array(handle1.clearanceM.length + 1),
    };
    expect(() => validateEngineeringWorkerResponse(badLength)).toThrow();
    const badFinite = {
      ...handle1,
      clearanceM: Float64Array.from(handle1.clearanceM, (v, i) =>
        i === 0 ? Number.NaN : v,
      ),
    };
    expect(() => validateEngineeringWorkerResponse(badFinite)).toThrow();
  });
});
