import { expect, test } from "vitest";
import snapshot from "../../../data/records/records-2026-09-01.json" with {
  type: "json",
};
import priorSnapshot from "../../../data/records/records-2026-08-29.json" with {
  type: "json",
};

type SourceFact = {
  readonly metric: string;
  readonly value: unknown;
  readonly unit: string;
  readonly provenance: string;
  readonly sourceUrls: readonly string[];
  readonly retrievedAt: string;
};

type RecordEntry = {
  readonly id: string;
  readonly name: string;
  readonly facts: readonly SourceFact[];
};

type ProjectComparison = {
  readonly provenance: string;
};

const records = snapshot.records as readonly RecordEntry[];

const expectFacts = (
  record: RecordEntry | undefined,
  expected: ReadonlyArray<{
    readonly label: string;
    readonly metric: RegExp;
    readonly value: number;
    readonly unit: string;
  }>,
): void => {
  expect(record).toBeDefined();
  for (const fact of expected) {
    expect(
      record?.facts.some(
        (candidate) =>
          fact.metric.test(candidate.metric) &&
          candidate.value === fact.value &&
          candidate.unit === fact.unit,
      ),
      fact.label,
    ).toBe(true);
  }
};

const numericValues = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numericValues);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(numericValues);
  return [];
};

test("the dated snapshot preserves its provenance vocabulary and source facts", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.provenanceVocabulary).toEqual(
    priorSnapshot.provenanceVocabulary,
  );

  const falconsFlight = records.find(
    (record) => record.id === "falcons-flight-metric-facts",
  );
  expectFacts(falconsFlight, [
    {
      label: "Falcons Flight height",
      metric: /height/i,
      value: 195,
      unit: "m",
    },
    {
      label: "Falcons Flight speed",
      metric: /speed/i,
      value: 250,
      unit: "km/h",
    },
    {
      label: "Falcons Flight length",
      metric: /length/i,
      value: 4325,
      unit: "m",
    },
  ]);

  const tormenta = records.find((record) => /tormenta/i.test(record.name));
  expectFacts(tormenta, [
    { label: "Tormenta height", metric: /height/i, value: 94, unit: "m" },
    {
      label: "Tormenta drop",
      metric: /drop.*height|height.*drop/i,
      value: 87,
      unit: "m",
    },
    { label: "Tormenta drop angle", metric: /angle/i, value: 95, unit: "deg" },
    { label: "Tormenta speed", metric: /speed/i, value: 140, unit: "km/h" },
    {
      label: "Tormenta Immelmann",
      metric: /immelmann/i,
      value: 66,
      unit: "m",
    },
    { label: "Tormenta vertical loop", metric: /loop/i, value: 55, unit: "m" },
    { label: "Tormenta length", metric: /length/i, value: 1280, unit: "m" },
  ]);

  const spitfire = records.find((record) => /spitfire/i.test(record.name));
  expectFacts(spitfire, [
    { label: "Spitfire inversion", metric: /inversion/i, value: 73, unit: "m" },
  ]);

  for (const record of records) {
    for (const fact of record.facts) {
      expect(fact.sourceUrls.length).toBeGreaterThan(0);
      expect(fact.provenance).toBe("SOURCE_VERIFIED");
      expect(fact.retrievedAt).toBe("2026-09-01");
    }
  }
});

test("every project comparison is an authored design target", () => {
  const comparisons = Object.values(
    snapshot.projectComparison,
  ) as ProjectComparison[];

  expect(comparisons).toHaveLength(6);
  for (const comparison of comparisons) {
    expect(comparison.provenance).toBe("DESIGN_TARGET");
    expect(comparison.provenance).not.toBe("SOURCE_VERIFIED");
  }

  const expectedComputations = [
    { label: "length", baseline: 4325, target: 5200, increasePercent: 20.2 },
    { label: "height", baseline: 195, target: 225, increasePercent: 15.4 },
    { label: "speed", baseline: 250, target: 285, increasePercent: 14.0 },
    {
      label: "inverted top hat",
      baseline: 73,
      target: 90,
      increasePercent: 23.3,
    },
    { label: "Immelmann", baseline: 66, target: 80, increasePercent: 21.2 },
    { label: "vertical loop", baseline: 55, target: 66, increasePercent: 20.0 },
  ] as const;

  for (const expected of expectedComputations) {
    const match = comparisons.find((comparison) => {
      const values = numericValues(comparison);
      return (
        values.includes(expected.baseline) &&
        values.includes(expected.target) &&
        values.includes(expected.increasePercent)
      );
    });
    expect(match, expected.label).toBeDefined();
  }
});

test("the dated snapshot contains no standards or compliance claim", () => {
  expect(JSON.stringify(snapshot)).not.toMatch(
    /ASTM|F2291|licensed|compliance|certification/i,
  );
});
