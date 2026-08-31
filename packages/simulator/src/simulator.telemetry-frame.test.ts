import { describe, expect, it } from "vitest";
import {
  compileTrack,
  sampleTrackAtDistance,
  vec3,
  vec3Dot,
  vec3Scale,
} from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  simulateRide,
  type SimulatorConfig,
} from "./index";

const cfg = (): SimulatorConfig => ({
  ...createDefaultSimulatorConfig(),
  rollingResistanceCoefficient: 0,
  staticStictionCoefficient: 0,
  dragCdA: 0,
  train: {
    ...createDefaultSimulatorConfig().train,
    cars: [{ massKg: 1000, seatCount: 0 }],
    spacingM: 3,
  },
});

describe("telemetry frame correction RED", () => {
  it("projects specific force into authoritative compiled track frame including bank", () => {
    // Rising helix with bank: RMF transported normal differs from gravity-aligned
    const track = compileTrack(
      [
        {
          id: "helix",
          bank: (u: number) => (u * Math.PI) / 6,
          span: {
            position: (u: number) =>
              vec3(8 * Math.cos(u * Math.PI), u * 6, 8 * Math.sin(u * Math.PI)),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(
                    -8 * Math.PI * Math.sin(u * Math.PI),
                    6,
                    8 * Math.PI * Math.cos(u * Math.PI),
                  )
                : vec3(
                    -8 * Math.PI * Math.PI * Math.cos(u * Math.PI),
                    0,
                    -8 * Math.PI * Math.PI * Math.sin(u * Math.PI),
                  ),
          },
        },
      ],
      { samples: 257 },
    );
    const distanceM = track.totalLength * 0.37;
    const speed = 9;
    const result = simulateRide(track, {
      durationSeconds: 0,
      config: cfg(),
      initial: { headDistanceM: distanceM, speedMps: speed },
    });
    const telemetry = result.frames[0]!.cars[0]!.telemetry;
    const sample = sampleTrackAtDistance(track, distanceM);
    const g = cfg().gravityMps2;
    // worldAcceleration = tangent * a_t + curvatureVector * v^2
    // For this test with zero drag/rolling, a_t = dot(gravity, tangent) integrated,
    // but at instantaneous snapshot the simulator uses dynamicsAt which also is gravity projection.
    // However worldAcceleration used for telemetry is exactly tangent*acc + curvature*v^2 where acc is totalForce/mass.
    // To avoid replicating dynamics incorrectly, we reconstruct specific directly from telemetry's own specificForceMps2
    // and verify its projection equals the G components via the authoritative frame.
    const specific = telemetry.specificForceMps2;
    const expectedLon = vec3Dot(specific, sample.tangent) / g;
    const expectedLat = vec3Dot(specific, vec3Scale(sample.binormal, -1)) / g;
    const expectedVert = vec3Dot(specific, sample.normal) / g;
    // Buggy telemetryAxes re-derives gravity-aligned frame => mismatch > 1e-4
    expect(telemetry.longitudinalG).toBeCloseTo(expectedLon, 6);
    expect(telemetry.lateralG).toBeCloseTo(expectedLat, 6);
    expect(telemetry.verticalG).toBeCloseTo(expectedVert, 6);
    expect(telemetry.bankRad).toBeCloseTo(sample.bank, 10);
  });

  it("remains continuous through vertical vs near-vertical tangent", () => {
    const k = 4;
    const vertical = compileTrack(
      [
        {
          id: "vert",
          bank: () => Math.PI / 8,
          span: {
            position: (u: number) => vec3(k * (u - 0.5) * (u - 0.5), u * 10, 0),
            derivative: (u: number, order = 1) =>
              order === 1 ? vec3(2 * k * (u - 0.5), 10, 0) : vec3(2 * k, 0, 0),
          },
        },
      ],
      { samples: 129 },
    );
    const nearVertical = compileTrack(
      [
        {
          id: "near",
          bank: () => Math.PI / 8,
          span: {
            position: (u: number) =>
              vec3(0.08 * (u - 0.5) + k * (u - 0.5) * (u - 0.5), u * 10, 0),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(0.08 + 2 * k * (u - 0.5), 10, 0)
                : vec3(2 * k, 0, 0),
          },
        },
      ],
      { samples: 129 },
    );
    const speed = 8;
    const distV = vertical.totalLength * 0.5;
    const distN = nearVertical.totalLength * 0.5;
    const resV = simulateRide(vertical, {
      durationSeconds: 0,
      config: cfg(),
      initial: { headDistanceM: distV, speedMps: speed },
    });
    const resN = simulateRide(nearVertical, {
      durationSeconds: 0,
      config: cfg(),
      initial: { headDistanceM: distN, speedMps: speed },
    });
    const telV = resV.frames[0]!.cars[0]!.telemetry;
    const telN = resN.frames[0]!.cars[0]!.telemetry;
    // With correct authoritative frame, exactly vertical and near-vertical should be nearly identical (continuous)
    // Buggy gravity-aligned frame jumps discontinuously at vertical fallback => difference large
    const dLat = Math.abs(telV.lateralG - telN.lateralG);
    const dVert = Math.abs(telV.verticalG - telN.verticalG);
    const dLon = Math.abs(telV.longitudinalG - telN.longitudinalG);
    // Continuity requires <0.05 G; buggy exceeds 0.4 G
    expect(dLat).toBeLessThan(0.05);
    expect(dVert).toBeLessThan(0.05);
    expect(dLon).toBeLessThan(0.05);
  });
});
