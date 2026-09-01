import { describe, it, expect } from "vitest";
import {
  vec3,
  compileTrack,
  SeventhOrderHermiteSpan,
  type CompiledTrackData,
  type EnvironmentQuery,
  type TrackElement,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
  mapClearanceToTimeline,
  DEFAULT_HARD_CLEARANCE_M,
  type ClearanceField,
} from "./clearance-field.js";
import {
  areSweptIntervalsWithinLocality,
  certifiedSweptDistance,
  createClearancePose,
} from "./clearance-geometry.js";
import { createDefaultSimulatorConfig } from "@openvibecoaster/simulator";

function lineTrack(points: Array<[number, number, number]>): CompiledTrackData {
  const spans: TrackElement[] = points.slice(0, -1).map((_, i) => {
    const a = vec3(points[i]![0], points[i]![1], points[i]![2]);
    const b = vec3(points[i + 1]![0], points[i + 1]![1], points[i + 1]![2]);
    return { id: `seg-${i}`, span: SeventhOrderHermiteSpan.line(a, b) };
  });
  return compileTrack(spans, { samples: 2 });
}

function simpleFlatTrack(): CompiledTrackData {
  return lineTrack([
    [0, 2, 0],
    [3, 2, 0],
    [6, 2, 0],
  ]);
}

function buildFakeField(
  base: ClearanceField,
  overrides: Partial<ClearanceField>,
): ClearanceField {
  return { ...base, ...overrides };
}

function withClosed(field: ClearanceField, closed: boolean): ClearanceField {
  return { ...field, closed };
}

describe("clearance field – terrain continuous", () => {
  it("penetration has real witness and margin, free case stays at cap", () => {
    const track = simpleFlatTrack();
    const penetratingEnv: EnvironmentQuery = {
      signedDistance: (p) => p[1] - 1.5,
      raycast: () => undefined,
      bounds: () => ({ min: vec3(-100, -100, -100), max: vec3(100, 0, 100) }),
    };
    const fieldPen = computeClearanceField(track, {
      environment: penetratingEnv,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(fieldPen.globalUpperM).toBeLessThan(0.5);
    expect(fieldPen.globalLowerM).toBeLessThan(0.5);
    expect(
      fieldPen.diagnostics.some(
        (d) => d.severity === "fatal" || d.severity === "error",
      ),
    ).toBe(false);
    const diags = projectClearanceDiagnostics(fieldPen, []);
    const terr = diags.find((d) => d.code === "TERRAIN_CLEARANCE");
    expect(terr).toBeDefined();
    expect(terr!.actual).toBeCloseTo(fieldPen.globalUpperM, 4);
    expect(terr!.margin).toBeCloseTo(fieldPen.globalUpperM - 0.5, 4);
    expect(terr!.location).toBeDefined();

    const freeEnv: EnvironmentQuery = {
      signedDistance: (p) => p[1] + 100,
      raycast: () => undefined,
      bounds: () => ({
        min: vec3(-100, -100, -100),
        max: vec3(100, -100, 100),
      }),
    };
    const fieldFree = computeClearanceField(track, {
      environment: freeEnv,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(fieldFree.globalLowerM).toBe(10);
    expect(fieldFree.globalUpperM).toBe(10);
    expect(projectClearanceDiagnostics(fieldFree, []).length).toBe(0);
  });
});

describe("clearance field – oriented nonlocal envelope collision", () => {
  it("detects collision with rotated boxes when far along arc but close in world", () => {
    const spans: TrackElement[] = [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 5)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 5), vec3(50, 0, 80)),
      },
      {
        id: "seg-2",
        span: SeventhOrderHermiteSpan.line(vec3(0.5, 0, 0), vec3(0.5, 0, 5)),
      },
    ];
    const track = compileTrack(spans, { samples: 2 });
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1", "seg-2"],
    });
    expect(field.globalLowerM).toBeLessThan(1);
    expect(field.globalSource).toBe("self");
    const d = projectClearanceDiagnostics(field, []);
    expect(d.some((x) => x.code === "TRACK_CLEARANCE")).toBe(true);
  });
});

