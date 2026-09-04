import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createDesignIntentV1,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
} from "@openvibecoaster/core";
import { generateCoaster, recordHybridDefaultElements } from "./pipeline.js";

export const RECORD_HYBRID_IDS = [
  "station-000",
  "launch-001",
  "transition-002",
  "airtimeHill-003",
  "overbankedTurn-004",
  "overbankedTurn-005",
  "launch-006",
  "brake-007",
  "diveDrop-008",
  "launch-009",
  "airtimeHill-010",
  "topHat-011",
  "immelmann-012",
  "verticalLoop-013",
  "overbankedTurn-014",
  "zeroGRoll-015",
  "stall-016",
  "brake-017",
  "brake-018",
  "station-019",
] as const;

const intent = () =>
  createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 42,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });

const options = {
  profileVersion: "record-targets-v1",
  researchSnapshotIds: ["records-2026-09-01"],
} as const;

describe("record-hybrid default pipeline", () => {
  it("authors a meaningful nondegenerate finale overbank", () => {
    const finale = recordHybridDefaultElements(42).find(
      (element) => element.id === "overbankedTurn-014",
    );
    expect(finale?.kind).toBe("overbankedTurn");
    expect(
      Math.abs((finale?.parameters as { readonly angle: number }).angle),
    ).toBeGreaterThan(Math.PI / 3);
    expect(
      Math.abs((finale?.parameters as { readonly bank: number }).bank),
    ).toBeGreaterThan(Math.PI / 2);
  });

  it(
    "generates exactly 20 stable elements inside the physical length window",
    { timeout: 120_000 },
    () => {
      const generated = generateCoaster(intent(), options);
      expect(generated.elements.map((element) => element.id)).toEqual(
        RECORD_HYBRID_IDS,
      );
      expect(generated.track.totalLength).toBeGreaterThanOrEqual(5200);
      expect(generated.track.totalLength).toBeLessThanOrEqual(5400);
      expect(
        generated.feasible,
        JSON.stringify({
          length: generated.track.totalLength,
          finale: generated.elements.find(
            (element) => element.id === "overbankedTurn-014",
          )?.parameters,
          finaleSpans: generated.file.solvedSpans
            .filter((span) => span.id.startsWith("overbankedTurn-014"))
            .map((span) => ({
              id: span.id,
              length: span.length,
              kind: span.kind,
            })),
          diagnostics: generated.diagnostics,
        }),
      ).toBe(true);
      expect(generated.file.profileVersion).toBe("record-targets-v1");
      expect(generated.file.researchSnapshotIds).toEqual([
        "records-2026-09-01",
      ]);
      expect(generated.elements.at(-1)).toMatchObject({
        id: "station-019",
        kind: "station",
        parameters: { length: 180, closed: false },
      });
    },
  );

  it(
    "preserves semantic editability, coefficients, provenance, and checksum on reload",
    { timeout: 120_000 },
    () => {
      const generated = generateCoaster(intent(), options);
      const serialized = serializeCoasterFileV1(generated.file);
      const loadedFile = deserializeCoasterFileV1(serialized);
      const loaded = compileCoasterFile(loadedFile);
      expect(loadedFile.intent.elements).toEqual(generated.file.intent.elements);
      expect(serializeCoasterFileV1(loadedFile)).toBe(serialized);
      expect(loadedFile.profileVersion).toBe("record-targets-v1");
      expect(loadedFile.researchSnapshotIds).toEqual([
        "records-2026-09-01",
      ]);
      expect(loaded.track.checksum).toBe(generated.track.checksum);
      expect(loaded.track.totalLength).toBe(generated.track.totalLength);
    },
  );
});
