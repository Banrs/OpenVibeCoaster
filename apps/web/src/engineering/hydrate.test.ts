import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker";
import { hydrateEngineeringSuccess } from "./hydrate";
import { validateEngineeringWorkerResponse } from "./protocol";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 80, targetSpeed: 15, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 80, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("hydrateEngineeringSuccess", () => {
  it("proves checksum equality and constructs real CompiledTrackData and RideTimeline", () => {
    const success = handleGenerate("hydrate-1", validIntent as unknown);
    expect(success.type).toBe("success");
    if (success.type !== "success") return;
    const hydrated = hydrateEngineeringSuccess(success);
    expect(hydrated.track.checksum).toBe(success.track.checksum);
    expect(hydrated.file.compiledDataChecksum).toBe(success.track.checksum);
    expect(hydrated.timeline.length).toBe(success.timeline.length);
    expect(hydrated.spanHashes).toEqual(success.spanHashes);
  });

  it("ownership/non-aliasing – hydrated buffers are copies, not same reference", () => {
    const success = handleGenerate("hydrate-2", validIntent as unknown);
    if (success.type !== "success") return;
    const hydrated = hydrateEngineeringSuccess(success);
    // CompiledTrackData copies buffers, so modifying hydrated shouldn't affect original transfer
    const origPos = success.track.positions;
    const hydratedPos = hydrated.track.positions;
    expect(origPos).not.toBe(hydratedPos);
    expect(origPos[0]).toBe(hydratedPos[0]);
    // Mutate hydrated copy, original unchanged
    hydratedPos[0] = 999999;
    expect(success.track.positions[0]).not.toBe(999999);
    // Timeline buffers also not aliased: hydrated timeline's internal buffers are copies
    const origTimeBuf = success.timeline.buffers[0]!;
    const hydTime = hydrated.timeline.timeSeconds;
    expect(origTimeBuf).not.toBe(hydTime.buffer);
  });

  it("malformed rejection – strict validation fails", () => {
    const success = handleGenerate("hydrate-3", validIntent as unknown);
    if (success.type !== "success") return;
    const malformed = { ...success, spanHashes: { bad: "not-hex" } };
    expect(() => hydrateEngineeringSuccess(malformed)).toThrow();
    const missing = { ...success };
    // @ts-ignore delete spanHashes
    delete (missing as any).spanHashes;
    expect(() => hydrateEngineeringSuccess(missing)).toThrow();
    const extra = { ...success, extraField: 123 };
    expect(() => validateEngineeringWorkerResponse(extra)).toThrow();
  });

  it("deterministic output – same input yields identical hydrated track/timeline", () => {
    const a = handleGenerate("hydrate-det-a", validIntent as unknown);
    const b = handleGenerate("hydrate-det-b", validIntent as unknown);
    if (a.type !== "success" || b.type !== "success") return;
    const ha = hydrateEngineeringSuccess(a);
    const hb = hydrateEngineeringSuccess(b);
    expect(ha.track.checksum).toBe(hb.track.checksum);
    expect(ha.timeline.timeSeconds).toEqual(hb.timeline.timeSeconds);
    expect(ha.track.positions).toEqual(hb.track.positions);
  });

  it("no JSON round-trip of typed arrays – buffers remain Float64Array", () => {
    const success = handleGenerate("hydrate-typed", validIntent as unknown);
    if (success.type !== "success") return;
    expect(success.track.positions instanceof Float64Array).toBe(true);
    expect(success.timeline.buffers[0] instanceof ArrayBuffer).toBe(true);
    const hydrated = hydrateEngineeringSuccess(success);
    expect(hydrated.track.positions instanceof Float64Array).toBe(true);
    expect(hydrated.timeline.timeSeconds instanceof Float64Array).toBe(true);
  });
});
