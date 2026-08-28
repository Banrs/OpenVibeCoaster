import { describe, expect, it } from "vitest";
import {
  ELEMENT_KINDS,
  boundedLevenbergMarquardt,
  compileSemanticChain,
  createElement,
  defaultPose,
  diagnoseSeams,
  solveSemanticChain,
  stableElementId,
} from "./index";
import type { ElementKind, Pose } from "./index";
import {
  vec3,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Sub,
} from "@openvibecoaster/core";

const gravity = 9.80665;
const supportForceG = (
  span: {
    derivative: (
      u: number,
      order?: number,
    ) => readonly [number, number, number];
  },
  u: number,
  speed: number,
): number => {
  const d1 = span.derivative(u, 1);
  const d2 = span.derivative(u, 2);
  const speedSquared = vec3Dot(d1, d1);
  const tangentAcceleration = vec3Cross(d1, vec3Cross(d2, d1));
  const curvatureVector = vec3(
    tangentAcceleration[0] / speedSquared ** 2,
    tangentAcceleration[1] / speedSquared ** 2,
    tangentAcceleration[2] / speedSquared ** 2,
  );
  return 1 + (speed ** 2 * curvatureVector[1]) / gravity;
};

const allKinds: readonly ElementKind[] = [
  "station",
  "launch",
  "boost",
  "brake",
  "transition",
  "topHat",
  "airtimeHill",
  "overbankedTurn",
  "zeroGRoll",
  "stall",
];

describe("semantic element library", () => {
  it("exposes every approved element with deterministic IDs", () => {
    expect(ELEMENT_KINDS).toEqual(allKinds);
    expect(stableElementId("topHat", 3)).toBe("topHat-003");
    expect(createElement("station", stableElementId("station", 0)).type).toBe(
      "station",
    );
    expect(
      allKinds.map((kind, index) =>
        createElement(kind, stableElementId(kind, index)),
      ),
    ).toHaveLength(10);
  });

  it("treats boost as a first-class launch element", () => {
    const boost = createElement("boost", stableElementId("boost", 0), {
      targetSpeed: 35,
    });
    expect(boost.type).toBe("boost");
    expect(solveSemanticChain([boost]).solvedSpans[0]?.zones).toContain(
      "boost",
    );
  });

  it("rejects missing, non-finite, and out-of-range parameters", () => {
    expect(() => createElement("topHat", "hat", { height: 79 })).toThrow(
      "height must be exactly 80 m",
    );
    expect(() =>
      createElement("overbankedTurn", "turn", { radius: 0 }),
    ).toThrow("radius must be between 5 and 200 m");
    expect(() =>
      createElement("launch", "launch", { targetSpeed: Number.NaN }),
    ).toThrow("targetSpeed must be finite");
    expect(() => createElement("overbankedTurn", "turn", { angle: 0 })).toThrow(
      "angle must not be zero",
    );
  });
});

