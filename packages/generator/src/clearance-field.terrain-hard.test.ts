import { describe, expect, it } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
  type EnvironmentQuery,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
} from "./clearance-field.js";

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

// Deterministic plane SDF: distance to horizontal plane y = -offset.
// For track at y~2 (center ~2.65, min corner ~1.2), choosing offset 9 gives
// bracket ~[6.7, 10.2] that straddles displayCap 10 while hard 0.5 is
// separated. circumsphere radius ~3.46 + motion ~1.5 prevents tightening
// past radius, so time subdivision alone cannot resolve cap straddle.
function planeEnv(offset: number): EnvironmentQuery {
  return {
    signedDistance: (p) => p[1] + offset,
    raycast: () => undefined,
  };
}

describe("clearance field – terrain hard-only certification", () => {
  it("hard-separated bracket straddling display cap stays bounded, honest, not fatal, but not display-certified", () => {
    const track = tinyTrack();
    const env = planeEnv(9);
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["seg-0"],
    });
    expect(field.segments).toHaveLength(1);
    const seg = field.segments[0]!;
    // Work stays at root: hard 0.5 already separated, cap soft value must not drive heap.
    expect(seg.work).toBe(1);
    expect(field.work).toBe(1);
    // No fabricated fatal from display cap straddle.
    expect(field.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    // Honest conservative lower / outward upper bracket straddles cap, ordering and witnesses intact.
    expect(seg.lowerM).toBeLessThan(10);
    expect(seg.upperM).toBeGreaterThanOrEqual(10);
    expect(seg.lowerM).toBeLessThan(seg.upperM);
    expect(seg.lowerM).toBeGreaterThan(0.5);
    expect(field.globalLowerM).toBeLessThan(10);
    expect(field.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(Number.isFinite(seg.witnessS)).toBe(true);
    expect(Array.isArray(seg.witnessPosition)).toBe(true);
    // Not vacuous: source remains terrain and lower witness invariant preserved.
    expect(seg.source).toBe("terrain");
    expect(field.globalSource).toBe("terrain");
    // Final segment certified uses full set (hard+soft+cap) => false due to cap straddle.
    expect(seg.certified).toBe(false);
    // Honest bracket proof: lower is nextDown-derived conservative, upper is nextUp outward ( > raw).
    expect(seg.upperM).toBeGreaterThan(seg.lowerM);
  });

  it("same shape with soft threshold inside bracket stays nonfatal and projects warning", () => {
    const track = tinyTrack();
    const env = planeEnv(9);
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      softThresholds: [8],
      maxWork: 100_000,
      segmentIds: ["seg-0"],
    });
    const seg = field.segments[0]!;
    // Terrain heap must not subdivide for soft: still root work and no terrain fatal.
    expect(seg.work).toBe(1);
    expect(field.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(seg.lowerM).toBeLessThan(8);
    expect(seg.upperM).toBeGreaterThanOrEqual(8);
    expect(seg.certified).toBe(false);
    // Projection must still emit warning for soft straddle, not downgrade.
    const diags = projectClearanceDiagnostics(field, [
      { id: "soft-8", hard: false, threshold: 8 },
    ]);
    const warn = diags.find((d) => d.relatedIds.includes("soft-8"));
    expect(warn).toBeDefined();
    expect(warn!.code).toBe("CLEARANCE_UNCERTIFIED");
    expect(warn!.severity).toBe("warning");
    expect(warn!.relatedIds).toContain("soft-8");
    // Warning branch has no location/actual – honest unknown, not fabricated failure.
    expect((warn as { location?: unknown }).location).toBeUndefined();
    expect((warn as { actual?: unknown }).actual).toBeUndefined();
  });

  it("hard threshold inside same bracket remains fatal error and not certified (bounded)", () => {
    const track = tinyTrack();
    const env = planeEnv(9);
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["seg-0"],
    });
    const seg = field.segments[0]!;
    // Still bounded at root, honest straddle around hard threshold 8.
    expect(seg.work).toBe(1);
    expect(seg.lowerM).toBeLessThan(8);
    expect(seg.upperM).toBeGreaterThanOrEqual(8);
    // Segment that straddles cap is uncertified; hard straddle must not be treated as certified.
    expect(seg.certified).toBe(false);
    const diags = projectClearanceDiagnostics(field, [
      { id: "hard-8", hard: true, threshold: 8 },
    ]);
    const err = diags.find((d) => d.relatedIds.includes("hard-8"));
    expect(err).toBeDefined();
    expect(err!.code).toBe("CLEARANCE_UNCERTIFIED");
    expect(err!.severity).toBe("fatal");
    expect(err!.relatedIds).toContain("hard-8");
    expect((err as { actual?: unknown }).actual).toBeUndefined();
    // Global not separated: must not be considered passing.
    expect(field.globalLowerM).toBeLessThan(8);
    expect(field.globalUpperM).toBeGreaterThanOrEqual(8);
  });
});
