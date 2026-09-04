import { expect, test } from "vitest";
import {
  createCliffValleyEnvironment,
  createDesignIntentV1,
  type Vec3,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "@openvibecoaster/simulator";
import { generateCoaster } from "./pipeline.js";

test(
  "directed footprint failure returns tested relaxation evidence",
  { timeout: 120_000 },
  () => {
    const footprint = [
      [-50, 0, -50],
      [50, 0, -50],
      [50, 0, 50],
      [-50, 0, 50],
    ] as Vec3[];
    const generated = generateCoaster(
      createDesignIntentV1({
        generatorVersion: "record-g",
        seed: 3,
        mode: "directed",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [{ id: "g-0", position: [0, 0, 50] }],
        targets: [],
        constraints: [
          {
            id: "c-fp",
            kind: "required-footprint",
            value: "tiny",
            hard: true,
          },
        ],
        footprint,
        pinnedElementIds: [],
      }),
      { environment: createCliffValleyEnvironment() },
    );

    expect(generated.feasible).toBe(false);
    expect(generated.relaxationEvidence.length).toBeGreaterThan(0);
    expect(generated.relaxationEvidence[0]!.rerun).toBe(true);
  },
);

test(
  "record summit aligns with the ridge seed in world coordinates",
  { timeout: 120_000 },
  () => {
    const environment = createCliffValleyEnvironment();
    const generated = generateCoaster(
      createDesignIntentV1({
        generatorVersion: "record-g",
        seed: 11,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      }),
      {
        environment,
        profileVersion: "record-targets-v1",
        researchSnapshotIds: ["records-2026-09-01"],
      },
    );
    const summit = operationZonesFromCoasterFile(generated.file).find(
      (zone) => zone.id === "brake-007",
    );
    if (!summit) throw new Error("Missing summit hold zone");
    const centerS = (summit.startDistanceM + summit.endDistanceM) / 2;
    const distances = generated.track.distances;
    const positions = generated.track.positions;
    let lower = 0;
    while (
      lower + 1 < distances.length &&
      distances[lower + 1]! < centerS
    )
      lower += 1;
    const upper = Math.min(lower + 1, distances.length - 1);
    const s0 = distances[lower]!;
    const s1 = distances[upper]!;
    const fraction = s1 > s0 ? (centerS - s0) / (s1 - s0) : 0;
    const worldX =
      positions[lower * 3]! * (1 - fraction) +
      positions[upper * 3]! * fraction;
    const worldZ =
      positions[lower * 3 + 2]! * (1 - fraction) +
      positions[upper * 3 + 2]! * fraction;

    expect(Math.abs(worldZ - 980)).toBeLessThanOrEqual(120);
    expect(environment.heightAt(worldX, worldZ)).toBeGreaterThanOrEqual(224.4);
  },
);
