import { describe, it, expect } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
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
  it("generate returns required clearanceM diagnostics transfer hydration determinism", () => {
    const r1 = handleGenerate("req-gen-clear-1", baseIntent);
    expect(r1.type).toBe("success");
    if (r1.type !== "success") return;
    expect(r1.clearanceM instanceof Float64Array).toBe(true);
    expect(r1.clearanceM.length).toBe(r1.timeline.length);
    for (let i = 0; i < r1.clearanceM.length; i++)
      expect(Number.isFinite(r1.clearanceM[i]!)).toBe(true);
    expect(() => validateEngineeringWorkerResponse(r1)).not.toThrow();
    const transfers = collectTransferables(r1);
    const clearanceBuf = r1.clearanceM.buffer as ArrayBuffer;
    expect(transfers.includes(clearanceBuf)).toBe(true);
    expect(transfers.filter((b) => b === clearanceBuf).length).toBe(1);
    const hydrated = hydrateEngineeringSuccess(r1);
    expect(hydrated.clearanceM instanceof Float64Array).toBe(true);
    expect(hydrated.clearanceM.length).toBe(r1.clearanceM.length);
    expect(hydrated.clearanceM.buffer).not.toBe(r1.clearanceM.buffer);
    expect(hydrated.clearanceM[0]).toBe(r1.clearanceM[0]);
    const r2 = handleGenerate("req-gen-clear-2", baseIntent);
    if (r2.type !== "success") return;
    expect(r1.clearanceM.length).toBe(r2.clearanceM.length);
    for (let i = 0; i < r1.clearanceM.length; i++)
      expect(r1.clearanceM[i]).toBe(r2.clearanceM[i]!);
    expect(r1.track.checksum).toBe(r2.track.checksum);
  });

  it("regenerate returns clearanceM with preservedDiagnostics", () => {
    const gen = generateCoaster(baseIntent);
    const r = handleRegenerate("req-reg-clear", gen.file, "launch-1");
    expect(r.type).toBe("success");
    if (r.type !== "success") return;
    expect(r.clearanceM instanceof Float64Array).toBe(true);
    expect(r.clearanceM.length).toBe(r.timeline.length);
    expect(() => validateEngineeringWorkerResponse(r)).not.toThrow();
    const hydrated = hydrateEngineeringSuccess(r);
    expect(hydrated.clearanceM.length).toBe(r.clearanceM.length);
  });

  it("compile-simulate returns clearanceM and projects diagnostics", () => {
    const gen = generateCoaster(baseIntent);
    const r = handleCompileSimulate("req-cs-clear", gen.file);
    expect(r.type).toBe("success");
    if (r.type !== "success") return;
    expect(r.clearanceM instanceof Float64Array).toBe(true);
    expect(r.clearanceM.length).toBe(r.timeline.length);
    expect(() => validateEngineeringWorkerResponse(r)).not.toThrow();
    const hydrated = hydrateEngineeringSuccess(r);
    expect(hydrated.clearanceM.length).toBe(r.clearanceM.length);
  });

  it("worker validates clearanceM length and finiteness", () => {
    const r = handleGenerate("req-gen-clear-3", baseIntent);
    if (r.type !== "success") return;
    const badLength = {
      ...r,
      clearanceM: new Float64Array(r.clearanceM.length + 1),
    };
    expect(() => validateEngineeringWorkerResponse(badLength)).toThrow();
    const badFinite = {
      ...r,
      clearanceM: Float64Array.from(r.clearanceM, (v, i) =>
        i === 0 ? Number.NaN : v,
      ),
    };
    expect(() => validateEngineeringWorkerResponse(badFinite)).toThrow();
  });
});