describe("clearance field – locality exclusions", () => {
  it("adjacent local pair is excluded via shared predicate", () => {
    const track = lineTrack([
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
      [15, 0, 0],
    ]);
    const seg0 = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const seg1 = {
      startS: 5,
      endS: 10,
      start: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(10, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const localityM = 20;
    expect(
      areSweptIntervalsWithinLocality(seg0, seg1, localityM, false, 0),
    ).toBe(true);
    const res = certifiedSweptDistance(seg0, seg1, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: false,
    });
    expect(res.ok && res.excluded).toBe(true);
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["a", "b", "c"],
    });
    // With correct envelope (noseTail 0.75) and locality 2*radius, straight track has clearance > hard but < cap
    expect(field.globalLowerM).toBeGreaterThan(0.5);
    expect(field.globalLowerM).toBeLessThan(10);
  });

  it("closed seam intervals within locality are excluded", () => {
    const L = 30;
    const segA = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const segB = {
      startS: 25,
      endS: 30,
      start: createClearancePose({
        position: vec3(25, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(30, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const localityM = 20;
    expect(
      areSweptIntervalsWithinLocality(segA, segB, localityM, true, L),
    ).toBe(true);
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: true,
      trackLengthM: L,
    });
    expect(res.ok && res.excluded).toBe(true);
  });

  it("shared predicate and certifiedSweptDistance agree on open intervals – local exclusion", () => {
    const localityM = 15;
    const segA = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const segB = {
      startS: 6,
      endS: 10,
      start: createClearancePose({
        position: vec3(6, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(10, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const within = areSweptIntervalsWithinLocality(
      segA,
      segB,
      localityM,
      false,
      0,
    );
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: false,
    });
    expect(within).toBe(true);
    expect(res.ok && res.excluded).toBe(true);
  });

  it("shared predicate and certifiedSweptDistance agree on open intervals – nonlocal inclusion", () => {
    const localityM = 5;
    const segA = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const segB = {
      startS: 50,
      endS: 55,
      start: createClearancePose({
        position: vec3(50, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(55, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const within = areSweptIntervalsWithinLocality(
      segA,
      segB,
      localityM,
      false,
      0,
    );
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: false,
    });
    expect(within).toBe(false);
    expect(res.ok && !res.excluded).toBe(true);
  });

  it("shared predicate and certifiedSweptDistance agree on closed intervals – local exclusion at seam", () => {
    const L = 100;
    const localityM = 20;
    const segA = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const segB = {
      startS: 95,
      endS: 100,
      start: createClearancePose({
        position: vec3(95, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(100, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const within = areSweptIntervalsWithinLocality(
      segA,
      segB,
      localityM,
      true,
      L,
    );
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: true,
      trackLengthM: L,
    });
    expect(within).toBe(true);
    expect(res.ok && res.excluded).toBe(true);
  });

  it("shared predicate and certifiedSweptDistance agree on closed intervals – nonlocal inclusion", () => {
    const L = 100;
    const localityM = 5;
    const segA = {
      startS: 0,
      endS: 5,
      start: createClearancePose({
        position: vec3(0, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(5, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const segB = {
      startS: 50,
      endS: 55,
      start: createClearancePose({
        position: vec3(50, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      end: createClearancePose({
        position: vec3(50, 0, 0),
        tangent: vec3(0, 0, 1),
        normal: vec3(0, 1, 0),
        binormal: vec3(-1, 0, 0),
      }),
      geometry: {
        halfWidthM: 1.25,
        aboveRailM: 2.1,
        belowRailM: 0.8,
        carPitchM: 3.4,
        noseTailMarginM: 0,
      },
    };
    const within = areSweptIntervalsWithinLocality(
      segA,
      segB,
      localityM,
      true,
      L,
    );
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 1000,
      resolutionM: 0.01,
      localityM,
      closed: true,
      trackLengthM: L,
    });
    expect(within).toBe(false);
    expect(res.ok && !res.excluded).toBe(true);
  });
});

describe("clearance field – adversarial multi-cell range pair", () => {
  it("range insertion finds close pair even when centres far apart", () => {
    const spans: TrackElement[] = [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 10)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 10), vec3(50, 0, 20)),
      },
      {
        id: "seg-2",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 20), vec3(50, 0, 30)),
      },
      {
        id: "seg-3",
        span: SeventhOrderHermiteSpan.line(vec3(3.5, 0, 0), vec3(3.5, 0, 10)),
      },
    ];
    const track = compileTrack(spans, { samples: 2 });
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 2,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1", "seg-2", "seg-3"],
    });
    expect(field.globalLowerM).toBeLessThan(2);
  });
});

describe("clearance field – deterministic and subquadratic", () => {
  it("sparse scaling at N and 2N is subquadratic and deterministic", () => {
    const makeSpans = (n: number): TrackElement[] => {
      const spans: TrackElement[] = [];
      for (let i = 0; i < n; i++)
        spans.push({
          id: `seg-${i}`,
          span: SeventhOrderHermiteSpan.line(
            vec3(i * 50, 0, 0),
            vec3(i * 50 + 10, 0, 0),
          ),
        });
      return spans;
    };
    const trackN = compileTrack(makeSpans(20), { samples: 2 });
    const nSegN = trackN.distances.length - 1;
    const idsN = Array.from({ length: nSegN }, (_, i) => `seg-${i}`);
    const fN1 = computeClearanceField(trackN, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 1_000_000,
      segmentIds: idsN,
    });
    const fN2 = computeClearanceField(trackN, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 1_000_000,
      segmentIds: idsN,
    });
    expect(fN1.globalLowerM).toBe(fN2.globalLowerM);
    expect(fN1.globalUpperM).toBe(fN2.globalUpperM);
    expect(fN1.work).toBe(fN2.work);

    const track2N = compileTrack(makeSpans(40), { samples: 2 });
    const nSeg2N = track2N.distances.length - 1;
    const ids2N = Array.from({ length: nSeg2N }, (_, i) => `seg-${i}`);
    const f2N = computeClearanceField(track2N, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 2_000_000,
      segmentIds: ids2N,
    });
    // Subquadratic: charged work at 2N should be < 4 * work at N (allow constant overhead)
    // For sparse tracks, work is linear in N, so ratio should be ~2, well below 4
    const ratio = f2N.work / Math.max(1, fN1.work);
    expect(ratio).toBeLessThan(3.5);
  });

  it("dense bucket consumes budget and returns conservative unknown", () => {
    // Create dense track where all segments overlap spatially (same AABB) to force high bucket occupancy
    const spans: TrackElement[] = [];
    for (let i = 0; i < 30; i++) {
      spans.push({
        id: `dense-${i}`,
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0)),
      });
    }
    const track = compileTrack(spans, { samples: 2 });
    const nSeg = track.distances.length - 1;
    const ids = Array.from({ length: nSeg }, (_, i) => `dense-${i}`);
    // Small budget to force exhaustion on dense bucket visits
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 500,
      segmentIds: ids,
    });
    // Dense case must not do uncharged quadratic work: budget exhausted => conservative lower and diagnostics without location
    expect(field.globalLowerM).toBe(-Number.MAX_VALUE);
    const budgetDiag = field.diagnostics.find((d) =>
      d.message.includes("budget"),
    );
    expect(budgetDiag).toBeDefined();
    expect(budgetDiag!.actual).toBeUndefined();
    expect(budgetDiag!.location).toBeUndefined();
    // Work should be charged and not exceed budget significantly
    expect(field.work).toBeLessThanOrEqual(500);
  });
});

describe("clearance field – thresholds and caps", () => {
  it("hard and soft thresholds from one field label correctly", () => {
    const spans: TrackElement[] = [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 10)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 10), vec3(50, 0, 80)),
      },
      {
        id: "seg-2",
        span: SeventhOrderHermiteSpan.line(vec3(0.6, 0, 0), vec3(0.6, 0, 10)),
      },
    ];
    const track = compileTrack(spans, { samples: 2 });
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1", "seg-2"],
    });
    const diags = projectClearanceDiagnostics(field, [
      { id: "soft-1", hard: false, threshold: 1.0 },
      { id: "hard-2", hard: true, threshold: 1.0 },
    ]);
    const hardDiag = diags.find(
      (d) => d.relatedIds?.includes("hard-2") ?? false,
    );
    const softDiag = diags.find(
      (d) => d.relatedIds?.includes("soft-1") ?? false,
    );
    expect(hardDiag).toBeDefined();
    expect(softDiag).toBeDefined();
    expect(hardDiag!.severity).toBe("error");
    expect(softDiag!.severity).toBe("warning");
    expect(hardDiag!.code).toBe("TRACK_CLEARANCE");
    expect(softDiag!.code).toBe("TRACK_CLEARANCE");
  });

  it("effective cap is max of display, hard, thresholds", () => {
    const track = simpleFlatTrack();
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 3,
      explicitThresholds: [5, 2],
      maxWork: 10000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(field.effectiveCap).toBe(5);
    const field2 = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [],
      maxWork: 10000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(field2.effectiveCap).toBe(10);
  });

  it("wide bracket thresholds separated yields no diagnostics", () => {
    const track = simpleFlatTrack();
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 10000,
      segmentIds: ["seg-0", "seg-1"],
    });
    const diags = projectClearanceDiagnostics(field, [
      { id: "wide", hard: true, threshold: 0.5 },
    ]);
    expect(diags.length).toBe(0);
    const fakeField = buildFakeField(field, {
      globalLowerM: -Number.MAX_VALUE,
      globalUpperM: 10,
      globalSource: "terrain",
      effectiveCap: 10,
    });
    const straddle = projectClearanceDiagnostics(fakeField, [
      { id: "t", hard: true, threshold: 0.5 },
    ]);
    expect(straddle[0]!.code).toBe("CLEARANCE_UNCERTIFIED");
    expect(straddle[0]!.actual).toBeUndefined();
    expect(straddle[0]!.location).toBeUndefined();
    expect(straddle[0]!.message).not.toContain("at s=");
  });
});

