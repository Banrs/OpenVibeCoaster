import { expect, it } from "vitest";
import { arcLength, createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "./pipeline.js";

it(
  "serializes integrated child arc lengths rather than semantic parameters",
  { timeout: 120_000 },
  () => {
    const generated = generateCoaster(
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
      }),
      {
        profileVersion: "record-targets-v1",
        researchSnapshotIds: ["records-2026-09-01"],
      },
    );
    expect(generated.file.solvedSpans).toHaveLength(
      generated.solvedSpans.length,
    );
    generated.solvedSpans.forEach((span, index) => {
      const integrated = arcLength(span.span);
      const stored = generated.file.solvedSpans[index]!.length;
      expect(Math.abs(stored - integrated)).toBeLessThanOrEqual(1e-9);
    });
    const stall = generated.elements.find(
      (element) => element.id === "stall-016",
    )!;
    const authoredLength = (stall.parameters as { length: number }).length;
    const storedStallLength = generated.file.solvedSpans
      .filter((span) => span.id.startsWith("stall-016"))
      .reduce((sum, span) => sum + span.length, 0);
    expect(Math.abs(storedStallLength - authoredLength)).toBeGreaterThan(1);
  },
);
