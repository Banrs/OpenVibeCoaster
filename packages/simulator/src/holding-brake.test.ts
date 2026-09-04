import { expect, test } from "vitest";
import {
  SeventhOrderHermiteSpan,
  compileTrack,
  vec3,
} from "@openvibecoaster/core";
import { createDefaultSimulatorConfig, simulateRide } from "./index.js";

test("a holding brake captures, dwells, and releases under powered drive", () => {
  const track = compileTrack(
    [
      {
        id: "line",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(200, 0, 0)),
      },
    ],
    { samples: 257 },
  );
  const base = createDefaultSimulatorConfig();
  const result = simulateRide(track, {
    durationSeconds: 4,
    config: {
      ...base,
      zones: [
        {
          id: "hold",
          kind: "brake",
          startDistanceM: 0,
          endDistanceM: 200,
          targetSpeedMps: 0,
          holdSeconds: 0.25,
          releaseTargetSpeedMps: 10,
        },
      ],
    },
    initial: { headDistanceM: 20, speedMps: 1 },
  });

  expect(result.diagnostics).toHaveLength(0);
  const stopped = result.frames.filter(({ speedMps }) => speedMps === 0);
  expect(stopped.length).toBeGreaterThanOrEqual(60);
  const resumed = result.frames.find(
    (frame) =>
      frame.timeSeconds > stopped[stopped.length - 1]!.timeSeconds &&
      frame.speedMps > 0.1,
  );
  expect(resumed).toBeDefined();
});