describe("clearance field – budget and nonfinite", () => {
  it("budget fatal has no fabricated evidence", () => {
    const track = simpleFlatTrack();
    const env: EnvironmentQuery = {
      signedDistance: (p) => p[1] + 10,
      raycast: () => undefined,
    };
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 1,
      segmentIds: ["seg-0", "seg-1"],
    });
    const budgetDiag = field.diagnostics.find((d) =>
      d.message.includes("budget"),
    );
    expect(budgetDiag).toBeDefined();
    expect(budgetDiag!.actual).toBeUndefined();
    expect(budgetDiag!.location).toBeUndefined();
    expect(field.globalLowerM).toBe(-Number.MAX_VALUE);
    expect(field.globalUpperM).toBe(10);
    expect(field.segments.some((s) => !s.certified)).toBe(true);
  });

  it("nonfinite SDF emits fatal and uses conservative lower", () => {
    const track = simpleFlatTrack();
    const badEnv: EnvironmentQuery = {
      signedDistance: () => Number.NaN,
      raycast: () => undefined,
    };
    const field = computeClearanceField(track, {
      environment: badEnv,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(
      field.diagnostics.some((d) => d.message.includes("non-finite")),
    ).toBe(true);
    expect(field.globalLowerM).toBe(-Number.MAX_VALUE);
  });

  it("invalid offsets throw", () => {
    const track = simpleFlatTrack();
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 10000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(() =>
      mapClearanceToTimeline(field, new Float64Array([0]), [-1]),
    ).toThrow();
    expect(() =>
      mapClearanceToTimeline(field, new Float64Array([Number.NaN]), [0]),
    ).toThrow();
    const infOffsets: readonly number[] = [Number.POSITIVE_INFINITY];
    expect(() =>
      mapClearanceToTimeline(field, Float64Array.from([0]), infOffsets),
    ).toThrow();
  });
});

