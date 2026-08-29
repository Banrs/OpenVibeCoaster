import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker";
import { hydrateEngineeringSuccess } from "./hydrate";
import { validateEngineeringWorkerResponse } from "./protocol";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 80, targetSpeed: 15, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 80, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 80, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("hydrateEngineeringSuccess", () => {
  it(
    "proves checksum equality and constructs real CompiledTrackData and RideTimeline",
    { timeout: 20000 },
    async () => {
      const success = handleGenerate("hydrate-1", validIntent as unknown);
      expect(success.type).toBe("success");
      if (success.type !== "success") return;
      const hydrated = hydrateEngineeringSuccess(success);
      expect(hydrated.track.checksum).toBe(success.track.checksum);
      expect(hydrated.file.compiledDataChecksum).toBe(success.track.checksum);
      expect(hydrated.timeline.length).toBe(success.timeline.length);
      expect(hydrated.spanHashes).toEqual(success.spanHashes);
    },
  );

  it(
    "ownership/non-aliasing – hydrated buffers are copies, not same reference",
    { timeout: 20000 },
    async () => {
      const success = handleGenerate("hydrate-2", validIntent as unknown);
      if (success.type !== "success") return;
      const hydrated = hydrateEngineeringSuccess(success);
      // CompiledTrackData copies buffers, so modifying hydrated shouldn't affect original transfer
      const origPos = success.track.positions;
      const hydratedPos = hydrated.track.positions;
      expect(origPos).not.toBe(hydratedPos);
      expect(origPos[0]).toBe(hydratedPos[0]);
      // Mutate hydrated copy, original unchanged
      hydratedPos[0] = 999999;
      expect(success.track.positions[0]).not.toBe(999999);
      // Timeline buffers also not aliased: hydrated timeline's internal buffers are copies
      const origTimeBuf = success.timeline.buffers[0]!;
      const hydTime = hydrated.timeline.timeSeconds;
      expect(origTimeBuf).not.toBe(hydTime.buffer);
    },
  );

  it(
    "malformed rejection – strict validation fails",
    { timeout: 20000 },
    async () => {
      const success = handleGenerate("hydrate-3", validIntent as unknown);
      if (success.type !== "success") throw new Error("expected success");
      const malformed = { ...success, spanHashes: { bad: "not-hex" } };
      expect(() => hydrateEngineeringSuccess(malformed)).toThrow();
      const { spanHashes: _removed, ...missing } = success;
      expect(() => hydrateEngineeringSuccess(missing)).toThrow();
      const empty = { ...success, spanHashes: {} as Record<string, string> };
      expect(() => hydrateEngineeringSuccess(empty)).toThrow();
      expect(() => validateEngineeringWorkerResponse(empty)).toThrow();
      const extra = {
        ...success,
        extraField: 123,
      } as unknown as typeof success;
      expect(() => validateEngineeringWorkerResponse(extra)).toThrow();
    },
  );

  it(
    "hydration returns owned/frozen diagnostics, relaxations, copied spanHashes and deeply frozen nested containers",
    { timeout: 20000 },
    async () => {
      const success = handleGenerate("hydrate-owned", validIntent as unknown);
      if (success.type !== "success") throw new Error("expected success");
      // Inject synthetic diagnostic to exercise nested freeze branches regardless of generator output
      const withNested = {
        ...success,
        diagnostics: [
          ...success.diagnostics,
          {
            code: "SYNTH",
            severity: "warning" as const,
            provenance: "PROJECT_ENGINEERING_LIMIT" as const,
            message: "synthetic",
            location: {
              s: 12.3,
              position: [
                1, 2, 3,
              ] as unknown as import("@openvibecoaster/core").Vec3,
            },
            relatedIds: ["a", "b"],
          },
        ],
      } as unknown as typeof success;
      const hydrated = hydrateEngineeringSuccess(withNested);
      expect(Object.isFrozen(hydrated.diagnostics)).toBe(true);
      expect(Object.isFrozen(hydrated.relaxations)).toBe(true);
      expect(Object.isFrozen(hydrated.spanHashes)).toBe(true);
      expect(Object.isFrozen(hydrated.file)).toBe(true);
      expect(hydrated.diagnostics).not.toBe(withNested.diagnostics);
      expect(hydrated.relaxations).not.toBe(success.relaxations);
      expect(hydrated.spanHashes).not.toBe(success.spanHashes);
      expect(hydrated.file).not.toBe(success.file);
      // Nested diagnostic containers are frozen and not aliased
      const diag = hydrated.diagnostics[hydrated.diagnostics.length - 1]!;
      expect(Object.isFrozen(diag)).toBe(true);
      expect(Object.isFrozen(diag.location as unknown as object)).toBe(true);
      expect(
        Object.isFrozen(diag.location!.position as unknown as object),
      ).toBe(true);
      expect(Object.isFrozen(diag.relatedIds as unknown as object)).toBe(true);
      expect(diag.location).not.toBe(
        (
          withNested.diagnostics as unknown as import("@openvibecoaster/core").Diagnostic[]
        )[(withNested.diagnostics as unknown[]).length - 1]!.location,
      );
      expect(diag.location!.position).not.toBe(
        (
          withNested.diagnostics as unknown as import("@openvibecoaster/core").Diagnostic[]
        )[(withNested.diagnostics as unknown[]).length - 1]!.location!.position,
      );
      expect(diag.relatedIds).not.toBe(
        (
          withNested.diagnostics as unknown as import("@openvibecoaster/core").Diagnostic[]
        )[(withNested.diagnostics as unknown[]).length - 1]!.relatedIds,
      );
      // Mutation attempts are inert – values cannot change
      const origS = diag.location!.s;
      try {
        (diag.location as unknown as Record<string, unknown>).s = 999;
      } catch {}
      expect(diag.location!.s).toBe(origS);
      const origPos0 = diag.location!.position![0]!;
      try {
        (diag.location!.position as unknown as number[])[0] = 9999;
      } catch {}
      expect(diag.location!.position![0]).toBe(origPos0);
      const origRelLen = diag.relatedIds!.length;
      try {
        (diag.relatedIds as unknown as string[]).push("c");
      } catch {}
      expect(diag.relatedIds!.length).toBe(origRelLen);
      // File deep freeze – nested plain containers frozen and mutation inert
      expect(Object.isFrozen(hydrated.file.intent as unknown as object)).toBe(
        true,
      );
      expect(
        Object.isFrozen(hydrated.file.intent.elements as unknown as object),
      ).toBe(true);
      expect(
        Object.isFrozen(hydrated.file.solvedSpans as unknown as object),
      ).toBe(true);
      if (hydrated.file.solvedSpans.length > 0) {
        const span0 = hydrated.file.solvedSpans[0] as unknown as Record<
          string,
          unknown
        >;
        expect(Object.isFrozen(span0 as unknown as object)).toBe(true);
        expect(
          Object.isFrozen(span0.positionCoefficients as unknown as object),
        ).toBe(true);
        if (Array.isArray(span0.positionCoefficients)) {
          expect(
            Object.isFrozen(
              (span0.positionCoefficients as unknown[])[0] as unknown as object,
            ),
          ).toBe(true);
        }
        expect(
          Object.isFrozen(span0.rollCoefficients as unknown as object),
        ).toBe(true);
        const origLen = (span0.positionCoefficients as unknown[]).length;
        try {
          (span0.positionCoefficients as unknown as unknown[]).push([
            1, 2, 3, 4, 5, 6, 7, 8,
          ]);
        } catch {}
        expect((span0.positionCoefficients as unknown[]).length).toBe(origLen);
      }
      const origName = hydrated.file.name;
      try {
        (hydrated.file as unknown as Record<string, unknown>).name = "mutated";
      } catch {}
      expect(hydrated.file.name).toBe(origName);
      // Relaxations/spanHashes mutation inert
      const origRelaxLen = hydrated.relaxations.length;
      try {
        (hydrated.relaxations as unknown as string[]).push("x");
      } catch {}
      expect(hydrated.relaxations.length).toBe(origRelaxLen);
      // Typed-array views: structuredClone did not JSON-roundtrip, buffers remain views (proven elsewhere) and file clone handles views safely
      expect(hydrated.file.solvedSpans.length).toBe(
        success.file.solvedSpans.length,
      );
    },
  );

  it(
    "deterministic output – same input yields identical hydrated track/timeline",
    { timeout: 20000 },
    async () => {
      const a = handleGenerate("hydrate-det-a", validIntent as unknown);
      const b = handleGenerate("hydrate-det-b", validIntent as unknown);
      if (a.type !== "success" || b.type !== "success") return;
      const ha = hydrateEngineeringSuccess(a);
      const hb = hydrateEngineeringSuccess(b);
      expect(ha.track.checksum).toBe(hb.track.checksum);
      expect(ha.timeline.timeSeconds).toEqual(hb.timeline.timeSeconds);
      expect(ha.track.positions).toEqual(hb.track.positions);
    },
  );

  it(
    "no JSON round-trip of typed arrays – buffers remain Float64Array",
    { timeout: 20000 },
    async () => {
      const success = handleGenerate("hydrate-typed", validIntent as unknown);
      if (success.type !== "success") return;
      expect(success.track.positions instanceof Float64Array).toBe(true);
      expect(success.timeline.buffers[0] instanceof ArrayBuffer).toBe(true);
      const hydrated = hydrateEngineeringSuccess(success);
      expect(hydrated.track.positions instanceof Float64Array).toBe(true);
      expect(hydrated.timeline.timeSeconds instanceof Float64Array).toBe(true);
    },
  );
});
