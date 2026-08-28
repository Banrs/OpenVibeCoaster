import { describe, expect, it } from "vitest";
import {
  CAMERA_IDS,
  clampPlaybackSpeed,
  createInitialState,
  getActionEnabled,
  getNextStatusAfterGenerate,
  getNextStatusAfterLoad,
  getPanelVisibility,
  getReducedMotionState,
  getStatusText,
  isPlaybackSpeedValid,
  METRIC_IDS,
  PLAYBACK_SPEED_MAX,
  PLAYBACK_SPEED_MIN,
  selectCamera,
  selectMetric,
  selectSeat,
} from "./viewState.js";

describe("viewState – pending versus ready enablement", () => {
  it("initial state is pending with disabled data-dependent actions", () => {
    const state = createInitialState();
    expect(state.generationStatus).toBe("pending");
    expect(getStatusText(state.generationStatus)).toMatch(/pending/i);
    expect(getActionEnabled("save", state.generationStatus)).toBe(false);
    expect(getActionEnabled("load", state.generationStatus)).toBe(true);
    expect(getActionEnabled("export", state.generationStatus)).toBe(false);
    expect(getActionEnabled("scrub", state.generationStatus)).toBe(false);
    expect(getActionEnabled("playback", state.generationStatus)).toBe(false);
    expect(getActionEnabled("seamInspect", state.generationStatus)).toBe(false);
    expect(getActionEnabled("localRegenerate", state.generationStatus)).toBe(
      false,
    );
    expect(getActionEnabled("generate", state.generationStatus)).toBe(true);
  });

  it("ready status enables data-dependent actions", () => {
    expect(getActionEnabled("save", "ready")).toBe(true);
    expect(getActionEnabled("scrub", "ready")).toBe(true);
    expect(getActionEnabled("playback", "ready")).toBe(true);
    expect(getActionEnabled("seamInspect", "ready")).toBe(true);
    expect(getActionEnabled("localRegenerate", "ready")).toBe(true);
    expect(getActionEnabled("export", "ready")).toBe(true);
  });

  it("generating disables generate but keeps load enabled", () => {
    expect(getActionEnabled("generate", "generating")).toBe(false);
    expect(getActionEnabled("load", "generating")).toBe(true);
    expect(getActionEnabled("save", "generating")).toBe(false);
  });

  it("error status keeps generate and load enabled", () => {
    expect(getActionEnabled("generate", "error")).toBe(true);
    expect(getActionEnabled("load", "error")).toBe(true);
    expect(getActionEnabled("save", "error")).toBe(false);
  });

  it("status text never fabricates ride numbers and is pending initially", () => {
    const pending = getStatusText("pending");
    expect(pending).toMatch(/pending/i);
    expect(pending).not.toMatch(/\d+\s*(m\/s|g|mph|kph)/i);
    expect(getStatusText("ready")).toMatch(/ready/i);
    expect(getStatusText("generating")).toMatch(/generat/i);
    expect(getStatusText("error")).toMatch(/error|failed/i);
  });

  it("error status is neutral and truthful for load, generate, and regenerate while integration unavailable", () => {
    const err = getStatusText("error");
    expect(err).not.toMatch(/Load failed/i);
    expect(err).toMatch(/canonical/i);
    expect(err).toMatch(/unavailable|integration/i);
    expect(err).toMatch(/error|failed|unavailable/i);
  });
});

describe("viewState – Ride mode panel visibility", () => {
  it("edit mode shows side rails and telemetry", () => {
    const state = createInitialState();
    const v = getPanelVisibility({ ...state, appMode: "edit" });
    expect(v.leftRailVisible).toBe(true);
    expect(v.rightInspectorVisible).toBe(true);
    expect(v.telemetryVisible).toBe(true);
    expect(v.viewportFocused).toBe(false);
    expect(v.topBarVisible).toBe(true);
  });

  it("ride mode focuses viewport and hides side panels", () => {
    const state = createInitialState();
    const v = getPanelVisibility({ ...state, appMode: "ride" });
    expect(v.leftRailVisible).toBe(false);
    expect(v.rightInspectorVisible).toBe(false);
    expect(v.telemetryVisible).toBe(false);
    expect(v.viewportFocused).toBe(true);
  });

  it("ride mode keeps top bar but telemetry is not visible", () => {
    const v = getPanelVisibility({
      ...createInitialState(),
      appMode: "ride",
      generationStatus: "ready",
    });
    expect(v.topBarVisible).toBe(true);
    expect(v.cameraControlsVisible).toBe(true);
    expect(v.telemetryVisible).toBe(false);
  });
});

describe("viewState – seat and camera selections", () => {
  it("selects valid cameras and rejects invalid", () => {
    for (const cam of CAMERA_IDS) {
      expect(selectCamera(cam, "orbit")).toBe(cam);
    }
    expect(selectCamera("orbit", "front")).toBe("orbit");
    expect(selectCamera("invalid" as never, "chase")).toBe("chase");
    expect(selectCamera("" as never, "front")).toBe("front");
  });

  it("camera ids include required set", () => {
    expect(CAMERA_IDS).toEqual(
      expect.arrayContaining(["front", "middle", "rear", "chase", "orbit"]),
    );
    expect(CAMERA_IDS).toHaveLength(5);
  });

  it("selects seat within bounds and clamps out-of-range", () => {
    expect(selectSeat(0, 4, 0)).toBe(0);
    expect(selectSeat(2, 4, 0)).toBe(2);
    expect(selectSeat(3, 4, 0)).toBe(3);
    expect(selectSeat(-1, 4, 1)).toBe(1);
    expect(selectSeat(10, 4, 1)).toBe(1);
    expect(selectSeat(1, 1, 0)).toBe(0);
  });

  it("selectMetric validates and falls back", () => {
    for (const m of METRIC_IDS) {
      expect(selectMetric(m, "speed")).toBe(m);
    }
    expect(selectMetric("invalid" as never, "speed")).toBe("speed");
    expect(METRIC_IDS).toEqual(
      expect.arrayContaining(["speed", "gForce", "height", "energy"]),
    );
  });
});

