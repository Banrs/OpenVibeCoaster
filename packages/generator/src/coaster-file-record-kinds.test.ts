import { expect, test } from "vitest";
import { deserializeCoasterFileV1 } from "@openvibecoaster/core";

const diveDrop = {
  id: "diveDrop-000",
  kind: "diveDrop",
  type: "diveDrop",
  parameters: {
    dropHeight: 210,
    angleDeg: 110,
    approachRadius: 90,
    exitRadius: 70,
    bank: 0,
  },
};

const validFile = () => ({
  schemaVersion: 1,
  name: "record-kind-contract",
  intent: {
    schemaVersion: 1,
    generatorVersion: "generator-v1",
    seed: 1,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [diveDrop],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  },
  solvedSpans: [
    {
      id: "diveDrop-000#0",
      kind: "diveDrop",
      positionCoefficients: [
        [0, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
      rollCoefficients: [0, 0, 0, 0, 0, 0],
      length: 120,
    },
  ],
  seed: 1,
  generatorVersion: "generator-v1",
  profileVersion: "record-targets-v1",
  researchSnapshotIds: ["records-2026-09-01"],
  compiledDataChecksum: "00000000",
});

test("coaster files accept a diveDrop span but reject terrainSwoop in either authority", () => {
  expect(() =>
    deserializeCoasterFileV1(JSON.stringify(validFile())),
  ).not.toThrow();

  const invalidIntent = validFile() as unknown as {
    intent: { elements: unknown[] };
  };
  invalidIntent.intent.elements = [
    ...invalidIntent.intent.elements,
    {
      id: "terrainSwoop-000",
      kind: "terrainSwoop",
      type: "terrainSwoop",
      parameters: {},
    },
  ];
  expect(() => deserializeCoasterFileV1(JSON.stringify(invalidIntent))).toThrow(
    /supported element kind/,
  );

  const invalidSpan = validFile() as unknown as {
    solvedSpans: Array<{ kind: string }>;
  };
  invalidSpan.solvedSpans[0]!.kind = "terrainSwoop";
  expect(() => deserializeCoasterFileV1(JSON.stringify(invalidSpan))).toThrow(
    /known element kind/,
  );
});
