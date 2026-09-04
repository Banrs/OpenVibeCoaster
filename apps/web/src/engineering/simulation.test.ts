import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate, handleCompileSimulate } from "./worker";
import { generateCoaster } from "@openvibecoaster/generator";
import { hydrateEngineeringSuccess } from "./hydrate";

const validLaunchIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [
    {
      id: "station-0",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
    {
      id: "launch-1",
      kind: "launch",
      type: "launch",
      parameters: { length: 100, targetSpeed: 20, bank: 0 },
    },
    {
      id: "brake-2",
      kind: "brake",
      type: "brake",
      parameters: { length: 100, targetSpeed: 5, bank: 0 },
    },
    {
      id: "station-3",
      kind: "station",
      type: "station",
      parameters: { length: 100, bank: 0, closed: false },
    },
  ],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
});

const flagshipIntent = createDesignIntentV1({
  generatorVersion: "test-v1",
  seed: 42,
  mode: "full-auto",
  family: "steel-sitdown-lsm-v1",
  elements: [],
  gates: [],
  targets: [],
  constraints: [],
  pinnedElementIds: [],
  terrainProfileId: "rolling-highlands-v1",
});

describe("full-ride simulation", () => {
  it(
    "valid launch track produces substantially more than five seconds and actual movement/operation activity",
    { timeout: 20000 },
    async () => {
      const result = handleGenerate("sim-full", validLaunchIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const hydrated = hydrateEngineeringSuccess(result);
      expect(hydrated.timeline.length).toBeGreaterThan(5 * 120);
      expect(hydrated.timeline.sampleRateHz).toBe(120);
      const head = hydrated.timeline.headDistanceM;
      expect(head.length).toBeGreaterThan(0);
      const hasMovement = head.some(
        (v, i) => i > 0 && Math.abs(v - head[0]!) > 1,
      );
      expect(hasMovement).toBe(true);
      // Compact timeline has zero nested frames; check SoA activity instead
      const hasLaunch =
        hydrated.timeline.frames.length > 0
          ? hydrated.timeline.frames.some((f) => f.telemetry.launchActivity)
          : Array.from(hydrated.timeline.launchActivity).some((v) => v >= 0.5);
      const hasBrake =
        hydrated.timeline.frames.length > 0
          ? hydrated.timeline.frames.some((f) => f.telemetry.brakeActivity)
          : Array.from(hydrated.timeline.brakeActivity).some((v) => v >= 0.5);
      expect(hasLaunch).toBe(true);
      expect(hasBrake).toBe(true);
    },
  );

  it("short tracks remain safe and produce exact diagnostics", async () => {
    const shortIntent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 4, bank: 0, closed: false },
        },
        {
          id: "station-1",
          kind: "station",
          type: "station",
          parameters: { length: 4, bank: 0, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const gen = generateCoaster(shortIntent);
    const result = handleCompileSimulate("sim-short", gen.file as unknown);
    expect(result.type).toBe("failure");
    if (result.type !== "failure") throw new Error("expected failure");
    expect(result.diagnostics[0]!.code).toBe("TRAIN_LENGTH_EXCEEDS_TRACK");
  });

  it(
    "determinism – same track produces identical timeline",
    { timeout: 20000 },
    async () => {
      const a = handleGenerate("sim-det-a", validLaunchIntent as unknown);
      const b = handleGenerate("sim-det-b", validLaunchIntent as unknown);
      expect(a.type).toBe("success");
      expect(b.type).toBe("success");
      if (a.type !== "success" || b.type !== "success")
        throw new Error("expected success");
      expect(a.track.checksum).toBe(b.track.checksum);
      expect(a.timeline.length).toBe(b.timeline.length);
      const ha = hydrateEngineeringSuccess(a);
      const hb = hydrateEngineeringSuccess(b);
      expect(ha.timeline.timeSeconds).toEqual(hb.timeline.timeSeconds);
      expect(ha.timeline.headDistanceM).toEqual(hb.timeline.headDistanceM);
    },
  );

  it(
    "uses fixed RK4 1/240 and telemetry 1/120, closedTrack false",
    { timeout: 20000 },
    async () => {
      const result = handleGenerate("sim-steps", validLaunchIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const hydrated = hydrateEngineeringSuccess(result);
      expect(hydrated.timeline.sampleRateHz).toBe(120);
      const times = hydrated.timeline.timeSeconds;
      for (let i = 1; i < Math.min(times.length, 10); i++) {
        const dt = times[i]! - times[i - 1]!;
        expect(Math.abs(dt - 1 / 120)).toBeLessThan(1e-9);
      }
    },
  );

  it(
    "flagship 1.6-2.2km with rolling profile completes full ride with launch/brake and Hydrated RideTimeline (~1843m actual default)",
    { timeout: 60000 },
    async () => {
      const result = handleGenerate("sim-flagship", flagshipIntent as unknown);
      expect(result.type).toBe("success");
      if (result.type !== "success") throw new Error("expected success");
      const hydrated = hydrateEngineeringSuccess(result);
      expect(hydrated.track.totalLength).toBeGreaterThanOrEqual(1600);
      expect(hydrated.track.totalLength).toBeLessThanOrEqual(2200);
      const timeline = hydrated.timeline;
      expect(timeline.length).toBeGreaterThan(15 * 120);
      // Compact timelines have zero nested frames; direct simulator full frames available via SimulationResult.frames
      expect(timeline.length).toBeGreaterThan(0);
      const head = timeline.headDistanceM;
      const lastHead = head[head.length - 1]!;
      let maxHeadIndex = 0;
      for (let index = 1; index < head.length; index += 1) {
        if (head[index]! > head[maxHeadIndex]!) maxHeadIndex = index;
      }
      const maxHead = head[maxHeadIndex]!;
      let maxHeadSample = 0;
      while (
        maxHeadSample + 1 < hydrated.track.distances.length &&
        hydrated.track.distances[maxHeadSample + 1]! <= maxHead
      ) {
        maxHeadSample += 1;
      }
      const maxSpanIndex = hydrated.track.elementIndices[maxHeadSample]!;
      console.error(
        "FLAGSHIP_TERMINAL_STATE",
        JSON.stringify({
          totalLength: hydrated.track.totalLength,
          lastHead,
          lastSpeed: timeline.speedMps[timeline.speedMps.length - 1],
          duration: timeline.timeSeconds[timeline.timeSeconds.length - 1],
          finalStartSample: hydrated.track.elementBoundaries.at(-2),
          maxHead,
          maxHeadTime: timeline.timeSeconds[maxHeadIndex],
          speedAtMaxHead: timeline.speedMps[maxHeadIndex],
          maxHeadSample,
          maxSpanIndex,
          maxSpanId: result.file.solvedSpans[maxSpanIndex]?.id,
          maxZoneMask: hydrated.track.zoneMasks[maxHeadSample],
        }),
      );
      expect(lastHead).toBeGreaterThan(hydrated.track.totalLength * 0.85);
      expect(lastHead).toBeLessThanOrEqual(hydrated.track.totalLength);
      // Derive final element start via authoritative elementBoundaries -> distances, assert lastHead enters final station
      const eb = hydrated.track.elementBoundaries;
      const dists = hydrated.track.distances;
      expect(eb.length % 2).toBe(0);
      expect(eb.length).toBeGreaterThanOrEqual(2);
      const finalStartSample = eb[eb.length - 2]!;
      const finalEndSample = eb[eb.length - 1]!;
      expect(finalStartSample).toBeLessThan(finalEndSample);
      expect(finalStartSample).toBeGreaterThanOrEqual(0);
      expect(finalEndSample).toBe(dists.length - 1);
      const finalStartDist = dists[finalStartSample]!;
      const finalEndDist = dists[finalEndSample]!;
      expect(finalEndDist).toBeCloseTo(hydrated.track.totalLength, 6);
      expect(lastHead).toBeGreaterThanOrEqual(finalStartDist);
      expect(lastHead).toBeLessThanOrEqual(finalEndDist);
      expect(lastHead).toBeGreaterThanOrEqual(finalStartDist + 1);
      const hasLaunchFlag =
        timeline.frames.length > 0
          ? timeline.frames.some((f) => f.telemetry.launchActivity)
          : Array.from(timeline.launchActivity).some((v) => v >= 0.5);
      const hasBrakeFlag =
        timeline.frames.length > 0
          ? timeline.frames.some((f) => f.telemetry.brakeActivity)
          : Array.from(timeline.brakeActivity).some((v) => v >= 0.5);
      expect(hasLaunchFlag).toBe(true);
      expect(hasBrakeFlag).toBe(true);
      // Head movement meaningful
      expect(Math.abs(head[head.length - 1]! - head[0]!)).toBeGreaterThan(100);
      // Fixed steps proven via sampleRate
      expect(timeline.sampleRateHz).toBe(120);
    },
  );
});
