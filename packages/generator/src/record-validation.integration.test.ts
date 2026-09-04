import { expect, test } from "vitest";
import {
  createDesignIntentV1,
  validateRecordTargetsProfile,
  type CoasterFileV1,
  type RecordTargetProfile,
} from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  localHeightForKind,
  simulateRide,
  summitHoldWindow,
  validateRecordTargets,
} from "@openvibecoaster/simulator";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
import { createElement } from "./elements.js";
import { generateCoaster } from "./pipeline.js";
import { compileSemanticChain } from "./solver.js";

validateRecordTargetsProfile(profile);
const targetProfile = profile as RecordTargetProfile;

function singleElementFile(
  kind: "topHat",
  height: number,
  solved: ReturnType<typeof compileSemanticChain>["solvedSpans"],
): CoasterFileV1 {
  return {
    intent: {
      elements: [
        {
          id: "topHat-011",
          kind,
          type: kind,
          parameters: { height, width: 180, bank: 0 },
        },
      ],
    },
    solvedSpans: solved.map((span) => ({
      id: span.id,
      kind,
      positionCoefficients: span.positionCoefficients,
      rollCoefficients: span.rollCoefficients,
      length: span.length,
    })),
  } as unknown as CoasterFileV1;
}

test("compiled local height, not authored intent, proves the top-hat record", () => {
  const low = compileSemanticChain([
    createElement("topHat", "topHat-011", {
      height: 80,
      width: 180,
      bank: 0,
    }),
  ]);
  const high = compileSemanticChain([
    createElement("topHat", "topHat-011", {
      height: 91,
      width: 180,
      bank: 0,
    }),
  ]);
  expect(low.feasible).toBe(true);
  expect(high.feasible).toBe(true);
  const dishonestIntent = singleElementFile("topHat", 91, low.solvedSpans);
  const modestIntent = singleElementFile("topHat", 80, high.solvedSpans);

  expect(
    localHeightForKind(low.track!, dishonestIntent, "topHat").deltaM,
  ).toBeLessThan(90);
  const measured = localHeightForKind(high.track!, modestIntent, "topHat");
  expect(measured.deltaM).toBeGreaterThanOrEqual(90);
  expect(measured.deltaM).toBeLessThanOrEqual(92);
  expect(measured.relatedIds).toContain("topHat-011");
});

test(
  "record route derives element heights and dive angle from compiled geometry",
  { timeout: 240_000 },
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
    const config = createDefaultSimulatorConfig();
    const simulation = simulateRide(generated.track, {
      durationSeconds: 1,
      config: { ...config, zones: [] },
      initial: { headDistanceM: config.train.spacingM * 5, speedMps: 5 },
      compactTimeline: true,
    });
    const diagnostics = validateRecordTargets(
      generated.track,
      simulation.timeline,
      generated.file,
      targetProfile,
      {
        holdSeconds: 3,
        holdLocationS: summitHoldWindow(generated.file).centerS,
      },
    );

    expect(
      diagnostics.filter(({ code }) => code === "RECORD_INVERSION"),
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "RECORD_IMMELMANN"),
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "RECORD_LOOP"),
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "RECORD_DIVE_HEIGHT"),
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "RECORD_DIVE_ANGLE"),
    ).toHaveLength(0);
  },
);
