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
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from "@openvibecoaster/core";

const gravity = 9.80665;
const worldGravity = vec3(0, -gravity, 0);
const curvatureVectorAt = (
  span: {
    derivative: (
      u: number,
      order?: number,
    ) => readonly [number, number, number];
  },
  u: number,
) => {
  const d1 = span.derivative(u, 1);
  const d2 = span.derivative(u, 2);
  const speedSquared = vec3Dot(d1, d1);
  const projection = vec3Dot(d1, d2);
  return vec3(
    (d2[0] * speedSquared - d1[0] * projection) / speedSquared ** 2,
    (d2[1] * speedSquared - d1[1] * projection) / speedSquared ** 2,
    (d2[2] * speedSquared - d1[2] * projection) / speedSquared ** 2,
  );
};
const specificForceComponents = (
  span: {
    derivative: (
      u: number,
      order?: number,
    ) => readonly [number, number, number];
  },
  bank: number,
  u: number,
  speed: number,
) => {
  const tangent = vec3Normalize(span.derivative(u, 1));
  const startTangent = vec3Normalize(span.derivative(0, 1));
  const midTangent = vec3Normalize(span.derivative(0.5, 1));
  let unbankedBinormal = vec3Normalize(vec3Cross(startTangent, midTangent));
  if (
    vec3Dot(
      vec3Normalize(vec3Cross(unbankedBinormal, startTangent)),
      vec3(0, 1, 0),
    ) < 0
  )
    unbankedBinormal = vec3Scale(unbankedBinormal, -1);
  const unbankedNormal = vec3Normalize(vec3Cross(unbankedBinormal, tangent));
  const normal = vec3Add(
    vec3Scale(unbankedNormal, Math.cos(bank)),
    vec3Scale(unbankedBinormal, Math.sin(bank)),
  );
  const binormal = vec3Normalize(vec3Cross(tangent, normal));
  const specificForce = vec3Sub(
    vec3Scale(curvatureVectorAt(span, u), speed ** 2),
    worldGravity,
  );
  return {
    tangent: vec3Dot(specificForce, tangent) / gravity,
    normal: vec3Dot(specificForce, normal) / gravity,
    binormal: vec3Dot(specificForce, binormal) / gravity,
    magnitude: vec3Length(specificForce) / gravity,
  };
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

  it("keeps the top-hat descent tangent and inverted frame continuous", () => {
    const result = compileSemanticChain(
      [createElement("topHat", "hat", { height: 80, width: 40 })],
      { samples: 64 },
    );
    const span = result.solvedSpans[0]!.span;
    const startTangent = vec3Normalize(span.derivative(0, 1));
    const endTangent = vec3Normalize(span.derivative(1, 1));
    expect(vec3Dot(startTangent, endTangent)).toBeCloseTo(1, 10);
    expect(span.position(1)[1]).toBeCloseTo(span.position(0)[1], 8);
    const parameters = result.track!.parameters;
    let apexIndex = 0;
    for (let index = 1; index < parameters.length; index += 1)
      if (
        Math.abs(parameters[index]! - 0.5) <
        Math.abs(parameters[apexIndex]! - 0.5)
      )
        apexIndex = index;
    expect(result.track!.bank[apexIndex]).toBeCloseTo(Math.PI, 2);
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

  it("matches adjacent C3 geometry and C2 bank derivatives at a seam", () => {
    const result = solveSemanticChain([
      createElement("transition", "first", {
        length: 20,
        rise: 8,
        pitch: 0.4,
      }),
      createElement("transition", "second", {
        length: 20,
        rise: -3,
        pitch: -0.2,
      }),
    ]);
    const left = result.solvedSpans[0]!;
    const right = result.solvedSpans[1]!;
    expect(
      vec3Length(vec3Sub(left.span.position(1), right.span.position(0))),
    ).toBeLessThan(1e-8);
    expect(
      vec3Length(
        vec3Sub(left.span.derivative(1, 1), right.span.derivative(0, 1)),
      ),
    ).toBeLessThan(1e-8);
    for (const order of [2, 3])
      expect(
        vec3Length(
          vec3Sub(
            left.span.derivative(1, order),
            right.span.derivative(0, order),
          ),
        ),
      ).toBeLessThan(1e-8);
    expect(left.bank!.derivative(1, 1)).toBeCloseTo(
      right.bank!.derivative(0, 1),
      10,
    );
    expect(left.bank!.position(1)).toBeCloseTo(right.bank!.position(0), 10);
    expect(left.bank!.derivative(1, 2)).toBeCloseTo(
      right.bank!.derivative(0, 2),
      10,
    );
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
    expect(result.feasible).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("hill:height"),
      ),
    ).toBe(true);
    const hill = result.solvedSpans[0]?.span;
    const roll = result.solvedSpans[1]?.bank;
    expect(hill).toBeDefined();
    expect(Math.abs(hill!.derivative(0.5, 2)[1])).toBeGreaterThan(0.01);
    expect(roll?.position(1)).toBeCloseTo(Math.PI * 2, 10);
    expect(roll?.derivative(0.5, 1)).toBeGreaterThan(0);
  });

  it("keeps a dense force profile continuous and physically calibrated", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "dense-hill", {
          length: 48,
          height: 10,
          targetForceG: 2,
          referenceSpeed: 24,
        }),
      ],
      { referenceSpeed: 24 },
    );
    const solved = result.solvedSpans[0]!;
    const samples = Array.from({ length: 2001 }, (_, index) => index / 2000);
    const forces = samples.map(
      (u) =>
        specificForceComponents(solved.span, solved.bank!.position(u), u, 24)
          .normal,
    );
    expect(Math.max(...forces)).toBeLessThan(2.05);
    expect(Math.min(...forces)).toBeGreaterThan(-0.05);
    for (const u of Array.from(
      { length: 1001 },
      (_, index) => 0.25 + index / 2000,
    ))
      expect(
        specificForceComponents(solved.span, solved.bank!.position(u), u, 24)
          .normal,
      ).toBeCloseTo(2, 2);
    for (const boundary of [0.15, 0.25, 0.75, 0.85]) {
      const before = specificForceComponents(
        solved.span,
        solved.bank!.position(boundary - 1e-5),
        boundary - 1e-5,
        24,
      ).normal;
      const after = specificForceComponents(
        solved.span,
        solved.bank!.position(boundary + 1e-5),
        boundary + 1e-5,
        24,
      ).normal;
      expect(Math.abs(after - before)).toBeLessThan(0.01);
    }
    expect(result.feasible).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("dense-hill:height");
  });

  it("reports impossible force geometry instead of clamping it", () => {
    const result = solveSemanticChain([
      createElement("airtimeHill", "impossible", {
        length: 500,
        height: 18,
        targetForceG: 5,
        referenceSpeed: 10,
      }),
    ]);
    expect(result.feasible).toBe(false);
    expect(
      result.solvedSpans.every((solved) =>
        Array.from({ length: 101 }, (_, index) => index / 100).every((u) =>
          solved.span.position(u).every(Number.isFinite),
        ),
      ),
    ).toBe(true);
    const infeasible = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS",
    );
    expect(infeasible?.message).toContain("impossible:height");
    expect(infeasible?.message).toContain("infeasible force geometry");
    expect(infeasible?.suggestedRelaxation).toContain("impossible:height");
  });

  it("uses local-frame specific force for an oriented force profile", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "oriented", {
          length: 24,
          height: 2,
          targetForceG: 2,
          referenceSpeed: 24,
          bank: 0.6,
        }),
      ],
      {
        referenceSpeed: 24,
        startPose: {
          position: vec3(10, 4, -3),
          tangent: vec3(0, 0, 1),
          normal: vec3(1, 0, 0),
          bank: 0.6,
        },
      },
    );
    expect(result.feasible).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("oriented:height");
  });

  it("keeps a banked positive-G target calibrated or reports force infeasibility", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "banked-hill", {
          length: 48,
          height: 10,
          targetForceG: 2,
          referenceSpeed: 24,
          bank: 0.6,
        }),
      ],
      {
        referenceSpeed: 24,
        startPose: { ...defaultPose(), bank: 0.6 },
      },
    );
    const solved = result.solvedSpans[0]!;
    const force = specificForceComponents(
      solved.span,
      solved.bank!.position(0.5),
      0.5,
      24,
    );
    if (result.feasible) {
      expect(force.normal).toBeCloseTo(2, 2);
      expect(Math.abs(force.binormal)).toBeLessThan(0.05);
    } else {
      const infeasible = result.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS" &&
          diagnostic.message.includes("banked-hill:force"),
      );
      expect(infeasible).toBeDefined();
      expect(infeasible?.suggestedRelaxation).toContain("banked-hill:force");
    }
  });

  it("reports zero transverse force at a vertical zero-curvature seam", () => {
    const result = solveSemanticChain(
      [
        createElement("station", "vertical-station", { length: 12 }),
        createElement("launch", "vertical-launch", { length: 20 }),
      ],
      {
        referenceSpeed: 24,
        startPose: {
          position: vec3(0, 0, 0),
          tangent: vec3(0, 1, 0),
          normal: vec3(1, 0, 0),
          bank: 0,
        },
      },
    );
    expect(result.feasible).toBe(true);
    expect(result.seamDiagnostics[0]?.specificForceJumpG).toBeCloseTo(0, 10);
  });

  it("keeps vertical zero-curvature soft-force diagnostics total", () => {
    const result = solveSemanticChain(
      [
        createElement("station", "soft-vertical-station", { length: 12 }),
        createElement("launch", "soft-vertical-launch", { length: 20 }),
      ],
      {
        referenceSpeed: 24,
        softForceTargetG: 0,
        startPose: {
          position: vec3(0, 0, 0),
          tangent: vec3(0, 1, 0),
          normal: vec3(1, 0, 0),
          bank: 0,
        },
      },
    );
    expect(result.feasible).toBe(true);
    expect(
      result.seamDiagnostics[0]?.softResiduals.sustainedForceDeviationG,
    ).toBeCloseTo(0, 10);
    expect(
      result.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    ).toBe(true);
  });

  it("rejects zero-G geometry whose plane cannot cancel gravity", () => {
    const result = solveSemanticChain(
      [
        createElement("zeroGRoll", "oriented-roll", {
          length: 28,
          roll: Math.PI,
        }),
      ],
      {
        referenceSpeed: 24,
        startPose: {
          position: vec3(0, 0, 0),
          tangent: vec3(0, 0, 1),
          normal: vec3(1, 0, 0),
          bank: 0,
        },
      },
    );
    expect(result.feasible).toBe(false);
    expect(result.diagnostics[0]?.message).toContain(
      "oriented-roll:orientation",
    );
    expect(result.diagnostics[0]?.suggestedRelaxation).toContain(
      "oriented-roll:orientation",
    );
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
      const solved = result.solvedSpans[0]!;
      const sustainedForces = [0.25, 0.35, 0.5, 0.65, 0.75].map(
        (u) =>
          specificForceComponents(solved.span, solved.bank!.position(u), u, 24)
            .normal,
      );
      expect(Math.max(...sustainedForces)).toBeLessThan(targetForceG + 0.05);
      expect(Math.min(...sustainedForces)).toBeGreaterThan(targetForceG - 0.05);
      expect(vec3Length(solved.span.derivative(0.5, 2))).toBeGreaterThan(0.001);
    },
  );

  it("builds zero-G roll geometry with zero specific force while the frame rolls", () => {
    const result = solveSemanticChain(
      [createElement("zeroGRoll", "roll", { length: 28, roll: Math.PI })],
      { referenceSpeed: 24 },
    );
    const solved = result.solvedSpans[0]!;
    const forces = Array.from({ length: 201 }, (_, index) => index / 200)
      .filter((u) => u >= 0.25 && u <= 0.75)
      .map((u) =>
        specificForceComponents(solved.span, solved.bank!.position(u), u, 24),
      );
    expect(
      Math.max(...forces.map((force) => Math.abs(force.normal))),
    ).toBeLessThan(0.05);
    expect(
      Math.max(...forces.map((force) => Math.abs(force.binormal))),
    ).toBeLessThan(0.05);
    expect(vec3Length(solved.span.derivative(0.5, 2))).toBeGreaterThan(0.001);
    expect(solved.bank!.position(0.25)).not.toBeCloseTo(
      solved.bank!.position(0.75),
      2,
    );
  });

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

  it("does not trade an authored force target for seam residuals", () => {
    const result = solveSemanticChain(
      [
        createElement("airtimeHill", "hard-force", {
          length: 48,
          height: 10,
          targetForceG: 2,
          referenceSpeed: 24,
        }),
        createElement("launch", "exit", { length: 20 }),
      ],
      { referenceSpeed: 24, maxIterations: 32 },
    );
    const hill = result.solvedSpans[0]!;
    const force = specificForceComponents(
      hill.span,
      hill.bank!.position(0.5),
      0.5,
      24,
    ).normal;
    expect(force).toBeCloseTo(2, 2);
  });

  it("is rigid-transform invariant and transports one continuous global frame", () => {
    const base = solveSemanticChain([
      createElement("station", "s"),
      createElement("transition", "hill", { length: 28, rise: 10 }),
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
        createElement("transition", "hill", { length: 28, rise: 10 }),
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

  it("rejects an unreachable hard endPose even when the chain is not closed", () => {
    const result = solveSemanticChain([createElement("launch", "launch")], {
      endPose: { ...defaultPose(), position: vec3(0, 0, 0) },
      maxIterations: 0,
    });
    const infeasible = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS",
    );
    expect(result.feasible).toBe(false);
    expect(infeasible?.message).toContain("endPose.position");
    expect(infeasible?.suggestedRelaxation).toContain("endPose.position");
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
    const baselineForce = specificForceComponents(
      baseline.solvedSpans[0]!.span,
      baseline.solvedSpans[0]!.bank!.position(0.5),
      0.5,
      24,
    ).normal;
    const softenedForce = specificForceComponents(
      softened.solvedSpans[0]!.span,
      softened.solvedSpans[0]!.bank!.position(0.5),
      0.5,
      24,
    ).normal;
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
    expect(infeasible?.message).toContain(
      "closed-loop pose/closure constraints",
    );
    expect(infeasible?.message).toContain("endPose.position");
    expect(infeasible?.suggestedRelaxation).toContain("endPose.position");
    expect(result.relaxations.length).toBeLessThanOrEqual(3);
  });

  it("names non-station closure failures as closed-loop pose constraints", () => {
    const result = solveSemanticChain(
      [createElement("launch", "launch", { length: 20 })],
      { closed: true, maxIterations: 0 },
    );
    const infeasible = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS",
    );
    expect(result.feasible).toBe(false);
    expect(infeasible?.message).toContain(
      "closed-loop pose/closure constraints",
    );
    expect(infeasible?.message).not.toContain("closed station pose");
  });

  it("bounds every LM solve to 32 iterations", () => {
    const problem = {
      initial: [0],
      lower: [-1],
      upper: [1],
      residual: () => [1],
    };
    expect(
      boundedLevenbergMarquardt({ ...problem, maxIterations: 33 }).iterations,
    ).toBeLessThanOrEqual(32);
    expect(
      boundedLevenbergMarquardt({ ...problem, maxIterations: Number.NaN })
        .iterations,
    ).toBeGreaterThanOrEqual(0);
    expect(
      boundedLevenbergMarquardt({ ...problem, maxIterations: -10 }).iterations,
    ).toBe(0);
    expect(
      boundedLevenbergMarquardt({
        ...problem,
        maxIterations: Number.POSITIVE_INFINITY,
      }).iterations,
    ).toBeLessThanOrEqual(32);
    expect(
      boundedLevenbergMarquardt({
        ...problem,
        maxIterations: Number.MAX_SAFE_INTEGER,
      }).iterations,
    ).toBeLessThanOrEqual(32);
  });

  it("keeps a reachable closed station final seam continuous", () => {
    const result = solveSemanticChain(
      [createElement("station", "station", { closed: true })],
      { closed: true },
    );
    const closure = result.seamDiagnostics[0]!;
    expect(result.feasible).toBe(true);
    expect(closure.seamId).toBe("station->station");
    expect(closure.positionM).toBeLessThan(1e-8);
    expect(closure.tangentRad).toBeLessThan(1e-8);
    expect(closure.curvatureVectorJumpPerM).toBeLessThan(1e-8);
    expect(closure.bankRad).toBeLessThan(1e-8);
    expect(closure.bankDerivativeRadPerM).toBeLessThan(1e-8);
    expect(closure.curvatureGradientPerM2).toBeLessThan(1e-8);
    expect(closure.specificForceJumpG).toBeLessThan(1e-8);
  });

  it("returns the same bank geometry that compilation samples", () => {
    const startPose: Pose = {
      position: vec3(0, 0, 0),
      tangent: vec3(1, 1, 0),
      normal: vec3(0, 0, 1),
      bank: 0,
    };
    const result = compileSemanticChain(
      [createElement("station", "station", { bank: 0.2 })],
      { startPose, samples: 8 },
    );
    const span = result.solvedSpans[0]!;
    const parameters = result.track!.parameters;
    const banks = result.track!.bank;
    for (let index = 0; index < parameters.length; index += 1)
      expect(banks[index]).toBeCloseTo(
        span.bank!.position(parameters[index]!),
        10,
      );
  });

  it("is deterministic across the full solved chain", () => {
    const elements = [
      createElement("station", "station"),
      createElement("topHat", "hat", { width: 40 }),
      createElement("airtimeHill", "hill", {
        length: 48,
        height: 10,
        targetForceG: 2,
        referenceSpeed: 24,
      }),
      createElement("zeroGRoll", "roll", { length: 28, roll: Math.PI }),
    ];
    const first = solveSemanticChain(elements, { referenceSpeed: 24 });
    const second = solveSemanticChain(elements, { referenceSpeed: 24 });
    expect(first.seamDiagnostics).toEqual(second.seamDiagnostics);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first.endPose).toEqual(second.endPose);
    for (let index = 0; index < first.solvedSpans.length; index += 1)
      for (const u of [0, 0.25, 0.5, 0.75, 1])
        expect(first.solvedSpans[index]!.span.position(u)).toEqual(
          second.solvedSpans[index]!.span.position(u),
        );
    const compiledElements = [
      createElement("station", "compiled-station"),
      createElement("topHat", "compiled-hat", { width: 40 }),
      createElement("launch", "compiled-launch", { length: 20 }),
    ];
    const firstCompiled = compileSemanticChain(compiledElements, {
      referenceSpeed: 24,
      samples: 48,
    });
    const secondCompiled = compileSemanticChain(compiledElements, {
      referenceSpeed: 24,
      samples: 48,
    });
    expect(firstCompiled.track!.positions).toEqual(
      secondCompiled.track!.positions,
    );
    expect(firstCompiled.track!.tangents).toEqual(
      secondCompiled.track!.tangents,
    );
    expect(firstCompiled.track!.normals).toEqual(secondCompiled.track!.normals);
    expect(firstCompiled.track!.binormals).toEqual(
      secondCompiled.track!.binormals,
    );
    expect(firstCompiled.track!.curvature).toEqual(
      secondCompiled.track!.curvature,
    );
    expect(firstCompiled.track!.bank).toEqual(secondCompiled.track!.bank);
    expect(firstCompiled.track!.bankDerivative).toEqual(
      secondCompiled.track!.bankDerivative,
    );
    expect(firstCompiled.track!.parameters).toEqual(
      secondCompiled.track!.parameters,
    );
    expect(firstCompiled.track!.elementIndices).toEqual(
      secondCompiled.track!.elementIndices,
    );
    expect(firstCompiled.track!.elementBoundaries).toEqual(
      secondCompiled.track!.elementBoundaries,
    );
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
