import { describe, expect, it } from "vitest";
import { QuinticScalarSpan, vec3 } from "@openvibecoaster/core";
import type { SolvedSpan } from "@openvibecoaster/core";
import type { ParametricSpan, Vec3 } from "@openvibecoaster/core";
import { diagnoseSeams } from "./solver";

const makeGeometry = (q: number, qU: number): ParametricSpan<Vec3> => ({
  position: () => vec3(0, 0, 0),
  derivative: (_u: number, order = 1): Vec3 => {
    if (order === 1) return vec3(q, 0, 0);
    if (order === 2) return vec3(qU, 0, 0);
    if (order === 3) return vec3(0, 0, 0);
    return vec3(0, 0, 0) as unknown as Vec3;
  },
});

describe("bank physical derivative regression", () => {
  it("reports ~0 when physical bank slope and curvature match despite different parameter speeds", () => {
    const betaS = 0.05; // rad/m
    const betaSS = 0.002; // rad/m^2

    const qL = 10;
    const qUL = 3;
    const qR = 20;
    const qUR = -2;

    const betaUL = betaS * qL;
    const betaUUL = qL * qL * betaSS + betaS * qUL;
    const betaUR = betaS * qR;
    const betaUUR = qR * qR * betaSS + betaS * qUR;

    // ensure raw parameter derivatives differ
    expect(Math.abs(betaUL - betaUR)).toBeGreaterThan(1e-6);
    expect(Math.abs(betaUUL - betaUUR)).toBeGreaterThan(1e-6);

    const seamBank = 0.2;
    const leftBank = new QuinticScalarSpan({
      v0: seamBank,
      d10: 0,
      d20: 0,
      v1: seamBank,
      d11: betaUL,
      d21: betaUUL,
    });
    const rightBank = new QuinticScalarSpan({
      v0: seamBank,
      d10: betaUR,
      d20: betaUUR,
      v1: seamBank,
      d11: 0,
      d21: 0,
    });

    // sanity: raw derivs differ
    expect(leftBank.derivative(1, 1)).toBeCloseTo(betaUL, 10);
    expect(rightBank.derivative(0, 1)).toBeCloseTo(betaUR, 10);
    expect(leftBank.derivative(1, 2)).toBeCloseTo(betaUUL, 10);
    expect(rightBank.derivative(0, 2)).toBeCloseTo(betaUUR, 10);

    const left: SolvedSpan = {
      id: "left",
      span: makeGeometry(qL, qUL),
      bank: leftBank,
    };
    const right: SolvedSpan = {
      id: "right",
      span: makeGeometry(qR, qUR),
      bank: rightBank,
    };

    const [seam] = diagnoseSeams([left, right]);
    expect(seam).toBeDefined();
    // physical derivatives must match => residuals ~0 within tolerant 1e-4
    expect(seam!.bankRad).toBeLessThan(1e-9);
    expect(seam!.bankDerivativeRadPerM).toBeLessThan(1e-4);
    expect(seam!.bankSecondDerivativeRadPerM2).toBeLessThan(1e-4);

    // also verify physical values are approximately betaS / betaSS via explicit formula
    // (not strictly required but documents intent)
    const qLcalc = Math.hypot(...left.span.derivative(1, 1));
    const qRcalc = Math.hypot(...right.span.derivative(0, 1));
    const betaSL = leftBank.derivative(1, 1) / qLcalc;
    const betaSR = rightBank.derivative(0, 1) / qRcalc;
    expect(Math.abs(betaSL - betaSR)).toBeLessThan(1e-9);
    expect(Math.abs(betaSL - betaS)).toBeLessThan(1e-9);
  });
});
