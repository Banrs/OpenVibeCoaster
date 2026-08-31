import { describe, it, expect } from "vitest";
import {
  compileCoasterFile,
  createCoasterFileV1,
  createDesignIntentV1,
} from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  preparePinnedRegeneration,
  restorePinnedFileAfterRegeneration,
} from "./pinnedRegeneration.js";
import { RideTimeline } from "@openvibecoaster/simulator";

function makeInstaResult() {
  const intent = createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    terrainProfileId: "rolling-highlands-v1",
    pinnedElementIds: [],
  });
  const gen = generateCoaster(intent, { name: "pin-test" });
  const track = compileCoasterFile(gen.file).track;
  const timeline = new RideTimeline({
    sampleRateHz: 10,
    timeSeconds: new Float64Array([0, 1]),
    headDistanceM: new Float64Array([0, 10]),
    speedMps: new Float64Array([5, 5]),
  });
  return {
    file: gen.file,
    track,
    timeline,
    diagnostics: [],
    spanHashes: { dummy: "abc" },
  };
}

function makePinnedFile(
  baseFile: ReturnType<typeof makeInstaResult>["file"],
  pinnedIds: string[],
) {
  const intent = createDesignIntentV1({
    ...baseFile.intent,
    pinnedElementIds: [...pinnedIds],
  });
  return createCoasterFileV1({
    name: baseFile.name,
    intent,
    solvedSpans: [...baseFile.solvedSpans],
    seed: baseFile.seed,
    generatorVersion: baseFile.generatorVersion,
    profileVersion: baseFile.profileVersion,
    researchSnapshotIds: [...baseFile.researchSnapshotIds],
    compiledDataChecksum: baseFile.compiledDataChecksum,
  });
}

function makeEditedFile(
  baseFile: ReturnType<typeof makeInstaResult>["file"],
  targetId: string,
  newLength: number,
) {
  const baseEl = baseFile.intent.elements.find((e) => e.id === targetId);
  if (!baseEl) throw new Error("target not found");
  const newParams = { ...baseEl.parameters, length: newLength };
  const newElements = baseFile.intent.elements.map((e) =>
    e.id === targetId ? { ...e, parameters: newParams } : e,
  );
  const intent = createDesignIntentV1({
    ...baseFile.intent,
    elements: newElements,
  });
  return createCoasterFileV1({
    name: baseFile.name,
    intent,
    solvedSpans: [...baseFile.solvedSpans],
    seed: baseFile.seed,
    generatorVersion: baseFile.generatorVersion,
    profileVersion: baseFile.profileVersion,
    researchSnapshotIds: [...baseFile.researchSnapshotIds],
    compiledDataChecksum: baseFile.compiledDataChecksum,
  });
}

describe("pinnedRegeneration helper", () => {
  it("no pinned changes: fallback to nearest unpinned for pinned selection", () => {
    const base = makeInstaResult();
    const file = base.file;
    const firstId = file.intent.elements[0]!.id;
    const draftFile = makePinnedFile(file, [firstId]);
    const baseResult = { ...base, file };
    const request = {
      file: draftFile,
      selectedElementId: firstId,
      baseResult,
    };
    const res = preparePinnedRegeneration(request);
    expect(res.kind).toBe("proceed");
    if (res.kind === "proceed") {
      expect(res.targetId).not.toBe(firstId);
      expect(res.restoreId).toBeNull();
      expect(res.workerFile.intent.pinnedElementIds).toContain(firstId);
    }
  });

  it("exactly selected pinned element changed: override preparation", () => {
    const base = makeInstaResult();
    const file = base.file;
    const firstId = file.intent.elements[0]!.id;
    const draftPinnedFile = makePinnedFile(file, [firstId]);
    const draftFile = makeEditedFile(draftPinnedFile, firstId, 999);
    const baseResult = { ...base, file };
    const request = {
      file: draftFile,
      selectedElementId: firstId,
      baseResult,
    };
    const res = preparePinnedRegeneration(request);
    expect(res.kind).toBe("proceed");
    if (res.kind === "proceed") {
      expect(res.targetId).toBe(firstId);
      expect(res.restoreId).toBe(firstId);
      expect(res.workerFile.intent.pinnedElementIds).not.toContain(firstId);
      expect(res.originalPinnedIds).toContain(firstId);
      const restored = restorePinnedFileAfterRegeneration(
        res.workerFile,
        res.restoreId,
        res.originalPinnedIds,
      );
      expect(restored.intent.pinnedElementIds).toContain(firstId);
      expect(restored.solvedSpans).toEqual(res.workerFile.solvedSpans);
      expect(restored.compiledDataChecksum).toBe(
        res.workerFile.compiledDataChecksum,
      );
      expect(() => compileCoasterFile(restored)).not.toThrow();
    }
  });

  it("remotely changed pinned element: fatal", () => {
    const base = makeInstaResult();
    const file = base.file;
    const ids = file.intent.elements.slice(0, 2).map((e) => e.id);
    const firstId = ids[0]!;
    const secondId = ids[1]!;
    const draftPinnedFile = makePinnedFile(file, [firstId, secondId]);
    const draftFile = makeEditedFile(draftPinnedFile, secondId, 888);
    const baseResult = { ...base, file };
    const request = {
      file: draftFile,
      selectedElementId: firstId,
      baseResult,
    };
    const res = preparePinnedRegeneration(request);
    expect(res.kind).toBe("fatal");
    if (res.kind === "fatal") {
      expect(res.diagnostic.code).toBe("LOCAL_REGENERATION");
      expect(res.diagnostic.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
      expect(res.diagnostic.relatedIds).toContain(secondId);
    }
  });

  it("preserves pin set and checksum after restoration", () => {
    const base = makeInstaResult();
    const file = base.file;
    const firstId = file.intent.elements[0]!.id;
    const draftPinnedFile = makePinnedFile(file, [firstId]);
    const draftFile = makeEditedFile(draftPinnedFile, firstId, 777);
    const baseResult = { ...base, file };
    const request = {
      file: draftFile,
      selectedElementId: firstId,
      baseResult,
    };
    const prep = preparePinnedRegeneration(request);
    expect(prep.kind).toBe("proceed");
    if (prep.kind === "proceed" && prep.restoreId) {
      const restored = restorePinnedFileAfterRegeneration(
        prep.workerFile,
        prep.restoreId,
        prep.originalPinnedIds,
      );
      expect(restored.intent.pinnedElementIds).toEqual(
        draftFile.intent.pinnedElementIds,
      );
      expect(restored.compiledDataChecksum).toBe(
        prep.workerFile.compiledDataChecksum,
      );
      expect(() => compileCoasterFile(restored)).not.toThrow();
    }
  });
});
