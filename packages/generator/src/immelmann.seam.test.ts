import { describe, expect, it } from "vitest";
import {
  vec3,
  vec3Cross,
  vec3Dot,
  vec3Length,
  type Vec3,
} from "@openvibecoaster/core";
import {
  buildElement,
  createElement,
  defaultPose,
} from "./elements.js";
import {
  compileSemanticChain,
  defaultTolerances,
  diagnoseSeams,
} from "./solver.js";

const element = (exitHeadingDeg = 180) =>
  createElement("immelmann", "immelmann-000", {
    height: 81,
    exitHeadingDeg,
    bank: 0,
  });

const trackVector = (values: Float64Array, index: number): Vec3 =>
  vec3(values[index * 3]!, values[index * 3 + 1]!, values[index * 3 + 2]!);

describe("immelmann seam and frame authority", () => {
  it("keeps every hard analytic residual inside the frozen seam tolerances", () => {
    const spans = buildElement(element(), defaultPose(), 44).solvedSpans;
    const seams = diagnoseSeams(spans, { referenceSpeed: 44 });
    expect(seams).toHaveLength(1);
    const seam = seams[0]!;
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
  });

  for (const heading of [180, 90, -90])
    it(`transports one right-handed frame field through ${heading} degree exit`, () => {
      const compiled = compileSemanticChain([element(heading)], {
        startPose: defaultPose(),
        referenceSpeed: 44,
        samples: 128,
      });
      expect(compiled.feasible).toBe(true);
      const track = compiled.track!;
      for (let index = 0; index < track.distances.length; index += 1) {
        const tangent = trackVector(track.tangents, index);
        const normal = trackVector(track.normals, index);
        const binormal = trackVector(track.binormals, index);
        expect(
          [...tangent, ...normal, ...binormal].every(Number.isFinite),
        ).toBe(true);
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
      const seamIndex = track.elementBoundaries[1]!;
      expect(
        vec3Dot(
          trackVector(track.normals, Math.max(0, seamIndex - 1)),
          trackVector(track.normals, seamIndex),
        ),
      ).toBeGreaterThan(0);
      expect(
        vec3Dot(
          trackVector(track.binormals, Math.max(0, seamIndex - 1)),
          trackVector(track.binormals, seamIndex),
        ),
      ).toBeGreaterThan(0);
    });
});
