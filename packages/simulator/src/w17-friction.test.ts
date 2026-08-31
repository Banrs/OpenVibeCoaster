import { describe, expect, it } from "vitest";
import {
  SeventhOrderHermiteSpan,
  compileTrack,
  sampleTrackAtDistance,
  vec3,
  vec3Dot,
  vec3Normalize,
  vec3Scale,
} from "@openvibecoaster/core";
import {
  computePerCarForces,
  createDefaultSimulatorConfig,
  simulateRide,
  type SimulatorConfig,
} from "./index";

const g = 9.80665;
const deg60Height = 86.60254019;
const deg60Horiz = 50;

const steepTrack = compileTrack(
  [
    {
      id: "steep",
      span: SeventhOrderHermiteSpan.line(
        vec3(0, 0, 0),
        vec3(0, deg60Height, deg60Horiz),
      ),
    },
  ],
  { samples: 65 },
);

const baseConfig = (
  overrides: Partial<SimulatorConfig> = {},
): SimulatorConfig => ({
  ...createDefaultSimulatorConfig(),
  gravityMps2: g,
  gravityDirection: vec3(0, -1, 0),
  rollingResistanceCoefficient: 0,
  staticStictionCoefficient: 0,
  dragCdA: 0,
  airDensityKgPerM3: 0,
  train: {
    ...createDefaultSimulatorConfig().train,
    cars: [{ massKg: 1000, seatCount: 0 }],
    spacingM: 3,
  },
  ...overrides,
});

const normalPerCar = (
  massKg: number,
  gravityMps2: number,
  tangent: readonly number[],
  gravityDirection: readonly number[],
): number => {
  const gVec = vec3Scale(
    vec3Normalize(
      vec3(gravityDirection[0]!, gravityDirection[1]!, gravityDirection[2]!),
    ),
    gravityMps2,
  );
  const dot = vec3Dot(gVec, vec3(tangent[0]!, tangent[1]!, tangent[2]!));
  const perpSq =
    gVec[0] * gVec[0] + gVec[1] * gVec[1] + gVec[2] * gVec[2] - dot * dot;
  return massKg * Math.sqrt(Math.max(0, perpSq));
};

describe("w17 friction correction (RED)", () => {
  it("stiction must use per-car normal: steep grade should slide not hold", () => {
    // 60 deg slope: sin=0.866, cos=0.5
    // total gravity along track = m*g*sin = 8492 N
    // incorrect capacity mu_s*m*g = 1.0*9806 = 9806 holds
    // correct capacity mu_s*N = 1.0*m*g*cos = 4903 must slide
    const config = baseConfig({
      staticStictionCoefficient: 1.0,
      rollingResistanceCoefficient: 0,
      train: {
        ...createDefaultSimulatorConfig().train,
        cars: [
          { massKg: 1000, seatCount: 0 },
          { massKg: 1000, seatCount: 0 },
          { massKg: 1000, seatCount: 0 },
        ],
        spacingM: 1,
      },
    });
    const result = simulateRide(steepTrack, {
      durationSeconds: 1,
      config,
      initial: { headDistanceM: 50, speedMps: 0 },
    });
    // correct behavior: must NOT be static-hold; must roll downhill (negative speed)
    expect(result.frames.at(-1)?.status).not.toBe("static-hold");
    expect(result.frames.at(-1)?.speedMps).toBeLessThan(-0.1);
  });

  it("rolling resistance must use mu_r*N per car not mu_r*m*g", () => {
    const muR = 0.2;
    const config = baseConfig({
      rollingResistanceCoefficient: muR,
      staticStictionCoefficient: 0,
      dragCdA: 0,
    });
    const headDistanceM = 50;
    const speedMps = 5;
    const forces = computePerCarForces(
      steepTrack,
      config,
      headDistanceM,
      speedMps,
    );
    const sample = sampleTrackAtDistance(steepTrack, headDistanceM);
    const expectedN = normalPerCar(1000, g, sample.tangent, [0, -1, 0]);
    const expectedRolling = -Math.sign(speedMps) * muR * expectedN;
    const incorrectRolling = -Math.sign(speedMps) * muR * 1000 * g;
    // ensure test distinguishes the two
    expect(Math.abs(expectedRolling - incorrectRolling)).toBeGreaterThan(500);
    expect(forces[0]!.rolling).toBeCloseTo(expectedRolling, 4);
    expect(forces[0]!.rolling).not.toBeCloseTo(incorrectRolling, 1);
  });

  it("rolling acceleration integration uses mu_r*N (steep grade)", () => {
    const muR = 0.2;
    const config = baseConfig({
      rollingResistanceCoefficient: muR,
      staticStictionCoefficient: 0,
      dragCdA: 0,
    });
    // rolling opposes motion: forward uphill should have larger negative acceleration with correct mu*N vs mu*m*g?
    // Actually incorrect mu*m*g gives larger rolling magnitude (4903 vs 1961), so incorrect acceleration is more negative.
    // Test via direct speed after short duration without gravity? isolate by checking delta.
    const result = simulateRide(steepTrack, {
      durationSeconds: 0.5,
      config,
      initial: { headDistanceM: 50, speedMps: 5 },
    });
    const finalSpeed = result.frames.at(-1)!.speedMps;
    // compute expected acceleration: (gravity + rolling)/mass
    const sample = sampleTrackAtDistance(steepTrack, 50);
    const gVec = vec3Scale(vec3Normalize(vec3(0, -1, 0)), g);
    const gravPerCar = 1000 * vec3Dot(gVec, sample.tangent);
    const n = normalPerCar(1000, g, sample.tangent, [0, -1, 0]);
    const rollingPerCar = -muR * n; // sign positive speed
    const expectedAccel = (gravPerCar + rollingPerCar) / 1000;
    const incorrectRolling = -muR * 1000 * g;
    const incorrectAccel = (gravPerCar + incorrectRolling) / 1000;
    // After 0.5s, speed ~5 + accel*0.5 (approx, RK4 close)
    const expectedSpeedApprox = 5 + expectedAccel * 0.5;
    const incorrectSpeedApprox = 5 + incorrectAccel * 0.5;
    expect(
      Math.abs(expectedSpeedApprox - incorrectSpeedApprox),
    ).toBeGreaterThan(0.2);
    // final speed should be closer to expected than incorrect
    expect(Math.abs(finalSpeed - expectedSpeedApprox)).toBeLessThan(
      Math.abs(finalSpeed - incorrectSpeedApprox),
    );
    expect(Math.abs(finalSpeed - expectedSpeedApprox)).toBeLessThan(0.3);
  });
});
