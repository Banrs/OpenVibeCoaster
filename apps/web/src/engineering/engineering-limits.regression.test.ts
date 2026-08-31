import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker";

describe("engineering limits final regression", () => {
  it(
    "production seed-42 Insta with bundled JSON returns success and warning diagnostics with exact evidence",
    { timeout: 20000 },
    () => {
      const intent = createDesignIntentV1({
        generatorVersion: "generator-v1",
        seed: 42,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        terrainProfileId: "rolling-highlands-v1",
        pinnedElementIds: [],
      });
      const result = handleGenerate("regression-insta-42", intent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const warnings = result.diagnostics.filter(
        (d) =>
          d.provenance === "PROJECT_ENGINEERING_LIMIT" &&
          d.severity === "warning",
      );
      expect(warnings.length).toBeGreaterThan(0);
      for (const w of warnings) {
        expect(w.actual).toBeDefined();
        expect(w.limit).toBeDefined();
        expect(w.margin).toBeLessThan(0);
        expect(w.location).toBeDefined();
        expect(w.location!.s).toBeDefined();
        expect(w.location!.time).toBeDefined();
        expect(w.location!.position).toBeDefined();
        expect(w.elementId).toBeDefined();
        expect(w.relatedIds?.[0]).toMatch(/^car-/);
        if (w.code === "ENGINEERING_LIMIT_VERTICAL_G_MIN")
          expect(w.margin).toBeCloseTo(w.actual! - w.limit!, 5);
        else expect(w.margin).toBeCloseTo(w.limit! - w.actual!, 5);
      }
      expect(
        result.diagnostics.some(
          (d) => d.severity === "error" || d.severity === "fatal",
        ),
      ).toBe(false);
    },
  );
});
