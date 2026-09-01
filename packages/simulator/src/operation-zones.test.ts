import { describe, expect, it } from "vitest";
import { createCoasterFileV1 } from "@openvibecoaster/core";
import type {
  CoasterFileV1,
  DesignElementV1,
  SerializedSolvedSpanV1,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "./operation-zones.js";

const positionCoefficients: readonly (readonly number[])[] = [
  [0, 10, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
];
const rollCoefficients: readonly number[] = [0, 0, 0, 0, 0, 0];

function span(
  id: string,
  kind: string,
  length: number,
): SerializedSolvedSpanV1 {
  return {
    id,
    kind,
    positionCoefficients: positionCoefficients.map((row) => [...row]),
    rollCoefficients: [...rollCoefficients],
    length,
  };
}

function file(
  elements: DesignElementV1[],
  spans: SerializedSolvedSpanV1[],
): CoasterFileV1 {
  return createCoasterFileV1({
    name: "test",
    intent: {
      schemaVersion: 1,
      generatorVersion: "test-v1",
      seed: 1,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements,
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    },
    solvedSpans: spans,
    seed: 1,
    generatorVersion: "test-v1",
    profileVersion: "profile-v1",
    researchSnapshotIds: [],
    compiledDataChecksum: "00000000",
  });
}

describe("operationZonesFromCoasterFile", () => {
  it("exact cumulative distances, child suffix ownership, authored launch/brake/boost targets", () => {
    const f = file(
      [
        {
          id: "launchA",
          kind: "launch",
          type: "launch",
          parameters: { length: 30, targetSpeed: 30, bank: 0 },
        },
        {
          id: "hill",
          kind: "transition",
          type: "transition",
          parameters: { length: 15, rise: 0, pitch: 0, bank: 0 },
        },
        {
          id: "brakeB",
          kind: "brake",
          type: "brake",
          parameters: { length: 12, targetSpeed: 5, bank: 0 },
        },
        {
          id: "boostC",
          kind: "boost",
          type: "boost",
          parameters: { length: 10, targetSpeed: 22, bank: 0 },
        },
      ],
      [
        span("launchA#1", "launch", 10),
        span("launchA#2", "launch", 20),
        span("hill", "transition", 15),
        span("brakeB", "brake", 12),
        span("boostC", "boost", 10),
      ],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(zones).toHaveLength(3);
    expect(zones[0]!.id).toBe("launchA");
    expect(zones[0]!.kind).toBe("launch");
    expect(zones[0]!.startDistanceM).toBe(0);
    expect(zones[0]!.endDistanceM).toBe(30);
    expect(zones[0]!.targetSpeedMps).toBe(30);
    expect(zones[1]!.id).toBe("brakeB");
    expect(zones[1]!.kind).toBe("brake");
    expect(zones[1]!.startDistanceM).toBe(45);
    expect(zones[1]!.endDistanceM).toBe(57);
    expect(zones[1]!.targetSpeedMps).toBe(5);
    expect(zones[2]!.id).toBe("boostC");
    expect(zones[2]!.kind).toBe("boost");
    expect(zones[2]!.startDistanceM).toBe(57);
    expect(zones[2]!.endDistanceM).toBe(67);
    expect(zones[2]!.targetSpeedMps).toBe(22);
  });

  it("two adjacent same-kind semantic elements remain two zones", () => {
    const f = file(
      [
        {
          id: "launchA",
          kind: "launch",
          type: "launch",
          parameters: { length: 10, targetSpeed: 10, bank: 0 },
        },
        {
          id: "launchB",
          kind: "launch",
          type: "launch",
          parameters: { length: 10, targetSpeed: 10, bank: 0 },
        },
      ],
      [span("launchA", "launch", 10), span("launchB", "launch", 10)],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.id).toBe("launchA");
    expect(zones[0]!.startDistanceM).toBe(0);
    expect(zones[0]!.endDistanceM).toBe(10);
    expect(zones[1]!.id).toBe("launchB");
    expect(zones[1]!.startDistanceM).toBe(10);
    expect(zones[1]!.endDistanceM).toBe(20);
  });

  it("preserves semantic ID containing nonnumeric #", () => {
    const f = file(
      [
        {
          id: "owner#part",
          kind: "brake",
          type: "brake",
          parameters: { length: 10, targetSpeed: 7, bank: 0 },
        },
      ],
      [span("owner#part", "brake", 10)],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.id).toBe("owner#part");
    expect(zones[0]!.kind).toBe("brake");
    expect(zones[0]!.targetSpeedMps).toBe(7);

    const f2 = file(
      [
        {
          id: "owner#part",
          kind: "launch",
          type: "launch",
          parameters: { length: 10, targetSpeed: 15, bank: 0 },
        },
      ],
      [span("owner#part#1", "launch", 5), span("owner#part#2", "launch", 5)],
    );
    const zones2 = operationZonesFromCoasterFile(f2);
    expect(zones2).toHaveLength(1);
    expect(zones2[0]!.id).toBe("owner#part");
    expect(zones2[0]!.startDistanceM).toBe(0);
    expect(zones2[0]!.endDistanceM).toBe(10);
  });

  it("closed: true station maps to target zero while open station has no invented target", () => {
    const f = file(
      [
        {
          id: "stationClosed",
          kind: "station",
          type: "station",
          parameters: { length: 5, closed: true },
        },
        {
          id: "stationOpen",
          kind: "station",
          type: "station",
          parameters: { length: 5, closed: false },
        },
      ],
      [span("stationClosed", "station", 5), span("stationOpen", "station", 5)],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(zones).toHaveLength(2);
    const closed = zones.find((z) => z.id === "stationClosed")!;
    const open = zones.find((z) => z.id === "stationOpen")!;
    expect(closed.targetSpeedMps).toBe(0);
    expect(open.targetSpeedMps).toBeUndefined();
    expect(closed.startDistanceM).toBe(0);
    expect(open.startDistanceM).toBe(5);
  });

  it("non-operation spans still advance cumulative distance but emit no zone", () => {
    const f = file(
      [
        {
          id: "stationA",
          kind: "station",
          type: "station",
          parameters: { length: 10, closed: false },
        },
        {
          id: "hill",
          kind: "transition",
          type: "transition",
          parameters: { length: 15, rise: 0, pitch: 0, bank: 0 },
        },
        {
          id: "launchB",
          kind: "launch",
          type: "launch",
          parameters: { length: 15, targetSpeed: 20, bank: 0 },
        },
      ],
      [
        span("stationA", "station", 10),
        span("hill", "transition", 20),
        span("launchB", "launch", 15),
      ],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(zones).toHaveLength(2);
    const launch = zones.find((z) => z.id === "launchB")!;
    expect(launch.startDistanceM).toBe(30);
    expect(launch.endDistanceM).toBe(45);
  });

  it("separated repeated owner throws with stable element ID", () => {
    const f = file(
      [
        {
          id: "launchA",
          kind: "launch",
          type: "launch",
          parameters: { length: 10, targetSpeed: 10, bank: 0 },
        },
        {
          id: "brakeB",
          kind: "brake",
          type: "brake",
          parameters: { length: 10, targetSpeed: 5, bank: 0 },
        },
      ],
      [
        span("launchA#1", "launch", 10),
        span("brakeB", "brake", 10),
        span("launchA#2", "launch", 10),
      ],
    );
    expect(() => operationZonesFromCoasterFile(f)).toThrow(RangeError);
    expect(() => operationZonesFromCoasterFile(f)).toThrow(/launchA/);
  });

  it("returned zones and array reject mutation via Object.isFrozen plus behavioral attempt", () => {
    const f = file(
      [
        {
          id: "launchA",
          kind: "launch",
          type: "launch",
          parameters: { length: 10, targetSpeed: 10, bank: 0 },
        },
      ],
      [span("launchA", "launch", 10)],
    );
    const zones = operationZonesFromCoasterFile(f);
    expect(Object.isFrozen(zones)).toBe(true);
    expect(Object.isFrozen(zones[0]!)).toBe(true);
    expect(() =>
      Reflect.apply(Array.prototype.push, zones, [
        {
          id: "evil",
          kind: "brake",
          startDistanceM: 0,
          endDistanceM: 1,
        },
      ]),
    ).toThrow();
    expect(zones).toHaveLength(1);
    const original = zones[0]!.targetSpeedMps;
    expect(Reflect.set(zones[0]!, "targetSpeedMps", 999)).toBe(false);
    expect(zones[0]!.targetSpeedMps).toBe(original);
  });
});
