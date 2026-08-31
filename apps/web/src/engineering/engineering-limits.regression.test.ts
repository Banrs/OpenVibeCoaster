import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate } from "./worker";
import { defaultProjectEngineeringLimits } from "@openvibecoaster/simulator";
import { RideTimeline } from "@openvibecoaster/simulator";
import { validateEngineeringLimits } from "@openvibecoaster/simulator";

const strict = defaultProjectEngineeringLimits;

describe("engineering limits final regression – production path over-limit", () => {
  it(
    "RED: valid launch track with default strict profile is over jerk limit and must be rejected as hard failure (before fix this was success)",
    { timeout: 20000 },
    () => {
      const validIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 42,
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
      // With strict limits, this ride exceeds jerk 426 >15 and must be failure
      const result = handleGenerate(
        "regression-over-limit",
        validIntent as unknown,
        strict,
      );
      expect(result.type).toBe("failure");
      if (result.type !== "failure") throw new Error("expected failure");
      const jerkDiag = result.diagnostics.find(
        (d) => d.code === "ENGINEERING_LIMIT_JERK",
      );
      expect(jerkDiag).toBeDefined();
      expect(jerkDiag!.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
      expect(jerkDiag!.severity).toMatch(/error|fatal/);
      expect(jerkDiag!.actual).toBeGreaterThan(jerkDiag!.limit!);
      expect(jerkDiag!.margin).toBeLessThan(0);
      expect(jerkDiag!.location).toBeDefined();
      expect(typeof jerkDiag!.location!.s).toBe("number");
      // Ensure no silent downgrade – success would have been wrong
      expect(result.type).not.toBe("success");
    },
  );

  it(
    "GREEN: same intent with permissive limits succeeds (proves explicit typed profile controls outcome)",
    { timeout: 20000 },
    () => {
      const validIntent = createDesignIntentV1({
        generatorVersion: "test-v1",
        seed: 42,
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
      const permissive = {
        ...strict,
        maximumJerkMps3: 5000,
        maximumAbsoluteLateralG: 50,
        maximumAbsoluteLongitudinalG: 50,
        verticalG: { minimum: -10, maximum: 40 },
        maximumRollRateRadPerSecond: 100,
      };
      const result = handleGenerate(
        "regression-permissive",
        validIntent as unknown,
        permissive,
      );
      expect(result.type).toBe("success");
    },
  );

  it("unit: crafted over-limit timeline is rejected with correct actual/limit/margin and PROJECT_ENGINEERING_LIMIT", () => {
    const tl = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120, 2 / 120]),
      headDistanceM: new Float64Array([0, 5, 10]),
      speedMps: new Float64Array([5, 5, 5]),
      longitudinalG: new Float64Array([0.2, 2.0, 0.2]),
      lateralG: new Float64Array([0.2, 0.2, 0.2]),
      verticalG: new Float64Array([1, 1, 6.0]),
      jerkMps3: new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      carCount: 1,
      carPositionsXYZ: new Float64Array([0, 0, 0, 5, 0, 0, 10, 0, 0]),
      carTangentsXYZ: new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
      carNormalsXYZ: new Float64Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      carBinormalsXYZ: new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      perCarLongitudinalG: new Float64Array([0.2, 2.0, 0.2]),
      perCarLateralG: new Float64Array([0.2, 0.2, 0.2]),
      perCarVerticalG: new Float64Array([1, 1, 6.0]),
      perCarRollRateRadPerSec: new Float64Array([0.2, 0.2, 0.2]),
      perCarJerkXYZ: new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      bankRad: new Float64Array([0, 0, 0]),
      rollRateRadPerSec: new Float64Array([0.2, 0.2, 0.2]),
      specificForceXYZ: new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      launchActivity: new Float64Array([0, 0, 0]),
      brakeActivity: new Float64Array([0, 0, 0]),
      kineticEnergyJ: new Float64Array([0, 0, 0]),
      potentialEnergyJ: new Float64Array([0, 0, 0]),
      accumulatedDriveWorkJ: new Float64Array([0, 0, 0]),
      accumulatedLossWorkJ: new Float64Array([0, 0, 0]),
      energyErrorJ: new Float64Array([0, 0, 0]),
      perCarBankRad: new Float64Array([0, 0, 0]),
      perCarSpecificForceXYZ: new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    const diags = validateEngineeringLimits(tl, undefined, strict);
    const vert = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_VERTICAL_G_MAX",
    );
    const long = diags.find(
      (d) => d.code === "ENGINEERING_LIMIT_LONGITUDINAL_G",
    );
    expect(vert).toBeDefined();
    expect(long).toBeDefined();
    expect(vert!.actual).toBeCloseTo(6.0);
    expect(vert!.limit).toBe(5.0);
    expect(vert!.margin).toBeCloseTo(-1.0);
    expect(vert!.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    expect(long!.actual).toBeCloseTo(2.0);
    expect(long!.limit).toBe(1.5);
  });
});
