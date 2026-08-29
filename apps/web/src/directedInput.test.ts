import { describe, expect, it } from "vitest";
import {
  createDirectedDesignIntent,
  parseUint32Seed,
  validateDirectedInput,
  type DirectedEditorInput,
} from "./directedInput.js";

const validInput: DirectedEditorInput = {
  seed: 42,
  gates: [
    { position: [10, 2, 20], orientation: [0, 0, 0, 1] },
    { position: [30, 5, 40] },
  ],
  footprint: {
    polygon: [
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
    ],
    maxHeightM: 60,
    minHeightM: 0,
  },
  terrainProfileId: "plains",
  requiredElements: ["station", "stall", "airtimeHill"],
  requiresStall: true,
  hardTargets: [{ id: "end-y", kind: "end-y", value: 15 }],
  softTargets: [{ id: "end-bank", kind: "end-bank", value: 0.2 }],
  pinnedElementIds: ["station-000"],
};

describe("directed input – seed parsing", () => {
  it("accepts uint32 and rejects overflow/fractional", () => {
    expect(parseUint32Seed("4294967295")).toBe(4294967295);
    expect(parseUint32Seed("0")).toBe(0);
    expect(parseUint32Seed("4294967296")).toBeNull();
    expect(parseUint32Seed("1.5")).toBeNull();
    expect(parseUint32Seed("seed")).toBeNull();
    expect(parseUint32Seed(" -1 ")).toBeNull();
  });
});

