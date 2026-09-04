import { describe, expect, it } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
  type EnvironmentQuery,
  type Vec3,
} from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";

// Sphere SDF helper: used only to count proof-elided SDF calls and verify
// source/cap vs terrain — not for exact-value threshold assertions.
const sphereSignedDistance = (p: Vec3): number =>
  Math.hypot(p[0], p[1], p[2]) - 1;

const sphereBounds = (): { min: Vec3; max: Vec3 } => ({
  min: vec3(-1, -1, -1),
  max: vec3(1, 1, 1),
});

function highTrack() {
  return compileTrack(
    [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 15, 0), vec3(0, 15, 2)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(0, 15, 2), vec3(0, 15, 4)),
      },
    ],
    { samples: 2 },
  );
}

function lowTrack() {
  return compileTrack(
    [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0.5, 0), vec3(0, 0.5, 5)),
      },
    ],
    { samples: 2 },
  );
}

function farLowTrack() {
  return compileTrack(
    [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(
          vec3(1000, 0.5, 1000),
          vec3(1000, 0.5, 1010),
        ),
      },
    ],
    { samples: 2 },
  );
}

describe("clearance field per-interval fast proof", () => {
  it("proves cap for entirely high swept interval without SDF calls", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: sphereBounds,
      raycast: () => undefined,
    };
    const track = highTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(calls).toBe(0);
    expect(field.segments.every((s) => s.source === "cap")).toBe(true);
    expect(field.globalSource).toBe("cap");
  });

  it("does not skip a low penetrating interval", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: sphereBounds,
      raycast: () => undefined,
    };
    const track = lowTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments[0]!.source).not.toBe("cap");
  });

  it("does not infer safety from horizontal distance", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: sphereBounds,
      raycast: () => undefined,
    };
    const track = farLowTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments[0]!.source).not.toBe("cap");
  });

  it("proves terrain clearance against hard thresholds without querying a display-cap-only gap", () => {
    const track = compileTrack(
      [
        {
          id: "seg-0",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 2)),
        },
        {
          id: "seg-1",
          span: SeventhOrderHermiteSpan.line(vec3(0, 0, 2), vec3(0, 0, 4)),
        },
      ],
      { samples: 2 },
    );
    let firstCalls = 0;
    let secondCalls = 0;
    const options = {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    };
    const first = computeClearanceField(track, {
      ...options,
      environment: {
        signedDistance: () => {
          firstCalls += 1;
          throw new Error("display-cap-only terrain query");
        },
        bounds: () => ({ min: vec3(-1, -9, -1), max: vec3(1, -8, 1) }),
        raycast: () => undefined,
      },
    });
    const second = computeClearanceField(track, {
      ...options,
      environment: {
        signedDistance: () => {
          secondCalls += 1;
          throw new Error("display-cap-only terrain query");
        },
        bounds: () => ({ min: vec3(-1, -9, -1), max: vec3(1, -8, 1) }),
        raycast: () => undefined,
      },
    });

    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(0);
    expect(first.globalLowerM).toBeGreaterThanOrEqual(0.5);
    expect(first.globalLowerM).toBeLessThan(10);
    expect(Number.isFinite(first.globalLowerM)).toBe(true);
    expect(Number.isFinite(first.globalUpperM)).toBe(true);
    expect(first.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(first.globalLowerM).toBeLessThanOrEqual(first.globalUpperM);
    expect(
      first.segments.every(
        (segment) =>
          Number.isFinite(segment.lowerM) &&
          Number.isFinite(segment.upperM) &&
          segment.lowerM <= segment.upperM &&
          segment.source === "terrain" &&
          segment.certified === false,
      ),
    ).toBe(true);
    expect(
      first.diagnostics.some((diagnostic) => diagnostic.severity === "fatal"),
    ).toBe(false);
    expect(
      second.diagnostics.some((diagnostic) => diagnostic.severity === "fatal"),
    ).toBe(false);
    expect(second.work).toBe(first.work);
    expect(second.globalLowerM).toBe(first.globalLowerM);
    expect(second.globalUpperM).toBe(first.globalUpperM);
    expect(second.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(first.globalSource).toBe("terrain");
    expect(second.globalSource).toBe("terrain");
    expect(first.globalLowerSource).toBe("terrain");
    expect(second.globalLowerSource).toBe("terrain");
    expect(second.segments).toEqual(first.segments);
  });
});

describe("clearance field bounds validation", () => {
  it("does not prove cap when bounds maxY is -Infinity", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: () => ({
        min: vec3(-1, -1, -1),
        max: vec3(1, -Infinity, 1),
      }),
      raycast: () => undefined,
    };
    const track = highTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments.every((s) => s.source === "cap")).toBe(false);
    expect(field.globalSource).not.toBe("cap");
  });

  it("does not prove cap when bounds maxY is NaN", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: () => ({
        min: vec3(-1, -1, -1),
        max: vec3(1, NaN, 1),
      }),
      raycast: () => undefined,
    };
    const track = highTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments.every((s) => s.source === "cap")).toBe(false);
    expect(field.globalSource).not.toBe("cap");
  });

  it("does not prove cap when bounds query throws", () => {
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: (p) => {
        calls += 1;
        return sphereSignedDistance(p);
      },
      bounds: () => {
        throw new Error("bounds failure");
      },
      raycast: () => undefined,
    };
    const track = highTrack();
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments.every((s) => s.source === "cap")).toBe(false);
    expect(field.globalSource).not.toBe("cap");
  });
});