describe("clearance field – timeline mapping endpoints", () => {
  it("six-car open endpoint and closed seam mapping", () => {
    const spans: TrackElement[] = [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 10)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 10), vec3(0, 0, 20)),
      },
      {
        id: "seg-2",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 20), vec3(0, 0, 30)),
      },
    ];
    const track = compileTrack(spans, { samples: 2 });
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1", "seg-2"],
    });
    const L = track.totalLength;
    const openField = withClosed(field, false);
    const outOpen = mapClearanceToTimeline(
      openField,
      new Float64Array([L]),
      [0],
    );
    expect(outOpen[0]).toBe(field.segments[field.segments.length - 1]!.lowerM);
    const offsets = Array.from({ length: 4 }, (_, i) => i * 3.4);
    const outFour = mapClearanceToTimeline(
      openField,
      new Float64Array([20]),
      offsets,
    );
    expect(Number.isFinite(outFour[0]!)).toBe(true);
    const sixOffsets = Array.from({ length: 6 }, (_, i) => i * 3.4);
    const outSixClosed = mapClearanceToTimeline(
      withClosed(field, true),
      new Float64Array([20]),
      sixOffsets,
    );
    expect(Number.isFinite(outSixClosed[0]!)).toBe(true);
    const closedField = withClosed(field, true);
    const outClosed = mapClearanceToTimeline(
      closedField,
      new Float64Array([0]),
      [0],
    );
    expect(outClosed[0]).toBe(
      Math.min(
        field.segments[0]!.lowerM,
        field.segments[field.segments.length - 1]!.lowerM,
      ),
    );
  });
});

describe("simulator – noseTail margin 0.75", () => {
  it("noseTail=0.75", () => {
    const cfg = createDefaultSimulatorConfig();
    expect(cfg.train.envelope.noseTailMarginM).toBe(0.75);
    const cfg2 = createDefaultSimulatorConfig();
    expect(cfg2.train.envelope.noseTailMarginM).toBe(0.75);
    expect(DEFAULT_HARD_CLEARANCE_M).toBe(0.5);
  });
});
