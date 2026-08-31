import { describe, it, expect } from "vitest";
import { detectGateContradictions } from "./gateContradiction.js";
import type { DirectedEditorInput } from "../directedInput.js";
import {
  isPointInsidePolygon,
  signedDistanceXZ,
  vec3,
} from "@openvibecoaster/core";

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
  it("detects gate outside footprint X/Z and height with negative margins (polygon inclusive)", () => {
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
    // Polygon outside + height outside = 2 diagnostics (not 3 X/Z separate)
    expect(diags.length).toBe(2);
    const footprintDiag = diags.find(
      (d) => d.code === "GATE_OUTSIDE_FOOTPRINT",
    );
    const yDiag = diags.find((d) => d.code === "GATE_OUTSIDE_HEIGHT");
    expect(footprintDiag).toBeDefined();
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
    expect(yDiag?.actual).toBe(200);
    expect(yDiag?.limit).toBe(85);
    expect(yDiag?.margin).toBe(-115);
    // Stable signed distance evidence: actual = distance, limit 0, margin negative distance
    expect(footprintDiag?.actual).toBeGreaterThan(0);
    expect(footprintDiag?.limit).toBe(0);
    expect(footprintDiag?.margin).toBeLessThan(0);
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

  it("does not reject gate on footprint boundary (inclusive) — rectangular and concave edge", () => {
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
    // Concave boundary: point exactly on notch edge is allowed
    const concave: DirectedEditorInput["footprint"] = {
      polygon: [
        [0, 0],
        [10, 0],
        [10, 6],
        [6, 6],
        [6, 10],
        [0, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    };
    // Point on notch boundary edge (6,6) -> (6,6) is vertex, boundary inclusive
    expect(
      detectGateContradictions(makeInput([{ position: [6, 82, 6] }], concave)),
    ).toHaveLength(0);
    // Point on polygon edge midpoint
    expect(
      detectGateContradictions(makeInput([{ position: [5, 82, 0] }], concave)),
    ).toHaveLength(0);
  });

  it("detects gate just outside footprint with exact stable evidence", () => {
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
      expect(d.code).toBe("GATE_OUTSIDE_FOOTPRINT");
      expect(d.actual).toBeCloseTo(0.1, 5);
      expect(d.limit).toBe(0);
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
      expect(d.code).toBe("GATE_OUTSIDE_HEIGHT");
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
    // First gate: polygon+X+Y? actually polygon+Y =2, second 0, third polygon+Y=2 => total 4
    expect(diags.length).toBe(4);
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

  it("rejects gate inside AABB but outside concave notch with exact stable evidence", () => {
    // Concave L-shape polygon: notch at interior (6,6)-(10,10) is outside even though inside AABB [0,10]
    const concave: DirectedEditorInput["footprint"] = {
      polygon: [
        [0, 0],
        [10, 0],
        [10, 6],
        [6, 6],
        [6, 10],
        [0, 10],
      ],
      maxHeightM: 85,
      minHeightM: 80,
    };
    // Gate at (8,82,8) is inside AABB but in notch outside polygon
    const notchGate = makeInput([{ position: [8, 82, 8] }], concave);
    const diags = detectGateContradictions(notchGate);
    expect(diags.length).toBe(1);
    const d = diags[0]!;
    expect(d.code).toBe("GATE_OUTSIDE_FOOTPRINT");
    expect(d.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(d.margin).toBeLessThan(0);
    expect(d.actual).toBeGreaterThan(0);
    expect(d.limit).toBe(0);
    // Verify via core classification
    const polyVec3 = concave.polygon.map(([x, z]) => vec3(x, 0, z));
    expect(
      isPointInsidePolygon(
        polyVec3 as unknown as readonly (typeof polyVec3)[number][],
        vec3(8, 0, 8),
      ),
    ).toBe(false);
    expect(
      signedDistanceXZ(
        polyVec3 as unknown as readonly (typeof polyVec3)[number][],
        vec3(8, 0, 8),
      ),
    ).toBeGreaterThan(0);
    expect(
      signedDistanceXZ(
        polyVec3 as unknown as readonly (typeof polyVec3)[number][],
        vec3(6, 0, 6),
      ),
    ).toBe(0);

    // Gate inside polygon but near notch interior (2,2) should be allowed
    expect(
      detectGateContradictions(makeInput([{ position: [2, 82, 2] }], concave)),
    ).toHaveLength(0);
    // Gate outside height but inside notch should give height diag only? Actually also footprint diag => 2
    const both = makeInput([{ position: [8, 90, 8] }], concave);
    expect(detectGateContradictions(both).length).toBe(2);
  });

  it("rigid transform invariance: detection stable under rotation/translation", () => {
    const originalPolygon: DirectedEditorInput["footprint"] = {
      polygon: [
        [0, 0],
        [10, 0],
        [10, 6],
        [6, 6],
        [6, 10],
        [0, 10],
      ],
      maxHeightM: 100,
      minHeightM: 0,
    };
    const insideGate: [number, number, number] = [2, 50, 2];
    const outsideNotchGate: [number, number, number] = [8, 50, 8];
    const boundaryGate: [number, number, number] = [6, 50, 6];
    // Original
    expect(
      detectGateContradictions(
        makeInput([{ position: insideGate }], originalPolygon),
      ),
    ).toHaveLength(0);
    expect(
      detectGateContradictions(
        makeInput([{ position: outsideNotchGate }], originalPolygon),
      ),
    ).toHaveLength(1);
    expect(
      detectGateContradictions(
        makeInput([{ position: boundaryGate }], originalPolygon),
      ),
    ).toHaveLength(0);

    // Rigid transform: rotate 90deg around origin and translate (100, -50)
    const angle = Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = 100,
      tz = -50;
    const transform = (p: readonly [number, number]): [number, number] => {
      const x = p[0] * cos - p[1] * sin + tx;
      const z = p[0] * sin + p[1] * cos + tz;
      return [x, z];
    };
    const transformGate = (
      g: readonly [number, number, number],
    ): [number, number, number] => {
      const [x, z] = transform([g[0], g[2]]);
      return [x, g[1], z];
    };
    const transformedPolygon: DirectedEditorInput["footprint"] = {
      polygon: originalPolygon.polygon.map(
        transform,
      ) as unknown as typeof originalPolygon.polygon,
      maxHeightM: 100,
      minHeightM: 0,
    };
    expect(
      detectGateContradictions(
        makeInput(
          [{ position: transformGate(insideGate) }],
          transformedPolygon,
        ),
      ),
    ).toHaveLength(0);
    const outsideTransformed = detectGateContradictions(
      makeInput(
        [{ position: transformGate(outsideNotchGate) }],
        transformedPolygon,
      ),
    );
    expect(outsideTransformed.length).toBe(1);
    expect(outsideTransformed[0]!.margin).toBeLessThan(0);
    expect(
      detectGateContradictions(
        makeInput(
          [{ position: transformGate(boundaryGate) }],
          transformedPolygon,
        ),
      ),
    ).toHaveLength(0);
  });
});
