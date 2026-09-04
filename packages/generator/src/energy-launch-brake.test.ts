import { expect, test } from "vitest";
import {
  createDesignIntentV1,
  sampleTrackAtDistance,
  validateRecordTargetsProfile,
  type RecordTargetProfile,
} from "@openvibecoaster/core";
import {
  createDefaultSimulatorConfig,
  operationZonesFromCoasterFile,
  simulateRide,
  summitHoldWindow,
  validateRecordTargets,
} from "@openvibecoaster/simulator";
import profile from "../../../data/profiles/record-targets-v1.json" with { type: "json" };
import { generateCoaster } from "./pipeline.js";

validateRecordTargetsProfile(profile);
const targetProfile = profile as RecordTargetProfile;

test(
  "launch work, record speed, and terminal brake margin come from the timeline",
  { timeout: 240_000 },
  () => {
    const generated = generateCoaster(
      createDesignIntentV1({
        generatorVersion: "record-g",
        seed: 42,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        pinnedElementIds: [],
      }),
      {
        profileVersion: "record-targets-v1",
        researchSnapshotIds: ["records-2026-09-01"],
      },
    );
    const zones = operationZonesFromCoasterFile(
      generated.file,
      generated.track.totalLength,
    );
    for (const zone of zones) {
      expect(zone.startDistanceM).toBeLessThan(zone.endDistanceM);
      expect(zone.endDistanceM).toBeLessThanOrEqual(
        generated.track.totalLength,
      );
    }
    const summitBrake = zones.find(({ id }) => id === "brake-007");
    expect(summitBrake?.holdSeconds).toBe(3);
    expect(summitBrake?.releaseTargetSpeedMps).toBe(60);
    const trimBrake = zones.find(({ id }) => id === "airtimeHill-010");
    expect(trimBrake?.kind).toBe("brake");
    expect(trimBrake?.targetSpeedMps).toBe(60);
    const terminalBrake = zones.find(({ id }) => id === "brake-018");
    expect(terminalBrake).toBeDefined();

    const config = createDefaultSimulatorConfig();
    const simulation = simulateRide(generated.track, {
      durationSeconds: 180,
      config: { ...config, zones },
      initial: { headDistanceM: config.train.spacingM * 5, speedMps: 5 },
      compactTimeline: true,
    });
    const speed = simulation.timeline.speedMps;
    const head = simulation.timeline.headDistanceM;
    const holdWindow = summitHoldWindow(generated.file);
    let run = 0;
    let holdSeconds = 0;
    for (let index = 0; index < simulation.timeline.length; index += 1) {
      const inWindow =
        Math.abs(head[index]! - holdWindow.centerS) <= holdWindow.toleranceM;
      run = speed[index]! <= 0.05 && inWindow ? run + 1 / 120 : 0;
      holdSeconds = Math.max(holdSeconds, run);
    }
    const diagnostics = validateRecordTargets(
      generated.track,
      simulation.timeline,
      generated.file,
      targetProfile,
      { holdSeconds, holdLocationS: holdWindow.centerS },
    );
    const driveWork =
      simulation.timeline.accumulatedDriveWorkJ[
        simulation.timeline.length - 1
      ]!;
    const maxSpeed = Math.max(...speed);
    const maxHeadDistance = Math.max(...head);
    const terminalSpeed = speed[speed.length - 1]!;
    const ownerAt = (distanceM: number | undefined): string | undefined => {
      if (distanceM === undefined) return undefined;
      let end = 0;
      for (const span of generated.file.solvedSpans) {
        end += span.length;
        if (distanceM <= end) return span.id;
      }
      return generated.file.solvedSpans.at(-1)?.id;
    };
    const maxSpeedIndex = speed.indexOf(maxSpeed);
    const elementWindows = new Map<
      string,
      { startDistanceM: number; endDistanceM: number }
    >();
    let spanStart = 0;
    for (const span of generated.file.solvedSpans) {
      const owner = span.id.replace(/#\d+$/, "");
      const current = elementWindows.get(owner) ?? {
        startDistanceM: spanStart,
        endDistanceM: spanStart,
      };
      current.endDistanceM = spanStart + span.length;
      elementWindows.set(owner, current);
      spanStart += span.length;
    }
    const nearestTimelineIndex = (distanceM: number): number => {
      let nearest = 0;
      for (let index = 1; index < head.length; index += 1)
        if (
          Math.abs(head[index]! - distanceM) <
          Math.abs(head[nearest]! - distanceM)
        )
          nearest = index;
      return nearest;
    };
    const evidence = JSON.stringify({
      driveWork,
      maxSpeed,
      maxSpeedAt: {
        time: simulation.timeline.timeSeconds[maxSpeedIndex],
        s: head[maxSpeedIndex],
        owner: ownerAt(head[maxSpeedIndex]),
      },
      maxHeadDistance,
      totalLength: generated.track.totalLength,
      terminalSpeed,
      holdSeconds,
      routeParameters: generated.file.intent.elements
        .filter(({ id }) =>
          [
            "brake-007",
            "diveDrop-008",
            "airtimeHill-010",
            "topHat-011",
            "immelmann-012",
            "verticalLoop-013",
          ].includes(id),
        )
        .map(({ id, parameters }) => ({ id, parameters })),
      recordSpanLengths: generated.file.solvedSpans
        .filter(({ id }) =>
          /^(diveDrop-008|topHat-011|immelmann-012|verticalLoop-013)#/.test(id),
        )
        .map(({ id, length }) => ({ id, length })),
      finaleWindows: [
        "overbankedTurn-014",
        "zeroGRoll-015",
        "stall-016",
        "brake-017",
        "brake-018",
      ].map((id) => {
        const window = elementWindows.get(id)!;
        const startIndex = nearestTimelineIndex(window.startDistanceM);
        const endIndex = nearestTimelineIndex(window.endDistanceM);
        return {
          id,
          ...window,
          startSpeed: speed[startIndex],
          endSpeed: speed[endIndex],
          startTangent: sampleTrackAtDistance(
            generated.track,
            window.startDistanceM,
          ).tangent,
          endTangent: sampleTrackAtDistance(
            generated.track,
            window.endDistanceM,
          ).tangent,
        };
      }),
      diagnostics,
      extrema: (
        [
          ["verticalMax", simulation.timeline.verticalG, "max"],
          ["verticalMin", simulation.timeline.verticalG, "min"],
          ["lateral", simulation.timeline.lateralG, "magnitude"],
          ["jerk", simulation.timeline.jerkMps3, "magnitude"],
          ["roll", simulation.timeline.rollRateRadPerSec, "magnitude"],
        ] as const
      ).map(([name, samples, mode]) => {
        let index = 0;
        for (let candidate = 1; candidate < samples.length; candidate += 1) {
          const current = samples[index]!;
          const next = samples[candidate]!;
          if (
            (mode === "max" && next > current) ||
            (mode === "min" && next < current) ||
            (mode === "magnitude" && Math.abs(next) > Math.abs(current))
          )
            index = candidate;
        }
        const timelineIndex =
          samples.length === simulation.timeline.length * 3
            ? Math.floor(index / 3)
            : index;
        return {
          name,
          value: samples[index],
          time: simulation.timeline.timeSeconds[timelineIndex],
          s: head[timelineIndex],
          speed: speed[timelineIndex],
          owner: ownerAt(head[timelineIndex]),
        };
      }),
    });

    expect(Number.isFinite(driveWork), evidence).toBe(true);
    expect(driveWork, evidence).toBeGreaterThan(9_000_000);
    expect(driveWork, evidence).toBeLessThanOrEqual(7.2e6 * 180);
    expect(maxSpeed, evidence).toBeGreaterThanOrEqual(79.16 - 1e-6);
    expect(maxSpeed, evidence).toBeLessThanOrEqual(81.94 + 1e-6);
    expect(maxHeadDistance, evidence).toBeGreaterThanOrEqual(
      terminalBrake!.startDistanceM,
    );
    const dynamicsCodes = new Set([
      "RECORD_FORCE_PEAK_POS",
      "RECORD_FORCE_NEG",
      "RECORD_FORCE_LAT",
      "RECORD_FORCE_LONG",
      "RECORD_JERK",
      "RECORD_ROLL",
    ]);
    expect(
      diagnostics.filter(({ code }) => dynamicsCodes.has(code)),
      evidence,
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "ENERGY_LSM_REQUIRED_WORK"),
      evidence,
    ).toHaveLength(0);
    expect(
      diagnostics.filter(({ code }) => code === "BRAKE_MARGIN"),
      evidence,
    ).toHaveLength(0);
    expect(terminalSpeed, evidence).toBeLessThanOrEqual(0.2 + 1e-6);
  },
);