describe("directed input – validation field-specific errors", () => {
  it("produces field-specific errors for invalid numbers, quaternions, polygons", () => {
    const invalidGatePos = {
      ...validInput,
      gates: [
        {
          position: [Number.NaN, 0, 0],
        } as unknown as DirectedEditorInput["gates"][number],
      ],
    };
    const errors1 = validateDirectedInput(invalidGatePos);
    expect(errors1.some((e) => e.field.startsWith("gates[0].position"))).toBe(
      true,
    );
    expect(errors1.some((e) => e.message.includes("finite"))).toBe(true);

    const invalidQuat = {
      ...validInput,
      gates: [
        {
          position: [0, 0, 0],
          orientation: [0, 0, 0, 0],
        } as unknown as DirectedEditorInput["gates"][number],
      ],
    };
    const errors2 = validateDirectedInput(invalidQuat);
    expect(errors2.some((e) => e.field.includes("orientation"))).toBe(true);

    const invalidQuatNaN = {
      ...validInput,
      gates: [
        {
          position: [0, 0, 0],
          orientation: [Number.NaN, 0, 0, 1],
        } as unknown as DirectedEditorInput["gates"][number],
      ],
    };
    const errors3 = validateDirectedInput(invalidQuatNaN);
    expect(errors3.some((e) => e.field.includes("orientation"))).toBe(true);

    const invalidPolygon = {
      ...validInput,
      footprint: {
        polygon: [
          [0, 0],
          [1, 1],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    const errors4 = validateDirectedInput(invalidPolygon);
    expect(errors4.some((e) => e.field.includes("polygon"))).toBe(true);

    const nonFinitePolygon = {
      ...validInput,
      footprint: {
        polygon: [
          [Number.POSITIVE_INFINITY, 0],
          [0, 0],
          [0, 10],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    const errors5 = validateDirectedInput(nonFinitePolygon);
    expect(errors5.some((e) => e.field.includes("polygon"))).toBe(true);

    const emptyTerrain = { ...validInput, terrainProfileId: "   " };
    expect(
      validateDirectedInput(emptyTerrain).some(
        (e) => e.field === "terrainProfileId",
      ),
    ).toBe(true);

    const unknownElement = {
      ...validInput,
      requiredElements: [
        "unknown-kind" as unknown as DirectedEditorInput["requiredElements"][number],
      ],
    };
    expect(
      validateDirectedInput(unknownElement).some((e) =>
        e.field.startsWith("requiredElements"),
      ),
    ).toBe(true);

    const zeroHeight = {
      ...validInput,
      footprint: { ...validInput.footprint, maxHeightM: 0 },
    };
    expect(
      validateDirectedInput(zeroHeight).some((e) =>
        e.field.includes("maxHeightM"),
      ),
    ).toBe(true);

    const nonFiniteTarget = {
      ...validInput,
      hardTargets: [{ id: "bad", kind: "end-y", value: Number.NaN }],
    };
    expect(
      validateDirectedInput(nonFiniteTarget).some((e) =>
        e.field.includes("hardTargets"),
      ),
    ).toBe(true);

    const duplicateTarget = {
      ...validInput,
      hardTargets: [{ id: "dup", kind: "end-y", value: 10 }],
      softTargets: [{ id: "dup", kind: "end-y", value: 10 }],
    };
    expect(
      validateDirectedInput(duplicateTarget).some((e) => e.field === "targets"),
    ).toBe(true);
  });

  it("rejects too many gates and invalid gate array", () => {
    const tooMany = {
      ...validInput,
      gates: [
        { position: [0, 0, 0] },
        { position: [0, 0, 1] },
        { position: [0, 0, 2] },
        { position: [0, 0, 3] },
      ],
    };
    expect(
      validateDirectedInput(tooMany).some((e) => e.field === "gates"),
    ).toBe(true);
  });

  it("never produces NaN in validated output", () => {
    const errors = validateDirectedInput(validInput);
    expect(errors).toHaveLength(0);
    // Ensure valid input fields are all finite
    for (const gate of validInput.gates) {
      for (const component of gate.position)
        expect(Number.isFinite(component)).toBe(true);
      if (gate.orientation)
        for (const c of gate.orientation) expect(Number.isFinite(c)).toBe(true);
    }
  });
});

describe("directed input – DesignIntent mapping", () => {
  it("maps spatial gates, footprint, terrain, stall/element, hard/soft exactly into DesignIntentV1", () => {
    const { intent, errors } = createDirectedDesignIntent(validInput);
    expect(errors).toHaveLength(0);
    expect(intent).not.toBeNull();
    expect(intent!.gates).toHaveLength(2);
    expect(intent!.gates[0]!.position).toEqual([10, 2, 20]);
    expect(intent!.gates[0]!.orientation).toEqual([0, 0, 0, 1]);
    expect(intent!.footprint).toBeDefined();
    expect(intent!.footprint!.min[0]).toBe(0);
    expect(intent!.footprint!.max[0]).toBe(100);
    expect(intent!.heightRange!.max).toBe(60);
    expect(intent!.terrainProfileId).toBe("plains");
    // requiredElements mapping – stable semantic IDs
    expect(intent!.elements.some((e) => e.id === "station-000")).toBe(true);
    expect(intent!.elements.some((e) => e.type === "stall")).toBe(true);
    // hard/soft mapping
    const hard = intent!.targets.find((t) => t.id === "end-y");
    const soft = intent!.targets.find((t) => t.id === "end-bank");
    expect(hard?.hard).toBe(true);
    expect(soft?.hard).toBe(false);
    // No NaN values
    for (const gate of intent!.gates) {
      for (const v of gate.position) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("preserves stable semantic element IDs and deterministic mapping", () => {
    const first = createDirectedDesignIntent(validInput).intent!;
    const second = createDirectedDesignIntent(validInput).intent!;
    expect(first.elements.map((e) => e.id)).toEqual(
      second.elements.map((e) => e.id),
    );
    // pinned IDs must be stable and exist
    expect(first.pinnedElementIds).toContain("station-000");
  });

  it("produces field-specific errors not NaN or silent defaults for invalid input", () => {
    const bad = {
      ...validInput,
      seed: -1,
      gates: [
        {
          position: [Number.POSITIVE_INFINITY, 0, 0],
        } as unknown as DirectedEditorInput["gates"][number],
      ],
    };
    const { intent, errors } = createDirectedDesignIntent(
      bad as DirectedEditorInput,
    );
    expect(intent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.every((e) => e.message.length > 0 && e.field.length > 0),
    ).toBe(true);
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("deep-copies inputs and freezes intent without mutating caller", () => {
    const copyBefore = JSON.stringify(validInput);
    const { intent } = createDirectedDesignIntent(validInput);
    expect(JSON.stringify(validInput)).toBe(copyBefore);
    expect(Object.isFrozen(intent!)).toBe(true);
    // mutating caller after should not affect intent
    const mutable = { ...validInput, seed: 999 } as DirectedEditorInput;
    const { intent: intent2 } = createDirectedDesignIntent(mutable);
    expect(intent!.seed).toBe(42);
    expect(intent2!.seed).toBe(999);
  });

  it("never returns schema-invalid intent", () => {
    const invalid = {
      ...validInput,
      requiredElements:
        [] as unknown as DirectedEditorInput["requiredElements"],
    };
    const { intent, errors } = createDirectedDesignIntent(invalid);
    expect(intent).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("maps footprint polygon exactly and validates finite numbers", () => {
    const polygonInput: DirectedEditorInput = {
      ...validInput,
      footprint: {
        polygon: [
          [5, 5],
          [55, 5],
          [55, 45],
          [5, 45],
        ],
        maxHeightM: 80,
      },
    };
    const { intent } = createDirectedDesignIntent(polygonInput);
    expect(intent!.footprint!.min[0]).toBe(5);
    expect(intent!.footprint!.max[0]).toBe(55);
    expect(intent!.footprint!.min[2]).toBe(5);
    expect(intent!.footprint!.max[2]).toBe(45);
  });
});
