import { describe, expect, it } from "vitest";
import { transportFramesAlongPath, vec3, vec3Dot } from "./index";

describe("double-reflection RMF separate Householder factors", () => {
  it("applies separate dot(d,n0) factor for curved two-point reflection", () => {
    const positions = [vec3(0, 0, 0), vec3(1.6, 0.8, 0.6)];
    const t0 = vec3(1, 0, 0);
    // t1 = normalize(10,3,4) => ~ (0.8944271909999159, 0.2683281572999747, 0.35777087639996635)
    const t1 = vec3(10, 3, 4);
    const frames = transportFramesAlongPath(
      positions,
      [t0, t1],
      [0, 1],
      () => 0,
    );

    // Expected normal from correct double-reflection (separate factors):
    // computed via independent Householder implementation with high precision
    const expectedNormal: [number, number, number] = [
      -0.2934853828423903, 0.9558150100450584, 0.016852199572182043,
    ];
    const actual = frames[1]!.normal;
    // Minimal twist: angular error must be far below 11.2 deg spurious twist.
    // Require close to expected within 1e-10 (tight) and orthonance already tested elsewhere.
    for (let i = 0; i < 3; i += 1)
      expect(actual[i]!).toBeCloseTo(expectedNormal[i]!, 10);

    const dot = vec3Dot(actual, expectedNormal);
    // cos(0.5 deg) ~ 0.99996, so this is strict
    expect(dot).toBeGreaterThan(0.99999);

    // Regression: buggy reuse of dot(d,t0) for normal yields ~11.2 deg twist.
    const buggyNormal: [number, number, number] = [
      -0.3535286962787549, 0.9141894078572902, 0.1981796848039196,
    ];
    const buggyDot = vec3Dot(actual, buggyNormal);
    // If bug persisted, actual would be close to buggy (dot ~0.98) and far from expected.
    // After fix, dot to buggy should be ~cos(11.22deg)=0.9809
    const expectedBuggyDot = 0.9809;
    expect(buggyDot).toBeCloseTo(expectedBuggyDot, 2);
    // Ensure we are not still matching buggy within tight tolerance
    expect(Math.abs(buggyDot - 1)).toBeGreaterThan(0.01);
  });

  it("does not alter straight-line transport (orthogonalization masks bug there)", () => {
    const positions = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0)];
    const tangents = [vec3(1, 0, 0), vec3(1, 0, 0), vec3(1, 0, 0)];
    const frames = transportFramesAlongPath(
      positions,
      tangents,
      [0, 1, 2],
      () => 0,
    );
    for (const f of frames) {
      expect(f.normal[0]).toBeCloseTo(0, 10);
      expect(f.normal[1]).toBeCloseTo(1, 10);
      expect(f.normal[2]).toBeCloseTo(0, 10);
    }
  });
});
