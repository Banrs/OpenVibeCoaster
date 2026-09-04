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
  it("emits only the required 120 Hz compact timeline without retaining integration frames", () => {
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
    expect(compact.frames).toEqual([]);
    expect(compact.timeline.length).toBe(241);
    // State and force series sampled on the shared 120 Hz output grid remain exact.
    // Jerk is intentionally derived from that authoritative output cadence.
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
    ];
    for (const [name, fullArr, compactArr] of cases) {
      expect(Array.from(compactArr), name).toEqual(Array.from(fullArr));
    }
    expect(Array.from(compact.timeline.jerkMps3).every(Number.isFinite)).toBe(
      true,
    );
    expect(
      Array.from(compact.timeline.perCarJerkXYZ).every(Number.isFinite),
    ).toBe(true);
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

  it("seven-car exact round-trip via generic transfer succeeds (no 6 limit)", () => {
    const length = 2;
    const carCount = 7;
    const fill = (size: number, value: number): Float64Array =>
      new Float64Array(Array.from({ length: size }, () => value));
    const timeline = new RideTimeline({
      sampleRateHz: 120,
      timeSeconds: new Float64Array([0, 1 / 120]),
      headDistanceM: new Float64Array([0, 10]),
      speedMps: new Float64Array([5, 5]),
      carCount,
      carPositionsXYZ: fill(length * carCount * 3, 1),
      carTangentsXYZ: fill(length * carCount * 3, 1),
      carNormalsXYZ: fill(length * carCount * 3, 1),
      carBinormalsXYZ: fill(length * carCount * 3, 1),
      longitudinalG: fill(length, 0.1),
      lateralG: fill(length, 0.2),
      verticalG: fill(length, 1),
      jerkMps3: fill(length * 3, 0.3),
      launchActivity: fill(length, 0),
      brakeActivity: fill(length, 0),
      kineticEnergyJ: fill(length, 100),
      potentialEnergyJ: fill(length, 200),
      accumulatedDriveWorkJ: fill(length, 300),
      accumulatedLossWorkJ: fill(length, 400),
      energyErrorJ: fill(length, 5),
      bankRad: fill(length, 0.5),
      rollRateRadPerSec: fill(length, 0.6),
      specificForceXYZ: fill(length * 3, 0.7),
      perCarLongitudinalG: fill(length * carCount, 0.8),
      perCarLateralG: fill(length * carCount, 0.9),
      perCarVerticalG: fill(length * carCount, 1.0),
      perCarBankRad: fill(length * carCount, 0.11),
      perCarRollRateRadPerSec: fill(length * carCount, 0.12),
      perCarSpecificForceXYZ: fill(length * carCount * 3, 0.13),
      perCarJerkXYZ: fill(length * carCount * 3, 0.14),
    });
    const transfer = timeline.toTransferable();
    expect(transfer.carCount).toBe(7);
    expect(transfer.buffers.length).toBe(TIMELINE_CURRENT_BUFFER_COUNT);
    const hydrated = RideTimeline.fromTransferable(transfer);
    expect(hydrated.carCount).toBe(7);
    expect(hydrated.length).toBe(length);
    expect(Array.from(hydrated.perCarBankRad)).toEqual(
      Array.from(timeline.perCarBankRad),
    );
  });

  it("direct fromTransferable rejects malformed buffers, unsafe integers and unsafe products", () => {
    // non-array buffers
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 1,
        length: 2,
        buffers: "bad" as unknown as ArrayBuffer[],
      }),
    ).toThrow();
    // non-ArrayBuffer member
    const badMember = Array.from({ length: 28 }, () => new ArrayBuffer(16));
    (badMember[5] as unknown) = new Uint8Array(16) as unknown as ArrayBuffer;
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 1,
        length: 2,
        buffers: badMember as unknown as ArrayBuffer[],
      }),
    ).toThrow();
    // unsafe carCount
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: Number.MAX_SAFE_INTEGER + 1,
        length: 2,
        buffers: Array.from({ length: 28 }, () => new ArrayBuffer(16)),
      }),
    ).toThrow();
    // unsafe length
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 1,
        length: Number.MAX_SAFE_INTEGER + 1,
        buffers: Array.from({ length: 28 }, () => new ArrayBuffer(16)),
      }),
    ).toThrow();
    // unsafe byte product: length safe but length*8 unsafe
    const unsafeLength = Math.floor(Number.MAX_SAFE_INTEGER / 8) + 1;
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 1,
        length: unsafeLength,
        buffers: Array.from({ length: 28 }, () => new ArrayBuffer(8)),
      }),
    ).toThrow();
    // unsafe per-car product: carCount*length*8 unsafe
    const unsafeCarCount = Math.floor(Number.MAX_SAFE_INTEGER / 4) + 1;
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: unsafeCarCount,
        length: 4,
        buffers: Array.from({ length: 28 }, () => new ArrayBuffer(8)),
      }),
    ).toThrow();
  });

  it("table-driven malformed current-buffer lengths and non-finite contents are rejected", () => {
    const length = 2;
    const carCount = 1;
    const makeValid = (): ArrayBuffer[] => [
      new Float64Array([0, 1]).buffer, // 0 time
      new Float64Array([0, 10]).buffer, // 1 head
      new Float64Array([5, 5]).buffer, // 2 speed
      new Float64Array([0, 0]).buffer, // 3 long
      new Float64Array([0, 0]).buffer, // 4 lat
      new Float64Array([1, 1]).buffer, // 5 vert
      new Float64Array([0, 0, 0, 0, 0, 0]).buffer, // 6 jerk vec3
      new Float64Array(length * carCount * 3).buffer, // 7 carPos
      new Float64Array(length * carCount * 3).buffer, // 8 carTan
      new Float64Array(length * carCount * 3).buffer, // 9 carNor
      new Float64Array(length * carCount * 3).buffer, //10 carBin
      new Float64Array([0, 0]).buffer, //11 launch
      new Float64Array([0, 0]).buffer, //12 brake
      new Float64Array([0, 0]).buffer, //13 kinetic
      new Float64Array([0, 0]).buffer, //14 potential
      new Float64Array([0, 0]).buffer, //15 drive
      new Float64Array([0, 0]).buffer, //16 loss
      new Float64Array([0, 0]).buffer, //17 energy
      new Float64Array([0, 0]).buffer, //18 bank
      new Float64Array([0, 0]).buffer, //19 roll
      new Float64Array([0, 0, 0, 0, 0, 0]).buffer, //20 specific vec3
      new Float64Array([0, 0]).buffer, //21 perCarLong
      new Float64Array([0, 0]).buffer, //22 perCarLat
      new Float64Array([0, 0]).buffer, //23 perCarVert
      new Float64Array([0, 0]).buffer, //24 perCarBank
      new Float64Array([0, 0]).buffer, //25 perCarRoll
      new Float64Array(length * carCount * 3).buffer, //26 perCarSpecific
      new Float64Array(length * carCount * 3).buffer, //27 perCarJerk
    ];
    // representative groups: scalar, vec3, car-vec3, per-car-scalar, per-car-vec3
    const cases: Array<[string, number, number]> = [
      ["scalar", 3, 8], // longitudinalG expected 16 bytes (2*8) but we give 8
      ["vec3", 6, 24], // jerk expected 48 bytes (2*3*8) but we give 24
      ["carVec3", 7, 24], // carPos expected 48 (2*1*3*8) but we give 24
      ["perCarScalar", 21, 8], // perCarLong expected 16 but we give 8
      ["perCarVec3", 26, 24], // perCarSpecific expected 48 but we give 24
    ];
    for (const [label, index, badBytes] of cases) {
      const buffers = makeValid();
      buffers[index] = new ArrayBuffer(badBytes);
      expect(
        () =>
          RideTimeline.fromTransferable({
            sampleRateHz: 120,
            carCount,
            length,
            buffers: buffers as unknown as ArrayBuffer[],
          }),
        label,
      ).toThrow();
    }
    // non-finite contents for each group
    const nonFiniteCases: Array<[string, number]> = [
      ["scalar", 3],
      ["vec3", 6],
      ["carVec3", 7],
      ["perCarScalar", 21],
      ["perCarVec3", 26],
    ];
    for (const [label, index] of nonFiniteCases) {
      const buffers = makeValid();
      const arr = new Float64Array(buffers[index]!);
      arr[0] = Number.NaN;
      // need to ensure buffer reflects NaN: recreate
      buffers[index] = arr.buffer;
      expect(
        () =>
          RideTimeline.fromTransferable({
            sampleRateHz: 120,
            carCount,
            length,
            buffers: buffers as unknown as ArrayBuffer[],
          }),
        `non-finite ${label}`,
      ).toThrow();
    }
    // also Infinity
    {
      const buffers = makeValid();
      new Float64Array(buffers[12]!)[1] = Number.POSITIVE_INFINITY;
      expect(() =>
        RideTimeline.fromTransferable({
          sampleRateHz: 120,
          carCount,
          length,
          buffers: buffers as unknown as ArrayBuffer[],
        }),
      ).toThrow();
    }
  });

  it("generic 28-buffer round-trip may contain optional zero-length new series (manual construction)", () => {
    const length = 2;
    // manually construct timeline with empty compact series (simulating legacy-like manual construction but with 28 buffers via toTransferable)
    // RideTimeline constructor allows empty optional arrays; toTransferable will produce 28 buffers with zero-length for those
    const timeline = new RideTimeline({
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
      // leave new series empty (will be zero-length buffers in 28)
    });
    const transfer = timeline.toTransferable();
    expect(transfer.buffers.length).toBe(28);
    // some new series are zero-length (allowed generically)
    expect(transfer.buffers[11]!.byteLength).toBe(0);
    const hydrated = RideTimeline.fromTransferable(transfer);
    expect(hydrated.launchActivity.length).toBe(0);
    expect(hydrated.length).toBe(length);
  });
});
