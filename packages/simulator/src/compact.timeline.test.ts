import { describe, expect, it } from "vitest";
import {
  compileTrack,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import type { CompiledTrackData } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";
import {
  RideTimeline,
  TIMELINE_CURRENT_BUFFER_COUNT,
  TIMELINE_LEGACY_BUFFER_COUNT,
} from "./timeline.js";

function straightTrack(): CompiledTrackData {
  const mk = (p0: [number, number, number], p1: [number, number, number]) =>
    new SeventhOrderHermiteSpan({
      p0: vec3(...p0),
      d10: vec3(1, 0, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(...p1),
      d11: vec3(1, 0, 0),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
  return compileTrack([
    {
      id: "a",
      span: mk([0, 10, 0], [500, 10, 0]),
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      zones: [],
    },
    {
      id: "b",
      span: mk([500, 10, 0], [1000, 10, 0]),
      bank: new QuinticScalarSpan({
        v0: 0,
        d10: 0,
        d20: 0,
        v1: 0,
        d11: 0,
        d21: 0,
      }),
      zones: [],
    },
  ]);
}

describe("compact vs full simulation parity", () => {
  it("full/default vs compact: identical 120 Hz for all authoritative series; compact frames zero but SimulationResult.frames remains", () => {
    const track = straightTrack();
    const base = createDefaultSimulatorConfig();
    const config = {
      ...base,
      zones: [
        {
          id: "launch-0",
          kind: "launch" as const,
          startDistanceM: 0,
          endDistanceM: 80,
          lsmForcePerCarN: 14000,
        } as never,
        {
          id: "brake-0",
          kind: "brake" as const,
          startDistanceM: 400,
          endDistanceM: 500,
          brakeForcePerCarN: 18000,
        } as never,
      ],
    };
    const full = simulateRide(track, {
      config,
      initial: { headDistanceM: 30, speedMps: 5 },
      durationSeconds: 2,
    });
    const compact = simulateRide(track, {
      config,
      initial: { headDistanceM: 30, speedMps: 5 },
      durationSeconds: 2,
      compactTimeline: true,
    });
    expect(full.timeline.length).toBeGreaterThan(0);
    expect(compact.timeline.length).toBe(full.timeline.length);
    expect(full.timeline.sampleRateHz).toBe(120);
    expect(compact.timeline.sampleRateHz).toBe(120);
    expect(full.timeline.frames.length).toBe(full.timeline.length);
    expect(compact.timeline.frames.length).toBe(0);
    expect(full.frames.length).toBeGreaterThan(0);
    expect(compact.frames.length).toBe(full.frames.length);
    // table-driven equality for every authoritative series
    const cases: Array<[string, Float64Array, Float64Array]> = [
      ["timeSeconds", full.timeline.timeSeconds, compact.timeline.timeSeconds],
      [
        "headDistanceM",
        full.timeline.headDistanceM,
        compact.timeline.headDistanceM,
      ],
      ["speedMps", full.timeline.speedMps, compact.timeline.speedMps],
      [
        "longitudinalG",
        full.timeline.longitudinalG,
        compact.timeline.longitudinalG,
      ],
      ["lateralG", full.timeline.lateralG, compact.timeline.lateralG],
      ["verticalG", full.timeline.verticalG, compact.timeline.verticalG],
      ["jerkMps3", full.timeline.jerkMps3, compact.timeline.jerkMps3],
      [
        "carPositionsXYZ",
        full.timeline.carPositionsXYZ,
        compact.timeline.carPositionsXYZ,
      ],
      [
        "carTangentsXYZ",
        full.timeline.carTangentsXYZ,
        compact.timeline.carTangentsXYZ,
      ],
      [
        "carNormalsXYZ",
        full.timeline.carNormalsXYZ,
        compact.timeline.carNormalsXYZ,
      ],
      [
        "carBinormalsXYZ",
        full.timeline.carBinormalsXYZ,
        compact.timeline.carBinormalsXYZ,
      ],
      [
        "launchActivity",
        full.timeline.launchActivity,
        compact.timeline.launchActivity,
      ],
      [
        "brakeActivity",
        full.timeline.brakeActivity,
        compact.timeline.brakeActivity,
      ],
      [
        "kineticEnergyJ",
        full.timeline.kineticEnergyJ,
        compact.timeline.kineticEnergyJ,
      ],
      [
        "potentialEnergyJ",
        full.timeline.potentialEnergyJ,
        compact.timeline.potentialEnergyJ,
      ],
      [
        "accumulatedDriveWorkJ",
        full.timeline.accumulatedDriveWorkJ,
        compact.timeline.accumulatedDriveWorkJ,
      ],
      [
        "accumulatedLossWorkJ",
        full.timeline.accumulatedLossWorkJ,
        compact.timeline.accumulatedLossWorkJ,
      ],
      [
        "energyErrorJ",
        full.timeline.energyErrorJ,
        compact.timeline.energyErrorJ,
      ],
      ["bankRad", full.timeline.bankRad, compact.timeline.bankRad],
      [
        "rollRateRadPerSec",
        full.timeline.rollRateRadPerSec,
        compact.timeline.rollRateRadPerSec,
      ],
      [
        "specificForceXYZ",
        full.timeline.specificForceXYZ,
        compact.timeline.specificForceXYZ,
      ],
      [
        "perCarLongitudinalG",
        full.timeline.perCarLongitudinalG,
        compact.timeline.perCarLongitudinalG,
      ],
      [
        "perCarLateralG",
        full.timeline.perCarLateralG,
        compact.timeline.perCarLateralG,
      ],
      [
        "perCarVerticalG",
        full.timeline.perCarVerticalG,
        compact.timeline.perCarVerticalG,
      ],
      [
        "perCarBankRad",
        full.timeline.perCarBankRad,
        compact.timeline.perCarBankRad,
      ],
      [
        "perCarRollRateRadPerSec",
        full.timeline.perCarRollRateRadPerSec,
        compact.timeline.perCarRollRateRadPerSec,
      ],
      [
        "perCarSpecificForceXYZ",
        full.timeline.perCarSpecificForceXYZ,
        compact.timeline.perCarSpecificForceXYZ,
      ],
      [
        "perCarJerkXYZ",
        full.timeline.perCarJerkXYZ,
        compact.timeline.perCarJerkXYZ,
      ],
    ];
    for (const [name, fullArr, compactArr] of cases) {
      expect(Array.from(compactArr), name).toEqual(Array.from(fullArr));
    }
  });

  it("compact transfer is exactly 28 buffers, omits frames, round-trips with transfer-buffer ownership and rejects malformed", () => {
    const track = straightTrack();
    const base = createDefaultSimulatorConfig();
    const config = {
      ...base,
      zones: [
        {
          id: "launch-0",
          kind: "launch" as const,
          startDistanceM: 0,
          endDistanceM: 80,
        } as never,
      ],
    };
    const compact = simulateRide(track, {
      config,
      initial: { headDistanceM: 30, speedMps: 5 },
      durationSeconds: 1,
      compactTimeline: true,
    });
    const timeline = compact.timeline;
    const transfer = timeline.toTransferable();
    expect(transfer.buffers.length).toBe(TIMELINE_CURRENT_BUFFER_COUNT);
    expect(transfer.buffers.length).toBe(28);
    expect(transfer.frames).toBeUndefined();
    // table-driven round-trip for all new fields
    const hydrated = RideTimeline.fromTransferable(transfer);
    expect(hydrated.frames.length).toBe(0);
    const roundTripCases: Array<[string, Float64Array, Float64Array]> = [
      ["launchActivity", timeline.launchActivity, hydrated.launchActivity],
      ["brakeActivity", timeline.brakeActivity, hydrated.brakeActivity],
      ["kineticEnergyJ", timeline.kineticEnergyJ, hydrated.kineticEnergyJ],
      [
        "potentialEnergyJ",
        timeline.potentialEnergyJ,
        hydrated.potentialEnergyJ,
      ],
      [
        "accumulatedDriveWorkJ",
        timeline.accumulatedDriveWorkJ,
        hydrated.accumulatedDriveWorkJ,
      ],
      [
        "accumulatedLossWorkJ",
        timeline.accumulatedLossWorkJ,
        hydrated.accumulatedLossWorkJ,
      ],
      ["energyErrorJ", timeline.energyErrorJ, hydrated.energyErrorJ],
      ["bankRad", timeline.bankRad, hydrated.bankRad],
      [
        "rollRateRadPerSec",
        timeline.rollRateRadPerSec,
        hydrated.rollRateRadPerSec,
      ],
      [
        "specificForceXYZ",
        timeline.specificForceXYZ,
        hydrated.specificForceXYZ,
      ],
      [
        "perCarLongitudinalG",
        timeline.perCarLongitudinalG,
        hydrated.perCarLongitudinalG,
      ],
      ["perCarLateralG", timeline.perCarLateralG, hydrated.perCarLateralG],
      ["perCarVerticalG", timeline.perCarVerticalG, hydrated.perCarVerticalG],
      ["perCarBankRad", timeline.perCarBankRad, hydrated.perCarBankRad],
      [
        "perCarRollRateRadPerSec",
        timeline.perCarRollRateRadPerSec,
        hydrated.perCarRollRateRadPerSec,
      ],
      [
        "perCarSpecificForceXYZ",
        timeline.perCarSpecificForceXYZ,
        hydrated.perCarSpecificForceXYZ,
      ],
      ["perCarJerkXYZ", timeline.perCarJerkXYZ, hydrated.perCarJerkXYZ],
    ];
    for (const [name, a, b] of roundTripCases)
      expect(Array.from(b), name).toEqual(Array.from(a));
    // ownership: mutating actual transfer buffer after hydration does not affect original or hydrated copy
    const originalFirstValue = new Float64Array(transfer.buffers[0]!)[0];
    const mutBuf = transfer.buffers[0]!;
    new Float64Array(mutBuf)[0] = 999999;
    expect(timeline.timeSeconds[0]).toBe(originalFirstValue);
    expect(hydrated.timeSeconds[0]).toBe(originalFirstValue);
    // determinism: second transfer from original timeline is still original value, not mutated
    const transfer2 = timeline.toTransferable();
    expect(new Float64Array(transfer2.buffers[0]!)[0]).toBe(originalFirstValue);
    expect(new Float64Array(transfer.buffers[0]!)[0]).toBe(999999);
    expect(new Float64Array(transfer2.buffers[0]!)[0]).not.toBe(
      new Float64Array(transfer.buffers[0]!)[0],
    );
    // table-driven shape / non-finite rejection for new fields
    const badLengthTransfer = {
      sampleRateHz: 120,
      carCount: 6,
      length: 2,
      buffers: [
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 0, 0, 0, 0, 0]).buffer,
        new Float64Array(2 * 6 * 3).buffer,
        new Float64Array(2 * 6 * 3).buffer,
        new Float64Array(2 * 6 * 3).buffer,
        new Float64Array(2 * 6 * 3).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, Number.NaN]).buffer, // non-finite
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 1]).buffer,
        new Float64Array([0, 0, 0, 0, 0, 0]).buffer,
        new Float64Array(12).buffer,
        new Float64Array(12).buffer,
        new Float64Array(12).buffer,
        new Float64Array(12).buffer,
        new Float64Array(12).buffer,
        new Float64Array(36).buffer,
        new Float64Array(36).buffer,
      ],
    } as unknown as never;
    expect(() => RideTimeline.fromTransferable(badLengthTransfer)).toThrow(
      RangeError,
    );
    // wrong buffer count
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 6,
        length: 1,
        buffers: Array.from({ length: 12 }, () => new ArrayBuffer(8)),
      } as unknown as never),
    ).toThrow(RangeError);
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 6,
        length: 1,
        buffers: Array.from({ length: 27 }, () => new ArrayBuffer(8)),
      } as unknown as never),
    ).toThrow(RangeError);
    // finite and shape validation via constructor
    expect(
      () =>
        new RideTimeline({
          sampleRateHz: 120,
          timeSeconds: new Float64Array([0, Number.NaN]),
          headDistanceM: new Float64Array([0, 1]),
          speedMps: new Float64Array([0, 1]),
        } as unknown as never),
    ).toThrow(RangeError);
  });

  it("legacy 11-buffer hydration remains supported with new compact series empty", () => {
    const timeSeconds = new Float64Array([0, 1 / 120]);
    const headDistanceM = new Float64Array([0, 10]);
    const speedMps = new Float64Array([5, 5]);
    const legacy = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds,
      headDistanceM,
      speedMps,
      longitudinalG: new Float64Array([0, 0]),
      lateralG: new Float64Array([0, 0]),
      verticalG: new Float64Array([1, 1]),
      jerkMps3: new Float64Array([0, 0, 0, 0, 0, 0]),
      carCount: 1,
      carPositionsXYZ: new Float64Array([0, 0, 0, 10, 0, 0]),
      carTangentsXYZ: new Float64Array([1, 0, 0, 1, 0, 0]),
      carNormalsXYZ: new Float64Array([0, 1, 0, 0, 1, 0]),
      carBinormalsXYZ: new Float64Array([0, 0, 1, 0, 0, 1]),
    });
    const transfer = legacy.toTransferable();
    // fresh output is exactly 28, but legacy path via direct construction still round-trips via 28; for 11-count test, craft 11-buffer transfer
    const legacyBuffers = transfer.buffers.slice(
      0,
      TIMELINE_LEGACY_BUFFER_COUNT,
    );
    expect(legacyBuffers.length).toBe(TIMELINE_LEGACY_BUFFER_COUNT);
    const hydrated = RideTimeline.fromTransferable({
      sampleRateHz: 120,
      carCount: 1,
      length: 2,
      buffers: legacyBuffers as unknown as ArrayBuffer[],
    });
    expect(hydrated.launchActivity.length).toBe(0);
    expect(hydrated.kineticEnergyJ.length).toBe(0);
    expect(hydrated.perCarLongitudinalG.length).toBe(0);
  });
});
