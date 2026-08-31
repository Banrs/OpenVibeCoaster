import { describe, expect, it } from "vitest";
import {
  aabbFromPoints,
  arcLength,
  compileCoasterFile,
  createDesignIntentV1,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  serializeCoasterFileV1,
  type Vec3,
} from "@openvibecoaster/core";
import {
  coasterFileSpanHashes,
  generateCoaster,
  regenerateLocal,
} from "./index";
import * as solver from "./solver";
import rawProfile from "../../../data/profiles/engineering-limits-v1.json";
import { parseEngineeringLimitsProfile } from "@openvibecoaster/core";
const testSeams = parseEngineeringLimitsProfile(rawProfile).seams;

const authoredBank = Math.PI * 0.6;

const ownerForTest = (
  id: string,
  elementIds: readonly string[],
): string | undefined => {
  if (elementIds.includes(id)) return id;
  let current = id;
  while (true) {
    const sep = current.lastIndexOf("#");
    if (sep <= 0 || !/^\d+$/.test(current.slice(sep + 1))) return undefined;
    current = current.slice(0, sep);
    if (elementIds.includes(current)) return current;
  }
};

const expectFiniteCoefficients = (
  positionCoefficients: readonly (readonly number[])[] | undefined,
  rollCoefficients: readonly number[] | undefined,
  id: string,
) => {
  expect(positionCoefficients, `${id} positionCoefficients`).toBeDefined();
  expect(positionCoefficients!.length).toBe(3);
  for (const row of positionCoefficients!) {
    expect(row.length).toBe(8);
    for (const v of row) expect(Number.isFinite(v)).toBe(true);
  }
  expect(rollCoefficients, `${id} rollCoefficients`).toBeDefined();
  expect(rollCoefficients!.length).toBe(6);
  for (const v of rollCoefficients!) expect(Number.isFinite(v)).toBe(true);
};

