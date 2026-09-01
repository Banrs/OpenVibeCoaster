import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createDesignIntentV1,
  parseEngineeringLimitsProfile,
} from "@openvibecoaster/core";
import { generateCoaster, regenerateCoasterFileLocal, regenerateLocal } from "./pipeline";
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
  it("embeds bundled defaults when no explicit provenance is supplied", () => {
    const result = generateCoaster(baseIntent);
    expect(result.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(result.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
    expect(result.file.researchSnapshotIds).not.toBe(result.options.researchSnapshotIds);
    expect(result.options.profileVersion).toBeUndefined();
    expect(result.options.researchSnapshotIds).toBeUndefined();
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
  });

  it("round-trips defaults through compileCoasterFile serialization", () => {
    const result = generateCoaster(baseIntent);
    const serialized = result.serializedFile;
    const loaded = compileCoasterFile(serialized);
    expect(loaded.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(loaded.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
    const reserialized = compileCoasterFile(loaded.file);
    expect(reserialized.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(reserialized.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
    expect(reserialized.track.checksum).toBe(result.file.compiledDataChecksum);
  });

  it("preserves defaults through regenerateLocal", () => {
    const result = generateCoaster(baseIntent);
    const local = regenerateLocal(result, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.generation.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(local.generation.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    const loaded = compileCoasterFile(local.generation.serializedFile);
    expect(loaded.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(loaded.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
  });

  it("preserves defaults through regenerateCoasterFileLocal", () => {
    const result = generateCoaster(baseIntent);
    const local = regenerateCoasterFileLocal(result.file, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.generation.file.profileVersion).toBe(
      "project-engineering-limits-v1",
    );
    expect(local.generation.file.researchSnapshotIds).toEqual([
      "records-2026-08-29",
    ]);
    const loaded = compileCoasterFile(local.generation.serializedFile);
    expect(loaded.file.profileVersion).toBe("project-engineering-limits-v1");
    expect(loaded.file.researchSnapshotIds).toEqual(["records-2026-08-29"]);
  });

  it("preserves overridden ids through local regeneration", () => {
    const result = generateCoaster(baseIntent, {
      profileVersion: "owned-profile",
      researchSnapshotIds: ["owned-snapshot"],
    });
    const local = regenerateLocal(result, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(local.generation.file.profileVersion).toBe("owned-profile");
    expect(local.generation.file.researchSnapshotIds).toEqual(["owned-snapshot"]);
    const fileLocal = regenerateCoasterFileLocal(result.file, "stall-1", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    expect(fileLocal.generation.file.profileVersion).toBe("owned-profile");
    expect(fileLocal.generation.file.researchSnapshotIds).toEqual([
      "owned-snapshot",
    ]);
  });
});
