import { describe, it, expect } from "vitest";
import { vec3, compileTrack, SeventhOrderHermiteSpan, type TrackElement } from "@openvibecoaster/core";
import { computeClearanceField, projectClearanceDiagnostics } from "./clearance-field.js";
import { certifiedSweptDistance, type SweptClearanceSegment } from "./clearance-geometry.js";
import { DEFAULT_ENVELOPE } from "./clearance-field.js";

function makeOffsetSegments(offsetXM: number): [SweptClearanceSegment, SweptClearanceSegment] {
  const pose = (pos: [number, number, number]): SweptClearanceSegment["start"] => ({
    position: vec3(pos[0], pos[1], pos[2]),
    tangent: vec3(0, 0, 1),
    normal: vec3(0, 1, 0),
    binormal: vec3(-1, 0, 0),
  });
  const segA: SweptClearanceSegment = {
    startS: 0,
    endS: 10,
    start: pose([0, 0, 0]),
    end: pose([0, 0, 10]),
    geometry: DEFAULT_ENVELOPE,
  };
  const segB: SweptClearanceSegment = {
    startS: 20,
    endS: 30,
    start: pose([offsetXM, 0, 0]),
    end: pose([offsetXM, 0, 10]),
    geometry: DEFAULT_ENVELOPE,
  };
  return [segA, segB];
}

function lineTrack(points: Array<[number, number, number]>): ReturnType<typeof compileTrack> {
  const spans: TrackElement[] = points.slice(0, -1).map((_, i) => {
    const a = vec3(points[i]![0], points[i]![1], points[i]![2]);
    const b = vec3(points[i + 1]![0], points[i + 1]![1], points[i + 1]![2]);
    return { id: `seg-${i}`, span: SeventhOrderHermiteSpan.line(a, b) };
  });
  return compileTrack(spans, { samples: 2 });
}

describe("threshold completeness – display cap and soft prevent premature separation", () => {
  it("AABB lower 1m with display cap 10m must not skip certification as complete via 0.5m hard limit", () => {
    const track = lineTrack([
      [0, 0, 0],
      [0, 0, 5],
      [50, 0, 5],
      [50, 0, 10],
      [0.5, 0, 0],
      [0.5, 0, 5],
    ]);
    const ids = ["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"];
    const fieldCap10 = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [],
      softThresholds: [],
      segmentIds: ids,
      maxWork: 200000,
    });
    expect(fieldCap10.globalLowerM).toBeLessThan(0.5);
    expect(fieldCap10.globalSource).toBe("self");
    expect(fieldCap10.work).toBeGreaterThan(0);
    const hasSelf = fieldCap10.segments.some((s) => s.source === "self");
    expect(hasSelf).toBe(true);

    const [segA, segB] = makeOffsetSegments(3.5);
    const resHardOnly = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    const resWithDisplay = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5, 10],
    });
    expect(resHardOnly.ok).toBe(true);
    expect(resHardOnly.excluded).toBe(false);
    expect(resWithDisplay.ok).toBe(true);
    expect(resWithDisplay.excluded).toBe(false);
    if (!resHardOnly.ok || resHardOnly.excluded) throw new Error("resHardOnly not certified");
    if (!resWithDisplay.ok || resWithDisplay.excluded) throw new Error("resWithDisplay not certified");
    expect(resHardOnly.lowerM).toBeGreaterThanOrEqual(0.5);
    expect(resWithDisplay.lowerM).toBeGreaterThanOrEqual(0.5);
    expect(resWithDisplay.lowerM).toBeLessThan(10);
    expect(resWithDisplay.upperM).toBeLessThan(10);

    const [segC, segD] = makeOffsetSegments(12.5);
    const resStraddleHard = certifiedSweptDistance(segC, segD, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    const resStraddleFull = certifiedSweptDistance(segC, segD, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5, 10],
    });
    expect(resStraddleHard.ok).toBe(true);
    expect(resStraddleHard.excluded).toBe(false);
    expect(resStraddleFull.ok).toBe(true);
    expect(resStraddleFull.excluded).toBe(false);
    if (!resStraddleHard.ok || resStraddleHard.excluded) throw new Error("resStraddleHard not certified");
    if (!resStraddleFull.ok || resStraddleFull.excluded) throw new Error("resStraddleFull not certified");
    expect(resStraddleHard.lowerM).toBeGreaterThanOrEqual(0.5);
    expect(resStraddleFull.lowerM).toBeLessThan(10);
    expect(resStraddleFull.upperM).toBeGreaterThanOrEqual(10);
    expect(resStraddleFull.work).toBeGreaterThanOrEqual(resStraddleHard.work);
  });

  it("soft threshold prevents premature separation – terrain and self use same complete set", () => {
    const track = lineTrack([
      [0, 2, 0],
      [5, 2, 0],
      [10, 2, 0],
      [15, 2, 0],
    ]);
    const ids = ["a", "b", "c"];
    const env = {
      signedDistance: (p: readonly [number, number, number]) => p[1] + 100,
      raycast: () => undefined,
      bounds: () => ({ min: vec3(-100, -100, -100), max: vec3(100, -100, 100) }),
    };
    const fieldNoSoft = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [],
      softThresholds: [],
      segmentIds: ids,
      maxWork: 100000,
    });
    const fieldWithSoft = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [],
      softThresholds: [2, 5],
      segmentIds: ids,
      maxWork: 100000,
    });
    expect(fieldNoSoft.globalLowerM).toBe(10);
    expect(fieldWithSoft.globalLowerM).toBe(10);
    expect(fieldWithSoft.effectiveCap).toBe(10);

    const base = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      segmentIds: ids,
      maxWork: 100000,
    });
    const fakeStraddle = {
      ...base,
      globalLowerM: 0.9,
      globalUpperM: 2.5,
      globalRelatedIds: ["a"] as readonly string[],
      globalSource: "self" as const,
      globalLowerRelatedIds: ["a"] as readonly string[],
      globalLowerSource: "self" as const,
      globalLowerWitnessS: 0,
      globalLowerWitnessPosition: vec3(0, 0, 0),
      effectiveCap: 10,
    };
    const diagsHardOnly = projectClearanceDiagnostics(fakeStraddle, [
      { id: "hard-1", hard: true, threshold: 1.0 },
    ]);
    expect(diagsHardOnly.some((d) => d.code === "CLEARANCE_UNCERTIFIED")).toBe(true);
    const diagsSoft = projectClearanceDiagnostics(fakeStraddle, [
      { id: "soft-1", hard: false, threshold: 2.0 },
    ]);
    const softDiag = diagsSoft.find((d) => d.relatedIds?.includes("soft-1"));
    expect(softDiag).toBeDefined();
    expect(softDiag!.severity).toBe("warning");
    expect(softDiag!.code).toBe("CLEARANCE_UNCERTIFIED");

    const [segA, segB] = makeOffsetSegments(4.5);
    const resHard = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    const resWithSoft = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5, 2, 10],
    });
    expect(resHard.ok).toBe(true);
    expect(resHard.excluded).toBe(false);
    expect(resWithSoft.ok).toBe(true);
    expect(resWithSoft.excluded).toBe(false);
    if (!resHard.ok || resHard.excluded) throw new Error("resHard not certified");
    if (!resWithSoft.ok || resWithSoft.excluded) throw new Error("resWithSoft not certified");
  });
});