describe("viewState – playback speed bounds", () => {
  it("clamps below min and above max", () => {
    expect(clampPlaybackSpeed(0)).toBe(PLAYBACK_SPEED_MIN);
    expect(clampPlaybackSpeed(-5)).toBe(PLAYBACK_SPEED_MIN);
    expect(clampPlaybackSpeed(100)).toBe(PLAYBACK_SPEED_MAX);
    expect(clampPlaybackSpeed(Number.NaN)).toBe(1);
    expect(clampPlaybackSpeed(Number.POSITIVE_INFINITY)).toBe(
      PLAYBACK_SPEED_MAX,
    );
  });

  it("preserves valid speeds", () => {
    expect(clampPlaybackSpeed(1)).toBe(1);
    expect(clampPlaybackSpeed(PLAYBACK_SPEED_MIN)).toBe(PLAYBACK_SPEED_MIN);
    expect(clampPlaybackSpeed(PLAYBACK_SPEED_MAX)).toBe(PLAYBACK_SPEED_MAX);
    expect(clampPlaybackSpeed(0.5)).toBe(0.5);
  });

  it("validates playback speed range", () => {
    expect(isPlaybackSpeedValid(1)).toBe(true);
    expect(isPlaybackSpeedValid(PLAYBACK_SPEED_MIN)).toBe(true);
    expect(isPlaybackSpeedValid(PLAYBACK_SPEED_MAX)).toBe(true);
    expect(isPlaybackSpeedValid(0)).toBe(false);
    expect(isPlaybackSpeedValid(10)).toBe(false);
    expect(isPlaybackSpeedValid(Number.NaN)).toBe(false);
  });

  it("initial state uses valid playback speed", () => {
    const state = createInitialState();
    expect(isPlaybackSpeedValid(state.playbackSpeed)).toBe(true);
    expect(state.playbackSpeed).toBe(1);
  });
});

describe("viewState – reduced motion", () => {
  it("respects prefers-reduced-motion when no override", () => {
    expect(getReducedMotionState(true, null)).toBe(true);
    expect(getReducedMotionState(false, null)).toBe(false);
  });

  it("user override takes precedence", () => {
    expect(getReducedMotionState(false, true)).toBe(true);
    expect(getReducedMotionState(true, false)).toBe(false);
    expect(getReducedMotionState(true, true)).toBe(true);
  });

  it("initial state defaults to not reduced unless system prefers", () => {
    const state = createInitialState();
    expect(typeof state.reducedMotion).toBe("boolean");
  });
});

describe("viewState – import validation and generation guard", () => {
  it("never transitions to ready on generate without canonical data", () => {
    expect(getNextStatusAfterGenerate("pending")).not.toBe("ready");
    expect(getNextStatusAfterGenerate("error")).not.toBe("ready");
    expect(getNextStatusAfterGenerate("generating")).not.toBe("ready");
    expect(getNextStatusAfterGenerate("ready")).not.toBe("ready");
    expect(
      getActionEnabled("save", getNextStatusAfterGenerate("pending")),
    ).toBe(false);
    expect(
      getActionEnabled("export", getNextStatusAfterGenerate("pending")),
    ).toBe(false);
  });

  it("never transitions to ready on load with arbitrary JSON", () => {
    expect(getNextStatusAfterLoad({}, "pending")).not.toBe("ready");
    expect(getNextStatusAfterLoad({}, "generating")).not.toBe("ready");
    expect(getNextStatusAfterLoad({ random: 1 }, "pending")).not.toBe("ready");
    expect(getNextStatusAfterLoad(null, "pending")).not.toBe("ready");
    expect(getNextStatusAfterLoad("string" as unknown, "pending")).not.toBe(
      "ready",
    );
    expect(
      getActionEnabled("save", getNextStatusAfterLoad({}, "pending")),
    ).toBe(false);
  });

  it("never transitions to ready even for shallow track-v1 shape – canonical validation unavailable", () => {
    expect(
      getNextStatusAfterLoad(
        {
          format: "openvibecoaster/track-v1",
          compiledTrackData: { spans: [] },
        },
        "pending",
      ),
    ).not.toBe("ready");
    expect(
      getNextStatusAfterLoad(
        {
          format: "openvibecoaster/track-v1",
          compiledTrackData: { spans: [{ kind: "line" }] },
        },
        "generating",
      ),
    ).not.toBe("ready");
    expect(
      getActionEnabled(
        "scrub",
        getNextStatusAfterLoad(
          {
            format: "openvibecoaster/track-v1",
            compiledTrackData: { spans: [] },
          },
          "pending",
        ),
      ),
    ).toBe(false);
  });

  it("keeps data actions disabled after any import attempt", () => {
    for (const payload of [
      {},
      { seed: "123" },
      { format: "openvibecoaster/track-v1", compiledTrackData: { spans: [] } },
      null,
    ] as unknown[]) {
      const next = getNextStatusAfterLoad(payload, "pending");
      expect(getActionEnabled("save", next)).toBe(false);
      expect(getActionEnabled("export", next)).toBe(false);
      expect(getActionEnabled("scrub", next)).toBe(false);
      expect(getActionEnabled("playback", next)).toBe(false);
      expect(getActionEnabled("seamInspect", next)).toBe(false);
      expect(getActionEnabled("localRegenerate", next)).toBe(false);
    }
  });
});