describe("semantic chain geometry", () => {
  it("builds an 80 m inverted top hat and preserves analytic span derivatives", () => {
    const result = solveSemanticChain([
      createElement("topHat", "hat", { height: 80, width: 40 }),
    ]);
    expect(result.feasible).toBe(true);
    const span = result.solvedSpans[0]?.span;
    expect(span).toBeDefined();
    const heights = Array.from(
      { length: 101 },
      (_, i) => span!.position(i / 100)[1],
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeCloseTo(80, 6);
    expect(vec3Length(span!.derivative(0, 1))).toBeGreaterThan(0);
    expect(span!.derivative(0, 3)[1]).toBeCloseTo(0, 8);
    expect(span!.derivative(1, 3)[1]).toBeCloseTo(0, 8);
    expect(() =>
      createElement("topHat", "wrong-height", { height: 81 }),
    ).toThrow("height must be exactly 80 m");
    expect(span!.position(0.5)[1]).toBeCloseTo(80, 6);
    expect(span!.position(0.65)[1]).toBeCloseTo(80, 6);
    expect(span!.position(0.15)[1]).toBeLessThan(80);
    expect(result.solvedSpans[0]?.bank?.position(0.5)).toBeCloseTo(Math.PI, 6);
  });

  it("uses seventh-order geometry and quintic bank laws at element boundaries", () => {
    const result = solveSemanticChain([
      createElement("transition", "t", { length: 20, rise: 8, bank: 0.4 }),
      createElement("zeroGRoll", "r", { length: 30, roll: Math.PI }),
    ]);
    const transition = result.solvedSpans[0];
    const roll = result.solvedSpans[1];
    expect(transition?.span.derivative(0, 3)).toBeDefined();
    expect(roll?.bank?.derivative(0, 2)).toBeCloseTo(0, 10);
    expect(roll?.bank?.derivative(1, 2)).toBeCloseTo(0, 10);
    expect(roll?.bank?.position(1)).toBeCloseTo(0.4 + Math.PI, 10);
  });

  it("retains positive-G curvature into a roll without flattening it", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "hill", {
          length: 35,
          height: 12,
          targetForceG: 2,
          referenceSpeed: 24,
        }),
        createElement("zeroGRoll", "roll", { length: 28, roll: Math.PI * 2 }),
      ],
      { referenceSpeed: 24 },
    );
    expect(result.feasible).toBe(true);
    const hill = result.solvedSpans[0]?.span;
    const roll = result.solvedSpans[1]?.bank;
    expect(hill).toBeDefined();
    expect(Math.abs(hill!.derivative(0.5, 2)[1])).toBeGreaterThan(0.01);
    expect(roll?.position(1)).toBeCloseTo(Math.PI * 2, 10);
    expect(roll?.derivative(0.5, 1)).toBeGreaterThan(0);
  });

  it.each([[2], [0], [-0.5]] as const)(
    "calibrates %s force geometry at reference speed",
    (targetForceG) => {
      const result = solveSemanticChain(
        [
          createElement("airtimeHill", `hill-${targetForceG}`, {
            length: 48,
            height: 10,
            targetForceG,
            referenceSpeed: 24,
          }),
        ],
        { referenceSpeed: 24 },
      );
      const span = result.solvedSpans[0]!.span;
      expect(supportForceG(span, 0.5, 24)).toBeCloseTo(targetForceG, 2);
      expect(vec3Length(span.derivative(0.5, 2))).toBeGreaterThan(0.001);
    },
  );

  it("keeps the force transition into a roll continuous and non-flat", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "hill", {
          length: 48,
          height: 10,
          targetForceG: 2,
          referenceSpeed: 24,
        }),
        createElement("zeroGRoll", "roll", { length: 28, roll: Math.PI }),
      ],
      { referenceSpeed: 24 },
    );
    expect(result.seamDiagnostics[0]?.specificForceJumpG).toBeLessThan(0.05);
    expect(result.seamDiagnostics[0]?.curvaturePerM).toBeLessThan(1e-4);
  });

  it("is rigid-transform invariant and transports one continuous global frame", () => {
    const base = solveSemanticChain([
      createElement("station", "s"),
      createElement("airtimeHill", "hill", { length: 28, height: 10 }),
      createElement("stall", "stall", { length: 24, height: 10 }),
    ]);
    const transformedStart: Pose = {
      position: vec3(100, 20, -40),
      tangent: vec3(0, 0, -1),
      normal: vec3(0, 1, 0),
      bank: 0.2,
    };
    const transformed = solveSemanticChain(
      [
        createElement("station", "s"),
        createElement("airtimeHill", "hill", { length: 28, height: 10 }),
        createElement("stall", "stall", { length: 24, height: 10 }),
      ],
      { startPose: transformedStart },
    );
    expect(transformed.feasible).toBe(true);
    const baseStart = base.solvedSpans[0]!.span.position(0);
    const transformedStartPoint = transformed.solvedSpans[0]!.span.position(0);
    expect(transformedStartPoint).toEqual(transformedStart.position);
    expect(
      vec3Length(vec3Sub(base.solvedSpans[2]!.span.position(0), baseStart)),
    ).toBeCloseTo(
      vec3Length(
        vec3Sub(
          transformed.solvedSpans[2]!.span.position(0),
          transformedStartPoint,
        ),
      ),
      8,
    );
    const compiled = compileSemanticChain(
      [
        createElement("station", "s"),
        createElement("zeroGRoll", "roll", { length: 24, roll: Math.PI }),
      ],
      { samples: 24 },
    );
    expect(compiled.track).toBeDefined();
    const normals = compiled.track!.normals;
    for (let i = 1; i < normals.length / 3; i += 1)
      expect(
        vec3Dot(
          [
            normals[(i - 1) * 3]!,
            normals[(i - 1) * 3 + 1]!,
            normals[(i - 1) * 3 + 2]!,
          ],
          [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!],
        ),
      ).toBeGreaterThan(-0.01);
  });

  it("re-orthonormalizes changed endpoint poses and preserves the authored start normal", () => {
    const startPose: Pose = {
      position: vec3(0, 0, 0),
      tangent: vec3(1, 1, 0),
      normal: vec3(0, 0, 1),
      bank: 0,
    };
    const result = solveSemanticChain(
      [createElement("transition", "transition", { length: 20, pitch: 0.7 })],
      { startPose },
    );
    const endPose = result.endPose;
    expect(vec3Length(endPose.tangent)).toBeCloseTo(1, 10);
    expect(vec3Length(endPose.normal)).toBeCloseTo(1, 10);
    expect(vec3Dot(endPose.tangent, endPose.normal)).toBeCloseTo(0, 10);

    const compiled = compileSemanticChain(
      [createElement("station", "station")],
      { startPose, samples: 8 },
    );
    const firstNormal = vec3(
      compiled.track!.normals[0]!,
      compiled.track!.normals[1]!,
      compiled.track!.normals[2]!,
    );
    expect(vec3Dot(firstNormal, vec3Normalize(startPose.normal))).toBeCloseTo(
      1,
      6,
    );
  });
});

