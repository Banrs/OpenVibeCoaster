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
    expect(seg.work).toBe(1);
    expect(field.work).toBe(1);
    expect(field.diagnostics).toHaveLength(0);
    expect(field.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(seg.lowerM).toBeLessThan(10);
    expect(seg.upperM).toBeGreaterThanOrEqual(10);
    expect(seg.lowerM).toBeLessThan(seg.upperM);
    expect(field.globalLowerM).toBeLessThan(10);
    expect(field.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(seg.certified).toBe(false);
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
    expect(seg.work).toBe(1);
    expect(field.diagnostics).toHaveLength(0);
    expect(field.diagnostics.some((d) => d.severity === "fatal")).toBe(false);
    expect(seg.lowerM).toBeLessThan(8);
    expect(seg.upperM).toBeGreaterThanOrEqual(8);
    expect(seg.certified).toBe(false);
    const diags = projectClearanceDiagnostics(field, [
      { id: "soft-8", hard: false, threshold: 8 },
    ]);
    const warn = diags.find((d) => d.relatedIds?.includes("soft-8") ?? false);
    expect(warn).toBeDefined();
    expect(warn!.code).toBe("CLEARANCE_UNCERTIFIED");
    expect(warn!.severity).toBe("warning");
    expect((warn as { location?: unknown }).location).toBeUndefined();
    expect((warn as { actual?: unknown }).actual).toBeUndefined();
  });

  it("hard threshold inside same bracket remains fatal error and not certified (bounded)", () => {
    const track = tinyTrack();
    const env = planeEnv(9);
    const maxWork = 100_000;
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [8],
      maxWork,
      segmentIds: ["seg-0"],
    });
    const seg = field.segments[0]!;
    expect(seg.work).toBeGreaterThan(1);
    expect(seg.work).toBeLessThanOrEqual(512);
    expect(seg.work % 2).toBe(1);
    expect(field.work % 2).toBe(1);
    expect(field.work).toBeLessThan(maxWork);
    expect(seg.lowerM).toBeLessThan(8);
    expect(seg.upperM).toBeGreaterThanOrEqual(8);
    expect(seg.lowerM).toBeLessThan(seg.upperM);
    expect(seg.certified).toBe(false);
    expect(
      field.diagnostics.some(
        (d) => d.code === "CLEARANCE_UNCERTIFIED" && d.severity === "fatal",
      ),
    ).toBe(true);
    const diags = projectClearanceDiagnostics(field, [
      { id: "hard-8", hard: true, threshold: 8 },
    ]);
    const err = diags.find((d) => d.relatedIds?.includes("hard-8") ?? false);
    expect(err).toBeDefined();
    expect(err!.code).toBe("CLEARANCE_UNCERTIFIED");
    expect(err!.severity).toBe("fatal");
    expect((err as { actual?: unknown }).actual).toBeUndefined();
    expect((err as { margin?: unknown }).margin).toBeUndefined();
    expect(field.globalLowerM).toBeLessThan(8);
    expect(field.globalUpperM).toBeGreaterThanOrEqual(8);
  });
});
