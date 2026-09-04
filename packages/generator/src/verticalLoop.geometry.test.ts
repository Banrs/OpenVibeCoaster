import { describe, expect, it } from "vitest";
import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
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
  defaultPose,
  VERTICAL_LOOP_SPAN_COUNT,
} from "./elements.js";
import { defaultTolerances } from "./solver.js";

const buildSpeed = (referenceSpeed: number) =>
  buildElement(
    createElement("verticalLoop", "verticalLoop-000", {
      height: 67,
      referenceSpeed,
      bank: 0,
    }),
    defaultPose(),
    referenceSpeed,
  );

const localHeight = (spans: readonly SolvedSpan[]): number => {
  const heights = spans.flatMap((span) =>
    Array.from({ length: 257 }, (_, index) =>
      span.span.position(index / 256),
    ).map((point) => point[1]),
  );
  return Math.max(...heights) - Math.min(...heights);
};

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

describe("verticalLoop analytic geometry", () => {
  it("stores three canonical seventh-order position and quintic roll spans", () => {
    const built = buildSpeed(38);
    expect(VERTICAL_LOOP_SPAN_COUNT).toBe(3);
    expect(built.solvedSpans).toHaveLength(VERTICAL_LOOP_SPAN_COUNT);
    expect(built.solvedSpans.map((span) => span.id)).toEqual([
      "verticalLoop-000#0",
      "verticalLoop-000#1",
      "verticalLoop-000#2",
    ]);
    for (const span of built.solvedSpans) {
      expect(span.kind).toBe("verticalLoop");
      expect(span.zones).toEqual(["verticalLoop"]);
      expect(span.length).toBeGreaterThan(0);
      expect(Number.isFinite(span.length ?? Number.NaN)).toBe(true);
      expect(span.positionCoefficients).toHaveLength(3);
      for (const row of span.positionCoefficients!) {
        expect(row).toHaveLength(8);
        expect(row.every(Number.isFinite)).toBe(true);
      }
      expect(span.rollCoefficients).toHaveLength(6);
      expect(span.rollCoefficients!.every(Number.isFinite)).toBe(true);
      const position = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
        span.positionCoefficients!,
      );
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

  it("holds the authored height, exits level, and has flat-curvature endpoints", () => {
    const built = buildSpeed(38);
    expect(localHeight(built.solvedSpans)).toBeGreaterThanOrEqual(66);
    expect(localHeight(built.solvedSpans)).toBeLessThanOrEqual(68);
    expect(built.solvedSpans[0]!.span.position(1)[2]).toBeCloseTo(
      67 / 2.05 / 2,
      10,
    );
    expect(
      vec3Dot(built.endPose.tangent, defaultPose().tangent),
    ).toBeGreaterThan(Math.cos(Math.PI / 180));
    expect(Math.abs(built.endPose.tangent[1])).toBeLessThan(
      Math.sin(Math.PI / 180),
    );
    const first = built.solvedSpans[0]!;
    const last = built.solvedSpans[2]!;
    expect(vec3Length(curvatureVector(first, 0))).toBeLessThanOrEqual(
      defaultTolerances.curvatureVectorJumpPerM,
    );
    expect(vec3Length(curvatureGradient(first, 0))).toBeLessThanOrEqual(
      defaultTolerances.curvatureGradientPerM2,
    );
    expect(vec3Length(curvatureVector(last, 1))).toBeLessThanOrEqual(
      defaultTolerances.curvatureVectorJumpPerM,
    );
    expect(vec3Length(curvatureGradient(last, 1))).toBeLessThanOrEqual(
      defaultTolerances.curvatureGradientPerM2,
    );
    for (const span of built.solvedSpans)
      for (const u of [0, 0.25, 0.5, 0.75, 1])
        for (const order of [0, 1, 2])
          expect(span.bank!.derivative(u, order)).toBeCloseTo(0, 12);
  });

  it("uses reference speed to shape the apex while preserving height", () => {
    const slow = buildSpeed(24);
    const fast = buildSpeed(50);
    expect(localHeight(slow.solvedSpans)).toBeGreaterThanOrEqual(66);
    expect(localHeight(slow.solvedSpans)).toBeLessThanOrEqual(68);
    expect(localHeight(fast.solvedSpans)).toBeGreaterThanOrEqual(66);
    expect(localHeight(fast.solvedSpans)).toBeLessThanOrEqual(68);
    expect(fast.solvedSpans[1]!.positionCoefficients).not.toEqual(
      slow.solvedSpans[1]!.positionCoefficients,
    );
    expect(
      vec3Length(curvatureVector(fast.solvedSpans[1]!, 0.5)),
    ).not.toBeCloseTo(
      vec3Length(curvatureVector(slow.solvedSpans[1]!, 0.5)),
      10,
    );
  });
});
