import { describe, expect, it } from "vitest";
import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import {
  buildElement,
  createElement,
  defaultPose,
  IMMELMANN_SPAN_COUNT,
} from "./elements.js";

const buildHeading = (exitHeadingDeg: number) =>
  buildElement(
    createElement("immelmann", "immelmann-000", {
      height: 81,
      exitHeadingDeg,
      bank: 0,
    }),
    defaultPose(),
    44,
  );

const localHeight = (spans: readonly SolvedSpan[]): number => {
  const heights = spans.flatMap((span) =>
    Array.from({ length: 257 }, (_, index) =>
      span.span.position(index / 256),
    ).map((point) => point[1]),
  );
  return Math.max(...heights) - Math.min(...heights);
};

const yawDeg = (tangent: Vec3): number =>
  (Math.atan2(tangent[0], tangent[2]) * 180) / Math.PI;

describe("immelmann analytic geometry", () => {
  it("stores two canonical seventh-order position and quintic roll spans", () => {
    const built = buildHeading(180);
    expect(IMMELMANN_SPAN_COUNT).toBe(2);
    expect(built.solvedSpans).toHaveLength(IMMELMANN_SPAN_COUNT);
    expect(built.solvedSpans.map((span) => span.id)).toEqual([
      "immelmann-000#0",
      "immelmann-000#1",
    ]);
    for (const span of built.solvedSpans) {
      expect(span.kind).toBe("immelmann");
      expect(span.zones).toEqual(["immelmann"]);
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

  it("reaches the authored height and exits at the authored relative heading", () => {
    const built = buildHeading(180);
    expect(localHeight(built.solvedSpans)).toBeGreaterThanOrEqual(80);
    expect(localHeight(built.solvedSpans)).toBeLessThanOrEqual(82);
    expect(Math.abs(yawDeg(built.endPose.tangent))).toBeCloseTo(180, 0);
  });

  it("preserves handed +90/-90 exits without mirroring IDs, height, or bank", () => {
    const positive = buildHeading(90);
    const negative = buildHeading(-90);
    expect(yawDeg(positive.endPose.tangent)).toBeCloseTo(90, 0);
    expect(yawDeg(negative.endPose.tangent)).toBeCloseTo(-90, 0);
    expect(positive.endPose.position[0]).toBeGreaterThan(5);
    expect(negative.endPose.position[0]).toBeLessThan(-5);
    expect(localHeight(positive.solvedSpans)).toBeCloseTo(
      localHeight(negative.solvedSpans),
      10,
    );
    expect(positive.solvedSpans.map((span) => span.id)).toEqual(
      negative.solvedSpans.map((span) => span.id),
    );
    expect(positive.solvedSpans.map((span) => span.rollCoefficients)).toEqual(
      negative.solvedSpans.map((span) => span.rollCoefficients),
    );
  });
});
