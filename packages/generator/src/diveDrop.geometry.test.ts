import { describe, expect, it } from "vitest";
import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
  vec3Add,
  vec3Dot,
  vec3Length,
  vec3Scale,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import {
  buildElement,
  createElement,
  DIVE_DROP_SPAN_COUNT,
} from "./elements.js";
import type { Pose } from "./types.js";
import { defaultTolerances } from "./solver.js";

const startPose: Pose = {
  position: vec3(0, 240, 0),
  tangent: vec3(1, 0, 0),
  normal: vec3(0, 1, 0),
  bank: 0,
};

const buildDrop = (angleDeg: number) =>
  buildElement(
    createElement("diveDrop", "diveDrop-000", {
      dropHeight: 210,
      angleDeg,
      approachRadius: 90,
      exitRadius: 70,
      bank: 0,
    }),
    startPose,
    44,
  );

const positionFromCoefficients = (span: SolvedSpan) =>
  SeventhOrderHermiteSpan.fromCoefficients<Vec3>(span.positionCoefficients!);

const curvatureVector = (span: SolvedSpan, u: number): Vec3 => {
  const d1 = span.span.derivative(u, 1);
  const d2 = span.span.derivative(u, 2);
  const speedSquared = vec3Dot(d1, d1);
  return vec3Add(
    vec3Scale(d2, 1 / speedSquared),
    vec3Scale(d1, -vec3Dot(d1, d2) / speedSquared ** 2),
  );
};

const curvatureGradient = (span: SolvedSpan, u: number): Vec3 => {
  const d1 = span.span.derivative(u, 1);
  const d2 = span.span.derivative(u, 2);
  const d3 = span.span.derivative(u, 3);
  const speedSquared = vec3Dot(d1, d1);
  const projection = vec3Dot(d1, d2);
  const projectionDerivative = vec3Dot(d2, d2) + vec3Dot(d1, d3);
  const derivative = vec3Add(
    vec3Scale(d3, 1 / speedSquared),
    vec3Add(
      vec3Scale(d2, (-3 * projection) / speedSquared ** 2),
      vec3Scale(
        d1,
        -projectionDerivative / speedSquared ** 2 +
          (4 * projection ** 2) / speedSquared ** 3,
      ),
    ),
  );
  return vec3Scale(derivative, 1 / Math.sqrt(speedSquared));
};

describe("diveDrop analytic geometry", () => {
  it("stores three canonical seventh-order position and quintic roll spans", () => {
    const built = buildDrop(110);
    expect(DIVE_DROP_SPAN_COUNT).toBe(3);
    expect(built.solvedSpans).toHaveLength(DIVE_DROP_SPAN_COUNT);
    expect(built.solvedSpans.map((span) => span.id)).toEqual([
      "diveDrop-000#0",
      "diveDrop-000#1",
      "diveDrop-000#2",
    ]);
    for (const span of built.solvedSpans) {
      expect(span.kind).toBe("diveDrop");
      expect(span.length).toBeGreaterThan(0);
      expect(Number.isFinite(span.length ?? Number.NaN)).toBe(true);
      expect(span.positionCoefficients).toHaveLength(3);
      for (const row of span.positionCoefficients!) {
        expect(row).toHaveLength(8);
        expect(row.every(Number.isFinite)).toBe(true);
      }
      expect(span.rollCoefficients).toHaveLength(6);
      expect(span.rollCoefficients!.every(Number.isFinite)).toBe(true);
      const position = positionFromCoefficients(span);
      const roll = QuinticScalarSpan.fromCoefficients(span.rollCoefficients!);
      for (const u of [0, 0.2, 0.5, 0.8, 1]) {
        for (const order of [0, 1, 2, 3])
          expect(position.derivative(u, order)).toEqual(
            span.span.derivative(u, order),
          );
        for (const order of [0, 1, 2])
          expect(roll.derivative(u, order)).toEqual(
            span.bank!.derivative(u, order),
          );
      }
    }
  });

  it("treats authored height as vertical drop and maps legal angles geometrically", () => {
    const built = buildDrop(110);
    const drop = built.solvedSpans[1]!;
    const middleDerivative = drop.span.derivative(0.5, 1);
    const pitchDeg =
      (Math.atan2(
        middleDerivative[1],
        Math.hypot(middleDerivative[0], middleDerivative[2]),
      ) *
        180) /
      Math.PI;
    expect(pitchDeg).toBeCloseTo(-70, 0);

    const verticalDerivative = buildDrop(90).solvedSpans[1]!.span.derivative(
      0.5,
      1,
    );
    const verticalPitchDeg =
      (Math.atan2(
        verticalDerivative[1],
        Math.hypot(verticalDerivative[0], verticalDerivative[2]),
      ) *
        180) /
      Math.PI;
    expect(verticalPitchDeg).toBeCloseTo(-90, 6);

    const y = Array.from({ length: 257 }, (_, index) =>
      drop.span.position(index / 256),
    ).map((point) => point[1]);
    expect(Math.max(...y) - Math.min(...y)).toBeGreaterThanOrEqual(207);
    expect(Math.max(...y) - Math.min(...y)).toBeLessThanOrEqual(213);
  });

  it("recovers nearly level with zero analytic exit curvature and gradient", () => {
    const built = buildDrop(110);
    const recovery = built.solvedSpans[2]!;
    const tangent = recovery.span.derivative(1, 1);
    const pitch = Math.atan2(tangent[1], Math.hypot(tangent[0], tangent[2]));
    expect(Math.abs(pitch)).toBeLessThan((10 * Math.PI) / 180);
    expect(vec3Length(curvatureVector(recovery, 1))).toBeLessThanOrEqual(
      defaultTolerances.curvatureVectorJumpPerM,
    );
    expect(vec3Length(curvatureGradient(recovery, 1))).toBeLessThanOrEqual(
      defaultTolerances.curvatureGradientPerM2,
    );
  });
});
