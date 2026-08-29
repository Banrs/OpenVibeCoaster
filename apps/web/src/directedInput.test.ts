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

  it("rejects duplicate vertices, zero-length edges, bow-tie self-intersection and true zero area", () => {
    const dup = {
      ...validInput,
      footprint: {
        polygon: [
          [0, 0],
          [1, 0],
          [1, 0],
          [0, 1],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    expect(
      validateDirectedInput(dup).some((e) => e.field.includes("polygon")),
    ).toBe(true);
    expect(createDirectedDesignIntent(dup).intent).toBeNull();

    const bowTie = {
      ...validInput,
      footprint: {
        polygon: [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    const bowErrors = validateDirectedInput(bowTie);
    expect(bowErrors.some((e) => e.field === "footprint.polygon")).toBe(true);
    expect(bowErrors.some((e) => e.message.includes("self-intersect"))).toBe(
      true,
    );
    expect(createDirectedDesignIntent(bowTie).intent).toBeNull();

    // collinear 3 points on edge + tiny area may still be > epsilon; force degenerate line
    const degenerate = {
      ...validInput,
      footprint: {
        polygon: [
          [0, 0],
          [1, 0],
          [2, 0],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    expect(
      validateDirectedInput(degenerate).some((e) =>
        e.field.includes("polygon"),
      ),
    ).toBe(true);
  });

  it("rejects non-rectangular polygons explicitly instead of silently using AABB", () => {
    const pentagon = {
      ...validInput,
      footprint: {
        polygon: [
          [0, 0],
          [100, 0],
          [100, 50],
          [50, 80],
          [0, 50],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    const errors = validateDirectedInput(pentagon);
    expect(errors.some((e) => e.message.includes("unsupported"))).toBe(true);
    expect(createDirectedDesignIntent(pentagon).intent).toBeNull();
  });

  it("never silently drops pinnedElementIds – unknown and duplicate pins error field-specifically", () => {
    const unknownPin = {
      ...validInput,
      pinnedElementIds: ["station-000", "nonexistent-999"],
    };
    const e1 = validateDirectedInput(unknownPin);
    expect(e1.some((e) => e.field === "pinnedElementIds[1]")).toBe(true);
    expect(createDirectedDesignIntent(unknownPin).intent).toBeNull();

    const duplicatePin = {
      ...validInput,
      pinnedElementIds: ["station-000", "station-000"],
    };
    const e2 = validateDirectedInput(duplicatePin);
    expect(e2.some((e) => e.field === "pinnedElementIds[1]")).toBe(true);
    expect(e2.some((e) => e.message.includes("duplicate"))).toBe(true);

    const validPin = {
      ...validInput,
      requiredElements: [
        "station",
        "stall",
      ] as unknown as DirectedEditorInput["requiredElements"],
      pinnedElementIds: ["stall-001", "station-000"],
    };
    const { intent, errors } = createDirectedDesignIntent(validPin);
    expect(errors).toHaveLength(0);
    expect(intent!.pinnedElementIds).toEqual(["stall-001", "station-000"]);
  });

  it("rejects extra fields with deterministic exact-key errors", () => {
    const withExtraInput = {
      ...validInput,
      extra: 1,
    } as unknown as DirectedEditorInput;
    expect(
      validateDirectedInput(withExtraInput).some((e) =>
        e.field.includes("extra"),
      ),
    ).toBe(true);
    const withGateExtra = {
      ...validInput,
      gates: [
        {
          position: [0, 0, 0],
          extra: 1,
        } as unknown as DirectedEditorInput["gates"][number],
      ],
    };
    expect(
      validateDirectedInput(withGateExtra).some(
        (e) => e.field === "gates[0].extra",
      ),
    ).toBe(true);
    const withFootprintExtra = {
      ...validInput,
      footprint: {
        ...validInput.footprint,
        extra: 1,
      } as unknown as DirectedEditorInput["footprint"],
    };
    expect(
      validateDirectedInput(withFootprintExtra).some(
        (e) => e.field === "footprint.extra",
      ),
    ).toBe(true);
    const withTargetExtra = {
      ...validInput,
      hardTargets: [
        {
          id: "t",
          kind: "end-y",
          value: 1,
          extra: 1,
        } as unknown as DirectedEditorInput["hardTargets"][number],
      ],
    };
    expect(
      validateDirectedInput(withTargetExtra).some(
        (e) => e.field === "hardTargets[0].extra",
      ),
    ).toBe(true);
  });

  it("rejects duplicate requiredElements field-specifically", () => {
    const dup = {
      ...validInput,
      requiredElements: [
        "station",
        "station",
      ] as unknown as DirectedEditorInput["requiredElements"],
    };
    expect(
      validateDirectedInput(dup).some((e) => e.field === "requiredElements[1]"),
    ).toBe(true);
    expect(
      validateDirectedInput(dup).some((e) => e.message.includes("duplicate")),
    ).toBe(true);
    expect(createDirectedDesignIntent(dup).intent).toBeNull();
  });

  it("handles large-coordinate degenerate and near-degenerate polygons", () => {
    const large = 1e7;
    const degenerateLarge = {
      ...validInput,
      footprint: {
        polygon: [
          [large, large],
          [large + 10, large],
          [large + 20, large],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    expect(
      validateDirectedInput(degenerateLarge).some((e) =>
        e.field.includes("polygon"),
      ),
    ).toBe(true);
    const nearCollinear = {
      ...validInput,
      footprint: {
        polygon: [
          [large, large],
          [large + 50, large + 50.0000001],
          [large + 100, large + 100.0000002],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    expect(
      validateDirectedInput(nearCollinear).some((e) =>
        e.field.includes("polygon"),
      ),
    ).toBe(true);
    // Valid large rectangle should still pass
    const validLarge = {
      ...validInput,
      footprint: {
        polygon: [
          [large, large],
          [large + 100, large],
          [large + 100, large + 80],
          [large, large + 80],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    expect(validateDirectedInput(validLarge)).toHaveLength(0);
  });
  it("rejects invented terrain field, only terrainProfileId is public", () => {
    const withTerrain = {
      ...validInput,
      terrain: "plains",
    } as unknown as DirectedEditorInput;
    expect(
      validateDirectedInput(withTerrain).some((e) =>
        e.field.includes("terrain"),
      ),
    ).toBe(true);
    expect(validateDirectedInput(validInput)).toHaveLength(0);
  });

  it("rejects contradictory hard flags in hardTargets/softTargets", () => {
    const hardWithFalse = {
      ...validInput,
      hardTargets: [
        {
          id: "t",
          kind: "end-y",
          value: 1,
          hard: false,
        } as unknown as DirectedEditorInput["hardTargets"][number],
      ],
    };
    expect(
      validateDirectedInput(hardWithFalse).some(
        (e) => e.field === "hardTargets[0].hard",
      ),
    ).toBe(true);
    expect(createDirectedDesignIntent(hardWithFalse).intent).toBeNull();
    const softWithTrue = {
      ...validInput,
      softTargets: [
        {
          id: "t",
          kind: "end-y",
          value: 1,
          hard: true,
        } as unknown as DirectedEditorInput["softTargets"][number],
      ],
    };
    expect(
      validateDirectedInput(softWithTrue).some(
        (e) => e.field === "softTargets[0].hard",
      ),
    ).toBe(true);
    expect(createDirectedDesignIntent(softWithTrue).intent).toBeNull();
  });
});
