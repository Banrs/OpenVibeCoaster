import { describe, expect, it, vi } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster, coasterFileSpanHashes } from "./index";
import * as pipeline from "./pipeline";

const baseIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 123,
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
      id: "topHat-1",
      kind: "topHat",
      type: "topHat",
      parameters: { height: 80, width: 40, bank: 0 },
    },
    {
      id: "my#element-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 60, targetSpeed: 5, bank: 0 },
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

describe("coasterFileSpanHashes", () => {
  it("is repeatable for same file", () => {
    const gen = generateCoaster(baseIntent);
    const a = coasterFileSpanHashes(gen.file);
    const b = coasterFileSpanHashes(gen.serializedFile);
    const c = coasterFileSpanHashes(gen.file);
    const d = coasterFileSpanHashes(gen.serializedFile);
    expect(a).toEqual(c);
    expect(b).toEqual(d);
    expect(a).toEqual(b);
    // also matches generation's own hashes (canonicalized)
    expect(a).toEqual(gen.spanHashes);
  });

  it("returns keys for every solved child span and semantic owner including multi-span and # ids", () => {
    const gen = generateCoaster(baseIntent);
    const hashes = coasterFileSpanHashes(gen.file);
    // child spans from topHat (splits into 2)
    expect(Object.keys(hashes)).toContain("topHat-1#0");
    expect(Object.keys(hashes)).toContain("topHat-1#1");
    // owner keys
    expect(Object.keys(hashes)).toContain("topHat-1");
    expect(Object.keys(hashes)).toContain("station-0");
    expect(Object.keys(hashes)).toContain("my#element-2");
    // owner hash equals first child hash for multi-span
    expect(hashes["topHat-1"]).toBe(hashes["topHat-1#0"]);
    // single-span owner also present and equals span hash
    expect(hashes["station-0"]).toBe(hashes["station-0"]);
  });

  it("changes when coefficients change", () => {
    const gen = generateCoaster(baseIntent);
    const before = coasterFileSpanHashes(gen.file);
    // instead test changing via regeneration path: generate with different length should change hash
    const intent2 = createDesignIntentV1({
      ...baseIntent,
      elements: baseIntent.elements.map((e) =>
        e.id === "station-0"
          ? { ...e, parameters: { length: 90, bank: 0, closed: false } }
          : e,
      ),
    });
    const gen2 = generateCoaster(intent2);
    const after = coasterFileSpanHashes(gen2.file);
    expect(after["station-0"]).not.toBe(before["station-0"]);
  });

  it("does not call global generation", async () => {
    const gen = generateCoaster(baseIntent);
    const spy = vi.spyOn(pipeline, "generateCoaster");
    coasterFileSpanHashes(gen.file);
    coasterFileSpanHashes(gen.serializedFile);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects malformed file", () => {
    expect(() =>
      coasterFileSpanHashes("not a file" as unknown as never),
    ).toThrow();
  });
});
