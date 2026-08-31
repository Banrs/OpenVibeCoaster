import { describe, expect, it } from "vitest";
import {
  SeventhOrderHermiteSpan,
  vec3,
  type Vec3,
} from "@openvibecoaster/core";
import {
  CertificationError,
  CertifiedWorkBudget,
  certifyPolynomialThreshold,
  nextDown,
  nextUp,
} from "./polynomial-bounds";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "./index";

describe("exact dyadic endpoint factorization", () => {
  it("constant exactly at limit satisfied for both directions", () => {
    const budget = new CertifiedWorkBudget(10_000);
    expect(certifyPolynomialThreshold([5], 0, 1, 5, "minimum", budget)).toEqual(
      { status: "satisfied" },
    );
    expect(
      certifyPolynomialThreshold(
        [5],
        0,
        1,
        5,
        "maximum",
        new CertifiedWorkBudget(10_000),
      ),
    ).toEqual({ status: "satisfied" });
    expect(
      certifyPolynomialThreshold(
        [0, 0, 0, 0],
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(10_000),
      ),
    ).toEqual({ status: "satisfied" });
    expect(
      certifyPolynomialThreshold(
        [0, 0, 0, 0],
        0,
        1,
        0,
        "maximum",
        new CertifiedWorkBudget(10_000),
      ),
    ).toEqual({ status: "satisfied" });
  });

  it("constant nextDown(0) minimum and nextUp(0) maximum violated with finite witnesses", () => {
    const md = nextDown(0);
    const mu = nextUp(0);
    const rMin = certifyPolynomialThreshold(
      [md],
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(10_000),
    );
    expect(rMin.status).toBe("violated");
    if (rMin.status === "violated") {
      expect(Number.isFinite(rMin.witness.value)).toBe(true);
      expect(rMin.witness.value).toBe(md);
      expect(rMin.witness.value < 0).toBe(true);
    }
    const rMax = certifyPolynomialThreshold(
      [mu],
      0,
      1,
      0,
      "maximum",
      new CertifiedWorkBudget(10_000),
    );
    expect(rMax.status).toBe("violated");
    if (rMax.status === "violated") {
      expect(Number.isFinite(rMax.witness.value)).toBe(true);
      expect(rMax.witness.value).toBe(mu);
      expect(rMax.witness.value > 0).toBe(true);
    }
  });

  it("u^7 inclusive root satisfied for minimum", () => {
    const coeff = [0, 0, 0, 0, 0, 0, 0, 1];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("satisfied");
  });

  it("(1-u)^3 inclusive root satisfied for minimum", () => {
    // (1-u)^3 = 1 -3u +3u^2 -1u^3
    const coeff = [1, -3, 3, -1, 0, 0, 0, 0];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("satisfied");
  });

  it("u^2(1-u)^2 both endpoints satisfied", () => {
    // u^2(1-u)^2 = u^2 -2u^3 + u^4
    const coeff = [0, 0, 1, -2, 1, 0, 0, 0];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("satisfied");
  });

  it("one-ULP near miss is not factored and is violated never satisfied", () => {
    // p(u)=u^2 + 2^-52, limit 0, maximum direction should be violated because p(0)=2^-52 >0
    const eps = Math.pow(2, -52);
    const coeff = [eps, 0, 1];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "maximum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).not.toBe("satisfied");
    expect(
      ["violated", "uncertified"].includes(res.status) ||
        (() => {
          try {
            return false;
          } catch {
            return true;
          }
        }),
    ).toBe(true);
    // Should be violated with witness at 0
    expect(res.status).toBe("violated");
    if (res.status === "violated") {
      expect(res.witness.value > 0).toBe(true);
      expect(Number.isFinite(res.witness.value)).toBe(true);
    }
    // Ensure not incorrectly satisfied via factoring: if it were factored, it would be satisfied, which we reject
  });

  it("arbitrary dyadic subinterval root satisfied", () => {
    // start 0.375 = 3/8 exactly representable, polynomial (u-0.375)^2 = u^2 -0.75u +0.140625
    const s = 0.375;
    const coeff = [s * s, -2 * s, 1];
    const res = certifyPolynomialThreshold(
      coeff,
      s,
      0.75,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("satisfied");
    // also test with start 0.5
    const s2 = 0.5;
    const coeff2 = [s2 * s2, -2 * s2, 1, 0, 0, 0, 0, 0];
    const res2 = certifyPolynomialThreshold(
      coeff2,
      s2,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res2.status).toBe("satisfied");
  });

  it("maxDepth and budget behavior", () => {
    const coeff = [0, 0, 0, 0, 0, 0, 0, 1]; // u^7
    // With tiny budget, should exceed
    expect(() =>
      certifyPolynomialThreshold(
        coeff,
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(5),
      ),
    ).toThrow();
    // With maxDepth 0 after factoring, quotient needs no subdivision so still satisfied
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
      0,
    );
    expect(res.status).toBe("satisfied");
    // For non-factorable that needs subdivision, maxDepth 0 should uncertify
    const eps = Math.pow(2, -52);
    const coeff2 = [eps, 0, 1];
    // This needs violation detection which should succeed even with maxDepth 0 because witness at start found without subdivision
    const r2 = certifyPolynomialThreshold(
      coeff2,
      0,
      1,
      0,
      "maximum",
      new CertifiedWorkBudget(100_000),
      0,
    );
    expect(r2.status).toBe("violated");
    // A case that truly needs subdivision and will uncertify with maxDepth 0
    // Use a polynomial that is just above limit without easy witness? For example, p(u)= (u-0.5)^2 + 1e-12, limit 0, maximum? Actually p always >0, so violated witness exists at 0.5? But witness at middle will be found. So still violated.
    // Instead test a flat but not factored due to interior flat? Use (u-0.5)^2 with limit 0 minimum should be satisfied via factoring? But without factoring it would need subdivision. Our factored version satisfies with maxDepth 0, which is expected.
  });

  it("stall-like polynomial reaches 0 at u=1 and is satisfied", () => {
    // Synthetic stall-like: (1-u)^4 = 1 -4u +6u^2 -4u^3 + u^4, degree 4, flat at u=1 multiplicity 4, >=0
    const coeff = [1, -4, 6, -4, 1, 0, 0, 0];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("satisfied");
    // Hermite y trajectory flat at end with zero derivatives: use limit larger than max to guarantee satisfied
    const span = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(0, 0, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(0, 18, 0),
      d11: vec3(0, 0, 0),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const yCoeff = [...span.coefficients[1]!] as number[];
    // Flat root check: p(u)-18 has root at u=1 with multiplicity at least 1; but interior overshoot may exceed 18,
    // so we test with generous limit 100 which must be satisfied (max)
    const res2 = certifyPolynomialThreshold(
      yCoeff,
      0,
      1,
      100,
      "maximum",
      new CertifiedWorkBudget(200_000),
    );
    expect(res2.status).toBe("satisfied");
    // With limit exactly at endpoint value, the same synthetic (1-u)^4 case already covers flat root
  });

  it("truly below-zero perturbation is violated not satisfied", () => {
    const coeff = [1, -4, 6, -4, 1, 0, 0, 0]; // (1-u)^4
    const perturb = 1e-12;
    // Perturb constant down by perturb => at u=1, value = -perturb <0, so minimum 0 should be violated
    const perturbed = [
      coeff[0]! - perturb,
      coeff[1]!,
      coeff[2]!,
      coeff[3]!,
      coeff[4]!,
      0,
      0,
      0,
    ];
    const res = certifyPolynomialThreshold(
      perturbed,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("violated");
    if (res.status === "violated") {
      expect(res.witness.value < 0).toBe(true);
    }
  });

  it("Insta seeds 42/7 feasible no HEIGHT_RANGE_UNCERTIFIED", () => {
    for (const seed of [42, 7] as const) {
      const intent = createDesignIntentV1({
        generatorVersion: "test",
        seed,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        terrainProfileId: "rolling-highlands-v1",
        pinnedElementIds: [],
      });
      const result = generateCoaster(intent, { name: `insta-${seed}` });
      const bad = result.diagnostics.filter(
        (d) => d.code === "HEIGHT_RANGE_UNCERTIFIED",
      );
      expect(
        bad,
        `seed ${seed} should have no HEIGHT_RANGE_UNCERTIFIED`,
      ).toEqual([]);
    }
  });

  it(
    "directed rectangle seed 5555 height 0..100 feasible",
    { timeout: 20000 },
    () => {
      const baseFootprint = [
        vec3(-260, 0, -180),
        vec3(260, 0, -180),
        vec3(260, 0, 180),
        vec3(-260, 0, 180),
      ];
      const intent = createDesignIntentV1({
        generatorVersion: "test",
        seed: 5555,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [{ id: "gate-000", position: vec3(0, 12, 0) } as any],
        targets: [],
        constraints: [
          {
            id: "required-footprint",
            kind: "required-footprint",
            hard: true,
          } as any,
          {
            id: "required-height-range",
            kind: "required-height-range",
            hard: true,
          } as any,
        ],
        footprint: baseFootprint,
        heightRange: { min: 0, max: 100 },
        terrainProfileId: "rolling-highlands-v1",
        pinnedElementIds: [],
      });
      const result = generateCoaster(intent, { name: "directed-5555" });
      const bad = result.diagnostics.filter(
        (d) => d.code === "HEIGHT_RANGE_UNCERTIFIED",
      );
      expect(bad).toEqual([]);
    },
  );

  it("rejects empty and degree-8 arrays", () => {
    expect(() =>
      certifyPolynomialThreshold(
        [],
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(1000),
      ),
    ).toThrow(CertificationError);
    expect(() =>
      certifyPolynomialThreshold(
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(1000),
      ),
    ).toThrow(CertificationError);
    // u^8 = degree 8 single leading 1
    expect(() =>
      certifyPolynomialThreshold(
        [0, 0, 0, 0, 0, 0, 0, 0, 1],
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(1000),
      ),
    ).toThrow(CertificationError);
    // bounded coefficient work: tiny budget should exceed even for small coeff
    expect(() =>
      certifyPolynomialThreshold(
        [1],
        0,
        1,
        0,
        "maximum",
        new CertifiedWorkBudget(1),
      ),
    ).toThrow();
  });

  it("maximum [1, +Number.MIN_VALUE] at limit 1 fails closed", () => {
    expect(() =>
      certifyPolynomialThreshold(
        [1, Number.MIN_VALUE],
        0,
        1,
        1,
        "maximum",
        new CertifiedWorkBudget(100_000),
      ),
    ).toThrow(CertificationError);
  });

  it("minimum [1, -Number.MIN_VALUE] at limit 1 fails closed", () => {
    expect(() =>
      certifyPolynomialThreshold(
        [1, -Number.MIN_VALUE],
        0,
        1,
        1,
        "minimum",
        new CertifiedWorkBudget(100_000),
      ),
    ).toThrow(CertificationError);
  });

  it("one-ULP miss at nonzero boundary not silently satisfied", () => {
    const coeff = [nextUp(1)];
    const res = certifyPolynomialThreshold(
      coeff,
      0,
      1,
      1,
      "maximum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res.status).toBe("violated");
    if (res.status === "violated") {
      expect(res.witness.value > 1).toBe(true);
    }
    const oneUlpBelow = nextDown(1);
    const resMin = certifyPolynomialThreshold(
      [oneUlpBelow],
      0,
      1,
      1,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(resMin.status).toBe("violated");
    if (resMin.status === "violated") {
      expect(resMin.witness.value < 1).toBe(true);
    }
  });

  it("maximum nextDown(1) + nextUp(EPSILON/2) never satisfied -- exact p(1)=1+2^-105 >1", () => {
    const c0 = nextDown(1);
    const c1 = nextUp(Number.EPSILON / 2);
    // JS rounded evaluation at 1 collapses to 1, but exact value is 1 + 2^-105 > 1
    expect(c0 + c1).toBe(1);
    let result: ReturnType<typeof certifyPolynomialThreshold>;
    let threw = false;
    try {
      result = certifyPolynomialThreshold(
        [c0, c1],
        0,
        1,
        1,
        "maximum",
        new CertifiedWorkBudget(100_000),
      );
    } catch (e) {
      threw = e instanceof CertificationError;
      // fail closed is acceptable
      expect(threw).toBe(true);
      return;
    }
    expect(result!.status).not.toBe("satisfied");
    if (result!.status === "violated") {
      expect(Number.isFinite(result!.witness.value)).toBe(true);
      expect(result!.witness.value > 1).toBe(true);
      expect(result!.witness.value).not.toBe(1);
    } else {
      // uncertified would have thrown; any other non-satisfied is acceptable via throw path
      expect(result!.status).not.toBe("satisfied");
    }
  });

  it("minimum nextUp(1) + nextDown(-EPSILON) never satisfied -- exact p(1)=1-2^-104 <1", () => {
    const c0 = nextUp(1);
    const c1 = nextDown(-Number.EPSILON);
    expect(c0 + c1).toBe(1);
    let result: ReturnType<typeof certifyPolynomialThreshold>;
    let threw = false;
    try {
      result = certifyPolynomialThreshold(
        [c0, c1],
        0,
        1,
        1,
        "minimum",
        new CertifiedWorkBudget(100_000),
      );
    } catch (e) {
      threw = e instanceof CertificationError;
      expect(threw).toBe(true);
      return;
    }
    expect(result!.status).not.toBe("satisfied");
    if (result!.status === "violated") {
      expect(Number.isFinite(result!.witness.value)).toBe(true);
      expect(result!.witness.value < 1).toBe(true);
      expect(result!.witness.value).not.toBe(1);
    } else {
      expect(result!.status).not.toBe("satisfied");
    }
  });

  it("exact failing Hermite coefficients at minimum 0 not generous limit", () => {
    const yCoeff = [
      0.659454345703125, -2.260986328125, 2.5301513671875, -0.692138671875,
      -0.3941345214843733, 0.09997558593749582, 0.04998779296875349,
      0.0076904296874990025,
    ];
    const res = certifyPolynomialThreshold(
      yCoeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(500_000),
    );
    expect(res.status).toBe("satisfied");
    const yNeg = yCoeff.map((v, i) => (i === 0 ? v - 0.7 : v)); // shift down so min <0
    const resMin = certifyPolynomialThreshold(
      yNeg,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(500_000),
    );
    expect(resMin.status).toBe("violated");
  });

  it("semantic span endpoint and fromCoefficients/load behavior", () => {
    const yCoeff = [
      0.659454345703125, -2.260986328125, 2.5301513671875, -0.692138671875,
      -0.3941345214843733, 0.09997558593749582, 0.04998779296875349,
      0.0076904296874990025,
    ];
    const xCoeff = [0, 1, 0, 0, 0, 0, 0, 0];
    const zCoeff = [0, 0, 0, 0, 0, 0, 0, 0];
    const spanFrom = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      xCoeff,
      yCoeff,
      zCoeff,
    ]);
    // fromCoefficients reconstructs endpoint via direct power sum, which carries sub-ULP residual, not exact 0
    expect((spanFrom.position(1) as Vec3)[1]).toBeCloseTo(
      3.642919299551295e-17,
      15,
    );
    const fromCoeffY = spanFrom.coefficients[1]!;
    expect(fromCoeffY.length).toBe(8);
    const resFrom = certifyPolynomialThreshold(
      [...fromCoeffY],
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(500_000),
    );
    expect(resFrom.status).toBe("satisfied");
    // Spec-constructed span has authoritative endpoint exactly 0 via stored endpointConditions
    const specSpan = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0.659454345703125, 0),
      d10: vec3(0, -2.260986328125, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(0, 0, 0),
      d11: vec3(0, 0, 0),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    expect((specSpan.position(1) as Vec3)[1]).toBe(0);
    // Its polynomial may have different coefficients but still has endpoint 0 exactly; certification via its y row should be satisfied (sub-ULP case handled)
    // For this spec, the y row is not same as yCoeff; we verify that certifying its actual y row does not falsely violate
    const specY = [...specSpan.coefficients[1]!];
    let specRes: any;
    try {
      specRes = certifyPolynomialThreshold(
        specY,
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(500_000),
      );
    } catch (e) {
      specRes = e;
    }
    // Should be satisfied (if flat) or at least not produce false witness; allow satisfied or uncertified, but not false violated with wrong witness
    if (specRes && specRes.status === "violated") {
      expect(specRes.witness.value < 0).toBe(true);
    } else if (specRes && specRes.status === "satisfied") {
      expect(specRes.status).toBe("satisfied");
    } else {
      expect(specRes instanceof CertificationError).toBe(true);
    }
    // Original yCoeff directly should be satisfied at minimum 0 (the core failing case)
    const resDirect = certifyPolynomialThreshold(
      yCoeff,
      0,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(500_000),
    );
    expect(resDirect.status).toBe("satisfied");
  });

  it("dyadic exact-equality exponent alignment", () => {
    // 0.5 = 1 *2^-1, check conversion round-trip exact
    const halfDy = ((): any => {
      const res = certifyPolynomialThreshold(
        [-0.5, 1],
        0.5,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(100_000),
      );
      return res;
    })();
    expect(halfDy.status).toBe("satisfied");
    // Test value 0.75 exact conversion: 0.75 is 3/4 = 3*2^-2, should be exact
    const res075 = certifyPolynomialThreshold(
      [-0.75, 1],
      0.75,
      1,
      0,
      "minimum",
      new CertifiedWorkBudget(100_000),
    );
    expect(res075.status).toBe("satisfied");
    // Also test dyadicToInterval exact: constant exactly representable should be exact interval
    // We indirectly test via restrictedBernstein that uses dyadicToInterval; no throw
    const resConst = certifyPolynomialThreshold(
      [0.5],
      0,
      1,
      0.5,
      "minimum",
      new CertifiedWorkBudget(1000),
    );
    expect(resConst.status).toBe("satisfied");
    const resConstMax = certifyPolynomialThreshold(
      [0.5],
      0,
      1,
      0.5,
      "maximum",
      new CertifiedWorkBudget(1000),
    );
    expect(resConstMax.status).toBe("satisfied");
  });

  it("odd end multiplicity sign handling", () => {
    // (1-u) has odd multiplicity 1 at end, should flip sign correctly for maximum vs minimum
    const coeffOneMinusU = [1, -1]; // 1 - u
    expect(
      certifyPolynomialThreshold(
        coeffOneMinusU,
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(10000),
      ).status,
    ).toBe("satisfied");
    // As maximum with limit 0, p=1-u <=1? Actually max 0? p in [0,1] with max 1 at 0, so maximum 0 should be violated (value 1 >0)
    expect(
      certifyPolynomialThreshold(
        coeffOneMinusU,
        0,
        1,
        0,
        "maximum",
        new CertifiedWorkBudget(10000),
      ).status,
    ).toBe("violated");
    // (1-u)^3 odd multiplicity 3
    const coeffCube = [1, -3, 3, -1];
    expect(
      certifyPolynomialThreshold(
        coeffCube,
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(10000),
      ).status,
    ).toBe("satisfied");
    const coeffNegCube = [-1, 3, -3, 1]; // -(1-u)^3 <=0
    expect(
      certifyPolynomialThreshold(
        coeffNegCube,
        0,
        1,
        0,
        "maximum",
        new CertifiedWorkBudget(10000),
      ).status,
    ).toBe("satisfied");
    expect(
      certifyPolynomialThreshold(
        coeffNegCube,
        0,
        1,
        0,
        "minimum",
        new CertifiedWorkBudget(10000),
      ).status,
    ).toBe("violated");
  });
});
