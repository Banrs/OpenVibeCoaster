import { describe, expect, it, vi } from "vitest";
import { generateCoaster, regenerateLocal } from "./pipeline";
import * as solver from "./solver";

describe("local seam C2 regression", () => {
  it("rejects local regeneration when only bankSecondDerivative exceeds tolerance", () => {
    const intent = {
      schemaVersion: 1 as const,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: [
        {
          id: "s1",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "s2",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
        {
          id: "s3",
          kind: "station",
          type: "station",
          parameters: { length: 12, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    };

    const generated = generateCoaster(intent);
    expect(generated.feasible, JSON.stringify(generated.diagnostics)).toBe(
      true,
    );

    const originalDiagnose = solver.diagnoseSeams.bind(solver);
    const spy = vi.spyOn(solver, "diagnoseSeams").mockImplementation(((
      spans,
      options,
    ) => {
      const seams = originalDiagnose(
        spans as Parameters<typeof solver.diagnoseSeams>[0],
        options as Parameters<typeof solver.diagnoseSeams>[1],
      );
      if (seams.length === 0) return seams;
      const first = seams[0]!;
      const mutated = {
        ...first,
        positionM: 5e-5,
        tangentRad: 5e-6,
        curvaturePerM: 5e-5,
        curvatureVectorJumpPerM: 5e-5,
        curvatureGradientPerM2: 5e-5,
        bankRad: 5e-5,
        bankDerivativeRadPerM: 5e-5,
        bankSecondDerivativeRadPerM2: 2e-4,
        specificForceJumpG: 1e-5,
        hardResiduals: {
          ...first.hardResiduals,
          positionM: 5e-5,
          tangentRad: 5e-6,
          curvaturePerM: 5e-5,
          curvatureVectorJumpPerM: 5e-5,
          curvatureGradientPerM2: 5e-5,
          bankRad: 5e-5,
          bankDerivativeRadPerM: 5e-5,
          bankSecondDerivativeRadPerM2: 2e-4,
          specificForceJumpG: 1e-5,
        },
      };
      return [mutated, ...seams.slice(1)];
    }) as typeof solver.diagnoseSeams);

    try {
      const result = regenerateLocal(generated, "s2");
      expect(result.feasible).toBe(false);
      const local = result.diagnostics.find(
        (item) => item.code === "LOCAL_REGENERATION",
      );
      expect(local).toBeDefined();
      expect(local!.actual).toBeCloseTo(2e-4, 6);
    } finally {
      spy.mockRestore();
    }
  });
});
