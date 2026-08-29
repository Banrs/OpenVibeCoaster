import { describe, expect, it } from "vitest";
import {
  SeventhOrderHermiteSpan,
  vec3,
  type Vec3,
} from "@openvibecoaster/core";
import { validateClearance } from "./clearance";
import {
  CertifiedWorkBudget,
  certifiedPolynomialBounds,
  nextDown,
  nextUp,
  WorkBudgetExceeded,
} from "./polynomial-bounds";

describe("certified polynomial bounds", () => {
  it("steps signed zero outward in both directions", () => {
    expect(Object.is(nextDown(0), -Number.MIN_VALUE)).toBe(true);
    expect(Object.is(nextUp(-0), Number.MIN_VALUE)).toBe(true);
  });

  it("encloses dense values after catastrophic cancellation", () => {
    const coefficients = [
      [1e16, -1e16, 1e16, -1e16, 1e16, -1e16, 1e16, -1e16],
      [1e-12, 1e16, -1e16, 1e16, -1e16, 1e16, -1e16, 1e16],
      [0, 1, -7, 21, -35, 35, -21, 7],
    ] as const;
    const bounds = certifiedPolynomialBounds(
      coefficients,
      0.123456789,
      0.987654321,
      new CertifiedWorkBudget(100_000),
    );
    for (let index = 0; index <= 10_000; index += 1) {
      const u = 0.123456789 + (0.987654321 - 0.123456789) * (index / 10_000);
      for (const [row, range] of coefficients.map(
        (row, component) =>
          [row, [bounds.min[component]!, bounds.max[component]!]] as const,
      )) {
        let value = 0;
        for (let power = row.length - 1; power >= 0; power -= 1)
          value = value * u + row[power]!;
        expect(value).toBeGreaterThanOrEqual(range[0]!);
        expect(value).toBeLessThanOrEqual(range[1]!);
      }
    }
  });

  it("rejects non-finite polynomial coefficients as uncertified", () => {
    const span = {
      id: "nan-coefficients",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, Number.NaN, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], undefined);
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
    expect(
      diagnostics.every((item) =>
        [item.actual, item.limit, item.margin].every(
          (value) => value === undefined || Number.isFinite(value),
        ),
      ),
    ).toBe(true);
  });

  it("rejects non-finite environment distances fatally", () => {
    const span = {
      id: "finite-track",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 1, 0), vec3(10, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], {
      signedDistance: () => Number.POSITIVE_INFINITY,
      raycast: () => undefined,
    });
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it("rejects infinite polynomial coefficients fatally", () => {
    const span = {
      id: "infinite-coefficients",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], undefined);
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "uses finite stored coefficients instead of a lying runtime position (%s)",
    (invalidPosition) => {
      const finiteRows = [
        [0, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ] as const;
      const span = {
        id: "non-finite-position",
        span: {
          position: () => vec3(invalidPosition, 0, 0),
          derivative: () => vec3(1, 0, 0),
        },
        positionCoefficients: finiteRows,
        bank: { position: () => 0, derivative: () => 0 },
      };
      const diagnostics = validateClearance([span], undefined);
      expect(diagnostics.some((item) => item.severity === "fatal")).toBe(false);
      expect(diagnostics).toEqual([]);
    },
  );

  it("certifies collisions from stored coefficients when public spans lie", () => {
    const firstGeometry = SeventhOrderHermiteSpan.line<Vec3>(
      vec3(0, 0, 0),
      vec3(10, 0, 0),
    );
    const secondGeometry = SeventhOrderHermiteSpan.line<Vec3>(
      vec3(5, -1, 0),
      vec3(5, 1, 0),
    );
    const first = {
      id: "canonical-first",
      span: SeventhOrderHermiteSpan.line<Vec3>(
        vec3(0, 100, 0),
        vec3(10, 100, 0),
      ),
      positionCoefficients: firstGeometry.coefficients,
      bank: { position: () => 0, derivative: () => 0 },
    };
    const second = {
      id: "canonical-second",
      span: SeventhOrderHermiteSpan.line<Vec3>(
        vec3(500, -100, 0),
        vec3(500, -99, 0),
      ),
      positionCoefficients: secondGeometry.coefficients,
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([first, second], undefined, {
      trainEnvelopeRadius: 0.1,
      samplesPerSpan: 5,
    });
    expect(diagnostics.some((item) => item.code === "TRACK_CLEARANCE")).toBe(
      true,
    );
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(false);
  });

  it("fails closed when finite coordinates or radii overflow distance arithmetic", () => {
    const first = {
      id: "overflow-first",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [Number.MAX_VALUE, 0, 0, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const second = {
      id: "overflow-second",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [-Number.MAX_VALUE, 0, 0, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const coordinateDiagnostics = validateClearance(
      [first, second],
      undefined,
      {
        samplesPerSpan: 2,
        trainEnvelopeRadius: 1,
      },
    );
    const radiusDiagnostics = validateClearance(
      [
        {
          id: "overflow-radius",
          span: SeventhOrderHermiteSpan.line<Vec3>(
            vec3(0, 1, 0),
            vec3(1, 1, 0),
          ),
          bank: { position: () => 0, derivative: () => 0 },
        },
      ],
      undefined,
      { trainEnvelopeRadius: Number.MAX_VALUE },
    );
    for (const diagnostics of [coordinateDiagnostics, radiusDiagnostics]) {
      expect(
        diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
      ).toBe(true);
      expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
      for (const diagnostic of diagnostics) {
        expect(
          [diagnostic.actual, diagnostic.limit, diagnostic.margin].every(
            (value) => value === undefined || Number.isFinite(value),
          ),
        ).toBe(true);
        if (diagnostic.location) {
          expect(Number.isFinite(diagnostic.location.s)).toBe(true);
          if (diagnostic.location.position)
            expect(diagnostic.location.position.every(Number.isFinite)).toBe(
              true,
            );
        }
      }
    }
  });

  it("rejects non-finite environment distances fatally", () => {
    const span = {
      id: "finite-track-for-nan-environment",
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 1, 0), vec3(1, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], {
      signedDistance: () => Number.NaN,
      raycast: () => undefined,
    });
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it("charges interval arithmetic against the shared work budget", () => {
    expect(() =>
      certifiedPolynomialBounds(
        [
          [0, 1, 0, 0, 0, 0, 0, 0],
          [0, 1, 0, 0, 0, 0, 0, 0],
          [0, 1, 0, 0, 0, 0, 0, 0],
        ],
        0,
        1,
        new CertifiedWorkBudget(1),
      ),
    ).toThrow(WorkBudgetExceeded);
  });

  it("fails before enumerating an unsafe huge spatial range", () => {
    const span = {
      id: "huge-span",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, 1e300, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], undefined, {
      maxWork: 8,
    });
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it("fails before enumerating a huge finite spatial range", () => {
    const span = {
      id: "huge-finite-span",
      span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
        [0, 100_000, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      bank: { position: () => 0, derivative: () => 0 },
    };
    const diagnostics = validateClearance([span], undefined, {
      maxWork: 10_000,
    });
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });

  it("charges candidate preprocessing before candidate explosion", () => {
    const spans = Array.from({ length: 10 }, (_, index) => ({
      id: `candidate-${index}`,
      span: SeventhOrderHermiteSpan.line<Vec3>(vec3(0, 1, 0), vec3(1, 1, 0)),
      bank: { position: () => 0, derivative: () => 0 },
    }));
    const diagnostics = validateClearance(spans, undefined, {
      maxWork: 1_000,
    });
    expect(
      diagnostics.some((item) => item.code === "CLEARANCE_UNCERTIFIED"),
    ).toBe(true);
    expect(diagnostics.some((item) => item.severity === "fatal")).toBe(true);
  });
});
