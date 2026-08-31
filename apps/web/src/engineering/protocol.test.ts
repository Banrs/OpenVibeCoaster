import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { generateCoaster } from "@openvibecoaster/generator";
import {
  isEngineeringWorkerRequest,
  validateEngineeringWorkerRequest,
  validateEngineeringWorkerResponse,
} from "./protocol";
import { RideTimeline } from "@openvibecoaster/simulator";

const validIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 1,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 100, targetSpeed: 10, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 100, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

describe("EngineeringWorkerRequest validation", () => {
  it("accepts exact generate request", () => {
    const req = {
      type: "generate" as const,
      requestId: "req-1",
      intent: validIntent,
    };
    expect(() => validateEngineeringWorkerRequest(req)).not.toThrow();
    expect(isEngineeringWorkerRequest(req)).toBe(true);
  });

  it("accepts exact regenerate request", () => {
    const file = generateCoaster(validIntent).file;
    const req = {
      type: "regenerate" as const,
      requestId: "req-2",
      file,
      elementId: "station-0",
    };
    expect(() => validateEngineeringWorkerRequest(req)).not.toThrow();
  });

  it("accepts exact compile-simulate request", () => {
    const file = generateCoaster(validIntent).file;
    const req = {
      type: "compile-simulate" as const,
      requestId: "req-3",
      file,
    };
    expect(() => validateEngineeringWorkerRequest(req)).not.toThrow();
  });

  it("accepts exact cancel request", () => {
    const req = { type: "cancel" as const, requestId: "req-4" };
    expect(() => validateEngineeringWorkerRequest(req)).not.toThrow();
  });

  it("rejects request with extra field", () => {
    const req = {
      type: "generate" as const,
      requestId: "r1",
      intent: validIntent,
      extra: 123,
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow(/extra field/);
    expect(isEngineeringWorkerRequest(req)).toBe(false);
  });

  it("rejects missing requestId", () => {
    const req = {
      type: "generate" as const,
      intent: validIntent,
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow();
  });

  it("rejects empty requestId", () => {
    const req = {
      type: "generate" as const,
      requestId: "   ",
      intent: validIntent,
    };
    expect(() => validateEngineeringWorkerRequest(req)).toThrow(/non-empty/);
  });

  it("rejects unknown type", () => {
    const req = {
      type: "unknown" as unknown as "generate",
      requestId: "r1",
      intent: validIntent,
    };
    expect(() => validateEngineeringWorkerRequest(req)).toThrow();
  });

  it("rejects generate without intent object", () => {
    const req = {
      type: "generate" as const,
      requestId: "r1",
      intent: "bad",
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow(/object/);
  });

  it("rejects regenerate without elementId", () => {
    const req = {
      type: "regenerate" as const,
      requestId: "r1",
      file: {},
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow();
  });

  it("rejects regenerate with empty elementId", () => {
    const req = {
      type: "regenerate" as const,
      requestId: "r1",
      file: {},
      elementId: "",
    };
    expect(() => validateEngineeringWorkerRequest(req)).toThrow(/non-empty/);
  });

  it("rejects compile-simulate without file", () => {
    const req = {
      type: "compile-simulate" as const,
      requestId: "r1",
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow();
  });

  it("rejects cancel with extra field", () => {
    const req = {
      type: "cancel" as const,
      requestId: "r1",
      intent: validIntent,
    } as unknown as Record<string, unknown>;
    expect(() => validateEngineeringWorkerRequest(req)).toThrow(
      /no extra field/,
    );
  });

  it("rejects non-object", () => {
    expect(() => validateEngineeringWorkerRequest("string")).toThrow(/object/);
    expect(isEngineeringWorkerRequest(null)).toBe(false);
  });

  it("rejects generate with NaN and Infinity via canonical validator", () => {
    const nanIntent = {
      ...validIntent,
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: Number.NaN, bank: 0, closed: false },
        },
      ],
    } as unknown as typeof validIntent;
    const infIntent = {
      ...validIntent,
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: {
            length: Number.POSITIVE_INFINITY,
            bank: 0,
            closed: false,
          },
        },
      ],
    } as unknown as typeof validIntent;
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "generate",
        requestId: "r-nan",
        intent: nanIntent,
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "generate",
        requestId: "r-inf",
        intent: infIntent,
      }),
    ).toThrow(/finite/);
    // Deterministic: same NaN produces same message
    let m1 = "";
    let m2 = "";
    try {
      validateEngineeringWorkerRequest({
        type: "generate",
        requestId: "r-nan2",
        intent: nanIntent,
      });
    } catch (e) {
      m1 = e instanceof Error ? e.message : String(e);
    }
    try {
      validateEngineeringWorkerRequest({
        type: "generate",
        requestId: "r-nan3",
        intent: nanIntent,
      });
    } catch (e) {
      m2 = e instanceof Error ? e.message : String(e);
    }
    expect(m1).toBe(m2);
  });

  it("rejects generate with nested extra field", () => {
    const extraIntent = {
      ...validIntent,
      elements: validIntent.elements.map((e, i) =>
        i === 0
          ? ({
              ...e,
              parameters: { ...(e.parameters as object), extraField: 123 },
            } as unknown as typeof e)
          : e,
      ),
    } as unknown as typeof validIntent;
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "generate",
        requestId: "r-extra",
        intent: extraIntent,
      }),
    ).toThrow(/extra field/);
  });

  it("rejects regenerate/compile-simulate with file containing NaN, Infinity, extra", () => {
    const file = generateCoaster(validIntent).file;
    // Create file with NaN in solvedSpans
    const nanFile = {
      ...file,
      solvedSpans: file.solvedSpans.map((s, i) =>
        i === 0
          ? {
              ...s,
              positionCoefficients: s.positionCoefficients.map((row) =>
                row.map(() => Number.NaN),
              ),
            }
          : s,
      ),
    } as unknown as typeof file;
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "regenerate",
        requestId: "r-nan-file",
        file: nanFile,
        elementId: "station-0",
      }),
    ).toThrow(/finite/);
    const infFile = {
      ...file,
      solvedSpans: file.solvedSpans.map((s, i) =>
        i === 0
          ? {
              ...s,
              rollCoefficients: s.rollCoefficients.map(
                () => Number.POSITIVE_INFINITY,
              ),
            }
          : s,
      ),
    } as unknown as typeof file;
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "compile-simulate",
        requestId: "r-inf-file",
        file: infFile,
      }),
    ).toThrow(/finite/);
    const extraTopFile = { ...file, extraTop: 1 } as unknown as typeof file;
    expect(() =>
      validateEngineeringWorkerRequest({
        type: "compile-simulate",
        requestId: "r-extra-file",
        file: extraTopFile,
      }),
    ).toThrow(/extra field/);
  });
});

