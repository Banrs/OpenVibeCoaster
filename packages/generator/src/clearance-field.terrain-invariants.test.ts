import { describe, expect, it, vi } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
  type Diagnostic,
  type EnvironmentQuery,
} from "@openvibecoaster/core";
import type { ClearanceField } from "./clearance-field.js";

// Selected optimization (pre-production): hoist per-swept-segment terrain
// invariants (validated OBB, motion bound) to once per segment instead of once
// per evaluated heap subinterval. RED must fail on per-subinterval calls.
const geometryCalls = vi.hoisted(() => ({
  createOrientedBox: 0,
  sweptMotionBound: 0,
  interpolatePose: 0,
}));

vi.mock("./clearance-geometry", async () => {
  const actual =
    await vi.importActual<typeof import("./clearance-geometry")>(
      "./clearance-geometry",
    );
  return {
    ...actual,
    createOrientedBox: (
      ...args: Parameters<typeof actual.createOrientedBox>
    ) => {
      geometryCalls.createOrientedBox += 1;
      return actual.createOrientedBox(...args);
    },
    sweptMotionBound: (
      ...args: Parameters<typeof actual.sweptMotionBound>
    ) => {
      geometryCalls.sweptMotionBound += 1;
      return actual.sweptMotionBound(...args);
    },
    interpolatePose: (...args: Parameters<typeof actual.interpolatePose>) => {
      geometryCalls.interpolatePose += 1;
      return actual.interpolatePose(...args);
    },
  };
});

function tinyTrack() {
  return compileTrack(
    [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 2, 0), vec3(3, 2, 0)),
      },
    ],
    { samples: 2 },
  );
}

function planeEnv(offset: number, counter: { calls: number }): EnvironmentQuery {
  return {
    signedDistance: (p) => {
      counter.calls += 1;
      return p[1] + offset;
    },
    raycast: () => undefined,
  };
}

function projectDiagnostic(d: Diagnostic) {
  return {
    code: d.code,
    severity: d.severity,
    provenance: d.provenance,
    message: d.message,
    relatedIds: d.relatedIds ? [...d.relatedIds] : undefined,
    location: d.location
      ? {
          s: d.location.s,
          position: d.location.position ? [...d.location.position] : undefined,
          time: d.location.time,
        }
      : undefined,
    actual: d.actual,
    limit: d.limit,
    margin: d.margin,
  };
}

function projectSegment(s: ClearanceField["segments"][number]) {
  return {
    index: s.index,
    startS: s.startS,
    endS: s.endS,
    lowerM: s.lowerM,
    upperM: s.upperM,
    witnessS: s.witnessS,
    witnessPosition: [...s.witnessPosition],
    relatedIds: [...s.relatedIds],
    work: s.work,
    certified: s.certified,
    source: s.source,
  };
}

function projectField(field: ClearanceField) {
  return {
    globalLowerM: field.globalLowerM,
    globalUpperM: field.globalUpperM,
    globalSource: field.globalSource,
    globalLowerSource: field.globalLowerSource,
    globalWitnessS: field.globalWitnessS,
    globalWitnessPosition: [...field.globalWitnessPosition],
    globalRelatedIds: [...field.globalRelatedIds],
    globalLowerWitnessS: field.globalLowerWitnessS,
    globalLowerWitnessPosition: [...field.globalLowerWitnessPosition],
    globalLowerRelatedIds: [...field.globalLowerRelatedIds],
    effectiveCap: field.effectiveCap,
    work: field.work,
    closed: field.closed,
    diagnostics: field.diagnostics.map(projectDiagnostic),
    segments: field.segments.map(projectSegment),
  };
}

describe("clearance field – terrain invariants (RED)", () => {
  it("hoists validated OBB and motion bound to once per swept segment", async () => {
    const { computeClearanceField } = await import("./clearance-field.js");
    const track = tinyTrack();
    const baseOptions = {
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [9],
      maxWork: 100_000,
      segmentIds: ["seg-0"],
    } as const;

    geometryCalls.createOrientedBox = 0;
    geometryCalls.sweptMotionBound = 0;
    geometryCalls.interpolatePose = 0;
    const countedSdf = { calls: 0 };
    const counted = computeClearanceField(track, {
      ...baseOptions,
      explicitThresholds: [...baseOptions.explicitThresholds],
      segmentIds: [...baseOptions.segmentIds],
      environment: planeEnv(9, countedSdf),
    });
    const countedObb = geometryCalls.createOrientedBox;
    const countedMotion = geometryCalls.sweptMotionBound;
    const countedPose = geometryCalls.interpolatePose;

    expect(counted.track).toBe(track);
    expect(counted.segments).toHaveLength(1);
    const seg = counted.segments[0]!;
    expect(seg.work).toBeGreaterThan(1);
    expect(countedSdf.calls).toBeGreaterThan(0);
    expect(countedPose).toBeGreaterThan(0);
    expect(seg.source).toBe("terrain");
    expect(seg.lowerM).toBeLessThan(9);
    expect(seg.upperM).toBeGreaterThanOrEqual(9);
    expect(seg.certified).toBe(false);

    geometryCalls.createOrientedBox = 0;
    geometryCalls.sweptMotionBound = 0;
    geometryCalls.interpolatePose = 0;
    const baselineSdf = { calls: 0 };
    const baseline = computeClearanceField(track, {
      ...baseOptions,
      explicitThresholds: [...baseOptions.explicitThresholds],
      segmentIds: [...baseOptions.segmentIds],
      environment: planeEnv(9, baselineSdf),
    });

    expect(baseline.track).toBe(track);
    expect(baselineSdf.calls).toBeGreaterThan(0);
    expect(projectField(counted)).toEqual(projectField(baseline));

    expect(countedObb).toBeLessThanOrEqual(1);
    expect(countedMotion).toBeLessThanOrEqual(1);
  });
});
