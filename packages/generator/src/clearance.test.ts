import { describe, expect, it } from "vitest";
import {
  SeventhOrderHermiteSpan,
  vec3,
  type SolvedSpan,
  type Vec3,
} from "@openvibecoaster/core";
import { validateClearance } from "./clearance";

const bank = { position: () => 0, derivative: () => 0 };

const pad = (values: readonly number[]): number[] =>
  Array.from({ length: 8 }, (_, index) => values[index] ?? 0);

const multiply = (
  left: readonly number[],
  right: readonly number[],
): number[] => {
  const result = Array.from(
    { length: Math.min(8, left.length + right.length - 1) },
    () => 0,
  );
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1)
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const index = leftIndex + rightIndex;
      if (index < result.length)
        result[index]! += left[leftIndex]! * right[rightIndex]!;
    }
  return result;
};

const narrowLoopRows = (
  gap = 0,
  center = 0.37,
  halfWidth = 0.003,
): readonly (readonly number[])[] => {
  const shifted = [-center, 1];
  const shiftedSquared = multiply(shifted, shifted);
  shiftedSquared[0]! -= halfWidth ** 2;
  const shiftedFourth = multiply(
    multiply(shifted, shifted),
    multiply(shifted, shifted),
  );
  shiftedFourth[0]! += 1 / 8;
  const loop = multiply(multiply(shifted, shiftedSquared), shiftedFourth).map(
    (value) => value * 800,
  );
  loop[0]! -= (gap * center) / (2 * halfWidth);
  loop[1]! += gap / (2 * halfWidth);
  return [pad(shiftedSquared.map((value) => value * 800)), pad(loop), pad([])];
};

const polynomialSpan = (
  id: string,
  rows: readonly (readonly number[])[],
): SolvedSpan => ({
  id,
  span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>(rows),
  positionCoefficients: rows,
  bank,
});

const transformRows = (
  rows: readonly (readonly number[])[],
): readonly (readonly number[])[] => {
  const angle = 0.73;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const translation = vec3(41, -19, 7);
  return [0, 1, 2].map((component) =>
    Array.from({ length: 8 }, (_, power) => {
      const x = rows[0]![power]!;
      const y = rows[1]![power]!;
      const z = rows[2]![power]!;
      const rotated = vec3(cosine * x - sine * z, y, sine * x + cosine * z);
      return rotated[component]! + (power === 0 ? translation[component]! : 0);
    }),
  );
};

describe("certified same-span clearance", () => {
  it("detects the reviewer figure-eight through the public default search", () => {
    const figureEight = {
      id: "figure-eight",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0.1875, -1, 1, 0, 0, 0, 0, 0],
        [4, 0, 0, 0, 0, 0, 0, 0],
        [-0.09375, -0.3125, -0.5, 1, 0, 0, 0, 0],
      ]),
      bank,
    };

    const diagnostics = validateClearance([figureEight], undefined, {
      trainEnvelopeRadius: 1,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TRACK_CLEARANCE" }),
      ]),
    );
  });

  it("detects a narrow degree-seven loop contained inside one coarse interval", () => {
    const diagnostics = validateClearance(
      [polynomialSpan("narrow-loop", narrowLoopRows())],
      undefined,
      { trainEnvelopeRadius: 0.001 },
    );
    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
  });

  it("detects a loop with a one-hundred-thousandth parameter half-width", () => {
    const diagnostics = validateClearance(
      [polynomialSpan("subdivision-loop", narrowLoopRows(0, 0.37, 0.00001))],
      undefined,
      { trainEnvelopeRadius: 0.000001 },
    );

    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
  });

  it("detects a degree-seven loop split across adjacent coarse intervals", () => {
    const diagnostics = validateClearance(
      [polynomialSpan("boundary-loop", narrowLoopRows(0, 0.375))],
      undefined,
      { trainEnvelopeRadius: 0.001 },
    );

    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
  });

  it("certifies a nearby degree-seven near-miss without a false collision", () => {
    const diagnostics = validateClearance(
      [polynomialSpan("narrow-near-miss", narrowLoopRows(0.02))],
      undefined,
      { trainEnvelopeRadius: 0.004 },
    );

    expect(diagnostics).toEqual([]);
  });

  it("fails closed when same-span subdivision cannot certify a singular leaf", () => {
    const center = 0.37;
    const diagnostics = validateClearance(
      [
        polynomialSpan("singular-cusp", [
          pad([center ** 2, -2 * center, 1]),
          pad([-(center ** 3), 3 * center ** 2, -3 * center, 1]),
          pad([]),
        ]),
      ],
      undefined,
      { maxDepth: 0 },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "fatal",
        }),
      ]),
    );
  });

  it("excludes only the legitimate endpoint adjacency between open spans", () => {
    const first = {
      id: "endpoint-first",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 0, 0), vec3(10, 0, 0)),
      bank,
    };
    const second = {
      id: "endpoint-second",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(10, 0, 0), vec3(10, 0, 10)),
      bank,
    };

    expect(validateClearance([first, second], undefined)).toEqual([]);
  });

  it("excludes the legitimate endpoint adjacency across a closed seam", () => {
    const spans = [
      {
        id: "seam-first",
        span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 0, 0), vec3(10, 0, 0)),
        bank,
      },
      {
        id: "seam-middle",
        span: SeventhOrderHermiteSpan.line<Vec3>(
          vec3(10, 0, 0),
          vec3(10, 0, 10),
        ),
        bank,
      },
      {
        id: "seam-last",
        span: SeventhOrderHermiteSpan.line<Vec3>(
          vec3(10, 0, 10),
          vec3(0, 0, 0),
        ),
        bank,
      },
    ];

    expect(validateClearance(spans, undefined, { closed: true })).toEqual([]);
  });

  it("detects the same narrow crossing after a rigid transform", () => {
    const transformed = polynomialSpan(
      "transformed-narrow-loop",
      transformRows(narrowLoopRows()),
    );

    const diagnostics = validateClearance([transformed], undefined, {
      trainEnvelopeRadius: 0.001,
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TRACK_CLEARANCE" }),
      ]),
    );
  });

  it("returns deterministic finite exact evidence for a same-span crossing", () => {
    const span = polynomialSpan("evidence-loop", narrowLoopRows());
    const options = { trainEnvelopeRadius: 0.001 } as const;
    const first = validateClearance([span], undefined, options);
    const second = validateClearance([span], undefined, options);

    expect(second).toEqual(first);
    const failure = first.find((item) => item.code === "TRACK_CLEARANCE");
    expect(failure).toBeDefined();
    expect(failure?.relatedIds).toEqual(["evidence-loop", "evidence-loop"]);
    expect(failure?.location?.position).toHaveLength(3);
    expect(
      [
        failure?.location?.s,
        ...(failure?.location?.position ?? []),
        failure?.actual,
        failure?.limit,
        failure?.margin,
      ].every((value) => typeof value === "number" && Number.isFinite(value)),
    ).toBe(true);
    expect(failure?.actual).toBeLessThanOrEqual(failure?.limit ?? -1);
    expect(failure?.margin).toBe(failure!.actual! - failure!.limit!);
  });
});
