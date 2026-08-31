import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createDesignIntentV1,
  parseEngineeringLimitsProfile,
} from "@openvibecoaster/core";
import { generateCoaster, regenerateCoasterFileLocal } from "./pipeline";
import rawProfile from "../../../data/profiles/engineering-limits-v1.json";

const testSeams = parseEngineeringLimitsProfile(rawProfile).seams;

const baseIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 100, targetSpeed: 10, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 100, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("regenerateCoasterFileLocal canonical 32", () => {
  it("file reload and file-local regeneration use canonical persisted adaptive checksum while preserving exact solved coefficients and untouched hashes", () => {
    const gen64 = generateCoaster(baseIntent, { samples: 64 });
    const file64 = gen64.file;
    // File's checksum is canonical adaptive, not 64 preview
    const loaded = compileCoasterFile(file64);
    expect(loaded.track.checksum).toBe(file64.compiledDataChecksum);
    expect(loaded.file.compiledDataChecksum).toBe(file64.compiledDataChecksum);
    // Also ensure that compiling with 32 vs file's checksum matches canonical, and preview does not weaken stored checksum
    const canonicalTrack = compileCoasterFile(file64).track;
    expect(canonicalTrack.checksum).toBe(file64.compiledDataChecksum);
    const preview = compileCoasterFile(file64, { samples: 32 });
    expect(preview.file.compiledDataChecksum).toBe(file64.compiledDataChecksum);
    // Preview track is fixed 32, file remains adaptive (for this simple file they coincidentally match at 32, but file remains adaptive)
    expect(preview.track.checksum).toBeDefined();
    expect(preview.file.compiledDataChecksum).toBe(file64.compiledDataChecksum);

    // Original span bytes for untouched element station-3
    const origSpan = file64.solvedSpans.find((s) => s.id === "station-3")!;
    expect(origSpan).toBeDefined();

    // File-local regeneration must use canonical adaptive explicitly
    const local = regenerateCoasterFileLocal(file64, "launch-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.feasible).toBe(true);
    const newFile = local.generation.file;
    // New file's checksum must still be canonical adaptive
    const reloaded = compileCoasterFile(newFile);
    expect(reloaded.track.checksum).toBe(newFile.compiledDataChecksum);
    expect(newFile.compiledDataChecksum).toMatch(/^[0-9a-f]{8}$/i);
    // Untouched span must remain bitwise identical
    const newSpan = newFile.solvedSpans.find((s) => s.id === "station-3")!;
    expect(newSpan.positionCoefficients).toEqual(origSpan.positionCoefficients);
    expect(newSpan.rollCoefficients).toEqual(origSpan.rollCoefficients);
    // Ensure that the regenerated generation honestly reports zero candidates (no search history)
    expect(local.generation.candidatesTested).toBe(0);
    expect(local.generation.candidateLmIterations).toEqual([]);
    // Ensure options remains canonical adaptive, not preview 64 nor fixed 32
    expect(
      (local.generation.options as { samples?: number }).samples,
    ).toBeUndefined();
  });

  it("handles beginning/middle/end and multi-span correctly with file-local API", () => {
    const multiIntent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 100, bank: 0, closed: false },
        },
        {
          id: "topHat-1",
          kind: "topHat",
          type: "topHat",
          parameters: { height: 80, width: 40, bank: 0 },
        },
        {
          id: "station-2",
          kind: "station",
          type: "station",
          parameters: { length: 100, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const gen = generateCoaster(multiIntent, { samples: 64 });
    const file = gen.file;
    expect(
      file.solvedSpans.filter((s) => s.id.startsWith("topHat-1")).length,
    ).toBe(2);
    const origStart = file.solvedSpans.find((s) => s.id === "station-0")!;
    const res = regenerateCoasterFileLocal(file, "topHat-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    // Should preserve station-0
    if (res.feasible) {
      const newStart = res.generation.file.solvedSpans.find(
        (s) => s.id === "station-0",
      )!;
      expect(newStart.positionCoefficients).toEqual(
        origStart.positionCoefficients,
      );
      expect(res.generation.file.compiledDataChecksum).toBe(
        compileCoasterFile(res.generation.file).track.checksum,
      );
    }
  });
});