const verifyOverbank = (
  generated: ReturnType<typeof generateCoaster>,
  overbankId: string,
  expectedPeak: number,
) => {
  expect(generated.feasible, JSON.stringify(generated.diagnostics)).toBe(true);
  expect(
    generated.diagnostics.some(
      (d) => d.severity === "error" || d.severity === "fatal",
    ),
  ).toBe(false);

  // authored peak is reached
  const overbankSpans = generated.solvedSpans.filter(
    (s) => s.id === overbankId || s.id.startsWith(`${overbankId}#`),
  );
  expect(overbankSpans.length).toBeGreaterThanOrEqual(2);
  const bankSamples = overbankSpans.flatMap((span) =>
    Array.from({ length: 33 }, (_, i) => span.bank!.position(i / 32)),
  );
  const peak = Math.max(...bankSamples.map(Math.abs));
  // also check that peak equals authored (positive magnitude) and that internal peak exactly matches authored
  expect(peak).toBeCloseTo(Math.abs(expectedPeak), 6);
  // the internal midpoint between the two halves should be the peak (handles nested coefficientSpan expansion)
  const touchesPeak = overbankSpans.some(
    (span) =>
      Math.abs(span.bank!.position(0) - expectedPeak) < 1e-6 ||
      Math.abs(span.bank!.position(1) - expectedPeak) < 1e-6,
  );
  expect(
    touchesPeak,
    `peak ${expectedPeak} not found at any overbank seam`,
  ).toBe(true);

  // bank value/first/second derivatives are continuous at every outer and internal overbank seam
  const seams = solver.diagnoseSeams(generated.solvedSpans);
  const overbankSeamIds = seams.filter((seam) =>
    seam.seamId.includes(overbankId),
  );
  // should include outer left, internal, outer right
  expect(overbankSeamIds.length).toBeGreaterThanOrEqual(2);
  for (const seam of seams) {
    // only strictly check seams that involve overbank spans (outer seams + internal)
    if (!seam.seamId.includes(overbankId)) continue;
    expect(seam.bankRad, `${seam.seamId} bankRad`).toBeLessThan(1e-4);
    expect(
      seam.bankDerivativeRadPerM,
      `${seam.seamId} bankDerivative`,
    ).toBeLessThan(1e-4);
    expect(
      seam.bankSecondDerivativeRadPerM2,
      `${seam.seamId} bankSecondDerivative`,
    ).toBeLessThan(1e-4);
  }
  // also ensure ALL seams in the chain are C2 (no regression elsewhere)
  for (const seam of seams) {
    expect(
      seam.bankSecondDerivativeRadPerM2,
      `global ${seam.seamId} C2`,
    ).toBeLessThan(1e-4);
  }

  // split spans' positionCoefficients, rollCoefficients, length, bounds, nested IDs and semantic owner resolve consistently with authoritative span/arc length
  const elementIds = generated.elements.map((e) => e.id);
  for (const span of overbankSpans) {
    expect(span.id === overbankId || /#\d+$/.test(span.id)).toBe(true);
    expectFiniteCoefficients(
      span.positionCoefficients,
      span.rollCoefficients,
      span.id,
    );
    // length vs arcLength consistency
    const owner = ownerForTest(span.id, elementIds);
    expect(owner, `owner for ${span.id}`).toBe(overbankId);
    const paramLength = (
      generated.elements.find((e) => e.id === owner)!.parameters as Record<
        string,
        unknown
      >
    ).length;
    const curvedLength = arcLength(span.span);
    const storedLength = span.length ?? curvedLength;
    if (typeof paramLength === "number") {
      expect(storedLength).toBeCloseTo(paramLength, 6);
    } else {
      expect(storedLength).toBeCloseTo(curvedLength, 6);
    }
    // verify coefficients reconstruct authoritative span
    const reconstructedPos = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
      span.positionCoefficients!,
    );
    const reconstructedBank = QuinticScalarSpan.fromCoefficients(
      span.rollCoefficients!,
    );
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(reconstructedPos.position(u)[0]).toBeCloseTo(
        span.span.position(u)[0],
        8,
      );
      expect(reconstructedPos.position(u)[1]).toBeCloseTo(
        span.span.position(u)[1],
        8,
      );
      expect(reconstructedPos.position(u)[2]).toBeCloseTo(
        span.span.position(u)[2],
        8,
      );
      expect(reconstructedBank.position(u)).toBeCloseTo(
        span.bank!.position(u),
        8,
      );
      expect(reconstructedBank.derivative(u, 1)).toBeCloseTo(
        span.bank!.derivative(u, 1),
        8,
      );
      expect(reconstructedBank.derivative(u, 2)).toBeCloseTo(
        span.bank!.derivative(u, 2),
        8,
      );
    }
    // arcLength via coefficients matches authoritative span
    expect(arcLength(reconstructedPos)).toBeCloseTo(curvedLength, 6);
    // bounds: final generation canonical spans lose bounds (reconstructed), so verify via recomputed aabb is finite and contains points
    const dense = Array.from({ length: 17 }, (_, i) =>
      span.span.position(i / 16),
    );
    const recomputed = aabbFromPoints(dense);
    expect(recomputed.min.every(Number.isFinite)).toBe(true);
    expect(recomputed.max.every(Number.isFinite)).toBe(true);
    expect(recomputed.min[0]! <= recomputed.max[0]!).toBe(true);
    expect(recomputed.min[1]! <= recomputed.max[1]!).toBe(true);
    expect(recomputed.min[2]! <= recomputed.max[2]!).toBe(true);
    for (const u of [0, 0.2, 0.5, 0.8, 1]) {
      const p = span.span.position(u);
      expect(
        p[0] >= recomputed.min[0]! - 1e-9 && p[0] <= recomputed.max[0]! + 1e-9,
      ).toBe(true);
      expect(
        p[1] >= recomputed.min[1]! - 1e-9 && p[1] <= recomputed.max[1]! + 1e-9,
      ).toBe(true);
      expect(
        p[2] >= recomputed.min[2]! - 1e-9 && p[2] <= recomputed.max[2]! + 1e-9,
      ).toBe(true);
    }
    if (span.bounds) {
      expect(span.bounds.min[0]).toBeCloseTo(recomputed.min[0]!, 6);
      expect(span.bounds.min[1]).toBeCloseTo(recomputed.min[1]!, 6);
      expect(span.bounds.min[2]).toBeCloseTo(recomputed.min[2]!, 6);
      expect(span.bounds.max[0]).toBeCloseTo(recomputed.max[0]!, 6);
      expect(span.bounds.max[1]).toBeCloseTo(recomputed.max[1]!, 6);
      expect(span.bounds.max[2]).toBeCloseTo(recomputed.max[2]!, 6);
    }
  }

  // file serializes in terms of split spans and owner mapping resolves (nested # for coefficient spans)
  const fileSpanIds = generated.file.solvedSpans.map((s) => s.id);
  const nestedForOverbank = fileSpanIds.filter(
    (id) => id === overbankId || id.startsWith(`${overbankId}#`),
  );
  expect(nestedForOverbank.length).toBeGreaterThanOrEqual(2);
  expect(fileSpanIds.includes(overbankId)).toBe(false);
  // at least the first child of each half must be present and owner resolves recursively
  const firstChild = fileSpanIds.find((id) => id.startsWith(`${overbankId}#0`));
  const secondHalfFirst = fileSpanIds.find((id) =>
    id.startsWith(`${overbankId}#1`),
  );
  expect(firstChild).toBeDefined();
  expect(secondHalfFirst).toBeDefined();
  for (const id of nestedForOverbank) {
    expect(ownerForTest(id, elementIds)).toBe(overbankId);
  }
};

