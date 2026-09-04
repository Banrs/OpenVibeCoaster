import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  createCliffValleyEnvironment,
  createDesignIntentV1,
} from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";
import { generateCoaster } from "./pipeline.js";

const recordIntent = () =>
  createDesignIntentV1({
    generatorVersion: "record-g",
    seed: 11,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });

test(
  "cliff-valley uses certified clearance inside the deterministic work budget",
  { timeout: 120_000 },
  () => {
    const environment = createCliffValleyEnvironment();
    expect((environment.width - 1) * environment.cellSize).toBe(4190);
    const generated = generateCoaster(recordIntent(), {
      environment,
      profileVersion: "record-targets-v1",
      researchSnapshotIds: ["records-2026-09-01"],
    });
    const field = generated.clearanceField;
    expect(field).toBeDefined();
    if (!field) throw new Error("Generator omitted its clearance field");
    expect(
      field.diagnostics.some(
        (diagnostic) => diagnostic.code === "CLEARANCE_UNCERTIFIED",
      ),
      JSON.stringify({ work: field.work, diagnostics: field.diagnostics }),
    ).toBe(false);
    expect(field.work).toBeLessThan(1_000_000);
    expect(Number.isFinite(field.minClearanceM)).toBe(true);

    const exhausted = computeClearanceField(generated.track, {
      environment,
      maxWork: 1,
    });
    expect(
      exhausted.diagnostics.some(
        (diagnostic) => diagnostic.code === "CLEARANCE_UNCERTIFIED",
      ),
    ).toBe(true);
  },
);

test("generator never imports web terrain", async () => {
  const source = await readFile(
    new URL("./pipeline.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("apps/web");
});
