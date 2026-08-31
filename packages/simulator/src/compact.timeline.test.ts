import { describe, expect, it } from "vitest";
import {
  compileTrack,
  QuinticScalarSpan,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import type { CompiledTrackData } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";
import { RideTimeline } from "./timeline.js";

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

describe("compact vs full simulation parity RED", () => {
  it("full/default vs compact: identical 120 Hz scalar, G, jerk, transforms, activity/energy; compact frames zero but SimulationResult.frames remains", () => {
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
    expect(Array.from(compact.timeline.timeSeconds)).toEqual(
      Array.from(full.timeline.timeSeconds),
    );
    expect(Array.from(compact.timeline.headDistanceM)).toEqual(
      Array.from(full.timeline.headDistanceM),
    );
    expect(Array.from(compact.timeline.speedMps)).toEqual(
      Array.from(full.timeline.speedMps),
    );
    expect(Array.from(compact.timeline.longitudinalG)).toEqual(
      Array.from(full.timeline.longitudinalG),
    );
    expect(Array.from(compact.timeline.lateralG)).toEqual(
      Array.from(full.timeline.lateralG),
    );
    expect(Array.from(compact.timeline.verticalG)).toEqual(
      Array.from(full.timeline.verticalG),
    );
    expect(Array.from(compact.timeline.jerkMps3)).toEqual(
      Array.from(full.timeline.jerkMps3),
    );
    expect(Array.from(compact.timeline.carPositionsXYZ)).toEqual(
      Array.from(full.timeline.carPositionsXYZ),
    );
    expect(Array.from(compact.timeline.carTangentsXYZ)).toEqual(
      Array.from(full.timeline.carTangentsXYZ),
    );
    // activity/energy
    const fullLaunch = full.timeline.frames.map((f) =>
      f.telemetry.launchActivity ? 1 : 0,
    );
    const fullBrake = full.timeline.frames.map((f) =>
      f.telemetry.brakeActivity ? 1 : 0,
    );
    const fullKinetic = full.timeline.frames.map(
      (f) => f.telemetry.kineticEnergyJ,
    );
    expect(Array.from(compact.timeline.launchActivity)).toEqual(fullLaunch);
    expect(Array.from(compact.timeline.brakeActivity)).toEqual(fullBrake);
    expect(Array.from(compact.timeline.kineticEnergyJ)).toEqual(fullKinetic);
    expect(Array.from(compact.timeline.potentialEnergyJ)).toEqual(
      full.timeline.frames.map((f) => f.telemetry.potentialEnergyJ),
    );
    expect(Array.from(compact.timeline.accumulatedDriveWorkJ)).toEqual(
      full.timeline.frames.map((f) => f.telemetry.accumulatedDriveWorkJ),
    );
    expect(Array.from(compact.timeline.accumulatedLossWorkJ)).toEqual(
      full.timeline.frames.map((f) => f.telemetry.accumulatedLossWorkJ),
    );
    expect(Array.from(compact.timeline.energyErrorJ)).toEqual(
      full.timeline.frames.map((f) => f.telemetry.energyErrorJ),
    );
    // per-car G truthful
    expect(compact.timeline.perCarLongitudinalG.length).toBe(
      compact.timeline.length * compact.timeline.carCount,
    );
    for (let i = 0; i < compact.timeline.length; i++) {
      for (let c = 0; c < compact.timeline.carCount; c++) {
        const idx = i * compact.timeline.carCount + c;
        const frameVal =
          full.timeline.frames[i]!.cars[c]!.telemetry.longitudinalG;
        expect(compact.timeline.perCarLongitudinalG[idx]!).toBeCloseTo(
          frameVal,
          9,
        );
      }
    }
  });

  it("compact transfer omits frames, round-trips buffers with ownership and rejects malformed", () => {
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
    expect(transfer.frames).toBeUndefined();
    expect(transfer.buffers.length).toBeGreaterThan(11);
    // round-trip
    const hydrated = RideTimeline.fromTransferable(transfer);
    expect(hydrated.frames.length).toBe(0);
    expect(Array.from(hydrated.timeSeconds)).toEqual(
      Array.from(timeline.timeSeconds),
    );
    expect(Array.from(hydrated.launchActivity)).toEqual(
      Array.from(timeline.launchActivity),
    );
    expect(Array.from(hydrated.kineticEnergyJ)).toEqual(
      Array.from(timeline.kineticEnergyJ),
    );
    expect(Array.from(hydrated.perCarLongitudinalG)).toEqual(
      Array.from(timeline.perCarLongitudinalG),
    );
    // ownership: buffers are copies
    const before = timeline.timeSeconds[0];
    hydrated.timeSeconds[0] = 99999;
    expect(timeline.timeSeconds[0]).toBe(before);
    // determinism: second transfer identical
    const transfer2 = timeline.toTransferable();
    expect(transfer2.buffers.length).toBe(transfer.buffers.length);
    for (let i = 0; i < transfer.buffers.length; i++)
      expect(new Float64Array(transfer2.buffers[i]!)).toEqual(
        new Float64Array(transfer.buffers[i]!),
      );
    // reject malformed shapes
    expect(() =>
      RideTimeline.fromTransferable({
        sampleRateHz: 120,
        carCount: 6,
        length: 1,
        buffers: [new ArrayBuffer(8)],
      } as unknown as never),
    ).toThrow(RangeError);
    expect(
      () =>
        new RideTimeline({
          sampleRateHz: 120,
          timeSeconds: new Float64Array([0, 1]),
          headDistanceM: new Float64Array([0]),
          speedMps: new Float64Array([0, 1]),
        } as unknown as never),
    ).toThrow(RangeError);
    // finite validation
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
});
