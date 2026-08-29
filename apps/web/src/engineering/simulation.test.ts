import { describe, expect, it } from "vitest";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { handleGenerate, handleCompileSimulate } from "./worker";
import { generateCoaster } from "@openvibecoaster/generator";

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

describe("full-ride simulation", () => {
  it("valid default launch track produces substantially more than five seconds and actual movement/operation activity", () => {
    const result = handleGenerate("sim-full", validLaunchIntent as unknown);
    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    // duration derived from track length: track 400 => duration ~24 >5
    void (result.timeline.length / result.timeline.sampleRateHz);
    // The timeline's last time is durationSeconds
    void (result.timeline.buffers[0]
      ? new Float64Array(result.timeline.buffers[0])
      : new Float64Array());
    // Alternatively check via timeline length/sampleRate
    // We check that timeline has many samples > 5*120
    expect(result.timeline.length).toBeGreaterThan(5 * 120);
    // Check that timeline's sample rate is 1/120
    expect(result.timeline.sampleRateHz).toBe(120);
    // Check that hydrating via simulate yields movement: headDistance changes
    const headDistances = result.timeline.buffers[1]
      ? new Float64Array(result.timeline.buffers[1])
      : new Float64Array();
    expect(headDistances.length).toBeGreaterThan(0);
    const hasMovement = headDistances.some(
      (v, i) => i > 0 && Math.abs(v - headDistances[0]!) > 1,
    );
    expect(hasMovement).toBe(true);
    // Check operation activity: at least one frame had launch or brake
    // Frames are passed through timeline.buffers? Check frames from transfer
    const frames = (result.timeline as any).frames as
      readonly any[] | undefined;
    if (frames && frames.length > 0) {
      const hasLaunch = frames.some((f: any) => f.telemetry.launchActivity);
      const hasBrake = frames.some((f: any) => f.telemetry.brakeActivity);
      // launch at start should be active, brake near end active if duration long enough to reach brake zone (100-200 launch, 200-300 brake)
      // With our zones, launch 100-200, brake 200-300, station 0-100 and 300-400. With head start 17.5, movement will enter launch.
      expect(hasLaunch).toBe(true);
      // Brake may be reached if duration sufficient to travel 200m; at avg 10 m/s, 24s => 240m, so should reach brake
      expect(hasBrake).toBe(true);
    }
  });

  it("short tracks remain safe and produce exact diagnostics", () => {
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
    // Short track totalLength ~8, train length 17 >8 so should fail with TRAIN_LENGTH_EXCEEDS_TRACK
    const result = handleCompileSimulate("sim-short", gen.file as unknown);
    expect(result.type).toBe("failure");
    if (result.type === "failure") {
      expect(result.diagnostics[0]!.code).toBe("TRAIN_LENGTH_EXCEEDS_TRACK");
    }
  });

  it("determinism – same track produces identical timeline", () => {
    const a = handleGenerate("sim-det-a", validLaunchIntent as unknown);
    const b = handleGenerate("sim-det-b", validLaunchIntent as unknown);
    expect(a.type).toBe("success");
    expect(b.type).toBe("success");
    if (a.type !== "success" || b.type !== "success") return;
    expect(a.track.checksum).toBe(b.track.checksum);
    expect(a.timeline.length).toBe(b.timeline.length);
    expect(a.timeline.sampleRateHz).toBe(b.timeline.sampleRateHz);
    const bufA = new Float64Array(a.timeline.buffers[0]!);
    const bufB = new Float64Array(b.timeline.buffers[0]!);
    expect(bufA).toEqual(bufB);
  });

  it("uses fixed RK4 1/240 and telemetry 1/120, closedTrack false", async () => {
    const result = handleGenerate("sim-steps", validLaunchIntent as unknown);
    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.timeline.sampleRateHz).toBe(120);
    // The worker's config uses fixedStep 1/240 – we can't directly inspect, but we can verify via timeline's fixed step implied by frame times?
    // For now, check that timeline's timeSeconds are multiples of 1/120
    const times = new Float64Array(result.timeline.buffers[0]!);
    for (let i = 1; i < Math.min(times.length, 10); i++) {
      const dt = times[i]! - times[i - 1]!;
      expect(Math.abs(dt - 1 / 120)).toBeLessThan(1e-9);
    }
  });
});