describe("bounded seam solve", () => {
  it("solves bounded least-squares variables deterministically", () => {
    const problem = {
      initial: [0],
      lower: [-1],
      upper: [1],
      residual: (variables: readonly number[]) => [variables[0]! - 0.75],
    };
    const first = boundedLevenbergMarquardt(problem);
    const second = boundedLevenbergMarquardt(problem);
    expect(first.variables[0]).toBeCloseTo(0.75, 6);
    expect(first).toEqual(second);
  });

  it("reports seam metrics separately for hard and soft residuals", () => {
    const elements = [
      createElement("station", "station"),
      createElement("launch", "launch", { length: 30 }),
      createElement("brake", "brake", { length: 20 }),
    ];
    const result = solveSemanticChain(elements, {
      referenceSpeed: 20,
      softForceTargetG: 1.5,
    });
    const seams = diagnoseSeams(result.solvedSpans, { referenceSpeed: 20 });
    expect(seams).toHaveLength(2);
    expect(seams[0]?.hardResiduals).toBeDefined();
    expect(seams[0]?.softResiduals).toBeDefined();
    expect(seams[0]?.curvatureVectorJumpPerM).toBeDefined();
    expect(
      result.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    ).toBe(true);
  });

  it("integrates bounded optimization and improves an authoritative seam residual", () => {
    const elements = [
      createElement("overbankedTurn", "turn", {
        radius: 5,
        angle: Math.PI / 2,
      }),
      createElement("launch", "exit", { length: 20 }),
    ];
    const initial = solveSemanticChain(elements, { maxIterations: 0 });
    const optimized = solveSemanticChain(elements, { maxIterations: 24 });
    expect(optimized.seamDiagnostics[0]!.curvaturePerM).toBeLessThan(
      initial.seamDiagnostics[0]!.curvaturePerM,
    );
  });

  it("solves a reachable hard endpoint target through rebuilt semantic spans", () => {
    const result = solveSemanticChain(
      [createElement("launch", "launch", { length: 20 })],
      {
        targets: [{ id: "end-z", kind: "end-z", target: 30 }],
      },
    );
    expect(result.feasible).toBe(true);
    expect(result.endPose.position[2]).toBeCloseTo(30, 6);
  });

  it("lets a soft force target change the solved force geometry", () => {
    const elements = [
      createElement("airtimeHill", "hill", {
        length: 48,
        height: 10,
        targetForceG: 2,
        referenceSpeed: 24,
      }),
    ];
    const baseline = solveSemanticChain(elements, { referenceSpeed: 24 });
    const softened = solveSemanticChain(elements, {
      referenceSpeed: 24,
      softForceTargetG: 0,
    });
    const baselineForce = supportForceG(baseline.solvedSpans[0]!.span, 0.5, 24);
    const softenedForce = supportForceG(softened.solvedSpans[0]!.span, 0.5, 24);
    expect(Math.abs(softenedForce)).toBeLessThan(Math.abs(baselineForce));
  });

  it("keeps incompatible closed hard poses hard and names relaxations", () => {
    const result = solveSemanticChain(
      [createElement("station", "station", { closed: true })],
      {
        closed: true,
        endPose: {
          ...defaultPose(),
          position: vec3(10, 0, 0),
        },
      },
    );
    const infeasible = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS",
    );
    expect(result.feasible).toBe(false);
    expect(infeasible?.message).toContain("closed station pose");
    expect(infeasible?.suggestedRelaxation).toContain("endPose.position");
    expect(result.relaxations.length).toBeLessThanOrEqual(3);
  });

  it("includes and diagnoses the final-to-first closure seam", () => {
    const result = solveSemanticChain(
      [
        createElement("station", "station"),
        createElement("launch", "exit", { length: 20 }),
      ],
      { closed: true },
    );
    expect(result.seamDiagnostics).toHaveLength(2);
    const closure = result.seamDiagnostics[1]!;
    expect(closure.seamId).toBe("exit->station");
    expect(closure.positionM).toBeGreaterThan(0);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS" &&
          diagnostic.message.includes("exit->station"),
      ),
    ).toBe(true);
  });
});
