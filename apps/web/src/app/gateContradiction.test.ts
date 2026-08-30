import { describe, it, expect } from "vitest";
import { detectGateContradictions } from "./gateContradiction.js";
import type { DirectedEditorInput } from "../directedInput.js";

function makeInput(
  gates: DirectedEditorInput["gates"],
  footprint: DirectedEditorInput["footprint"],
): DirectedEditorInput {
  return {
    seed: 1,
    gates,
    footprint,
    terrainProfileId: "rolling-highlands-v1",
    requiredElements: ["stall"],
    hardTargets: [],
    softTargets: [],
    pinnedElementIds: [],
  };
}

describe("detectGateContradictions", () => {
  it("detects gate outside footprint X/Z and height with negative margins", () => {
    const input = makeInput([{ position: [500, 200, 500] }], {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ] as const,
      maxHeightM: 85,
      minHeightM: 80,
    });
    const diags = detectGateContradictions(input);
    expect(diags.length).toBe(3);
    const xDiag = diags.find((d) => d.message.includes("X="));
    const zDiag = diags.find((d) => d.message.includes("Z="));
    const yDiag = diags.find((d) => d.message.includes("Y="));
    expect(xDiag).toBeDefined();
    expect(zDiag).toBeDefined();
    expect(yDiag).toBeDefined();
    for (const d of diags) {
      expect(d.code).toBeDefined();
      expect(d.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
      expect(d.severity).toBe("error");
      expect(d.actual !== undefined && Number.isFinite(d.actual)).toBe(true);
      expect(d.limit !== undefined && Number.isFinite(d.limit)).toBe(true);
      expect(d.margin !== undefined && Number.isFinite(d.margin)).toBe(true);
      expect(d.margin).toBeLessThan(0);
    }
    expect(xDiag?.actual).toBe(500);
    expect(xDiag?.limit).toBe(10);
    expect(xDiag?.margin).toBe(-490);
    expect(yDiag?.actual).toBe(200);
    expect(yDiag?.limit).toBe(85);
    expect(yDiag?.margin).toBe(-115);
    expect(zDiag?.actual).toBe(500);
    expect(zDiag?.limit).toBe(10);
    expect(zDiag?.margin).toBe(-490);
  });

  it("does not reject gate inside footprint and height", () => {
    const input = makeInput([{ position: [0, 82, 0] }], {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ] as const,
      maxHeightM: 85,
      minHeightM: 80,
    });
    expect(detectGateContradictions(input)).toHaveLength(0);
  });

  it("does not reject gate on footprint boundary (inclusive)", () => {
    const footprint: DirectedEditorInput["footprint"] = {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    };
    const cases: Array<[number, number, number]> = [
      [10, 80, 10],
      [-10, 80, -10],
      [10, 85, 10],
      [-10, 85, -10],
      [0, 80, 0],
      [0, 85, 0],
    ];
    for (const pos of cases) {
      const input = makeInput([{ position: pos }], footprint);
      expect(detectGateContradictions(input)).toHaveLength(0);
    }
  });

  it("detects gate just outside footprint", () => {
    const footprint: DirectedEditorInput["footprint"] = {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    };
    const input = makeInput([{ position: [10.1, 82, 0] }], footprint);
    const diags = detectGateContradictions(input);
    expect(diags.length).toBe(1);
    const d = diags[0];
    expect(d).toBeDefined();
    if (d) {
      expect(d.actual).toBe(10.1);
      expect(d.limit).toBe(10);
      expect(d.margin).toBeCloseTo(-0.1, 5);
      expect(d.margin).toBeLessThan(0);
    }
  });

  it("detects gate outside height but inside footprint", () => {
    const input = makeInput([{ position: [0, 90, 0] }], {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ] as const,
      maxHeightM: 85,
      minHeightM: 80,
    });
    const diags = detectGateContradictions(input);
    expect(diags.length).toBe(1);
    const d = diags[0];
    expect(d).toBeDefined();
    if (d) {
      expect(d.actual).toBe(90);
      expect(d.limit).toBe(85);
      expect(d.margin).toBe(-5);
    }
  });

  it("returns empty for no gates", () => {
    const input = makeInput([], {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    });
    expect(detectGateContradictions(input)).toHaveLength(0);
  });

  it("handles multiple gates with mixed inside/outside", () => {
    const footprint: DirectedEditorInput["footprint"] = {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    };
    const input = makeInput(
      [
        { position: [500, 200, 500] },
        { position: [0, 82, 0] },
        { position: [-20, 90, 0] },
      ],
      footprint,
    );
    const diags = detectGateContradictions(input);
    // First gate: 3 diagnostics (X,Z,Y), third gate: X outside and Y outside => 2 diagnostics
    // Total should be 5
    expect(diags.length).toBe(5);
    const margins = diags.map((d) => d.margin);
    for (const m of margins) {
      expect(m !== undefined && Number.isFinite(m)).toBe(true);
      expect(m).toBeLessThan(0);
    }
  });

  it("is deterministic and pure", () => {
    const input = makeInput([{ position: [500, 200, 500] }], {
      polygon: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ] as const,
      maxHeightM: 85,
      minHeightM: 80,
    });
    const a = detectGateContradictions(input);
    const b = detectGateContradictions(input);
    expect(a).toEqual(b);
  });
});