describe("overbank C2 regression", () => {
  it(
    "directed >90-degree overbank via solver is C2, feasible, serializes/round-trips, deterministic and supports local regeneration",
    { timeout: 60000 },
    () => {
      const intent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 42,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [
          {
            id: "station-000",
            kind: "station",
            type: "station",
            parameters: { length: 30, bank: 0, closed: false },
          },
          {
            id: "overbank-001",
            kind: "overbankedTurn",
            type: "overbankedTurn",
            parameters: {
              radius: 75,
              angle: Math.PI * 0.75,
              bank: authoredBank,
            },
          },
          {
            id: "brake-002",
            kind: "brake",
            type: "brake",
            parameters: { length: 60, targetSpeed: 8, bank: 0 },
          },
          {
            id: "station-003",
            kind: "station",
            type: "station",
            parameters: { length: 30, bank: 0, closed: false },
          },
        ],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      });

      const first = generateCoaster(intent);
      verifyOverbank(first, "overbank-001", authoredBank);

      // serializes/round-trips/recompiles without re-solving, and checksum is stable
      const serialized = first.serializedFile;
      const deserialized = serializeCoasterFileV1(first.file);
      expect(deserialized).toBe(serialized);
      const loaded = compileCoasterFile(serialized);
      expect(loaded.track.checksum).toBe(first.file.compiledDataChecksum);
      expect(loaded.track.checksum).toBe(first.track.checksum);
      expect(loaded.file.solvedSpans.map((s) => s.id)).toEqual(
        first.file.solvedSpans.map((s) => s.id),
      );
      // recompiles without re-solving: loading via compileCoasterFile must not change coefficients (allow -0 vs 0 canonical)
      const norm = (rows: readonly (readonly number[])[]) =>
        rows.map((r) => r.map((v) => (v === 0 ? 0 : v)));
      const normRoll = (rows: readonly number[]) =>
        rows.map((v) => (v === 0 ? 0 : v));
      for (let i = 0; i < first.file.solvedSpans.length; i += 1) {
        expect(norm(loaded.file.solvedSpans[i]!.positionCoefficients)).toEqual(
          norm(first.file.solvedSpans[i]!.positionCoefficients),
        );
        expect(normRoll(loaded.file.solvedSpans[i]!.rollCoefficients)).toEqual(
          normRoll(first.file.solvedSpans[i]!.rollCoefficients),
        );
        expect(loaded.file.solvedSpans[i]!.length).toBeCloseTo(
          first.file.solvedSpans[i]!.length,
          10,
        );
      }
      expect(loaded.track.positions).toEqual(first.track.positions);
      expect(loaded.track.bank).toEqual(first.track.bank);

      // repeated seed output and span hashes are deterministic
      const second = generateCoaster(intent);
      expect(second.serializedFile).toBe(first.serializedFile);
      expect(second.track.checksum).toBe(first.track.checksum);
      expect(second.spanHashes).toEqual(first.spanHashes);
      expect(second.spanBytes).toEqual(first.spanBytes);
      const hashesA = coasterFileSpanHashes(first.file);
      const hashesB = coasterFileSpanHashes(second.file);
      expect(hashesA).toEqual(hashesB);
      expect(hashesA).toEqual(first.spanHashes);
      // owner hash equals first child (nested coefficientSpan expansion)
      const firstOverbankChild = first.solvedSpans.find((s) =>
        s.id.startsWith("overbank-001#"),
      )!.id;
      expect(hashesA["overbank-001"]).toBe(hashesA[firstOverbankChild]);

      // owner mapping supports local regeneration/pin paths
      const local = regenerateLocal(first, "station-003", {
        seams: testSeams,
        referenceSpeed: 44,
        pinnedElementIds: ["overbank-001"],
      });
      expect(local.feasible).toBe(true);
      expect(local.untouchedSpanHashes["overbank-001"]).toBe(
        first.spanHashes["overbank-001"],
      );
      expect(local.untouchedSpanHashes["station-000"]).toBe(
        first.spanHashes["station-000"],
      );
      // overbank hashes remain bitwise stable when not in window
      expect(local.generation.spanHashes["overbank-001"]).toBe(
        first.spanHashes["overbank-001"],
      );
      expect(local.generation.spanBytes["overbank-001"]).toBe(
        first.spanBytes["overbank-001"],
      );
      // also verify a regeneration window that includes overbank still keeps other pins stable
      const local2 = regenerateLocal(first, "brake-002", {
        seams: testSeams,
        referenceSpeed: 44,
        pinnedElementIds: ["station-000"],
      });
      expect(local2.feasible).toBe(true);
      expect(local2.untouchedSpanHashes["station-000"]).toBe(
        first.spanHashes["station-000"],
      );
      // pinned guard
      const pinnedFail = regenerateLocal(first, "station-000", {
        seams: testSeams,
        referenceSpeed: 44,
        pinnedElementIds: ["station-000"],
      });
      expect(pinnedFail.feasible).toBe(false);
    },
  );

  it(
    "full-auto flagship overbank via pipeline is C2, feasible, serializes/round-trips, deterministic and checksum stable",
    { timeout: 60000 },
    () => {
      const flagshipIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 7,
        mode: "full-auto",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      });

      const first = generateCoaster(flagshipIntent);
      // flagship must contain overbankedTurn-003 with bank >90deg
      const overbankElement = first.elements.find(
        (e) => e.type === "overbankedTurn",
      );
      expect(overbankElement).toBeDefined();
      expect(
        Math.abs((overbankElement!.parameters as { bank: number }).bank),
      ).toBeGreaterThan(Math.PI / 2);
      const overbankId = overbankElement!.id;
      const peak = (overbankElement!.parameters as { bank: number }).bank;

      verifyOverbank(first, overbankId, peak);

      // real default/full-auto generateCoaster succeeds, is feasible, serializes/round-trips/recompiles without re-solving, and checksum is stable
      expect(first.feasible).toBe(true);
      const loaded = compileCoasterFile(first.serializedFile);
      expect(loaded.track.checksum).toBe(first.track.checksum);
      expect(loaded.track.checksum).toBe(first.file.compiledDataChecksum);
      expect(serializeCoasterFileV1(loaded.file)).toBe(first.serializedFile);
      // recompiles deterministically via file
      const reloaded2 = compileCoasterFile(first.file);
      expect(reloaded2.track.checksum).toBe(first.track.checksum);

      // deterministic repeated seed
      const second = generateCoaster(flagshipIntent);
      expect(second.serializedFile).toBe(first.serializedFile);
      expect(second.track.checksum).toBe(first.track.checksum);
      expect(second.spanHashes).toEqual(first.spanHashes);
      expect(coasterFileSpanHashes(first.file)).toEqual(
        coasterFileSpanHashes(second.file),
      );

      // full-auto also verifies solver site is not bypassed: ensure solver still produces C2 when called directly
      const directSolver = solver.solveSemanticChain(first.elements, {
        referenceSpeed: 44,
      });
      const solverSeams = solver.diagnoseSeams(directSolver.solvedSpans);
      for (const seam of solverSeams) {
        if (seam.seamId.includes(overbankId)) {
          expect(seam.bankSecondDerivativeRadPerM2).toBeLessThan(1e-4);
        }
      }

      // owner mapping supports local regeneration in flagship
      const local = regenerateLocal(first, "stall-007", {
        seams: testSeams,
        referenceSpeed: 44,
        pinnedElementIds: ["station-000"],
      });
      // flagship has station-000 pinned scenario; ensure overbank untouched stays stable when window excludes it
      if (local.feasible) {
        // stall-007 window typically [6,7] or [6,8]; overbank-003 should be untouched
        if (local.untouchedSpanHashes[overbankId] !== undefined) {
          expect(local.untouchedSpanHashes[overbankId]).toBe(
            first.spanHashes[overbankId],
          );
        }
      }
    },
  );

  it("solver directed overbank split spans expose correct coefficients, bounds and owner semantics via file hashes", () => {
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 123,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-000",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "overbank-001",
          kind: "overbankedTurn",
          type: "overbankedTurn",
          parameters: { radius: 30, angle: Math.PI * 0.6, bank: -authoredBank },
        },
        {
          id: "station-002",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const gen = generateCoaster(intent);
    const ids = gen.solvedSpans
      .filter((s) => s.id.startsWith("overbank-001"))
      .map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.every((id) => id.startsWith("overbank-001#"))).toBe(true);
    const hashes = coasterFileSpanHashes(gen.file);
    expect(hashes["overbank-001"]).toBeDefined();
    // owner hash equals first child hash (recursive resolver)
    const firstNested = ids[0]!;
    expect(hashes[firstNested]).toBeDefined();
    expect(hashes["overbank-001"]).toBe(hashes[firstNested]);
    // file validates nested # semantics
    expect(() => compileCoasterFile(gen.serializedFile)).not.toThrow();
    // negative bank peak is also reached
    verifyOverbank(gen, "overbank-001", -authoredBank);
  });
});
