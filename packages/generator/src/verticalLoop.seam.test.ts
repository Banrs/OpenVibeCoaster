import { describe, expect, it } from "vitest";
import {
  vec3,
  vec3Cross,
  vec3Dot,
  vec3Length,
  type Vec3,
} from "@openvibecoaster/core";
import { buildElement, createElement, defaultPose } from "./elements.js";
import {
  compileSemanticChain,
  defaultTolerances,
  diagnoseSeams,
} from "./solver.js";

const element = () =>
  createElement("verticalLoop", "verticalLoop-000", {
    height: 67,
    referenceSpeed: 38,
    bank: 0,
  });

const trackVector = (values: Float64Array, index: number): Vec3 =>
  vec3(values[index * 3]!, values[index * 3 + 1]!, values[index * 3 + 2]!);

describe("verticalLoop seam and frame authority", () => {
  it("keeps both seams inside every frozen hard tolerance", () => {
    const spans = buildElement(element(), defaultPose(), 38).solvedSpans;
    const seams = diagnoseSeams(spans, { referenceSpeed: 38 });
    expect(seams).toHaveLength(2);
    for (const seam of seams) {
      expect(seam.positionM).toBeLessThanOrEqual(defaultTolerances.positionM);
      expect(seam.tangentRad).toBeLessThanOrEqual(defaultTolerances.tangentRad);
      expect(seam.curvaturePerM).toBeLessThanOrEqual(
        defaultTolerances.curvaturePerM,
      );
      expect(seam.curvatureVectorJumpPerM).toBeLessThanOrEqual(
        defaultTolerances.curvatureVectorJumpPerM,
      );
      expect(seam.curvatureGradientPerM2).toBeLessThanOrEqual(
        defaultTolerances.curvatureGradientPerM2,
      );
      expect(seam.bankRad).toBeLessThanOrEqual(defaultTolerances.bankRad);
      expect(seam.bankDerivativeRadPerM).toBeLessThanOrEqual(
        defaultTolerances.bankDerivativeRadPerM,
      );
      expect(seam.bankSecondDerivativeRadPerM2).toBeLessThanOrEqual(
        defaultTolerances.bankSecondDerivativeRadPerM2,
      );
      expect(seam.specificForceJumpG).toBeLessThanOrEqual(
        defaultTolerances.specificForceJumpG,
      );
      expect(seam.hardResiduals.sustainedForceDeviationG).toBe(0);
    }
  });

  it("compiles one finite right-handed frame field without seam flips", () => {
    const compiled = compileSemanticChain([element()], {
      startPose: defaultPose(),
      referenceSpeed: 38,
      samples: 128,
    });
    expect(compiled.feasible).toBe(true);
    const track = compiled.track!;
    for (let index = 0; index < track.distances.length; index += 1) {
      const tangent = trackVector(track.tangents, index);
      const normal = trackVector(track.normals, index);
      const binormal = trackVector(track.binormals, index);
      expect([...tangent, ...normal, ...binormal].every(Number.isFinite)).toBe(
        true,
      );
      expect(vec3Length(tangent)).toBeCloseTo(1, 10);
      expect(vec3Length(normal)).toBeCloseTo(1, 10);
      expect(vec3Length(binormal)).toBeCloseTo(1, 10);
      expect(Math.abs(vec3Dot(tangent, normal))).toBeLessThan(1e-9);
      expect(Math.abs(vec3Dot(tangent, binormal))).toBeLessThan(1e-9);
      expect(Math.abs(vec3Dot(normal, binormal))).toBeLessThan(1e-9);
      expect(vec3Dot(vec3Cross(tangent, normal), binormal)).toBeGreaterThan(
        1 - 1e-9,
      );
      if (index > 0) {
        expect(
          vec3Dot(trackVector(track.normals, index - 1), normal),
        ).toBeGreaterThan(0);
        expect(
          vec3Dot(trackVector(track.binormals, index - 1), binormal),
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps legal boundary parameters and reports an incompatible endpoint", () => {
    const hard = createElement("verticalLoop", "verticalLoop-hard", {
      height: 130,
      referenceSpeed: 5,
      bank: 0,
    });
    const authored = { ...hard.parameters };
    const result = compileSemanticChain([hard], {
      startPose: defaultPose(),
      endPose: {
        position: vec3(10_000, 10_000, 10_000),
        tangent: vec3(1, 0, 0),
        normal: vec3(0, 1, 0),
        bank: 0,
      },
      referenceSpeed: 5,
    });
    expect(result.feasible).toBe(false);
    const failures = result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "fatal",
    );
    expect(
      failures.some(
        (diagnostic) =>
          /endpoint|endPose|position|closure/i.test(diagnostic.message) &&
          Number.isFinite(diagnostic.actual) &&
          Number.isFinite(diagnostic.limit),
      ),
    ).toBe(true);
    expect(hard.parameters).toEqual(authored);
  });
});
