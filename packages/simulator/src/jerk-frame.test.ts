import { expect, test } from "vitest";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";

test("constant rider-frame force on a horizontal curve has negligible jerk", () => {
  const radius = 20;
  const track = compileTrack(
    [
      {
        id: "horizontal-curve",
        span: {
          position: (u: number) =>
            vec3(radius * Math.cos(u), 0, radius * Math.sin(u)),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(-radius * Math.sin(u), 0, radius * Math.cos(u))
              : vec3(-radius * Math.cos(u), 0, -radius * Math.sin(u)),
        },
      },
    ],
    { samples: 257 },
  );
  const defaults = createDefaultSimulatorConfig();
  const result = simulateRide(track, {
    durationSeconds: 0.5,
    config: {
      ...defaults,
      rollingResistanceCoefficient: 0,
      staticStictionCoefficient: 0,
      dragCdA: 0,
      train: {
        ...defaults.train,
        cars: [{ massKg: 1_000, seatCount: 1 }],
      },
    },
    initial: { headDistanceM: 2, speedMps: 12 },
  });

  expect(result.diagnostics).toHaveLength(0);
  const maximumJerk = Math.max(
    ...result.frames
      .slice(2, -2)
      .map(({ telemetry }) => Math.hypot(...telemetry.jerkMps3)),
  );
  expect(maximumJerk).toBeLessThan(0.2);
});
