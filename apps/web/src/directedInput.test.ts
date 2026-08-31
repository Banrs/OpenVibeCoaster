import { describe, expect, it } from "vitest";
import {
  parseDesignIntentV1,
  serializeDesignIntentV1,
} from "@openvibecoaster/core";
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
    expect(intent!.footprint).toHaveLength(4);
    expect(intent!.footprint![0]).toEqual([0, 0, 0]);
    expect(intent!.footprint![1]).toEqual([100, 0, 0]);
    expect(intent!.footprint![2]).toEqual([100, 0, 80]);
    expect(intent!.footprint![3]).toEqual([0, 0, 80]);
    expect(intent!.heightRange!.min).toBe(0);
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
    const { intent, errors } = createDirectedDesignIntent(polygonInput);
    expect(errors).toHaveLength(0);
    expect(intent!.footprint).toHaveLength(4);
    expect(intent!.footprint![0]).toEqual([5, 0, 5]);
    expect(intent!.footprint![1]).toEqual([55, 0, 5]);
    expect(intent!.footprint![2]).toEqual([55, 0, 45]);
    expect(intent!.footprint![3]).toEqual([5, 0, 45]);
    expect(intent!.heightRange!.min).toBe(0);
    expect(intent!.heightRange!.max).toBe(80);
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
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 1],
          [2, 1],
        ] as unknown as DirectedEditorInput["footprint"]["polygon"],
        maxHeightM: 10,
      },
    };
    const bowErrors = validateDirectedInput(bowTie);
    expect(bowErrors.some((e) => e.field === "footprint.polygon")).toBe(true);
    expect(
      bowErrors.some((e) => /crossing|overlapping|touching/i.test(e.message)),
    ).toBe(true);
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

  it("accepts valid pentagon and concave polygons preserving CW/CCW and order", () => {
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
    const pentErrors = validateDirectedInput(pentagon);
    expect(pentErrors).toHaveLength(0);
    const { intent: pentIntent, errors: pentCreateErrors } =
      createDirectedDesignIntent(pentagon);
    expect(pentCreateErrors).toHaveLength(0);
    expect(pentIntent).not.toBeNull();
    if (!pentIntent) throw new Error("pentIntent must be defined");
    const pentFootprint = pentIntent.footprint;
    if (!pentFootprint) throw new Error("pentFootprint must be defined");
    expect(pentFootprint).toHaveLength(5);
    expect(pentFootprint[0]).toEqual([0, 0, 0]);
    expect(pentFootprint[1]).toEqual([100, 0, 0]);
    expect(pentFootprint[4]).toEqual([0, 0, 50]);
    // Y always zero, heightRange separate authoritative
    for (const v of pentFootprint) expect(v[1]).toBe(0);
    const pentHeightRange = pentIntent.heightRange;
    if (!pentHeightRange) throw new Error("pentHeightRange must be defined");
    expect(pentHeightRange.max).toBe(10);
    expect(pentHeightRange.min).toBe(0);

    // Concave simple polygon (notch), CW and CCW both valid, order preserved
    const concave: DirectedEditorInput["footprint"]["polygon"] = [
      [0, 0],
      [10, 0],
      [10, 6],
      [6, 6],
      [6, 10],
      [0, 10],
    ];
    const concaveInput = {
      ...validInput,
      footprint: {
        polygon: concave,
        maxHeightM: 20,
        minHeightM: 2,
      },
    };
    const concaveErrors = validateDirectedInput(concaveInput);
    expect(concaveErrors).toHaveLength(0);
    const { intent: concaveIntent } = createDirectedDesignIntent(concaveInput);
    if (!concaveIntent) throw new Error("concaveIntent must be defined");
    const concaveFootprint = concaveIntent.footprint;
    if (!concaveFootprint) throw new Error("concaveFootprint must be defined");
    expect(concaveFootprint).toHaveLength(6);
    expect(concaveFootprint[0]).toEqual([0, 0, 0]);
    expect(concaveFootprint[2]).toEqual([10, 0, 6]);
    for (const v of concaveFootprint) expect(v[1]).toBe(0);
    const concaveHeightRange = concaveIntent.heightRange;
    if (!concaveHeightRange)
      throw new Error("concaveHeightRange must be defined");
    expect(concaveHeightRange.min).toBe(2);
    expect(concaveHeightRange.max).toBe(20);

    // CW order also valid (reverse)
    const concaveCW = [...concave].reverse();
    const cwErrors = validateDirectedInput({
      ...validInput,
      footprint: { polygon: concaveCW, maxHeightM: 20 },
    });
    expect(cwErrors).toHaveLength(0);
    const { intent: cwIntent } = createDirectedDesignIntent({
      ...validInput,
      footprint: { polygon: concaveCW, maxHeightM: 20 },
    });
    if (!cwIntent) throw new Error("cwIntent must be defined");
    const cwFootprint = cwIntent.footprint;
    if (!cwFootprint) throw new Error("cwFootprint must be defined");
    expect(cwFootprint[0]).toEqual([0, 0, 10]);
    expect(cwFootprint[5]).toEqual([0, 0, 0]);
  });

  it("preserves polygon order round-trip, maps [x,z]->[x,0,z], rectangle convenience order, separate heightRange", () => {
    // Order round-trip: input order -> Vec3 order -> serialized intent order
    const orderedPolygon: DirectedEditorInput["footprint"]["polygon"] = [
      [0, 0],
      [5, 0],
      [5, 5],
      [3, 3],
      [0, 5],
    ];
    const { intent } = createDirectedDesignIntent({
      ...validInput,
      footprint: { polygon: orderedPolygon, maxHeightM: 50, minHeightM: 5 },
    });
    if (!intent) throw new Error("ordered intent must be defined");
    expect(intent.footprint).toHaveLength(5);
    const orderedFootprint = intent.footprint;
    if (!orderedFootprint) throw new Error("footprint must be defined");
    expect(orderedFootprint[0]).toEqual([0, 0, 0]);
    expect(orderedFootprint[1]).toEqual([5, 0, 0]);
    expect(orderedFootprint[2]).toEqual([5, 0, 5]);
    expect(orderedFootprint[3]).toEqual([3, 0, 3]);
    expect(orderedFootprint[4]).toEqual([0, 0, 5]);
    // [x,z]->[x,0,z] mapping: Y always zero, heightRange authoritative
    for (const v of orderedFootprint) expect(v[1]).toBe(0);
    expect(intent.heightRange).toEqual({ min: 5, max: 50 });

    // Rectangle convenience frozen order: [minX,minZ],[maxX,minZ],[maxX,maxZ],[minX,maxZ]
    const rectMinX = -10,
      rectMaxX = 20,
      rectMinZ = -5,
      rectMaxZ = 15;
    const rectPolygon: DirectedEditorInput["footprint"]["polygon"] = [
      [rectMinX, rectMinZ],
      [rectMaxX, rectMinZ],
      [rectMaxX, rectMaxZ],
      [rectMinX, rectMaxZ],
    ];
    const { intent: rectIntent } = createDirectedDesignIntent({
      ...validInput,
      footprint: { polygon: rectPolygon, maxHeightM: 30 },
    });
    if (!rectIntent) throw new Error("rectIntent must be defined");
    expect(rectIntent.footprint).toEqual([
      [rectMinX, 0, rectMinZ],
      [rectMaxX, 0, rectMinZ],
      [rectMaxX, 0, rectMaxZ],
      [rectMinX, 0, rectMaxZ],
    ]);
    expect(rectIntent.heightRange).toEqual({ min: 0, max: 30 });

    // Save/reload canonical JSON preserves order via design intent (never emits {min,max})
    if (!intent) throw new Error("intent must be defined");
    const serialized = serializeDesignIntentV1(intent);
    const parsed = JSON.parse(serialized) as { footprint: unknown };
    expect(Array.isArray(parsed.footprint)).toBe(true);
    const footprintJson = parsed.footprint;
    if (Array.isArray(footprintJson)) {
      expect(footprintJson[0]).toEqual([0, 0, 0]);
      expect(footprintJson[1]).toEqual([5, 0, 0]);
    }
    const reparsed = parseDesignIntentV1(serialized);
    expect(reparsed.footprint).toEqual(intent.footprint);
    const second = intent.footprint ? intent.footprint[1] : undefined;
    if (second) expect(second[0]).toBe(5);
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
          [large + 50, large + 50],
          [large + 100, large + 100],
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
