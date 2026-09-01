import { beforeAll, describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createDesignIntentV1,
  parseEngineeringLimitsProfile,
} from "@openvibecoaster/core";
import {
  generateCoaster,
  regenerateCoasterFileLocal,
  regenerateLocal,
} from "./pipeline";
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
      parameters: { length: 12, bank: 0, closed: false },
    },
    {
      id: "stall-1",
      kind: "stall",
      type: "stall",
      parameters: { length: 32, height: 18, bank: 0 },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("default bundled provenance ids", () => {
  let defaultResult: ReturnType<typeof generateCoaster>;

  beforeAll(() => {
    defaultResult = generateCoaster(baseIntent);
  });

  it("embeds bundled defaults when no explicit provenance is supplied", () => {
    expect(defaultResult.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(defaultResult.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    expect(Object.isFrozen(defaultResult.file.researchSnapshotIds)).toBe(true);
    expect(defaultResult.serializedFile).toContain(
      "project-engineering-limits-v1",
    );
    expect(defaultResult.serializedFile).toContain("records-2026-08-29");
    expect(defaultResult.options.profileVersion).toBeUndefined();
    expect(defaultResult.options.researchSnapshotIds).toBeUndefined();
  });

  it("round-trips defaults through compileCoasterFile serialization", () => {
    const loaded = compileCoasterFile(defaultResult.serializedFile);
    expect(loaded.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(loaded.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
    const reserialized = compileCoasterFile(loaded.file);
    expect(reserialized.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(reserialized.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    expect(reserialized.track.checksum).toBe(
      defaultResult.file.compiledDataChecksum,
    );
  });

  it("preserves defaults through local regeneration entry points", () => {
    const local = regenerateLocal(defaultResult, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.generation.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(local.generation.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    expect(
      compileCoasterFile(local.generation.serializedFile).file.profileVersion,
    ).toBe("project-engineering-limits-v1");
    expect(
      compileCoasterFile(local.generation.serializedFile).file
        .researchSnapshotIds,
    ).toEqual(["records-2026-08-29"]);

    const fileLocal = regenerateCoasterFileLocal(
      defaultResult.file,
      "stall-1",
      {
        seams: testSeams,
        referenceSpeed: 44,
      },
    );
    expect(fileLocal.generation.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(fileLocal.generation.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    expect(
      compileCoasterFile(fileLocal.generation.serializedFile).file
        .profileVersion,
    ).toBe("project-engineering-limits-v1");
    expect(
      compileCoasterFile(fileLocal.generation.serializedFile).file
        .researchSnapshotIds,
    ).toEqual(["records-2026-08-29"]);
  });

  it("allows explicit caller provenance to override defaults immutably", () => {
    const callerIds = ["custom-snapshot"];
    const result = generateCoaster(baseIntent, {
      profileVersion: "custom-profile-v9",
      researchSnapshotIds: callerIds,
    });
    expect(result.file.profileVersion).toBe("custom-profile-v9");
    expect(result.file.researchSnapshotIds).toEqual(["custom-snapshot"]);
    expect(result.options.profileVersion).toBe("custom-profile-v9");
    expect(result.options.researchSnapshotIds).toEqual(["custom-snapshot"]);
    expect(result.options.researchSnapshotIds).not.toBe(callerIds);
    expect(Object.isFrozen(result.options.researchSnapshotIds)).toBe(true);
    callerIds.push("mutated");
    expect(result.file.researchSnapshotIds).toEqual(["custom-snapshot"]);
    expect(result.options.researchSnapshotIds).toEqual(["custom-snapshot"]);

    const local = regenerateLocal(result, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.generation.file.profileVersion).toBe("custom-profile-v9");
    expect(local.generation.file.researchSnapshotIds).toEqual([
      "custom-snapshot",
    ]);
    const fileLocal = regenerateCoasterFileLocal(result.file, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(fileLocal.generation.file.profileVersion).toBe(
      "custom-profile-v9",
    );
    expect(fileLocal.generation.file.researchSnapshotIds).toEqual([
      "custom-snapshot",
    ]);
  });

  it("allows explicit empty provenance to override defaults with empty array", () => {
    const result = generateCoaster(baseIntent, {
      researchSnapshotIds: [],
    });
    expect(result.file.researchSnapshotIds).toEqual([]);
    expect(Object.isFrozen(result.file.researchSnapshotIds)).toBe(true);
    expect(result.options.researchSnapshotIds).toEqual([]);
    expect(Object.isFrozen(result.options.researchSnapshotIds)).toBe(true);
    expect(result.serializedFile).not.toContain("records-2026-08-29");
    const loaded = compileCoasterFile(result.serializedFile);
    expect(loaded.file.researchSnapshotIds).toEqual([]);
  });
});
