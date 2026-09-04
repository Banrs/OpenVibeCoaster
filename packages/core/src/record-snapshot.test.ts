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
  readonly sourceUrls: readonly string[];
  readonly retrievedAt: string;
};

type RecordEntry = {
  readonly id: string;
  readonly facts: readonly SourceFact[];
};

type ProjectComparison = {
  readonly provenance: string;
};

test("the dated snapshot preserves its provenance vocabulary and source facts", () => {
  expect(snapshot.capturedAt).toBe("2026-09-01");
  expect(snapshot.provenanceVocabulary).toEqual(priorSnapshot.provenanceVocabulary);

  const falconsFlight = (snapshot.records as readonly RecordEntry[]).find(
    (record) => record.id === "falcons-flight-metric-facts",
  );
  expect(falconsFlight).toBeDefined();
  expect(
    falconsFlight?.facts.find((fact) => fact.metric === "rideHeight")?.value,
  ).toBe(195);
  expect(
    falconsFlight?.facts.find((fact) => fact.metric === "trackLength")?.value,
  ).toBe(4325);

  for (const record of snapshot.records as readonly RecordEntry[]) {
    for (const fact of record.facts) {
      expect(fact.sourceUrls.length).toBeGreaterThan(0);
      expect(fact.retrievedAt).toBe("2026-09-01");
    }
  }
});

test("every project comparison is an authored design target", () => {
  for (const comparison of Object.values(
    snapshot.projectComparison as Record<string, ProjectComparison>,
  )) {
    expect(comparison.provenance).toBe("DESIGN_TARGET");
    expect(comparison.provenance).not.toBe("SOURCE_VERIFIED");
  }
});
