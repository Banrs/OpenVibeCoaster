import { expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import {
  generateCoaster,
  recordHybridDefaultElements,
} from "./pipeline.js";
import { RECORD_HYBRID_IDS } from "./recordHybrid.pipeline.test.js";

const intent = () =>
  createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 7,
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

it(
  "same seed produces identical solved bytes, checksum, and length",
  { timeout: 120_000 },
  () => {
    const first = generateCoaster(intent(), options);
    const second = generateCoaster(intent(), options);
    expect(second.track.checksum).toBe(first.track.checksum);
    expect(second.track.totalLength).toBe(first.track.totalLength);
    expect(second.spanBytes).toEqual(first.spanBytes);
  },
);

it("candidate variation is deterministic without changing stable IDs", () => {
  const first = recordHybridDefaultElements(7, 0);
  const repeated = recordHybridDefaultElements(7, 0);
  const next = recordHybridDefaultElements(7, 1);
  expect(first.map((element) => element.id)).toEqual(RECORD_HYBRID_IDS);
  expect(next.map((element) => element.id)).toEqual(RECORD_HYBRID_IDS);
  expect(repeated).toEqual(first);
  expect(next.map((element) => element.parameters)).not.toEqual(
    first.map((element) => element.parameters),
  );
});
