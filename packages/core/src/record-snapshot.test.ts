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

const records = snapshot.records as readonly RecordEntry[];

const expectFacts = (
  record: RecordEntry | undefined,
  expected: ReadonlyArray<{
    readonly label: string;
    readonly metric: RegExp;
    readonly value: number;
    readonly unit: string;
    readonly sourceUrls: readonly string[];
  }>,
): void => {
  expect(record).toBeDefined();
  for (const fact of expected) {
    const actual = record?.facts.find(
      (candidate) =>
        fact.metric.test(candidate.metric) &&
        candidate.value === fact.value &&
        candidate.unit === fact.unit,
    );
    expect(actual, fact.label).toBeDefined();
    expect(actual?.sourceUrls, fact.label).toEqual(fact.sourceUrls);
  }
};

test("the dated snapshot preserves its provenance vocabulary and source facts", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.provenanceVocabulary).toEqual(
    priorSnapshot.provenanceVocabulary,
  );

  const falconsFlight = records.find(
    (record) => record.id === "falcons-flight-metric-facts",
  );
  expect(records).toHaveLength(3);
  expect(falconsFlight?.facts).toHaveLength(3);
  expectFacts(falconsFlight, [
    {
      label: "Falcons Flight height",
      metric: /height/i,
      value: 195,
      unit: "m",
      sourceUrls: [
        "https://sixflagsqiddiyacity.com/en/explore/rides/falcons-flight",
        "https://www.intamin.com/project/falcons-flight/",
      ],
    },
    {
      label: "Falcons Flight speed",
      metric: /speed/i,
      value: 250,
      unit: "km/h",
      sourceUrls: [
        "https://sixflagsqiddiyacity.com/en/explore/rides/falcons-flight",
        "https://www.intamin.com/project/falcons-flight/",
      ],
    },
    {
      label: "Falcons Flight length",
      metric: /length/i,
      value: 4325,
      unit: "m",
      sourceUrls: [
        "https://sixflagsqiddiyacity.com/en/explore/rides/falcons-flight",
        "https://www.intamin.com/project/falcons-flight/",
      ],
    },
  ]);

  const tormenta = records.find((record) => /tormenta/i.test(record.name));
  expect(tormenta?.facts).toHaveLength(7);
  expectFacts(tormenta, [
    {
      label: "Tormenta height",
      metric: /height/i,
      value: 94,
      unit: "m",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta drop",
      metric: /drop.*height|height.*drop/i,
      value: 87,
      unit: "m",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta drop angle",
      metric: /angle/i,
      value: 95,
      unit: "deg",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta speed",
      metric: /speed/i,
      value: 140,
      unit: "km/h",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta Immelmann",
      metric: /immelmann/i,
      value: 66,
      unit: "m",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta vertical loop",
      metric: /loop/i,
      value: 55,
      unit: "m",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
    {
      label: "Tormenta length",
      metric: /length/i,
      value: 1280,
      unit: "m",
      sourceUrls: [
        "https://www.sixflags.com/overtexas/attractions/tormenta-rampaging-run",
        "https://www.bolliger-mabillard.com/blog/now-operating-tormenta-rampaging-run",
      ],
    },
  ]);

  const spitfire = records.find((record) => /spitfire/i.test(record.name));
  expect(spitfire?.facts).toHaveLength(2);
  expectFacts(spitfire, [
    {
      label: "Spitfire inversion",
      metric: /inversion/i,
      value: 73,
      unit: "m",
      sourceUrls: [
        "https://www.intamin.com/project/spitfire-six-flags-qiddiya/",
      ],
    },
    {
      label: "Spitfire speed",
      metric: /speed/i,
      value: 127,
      unit: "km/h",
      sourceUrls: [
        "https://www.intamin.com/project/spitfire-six-flags-qiddiya/",
      ],
    },
  ]);

  expect(records.reduce((total, record) => total + record.facts.length, 0)).toBe(
    12,
  );

  for (const record of records) {
    for (const fact of record.facts) {
      expect(fact.sourceUrls.length).toBeGreaterThan(0);
      expect(fact.provenance).toBe("SOURCE_VERIFIED");
      expect(fact.retrievedAt).toBe("2026-09-01");
    }
  }
});

test("every project comparison is an authored design target", () => {
  expect(snapshot.projectComparison).toEqual({
    totalLengthM: {
      baseline: 4325,
      target: 5200,
      increasePercent: 20.2,
      provenance: "DESIGN_TARGET",
    },
    maxHeightM: {
      baseline: 195,
      target: 225,
      increasePercent: 15.4,
      provenance: "DESIGN_TARGET",
    },
    maxSpeedKmh: {
      baseline: 250,
      target: 285,
      increasePercent: 14.0,
      provenance: "DESIGN_TARGET",
    },
    invertedTopHatM: {
      baseline: 73,
      target: 90,
      increasePercent: 23.3,
      provenance: "DESIGN_TARGET",
    },
    immelmannM: {
      baseline: 66,
      target: 80,
      increasePercent: 21.2,
      provenance: "DESIGN_TARGET",
    },
    verticalLoopM: {
      baseline: 55,
      target: 66,
      increasePercent: 20.0,
      provenance: "DESIGN_TARGET",
    },
  });
});

test("the dated snapshot contains no standards or compliance claim", () => {
  expect(JSON.stringify(snapshot)).not.toMatch(
    /ASTM|F2291|licensed|compliance|certification/i,
  );
});
