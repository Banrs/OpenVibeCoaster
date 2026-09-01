import { describe, expect, it } from "vitest";
import { compileTrack, SeventhOrderHermiteSpan, vec3, type EnvironmentQuery, type Vec3 } from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";

describe("clearance field per-interval fast proof", () => {
  it("skips SDF only for entirely high swept interval", () => {
    let highCalls = 0;
    let lowCalls = 0;

    const highEnv: EnvironmentQuery = {
      signedDistance: (p: Vec3) => {
        highCalls += 1;
        return p[1] + 100;
      },
      bounds: () => ({ min: vec3(-100, -100, -100), max: vec3(100, -100, 100) }),
      raycast: () => undefined,
    };

    // Track at y=12 is entirely above maxY=-100 by > cap (10), so first intervals should be skipped.
    // But we use a track high above: we compile track at y=12
    const highTrack = compileTrack(
      [
        { id: "seg-0", span: SeventhOrderHermiteSpan.line(vec3(0, 12, 0), vec3(0, 12, 5)) },
        { id: "seg-1", span: SeventhOrderHermiteSpan.line(vec3(0, 12, 5), vec3(0, 12, 10)) },
      ],
      { samples: 2 },
    );
    const fieldHigh = computeClearanceField(highTrack, {
      environment: highEnv,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(highCalls).toBe(0);
    expect(fieldHigh.segments.every((s) => s.source === "cap")).toBe(true);

    const lowEnv: EnvironmentQuery = {
      signedDistance: (p: Vec3) => {
        lowCalls += 1;
        return p[1] + 100;
      },
      bounds: () => ({ min: vec3(-100, -100, -100), max: vec3(100, 0, 100) }),
      raycast: () => undefined,
    };
    // Track at y=-2 is below maxY=0, so not entirely high, must call SDF
    const lowTrack = compileTrack(
      [
        { id: "seg-0", span: SeventhOrderHermiteSpan.line(vec3(0, -2, 0), vec3(0, -2, 5)) },
      ],
      { samples: 2 },
    );
    const fieldLow = computeClearanceField(lowTrack, {
      environment: lowEnv,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0"],
    });
    expect(lowCalls).toBeGreaterThan(0);
    expect(fieldLow.segments[0]!.source).not.toBe("cap");
  });

  it("does not skip penetrating interval when horizontal bounds far but vertical low", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p: Vec3) => {
        calls += 1;
        return p[1] - 0;
      },
      bounds: () => ({ min: vec3(-100, -100, -100), max: vec3(100, 0, 100) }),
      raycast: () => undefined,
    };
    const trackLow = compileTrack(
      [
        { id: "seg-0", span: SeventhOrderHermiteSpan.line(vec3(1000, -1, 1000), vec3(1000, -1, 1010)) },
      ],
      { samples: 2 },
    );
    computeClearanceField(trackLow, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0"],
    });
    expect(calls).toBeGreaterThan(0);
  });
});
