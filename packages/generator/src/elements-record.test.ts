import { expect, test } from "vitest";
import { parseDesignIntentV1 } from "@openvibecoaster/core";
import { createElement } from "./elements.js";
import { ELEMENT_KINDS } from "./types.js";

const createRecordElement = createElement as unknown as (
  kind: string,
  id: string,
  parameters?: Readonly<Record<string, number>>,
) => { readonly parameters: Readonly<Record<string, number>> };

const intentWith = (kind: string, parameters: Record<string, number>) =>
  JSON.stringify({
    schemaVersion: 1,
    generatorVersion: "generator-v1",
    seed: 1,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [{ id: `${kind}-000`, kind, type: kind, parameters }],
    gates: [],
    targets: [],
    constraints: [],
    pinnedElementIds: [],
  });

test("the three record kinds have only their exact defaults and parameter bounds", () => {
  const cases = [
    {
      kind: "diveDrop",
      defaults: {
        dropHeight: 210,
        angleDeg: 110,
        approachRadius: 90,
        exitRadius: 70,
        bank: 0,
      },
      lower: {
        dropHeight: 40,
        angleDeg: 90,
        approachRadius: 15,
        exitRadius: 15,
        bank: -Math.PI,
      },
      upper: {
        dropHeight: 250,
        angleDeg: 135,
        approachRadius: 400,
        exitRadius: 400,
        bank: Math.PI,
      },
      below: {
        dropHeight: 39.999,
        angleDeg: 89.999,
        approachRadius: 14.999,
        exitRadius: 14.999,
        bank: -Math.PI - 0.001,
      },
      above: {
        dropHeight: 250.001,
        angleDeg: 135.001,
        approachRadius: 400.001,
        exitRadius: 400.001,
        bank: Math.PI + 0.001,
      },
    },
    {
      kind: "immelmann",
      defaults: { height: 81, exitHeadingDeg: 180, bank: 0 },
      lower: { height: 20, exitHeadingDeg: -180, bank: -Math.PI },
      upper: { height: 130, exitHeadingDeg: 180, bank: Math.PI },
      below: {
        height: 19.999,
        exitHeadingDeg: -180.001,
        bank: -Math.PI - 0.001,
      },
      above: {
        height: 130.001,
        exitHeadingDeg: 180.001,
        bank: Math.PI + 0.001,
      },
    },
    {
      kind: "verticalLoop",
      defaults: { height: 67, referenceSpeed: 38, bank: 0 },
      lower: { height: 20, referenceSpeed: 5, bank: -Math.PI },
      upper: { height: 130, referenceSpeed: 85, bank: Math.PI },
      below: {
        height: 19.999,
        referenceSpeed: 4.999,
        bank: -Math.PI - 0.001,
      },
      above: {
        height: 130.001,
        referenceSpeed: 85.001,
        bank: Math.PI + 0.001,
      },
    },
  ] as const;

  expect(cases).toHaveLength(3);
  for (const entry of cases) {
    expect(
      createRecordElement(entry.kind, `${entry.kind}-default`).parameters,
    ).toEqual(entry.defaults);
    expect(() =>
      createRecordElement(entry.kind, `${entry.kind}-lower`, entry.lower),
    ).not.toThrow();
    expect(() =>
      createRecordElement(entry.kind, `${entry.kind}-upper`, entry.upper),
    ).not.toThrow();
    for (const [side, invalid] of Object.entries({
      below: entry.below,
      above: entry.above,
    }))
      for (const [name, invalidValue] of Object.entries(invalid))
        expect(() =>
          createRecordElement(entry.kind, `${entry.kind}-${side}-${name}`, {
            ...entry.defaults,
            [name]: invalidValue,
          }),
        ).toThrow();
    for (const invalidValue of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      for (const name of Object.keys(entry.defaults))
        expect(() =>
          createRecordElement(entry.kind, `${entry.kind}-non-finite-${name}`, {
            ...entry.defaults,
            [name]: invalidValue,
          }),
        ).toThrow();
  }
});

test("topHat preserves the 80 m default and accepts precisely the extended range", () => {
  expect(createElement("topHat", "topHat-default").parameters.height).toBe(80);
  expect(
    createElement("topHat", "topHat-record", {
      height: 91,
      width: 60,
      bank: 0,
    }).parameters.height,
  ).toBe(91);
  expect(
    createElement("topHat", "topHat-upper-bound", {
      height: 92,
      width: 60,
      bank: 0,
    }).parameters.height,
  ).toBe(92);
  expect(() =>
    createElement("topHat", "topHat-too-low", {
      height: 79.999,
      width: 60,
      bank: 0,
    }),
  ).toThrow(/height/);
  expect(() =>
    createElement("topHat", "topHat-too-high", {
      height: 92.001,
      width: 60,
      bank: 0,
    }),
  ).toThrow(/height/);
});

test("a fourth terrainSwoop kind remains invalid at generator and intent boundaries", () => {
  expect(ELEMENT_KINDS).not.toContain("terrainSwoop");
  expect(() =>
    createRecordElement("terrainSwoop", "terrainSwoop-000", {
      length: 20,
      height: 10,
    }),
  ).toThrow(/Unknown element kind: terrainSwoop/);
  expect(() =>
    parseDesignIntentV1(
      intentWith("terrainSwoop", { length: 20, height: 10 }),
    ),
  ).toThrow(/supported element kind/);
});
