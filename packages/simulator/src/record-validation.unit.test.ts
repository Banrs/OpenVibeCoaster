import { expect, test } from "vitest";
import type {
  CoasterFileV1,
  CompiledTrackData,
} from "@openvibecoaster/core";
import profile from "../../../data/profiles/record-targets-v1.json" with {
  type: "json",
};
import { RideTimeline } from "./timeline.js";
import {
  summitHoldWindow,
  validateRecordTargets,
} from "./record-validation.js";

const syntheticTrack = {
  totalLength: 5_300,
  positions: new Float64Array([0, 230, 0]),
  distances: new Float64Array([0]),
  elementBoundaries: new Uint32Array(),
} as unknown as CompiledTrackData;

const syntheticFile = {
  intent: { elements: [] },
  solvedSpans: [],
} as unknown as CoasterFileV1;

function timeline(
  verticalG: readonly number[],
  speedMps: readonly number[] = verticalG.map(() => 30),
): RideTimeline {
  const length = verticalG.length;
  const values = (value: number): Float64Array =>
    Float64Array.from({ length }, () => value);
  return new RideTimeline({
    sampleRateHz: 120,
    timeSeconds: Float64Array.from({ length }, (_, index) => index / 120),
    headDistanceM: values(10),
    speedMps: Float64Array.from(speedMps),
    verticalG: Float64Array.from(verticalG),
    lateralG: values(0),
    longitudinalG: values(0),
    jerkMps3: values(0),
    rollRateRadPerSec: values(0),
    accumulatedDriveWorkJ: values(0),
    accumulatedLossWorkJ: values(0),
    kineticEnergyJ: values(0),
    potentialEnergyJ: values(0),
  });
}

test("negative-G record target requires achievement without breaching its floor", () => {
  const diagnosticsFor = (verticalG: number) =>
    validateRecordTargets(
      syntheticTrack,
      timeline([verticalG]),
      syntheticFile,
      profile,
      { holdSeconds: 3, holdLocationS: 0 },
    ).filter((diagnostic) => diagnostic.code === "RECORD_FORCE_NEG");

  expect(diagnosticsFor(-1.1)).toHaveLength(0);
  expect(diagnosticsFor(-0.5)[0]).toMatchObject({
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    actual: -0.5,
    limit: -1,
  });
  expect(diagnosticsFor(-1.3)[0]).toMatchObject({
    severity: "error",
    provenance: "PROJECT_ENGINEERING_LIMIT",
    actual: -1.3,
    limit: -1.2,
  });
});

test("hold validation consumes numeric timeline-dwell proof", () => {
  const resultFor = (holdSeconds: number) =>
    validateRecordTargets(
      syntheticTrack,
      timeline([0]),
      syntheticFile,
      profile,
      { holdSeconds, holdLocationS: 0 },
    );

  expect(resultFor(2.9).some(({ code }) => code === "HOLD_DURATION")).toBe(
    true,
  );
  expect(resultFor(3).some(({ code }) => code === "HOLD_DURATION")).toBe(
    false,
  );
});

test("summit hold authority derives its center from brake-007", () => {
  const file = {
    intent: {
      elements: [
        {
          id: "brake-007",
          kind: "brake",
          type: "brake",
          parameters: {},
        },
      ],
    },
    solvedSpans: [{ id: "brake-007", length: 35 }],
  } as unknown as CoasterFileV1;

  expect(summitHoldWindow(file)).toEqual({ centerS: 17.5, toleranceM: 36 });
});