describe("EngineeringWorkerResponse timings validation", () => {
  function validSuccessBase() {
    const g = generateCoaster(validIntent);
    // Use real file/track/timeline via generator to satisfy strict track checks; timeline is genuinely valid 28-buffer compact
    const validTimeline = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120]),
      headDistanceM: new Float64Array([0, 10]),
      speedMps: new Float64Array([5, 5]),
      longitudinalG: new Float64Array([0, 0]),
      lateralG: new Float64Array([0, 0]),
      verticalG: new Float64Array([1, 1]),
      jerkMps3: new Float64Array([0, 0, 0, 0, 0, 0]),
      carCount: 1,
      carPositionsXYZ: new Float64Array([0, 0, 0, 10, 0, 0]),
      carTangentsXYZ: new Float64Array([1, 0, 0, 1, 0, 0]),
      carNormalsXYZ: new Float64Array([0, 1, 0, 0, 1, 0]),
      carBinormalsXYZ: new Float64Array([0, 0, 1, 0, 0, 1]),
      launchActivity: new Float64Array([0, 0]),
      brakeActivity: new Float64Array([0, 0]),
      kineticEnergyJ: new Float64Array([0, 0]),
      potentialEnergyJ: new Float64Array([0, 0]),
      accumulatedDriveWorkJ: new Float64Array([0, 0]),
      accumulatedLossWorkJ: new Float64Array([0, 0]),
      energyErrorJ: new Float64Array([0, 0]),
      bankRad: new Float64Array([0, 0]),
      rollRateRadPerSec: new Float64Array([0, 0]),
      specificForceXYZ: new Float64Array([0, 0, 0, 0, 0, 0]),
      perCarLongitudinalG: new Float64Array([0, 0]),
      perCarLateralG: new Float64Array([0, 0]),
      perCarVerticalG: new Float64Array([1, 1]),
      perCarBankRad: new Float64Array([0, 0]),
      perCarRollRateRadPerSec: new Float64Array([0, 0]),
      perCarSpecificForceXYZ: new Float64Array([0, 0, 0, 0, 0, 0]),
      perCarJerkXYZ: new Float64Array([0, 0, 0, 0, 0, 0]),
    }).toTransferable();
    return {
      type: "success" as const,
      requestId: "resp-1",
      file: g.file,
      track: {
        positions: g.track.positions,
        tangents: g.track.tangents,
        normals: g.track.normals,
        binormals: g.track.binormals,
        distances: g.track.distances,
        curvature: g.track.curvature,
        curvatureVector: g.track.curvatureVector,
        bank: g.track.bank,
        bankDerivative: g.track.bankDerivative,
        zoneMasks: g.track.zoneMasks,
        zoneNames: [...g.track.zoneNames],
        elementIndices: g.track.elementIndices,
        elementBoundaries: g.track.elementBoundaries,
        parameters: g.track.parameters,
        totalLength: g.track.totalLength,
        checksum: g.track.checksum,
      },
      timeline: validTimeline,
      diagnostics: [],
      relaxations: [],
      spanHashes: { a: "00000000" },
      timings: {
        simulationMs: 15.2,
        workerSendEpochMs: performance.timeOrigin + performance.now(),
      },
    } as unknown as Record<string, unknown>;
  }

  it("accepts success with valid timings", () => {
    const s = validSuccessBase();
    expect(() => validateEngineeringWorkerResponse(s)).not.toThrow();
  });

  it("rejects success missing timings", () => {
    const s = validSuccessBase();
    delete (s as { timings?: unknown }).timings;
    expect(() => validateEngineeringWorkerResponse(s)).toThrow(/timings/);
  });

  it("rejects timings with NaN, Infinity, negative", () => {
    const s = validSuccessBase();
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: { simulationMs: Number.NaN, workerSendEpochMs: 100 },
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: {
          simulationMs: Number.POSITIVE_INFINITY,
          workerSendEpochMs: 100,
        },
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: { simulationMs: -1, workerSendEpochMs: 100 },
      }),
    ).toThrow(/non-negative/);
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: { simulationMs: 5, workerSendEpochMs: Number.NaN },
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: { simulationMs: 5, workerSendEpochMs: -10 },
      }),
    ).toThrow(/non-negative/);
  });

  it("rejects success with extra field in timings or top level", () => {
    const s = validSuccessBase();
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: {
          simulationMs: 1,
          workerSendEpochMs: 100,
          extra: 123,
        },
      } as unknown as Record<string, unknown>),
    ).toThrow(/extra field/);
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        extraTop: 1,
      } as unknown as Record<string, unknown>),
    ).toThrow(/extra field/);
  });

  it("rejects success with no timings extra malformed still fails when other fields valid", () => {
    const s = validSuccessBase();
    // ensure strict extra field rejection not loosened
    expect(() =>
      validateEngineeringWorkerResponse({
        ...s,
        timings: { simulationMs: 5, workerSendEpochMs: 100 },
        timings_extra: 1,
      } as unknown as Record<string, unknown>),
    ).toThrow(/extra field/);
  });
});
