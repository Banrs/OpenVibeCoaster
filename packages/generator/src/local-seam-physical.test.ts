import { describe, expect, it } from "vitest";
import { arcLength } from "@openvibecoaster/core";
import {
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import type { Diagnostic, SolvedSpan, Vec3 } from "@openvibecoaster/core";
import type { AnySemanticElement, SeamTolerances } from "./types";
import { createElement } from "./elements";
import {
  generateCoaster,
  localSeamDiagnostics,
  regenerateLocal,
} from "./pipeline";

const productionSeams: SeamTolerances = {
  positionM: 1e-4,
  tangentRad: 1e-5,
  curvaturePerM: 1e-4,
  curvatureVectorJumpPerM: 1e-4,
  curvatureGradientPerM2: 1e-4,
  bankRad: 1e-4,
  bankDerivativeRadPerM: 1e-4,
  bankSecondDerivativeRadPerM2: 1e-4,
  specificForceJumpG: 0.05,
  sustainedForceDeviationG: 0.05,
};

function assertDiagnostic(
  diag: Diagnostic | undefined,
): asserts diag is Diagnostic & {
  actual: number;
  limit: number;
  margin: number;
  location: { s: number; position: Vec3 };
  relatedIds: readonly string[];
} {
  if (
    diag === undefined ||
    typeof diag.actual !== "number" ||
    typeof diag.limit !== "number" ||
    typeof diag.margin !== "number" ||
    diag.location === undefined ||
    typeof diag.location.s !== "number" ||
    diag.location.position === undefined ||
    diag.relatedIds === undefined
  ) {
    throw new Error(`Missing diagnostic evidence ${JSON.stringify(diag)}`);
  }
}

function assertFatal(diag: Diagnostic | undefined): asserts diag is Diagnostic {
  if (diag === undefined || diag.severity !== "fatal") {
    throw new Error(`Expected fatal diagnostic ${JSON.stringify(diag)}`);
  }
}

function stationElement(id: string): AnySemanticElement {
  return createElement("station", id, { length: 12, bank: 0, closed: false });
}

function makeStationSpan(id: string, p0: Vec3, p1: Vec3): SolvedSpan {
  const span = SeventhOrderHermiteSpan.line(p0, p1);
  const bank = new QuinticScalarSpan({
    v0: 0,
    d10: 0,
    d20: 0,
    v1: 0,
    d11: 0,
    d21: 0,
  });
  return {
    id,
    kind: "station",
    span,
    bank,
    positionCoefficients: span.coefficients,
    rollCoefficients: bank.coefficients,
  };
}

function isolatedSeams(
  target: keyof SeamTolerances,
  limit: number,
): SeamTolerances {
  return {
    positionM: target === "positionM" ? limit : 1,
    tangentRad: target === "tangentRad" ? limit : 1,
    curvaturePerM: target === "curvaturePerM" ? limit : 1,
    curvatureVectorJumpPerM: target === "curvatureVectorJumpPerM" ? limit : 1,
    curvatureGradientPerM2: target === "curvatureGradientPerM2" ? limit : 1,
    bankRad: target === "bankRad" ? limit : 1,
    bankDerivativeRadPerM: target === "bankDerivativeRadPerM" ? limit : 1,
    bankSecondDerivativeRadPerM2:
      target === "bankSecondDerivativeRadPerM2" ? limit : 1,
    specificForceJumpG: target === "specificForceJumpG" ? limit : 1,
    sustainedForceDeviationG: target === "sustainedForceDeviationG" ? limit : 1,
  };
}

describe("local seam metrics isolated", () => {
  it("POSITION exceeds 2e-4 at seam 12", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const right = makeStationSpan(
      "s2",
      vec3(12 + 2e-4, 0, 0),
      vec3(24 + 2e-4, 0, 0),
    );
    const s3 = makeStationSpan(
      "s3",
      vec3(24 + 2e-4, 0, 0),
      vec3(36 + 2e-4, 0, 0),
    );
    const spans: readonly SolvedSpan[] = [left, right, s3];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
      stationElement("s3"),
    ];
    const seams = isolatedSeams("positionM", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_POSITION",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 9);
    expect(diag.limit).toBe(1e-4);
    expect(diag.margin).toBeCloseTo(-1e-4, 9);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diag.location.s).toBeCloseTo(arcLength(left.span), 9);
    expect(diag.location.position).toEqual(left.span.position(1));
    expect(diags).toHaveLength(1);
  });

  it("TANGENT exceeds 2e-5 at seam 12", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const angle = 2e-5;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const p1 = vec3(12 + cos * 12, 0, sin * 12);
    const span2 = new SeventhOrderHermiteSpan({
      p0: vec3(12, 0, 0),
      d10: vec3(cos, 0, sin),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1,
      d11: vec3(cos, 0, sin),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const right: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: span2,
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      positionCoefficients: span2.coefficients,
      rollCoefficients: [0, 0, 0, 0, 0, 0],
    };
    const p2 = vec3(p1[0] + cos * 12, 0, p1[2] + sin * 12);
    const span3 = new SeventhOrderHermiteSpan({
      p0: p1,
      d10: vec3(cos, 0, sin),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: p2,
      d11: vec3(cos, 0, sin),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const s3: SolvedSpan = {
      id: "s3",
      kind: "station",
      span: span3,
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      positionCoefficients: span3.coefficients,
      rollCoefficients: [0, 0, 0, 0, 0, 0],
    };
    const spans: readonly SolvedSpan[] = [left, right, s3];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
      stationElement("s3"),
    ];
    const seams = isolatedSeams("tangentRad", 1e-5);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_TANGENT",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-5, 9);
    expect(diag.limit).toBe(1e-5);
    expect(diag.margin).toBeCloseTo(-1e-5, 9);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diag.location.s).toBeCloseTo(arcLength(left.span), 9);
    expect(diags).toHaveLength(1);
  });

  it("CURVATURE exceeds 2e-4 isolated", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const p0 = vec3(12, 0, 0);
    const k = 2e-4;
    const span2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 =>
          vec3(p0[0] + 12 * u, p0[1] + 0.5 * k * 144 * 12 * u * u, p0[2]),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, k * 144 * u, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          if (order === 3) return vec3(0, 0, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [left, span2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("curvaturePerM", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_CURVATURE",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 7);
    expect(diag.limit).toBe(1e-4);
    expect(diag.margin).toBeCloseTo(-1e-4, 7);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diags).toHaveLength(1);
  });

  it("CURVATURE_VECTOR exceeds via orthogonal direction", () => {
    const k = 2e-4;
    const s1fix: SolvedSpan = {
      id: "s1",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const leftVec: SolvedSpan = {
      id: "s2a",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(12 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const right: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(24 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, 0, k * 144);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const s3fix: SolvedSpan = {
      id: "s3",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(36 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, 0, k * 144);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [s1fix, leftVec, right, s3fix];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2a"),
      stationElement("s2"),
      stationElement("s3"),
    ];
    const seams = isolatedSeams("curvatureVectorJumpPerM", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_CURVATURE_VECTOR",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(Math.sqrt(2) * 2e-4, 7);
    expect(diag.limit).toBe(1e-4);
    expect(diag.margin).toBeCloseTo(1e-4 - Math.sqrt(2) * 2e-4, 7);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s2a", "s2"]);
    expect(diag.location.s).toBeCloseTo(24, 9);
    expect(diags).toHaveLength(1);
  });

  it("CURVATURE_GRADIENT exceeds via d3", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const p0 = vec3(12, 0, 0);
    const grad = 2e-4;
    const d3mag = grad * 12 * 12 * 12;
    const span2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(p0[0] + 12 * u, p0[1], p0[2]),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, 0, 0);
          if (order === 3) return vec3(0, d3mag, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [left, span2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("curvatureGradientPerM2", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_CURVATURE_GRADIENT",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 7);
    expect(diag.limit).toBe(1e-4);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diags).toHaveLength(1);
  });

  it("BANK exceeds 2e-4", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const span2 = new SeventhOrderHermiteSpan({
      p0: vec3(12, 0, 0),
      d10: vec3(12, 0, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(24, 0, 0),
      d11: vec3(12, 0, 0),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const right: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: span2,
      bank: new QuinticScalarSpan({
        v0: 2e-4,
        d10: 0,
        d20: 0,
        v1: 2e-4,
        d11: 0,
        d21: 0,
      }),
      positionCoefficients: span2.coefficients,
      rollCoefficients: [2e-4, 0, 0, 0, 0, 0],
    };
    const spans: readonly SolvedSpan[] = [left, right];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("bankRad", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find((d) => d.code === "LOCAL_REGENERATION_SEAM_BANK");
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 9);
    expect(diag.limit).toBe(1e-4);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diags).toHaveLength(1);
  });

  it("BANK_DERIVATIVE exceeds via physical derivative", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const p0 = vec3(12, 0, 0);
    const span2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(p0[0] + 12 * u, p0[1], p0[2]),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 2.4e-3,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [left, span2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("bankDerivativeRadPerM", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_BANK_DERIVATIVE",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 7);
    expect(diag.limit).toBe(1e-4);
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diags).toHaveLength(1);
  });

  it("BANK_SECOND_DERIVATIVE exceeds", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const p0 = vec3(12, 0, 0);
    const span2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(p0[0] + 12 * u, p0[1], p0[2]),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0.0288,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [left, span2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("bankSecondDerivativeRadPerM2", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_BANK_SECOND_DERIVATIVE",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 7);
    expect(diag.limit).toBe(1e-4);
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diags).toHaveLength(1);
  });

  it("SPECIFIC_FORCE_JUMP exceeds 0.06 via curvature", () => {
    const left = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const p0 = vec3(12, 0, 0);
    const k = (0.06 * 9.80665) / (44 * 44);
    const span2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: {
        position: (u: number): Vec3 => vec3(p0[0] + 12 * u, p0[1], p0[2]),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [left, span2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const seams = isolatedSeams("specificForceJumpG", 0.05);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_SPECIFIC_FORCE_JUMP",
    );
    assertDiagnostic(diag);
    expect(diag.code).toBe("LOCAL_REGENERATION_SEAM_SPECIFIC_FORCE_JUMP");
    expect(diag.actual).toBeCloseTo(0.06, 5);
    expect(diag.limit).toBe(0.05);
    expect(diag.margin).toBeCloseTo(-0.01, 5);
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(diag.relatedIds).toEqual(["s1", "s2"]);
    expect(diag.location.s).toBeCloseTo(12, 9);
    expect(diag.location.position).toEqual(left.span.position(1));
    expect(diags).toHaveLength(1);
  });
});

describe("authored sustained physics", () => {
  it("preserves flat airtime hill within 0.05 over physical +/-5m", () => {
    const hillElement = createElement("airtimeHill", "hill", {
      length: 12,
      targetForceG: 1.0,
      referenceSpeed: 24,
      bank: 0,
    });
    const s1 = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const hillSpan: SolvedSpan = {
      id: "hill",
      kind: "airtimeHill",
      span: {
        position: (u: number): Vec3 => vec3(12 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const s3 = makeStationSpan("s3", vec3(24, 0, 0), vec3(36, 0, 0));
    const spans: readonly SolvedSpan[] = [s1, hillSpan, s3];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      hillElement,
      stationElement("s3"),
    ];
    const seams = isolatedSeams("sustainedForceDeviationG", 0.05);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    expect(
      diags.filter(
        (d) => d.code === "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION",
      ),
    ).toHaveLength(0);
  });

  it("fails sustained deviation >0.05 at hill flat within seam window", () => {
    const hillElement = createElement("airtimeHill", "hill", {
      length: 12,
      targetForceG: 1.0,
      referenceSpeed: 24,
      bank: 0,
    });
    const s1 = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const k = (0.06 * 9.80665) / (24 * 24);
    const hillSpan: SolvedSpan = {
      id: "hill",
      kind: "airtimeHill",
      span: {
        position: (u: number): Vec3 => vec3(12 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [s1, hillSpan];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      hillElement,
    ];
    const seams = isolatedSeams("sustainedForceDeviationG", 0.05);
    const diags = localSeamDiagnostics(spans, elements, false, seams, 44);
    const sustained = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION",
    );
    assertDiagnostic(sustained);
    expect(sustained.code).toBe(
      "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION",
    );
    expect(sustained.actual).toBeGreaterThan(0.05);
    expect(sustained.actual).toBeCloseTo(0.06, 5);
    expect(sustained.limit).toBe(0.05);
    expect(sustained.margin).toBeCloseTo(0.05 - sustained.actual, 9);
    expect(sustained.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(sustained.relatedIds).toEqual(["s1", "hill"]);
    expect(sustained.location.s).toBeGreaterThanOrEqual(12 - 5 - 1e-9);
    expect(sustained.location.s).toBeLessThanOrEqual(12 + 5 + 1e-9);
    expect(diags).toHaveLength(1);
  });

  it("geometric neighboring element produces no fabricated sustained target", () => {
    const gen = generateCoaster({
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
    });
    const diags = localSeamDiagnostics(
      gen.solvedSpans,
      gen.elements,
      false,
      productionSeams,
      44,
    );
    expect(
      diags.filter(
        (d) => d.code === "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION",
      ),
    ).toHaveLength(0);
  });

  it("sustained gating respects seam-adjacent +/-5m window", () => {
    const hillElement = createElement("airtimeHill", "hill", {
      length: 12,
      targetForceG: 1.0,
      referenceSpeed: 24,
      bank: 0,
    });
    const k = (0.06 * 9.80665) / (24 * 24);
    const farHillSpan: SolvedSpan = {
      id: "hill",
      kind: "airtimeHill",
      span: {
        position: (u: number): Vec3 => vec3(24 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const s1 = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const s2 = makeStationSpan("s2", vec3(12, 0, 0), vec3(24, 0, 0));
    const spans: readonly SolvedSpan[] = [s1, s2, farHillSpan];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
      hillElement,
    ];
    const seams = isolatedSeams("sustainedForceDeviationG", 0.05);
    const diagsAtS1 = localSeamDiagnostics(spans, elements, false, seams, 44);
    const sustainedAtFirst = diagsAtS1.filter(
      (d) =>
        d.code === "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION" &&
        d.relatedIds !== undefined &&
        d.relatedIds[0] === "s1",
    );
    expect(sustainedAtFirst).toHaveLength(0);
  });
});

describe("closed wrap and profile boundaries", () => {
  it("closed seam wraps modulo total length at position offset", () => {
    const s1 = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const s2: SolvedSpan = {
      id: "s2",
      kind: "station",
      span: SeventhOrderHermiteSpan.line(vec3(12, 0, 0), vec3(2e-4, 0, 0)),
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const spans: readonly SolvedSpan[] = [s1, s2];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      stationElement("s2"),
    ];
    const totalLen = spans.reduce((a, s) => a + arcLength(s.span), 0);
    const seams = isolatedSeams("positionM", 1e-4);
    const diags = localSeamDiagnostics(spans, elements, true, seams, 44);
    const diag = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_POSITION",
    );
    assertDiagnostic(diag);
    expect(diag.actual).toBeCloseTo(2e-4, 9);
    expect(diag.location.s).toBeCloseTo(totalLen, 6);
    expect(diag.location.s).toBeGreaterThanOrEqual(0);
    expect(diag.location.s).toBeLessThanOrEqual(totalLen + 1e-9);
  });

  it("closed sustained wraps modulo for hill at closure", () => {
    const hillElement = createElement("airtimeHill", "hill", {
      length: 12,
      targetForceG: 1.0,
      referenceSpeed: 24,
      bank: 0,
    });
    const k = (0.06 * 9.80665) / (24 * 24);
    const hillSpan: SolvedSpan = {
      id: "hill",
      kind: "airtimeHill",
      span: {
        position: (u: number): Vec3 => vec3(12 + 12 * u, 0, 0),
        derivative: (u: number, order = 1): Vec3 => {
          if (order === 1) return vec3(12, 0, 0);
          if (order === 2) return vec3(0, k * 144, 0);
          return vec3(0, 0, 0);
        },
      },
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
    };
    const s1 = makeStationSpan("s1", vec3(0, 0, 0), vec3(12, 0, 0));
    const spans: readonly SolvedSpan[] = [s1, hillSpan];
    const elements: readonly AnySemanticElement[] = [
      stationElement("s1"),
      hillElement,
    ];
    const totalLen = spans.reduce((a, s) => a + arcLength(s.span), 0);
    const seams = isolatedSeams("sustainedForceDeviationG", 0.05);
    const diags = localSeamDiagnostics(spans, elements, true, seams, 44);
    const sustained = diags.find(
      (d) => d.code === "LOCAL_REGENERATION_SEAM_SUSTAINED_FORCE_DEVIATION",
    );
    assertDiagnostic(sustained);
    expect(sustained.location.s).toBeGreaterThanOrEqual(0);
    expect(sustained.location.s).toBeLessThanOrEqual(totalLen + 1e-9);
  });

  it("profile missing key fails closed", () => {
    const gen = generateCoaster({
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
    });
    const incomplete: unknown = (() => {
      const copy: Record<string, unknown> = { ...productionSeams };
      delete copy["curvatureVectorJumpPerM"];
      return copy;
    })();
    const result = regenerateLocal(gen, "s2", {
      seams: incomplete,
      referenceSpeed: 44,
    });
    expect(result.feasible).toBe(false);
    const diag = result.diagnostics[0];
    assertFatal(diag);
    expect(diag.code).toBe("SEAM_LIMITS_UNCERTIFIED");
  });

  it("profile extra key fails closed", () => {
    const gen = generateCoaster({
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
    });
    const extra: unknown = { ...productionSeams, extraKey: 0.0001 };
    const result = regenerateLocal(gen, "s2", {
      seams: extra,
      referenceSpeed: 44,
    });
    expect(result.feasible).toBe(false);
    const diag = result.diagnostics[0];
    assertFatal(diag);
    expect(diag.code).toBe("SEAM_LIMITS_UNCERTIFIED");
  });

  it("profile negative new key fails closed", () => {
    const gen = generateCoaster({
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
    });
    const invalid: unknown = {
      ...productionSeams,
      curvatureVectorJumpPerM: -1,
    };
    const result = regenerateLocal(gen, "s2", {
      seams: invalid,
      referenceSpeed: 44,
    });
    expect(result.feasible).toBe(false);
    const diag = result.diagnostics[0];
    assertFatal(diag);
    expect(diag.code).toBe("SEAM_LIMITS_UNCERTIFIED");
  });

  it("untouched span hashes remain bitwise equal after feasible regeneration", () => {
    const gen = generateCoaster({
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 11,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
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
    });
    const result = regenerateLocal(gen, "s1", {
      seams: productionSeams,
      referenceSpeed: 44,
    });
    expect(result.feasible).toBe(true);
    expect(result.untouchedSpanHashes["s3"]).toBe(gen.spanHashes["s3"]);
    expect(result.untouchedSpanBytes["s3"]).toBe(gen.spanBytes["s3"]);
    expect(result.generation.spanHashes["s3"]).toBe(gen.spanHashes["s3"]);
  });
});
