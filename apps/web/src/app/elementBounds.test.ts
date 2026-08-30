import { describe, it, expect } from "vitest";
import {
  createDesignIntentV1,
  compileCoasterFile,
} from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  getElementCompiledRange,
  getSemanticSeamIndices,
} from "./elementBounds.js";

function makeInstaFile() {
  const intent = createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed: 123,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    terrainProfileId: "rolling-highlands-v1",
    pinnedElementIds: [],
  });
  const gen = generateCoaster(intent, { name: "bounds-test" });
  return gen.file;
}

describe("getElementCompiledRange", () => {
  it("maps semantic id to first/last compiled boundary", () => {
    const file = makeInstaFile();
    const track = compileCoasterFile(file).track;
    const firstId = file.intent.elements[0]!.id;
    const range = getElementCompiledRange(firstId, file, track);
    expect(range).not.toBeNull();
    if (range) {
      expect(range.start).toBe(0);
      expect(range.end).toBeGreaterThan(range.start);
      expect(range.end).toBeLessThan(track.distances.length);
    }
  });

  it("handles id# child spans", () => {
    const file = makeInstaFile();
    const track = compileCoasterFile(file).track;
    // Find an element that has multiple solved spans (if any) – otherwise test single mapping still passes
    // Use first element and verify range covers at least one span
    for (const el of file.intent.elements) {
      const spanCount = file.solvedSpans.filter(
        (s) => s.id === el.id || s.id.startsWith(`${el.id}#`),
      ).length;
      const range = getElementCompiledRange(el.id, file, track);
      expect(spanCount).toBeGreaterThan(0);
      expect(range).not.toBeNull();
    }
  });

  it("returns null for unknown id", () => {
    const file = makeInstaFile();
    const track = compileCoasterFile(file).track;
    expect(getElementCompiledRange("nonexistent-id", file, track)).toBeNull();
  });
});

describe("getSemanticSeamIndices", () => {
  it("has semantic count elements.length - 1 for Insta", () => {
    const file = makeInstaFile();
    const track = compileCoasterFile(file).track;
    const seams = getSemanticSeamIndices(file, track);
    expect(seams.length).toBe(file.intent.elements.length - 1);
    expect(seams.length).toBe(10);
  });

  it("indices are canonical, in-range, unique, sorted, exclude outer endpoints", () => {
    const file = makeInstaFile();
    const track = compileCoasterFile(file).track;
    const seams = getSemanticSeamIndices(file, track);
    const canonical = new Set(Array.from(track.elementBoundaries));
    const seen = new Set<number>();
    for (const idx of seams) {
      expect(canonical.has(idx)).toBe(true);
      expect(idx).toBeGreaterThan(0);
      expect(idx).toBeLessThan(track.distances.length - 1);
      expect(seen.has(idx)).toBe(false);
      seen.add(idx);
    }
    const sorted = [...seams].sort((a, b) => a - b);
    expect(seams).toEqual(sorted);
  });
});
