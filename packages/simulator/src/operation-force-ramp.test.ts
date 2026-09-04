import { expect, test } from "vitest";
import {
  SeventhOrderHermiteSpan,
  compileTrack,
  vec3,
} from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";

test("entering a powered brake zone respects the rider jerk limit", () => {
  const track = compileTrack(
    [
      {
        id: "line",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 200)),
      },
    ],
    { samples: 257 },
  );
  const defaults = createDefaultSimulatorConfig();
  const result = simulateRide(track, {
    durationSeconds: 2,
    config: {
      ...defaults,
      rollingResistanceCoefficient: 0,
      staticStictionCoefficient: 0,
      dragCdA: 0,
      train: {
        ...defaults.train,
        cars: [{ massKg: 1_500, seatCount: 1 }],
      },
      zones: [
        {
          id: "brake",
          kind: "brake",
          startDistanceM: 50,
          endDistanceM: 180,
          targetSpeedMps: 0,
        },
      ],
    },
    initial: { headDistanceM: 40, speedMps: 20 },
  });

  expect(result.diagnostics).toHaveLength(0);
  expect(result.frames.at(-1)!.speedMps).toBeLessThan(20);
  const maximumJerk = Math.max(
    ...result.frames
      .slice(2, -2)
      .map(({ telemetry }) => Math.hypot(...telemetry.jerkMps3)),
  );
  expect(maximumJerk).toBeLessThanOrEqual(15);
});
