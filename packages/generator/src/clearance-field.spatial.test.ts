import { describe, it, expect } from "vitest";
import { vec3, compileTrack, type TrackElement } from "@openvibecoaster/core";
import type { Vec3, ParametricSpan } from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";

function makeHelixTrack(): ReturnType<typeof compileTrack> {
  const R = 30;
  const pitchTotal = 12;
  const turns = 2;
  const samples = 65;
  const thetaScale = turns * 2 * Math.PI;
  const span: ParametricSpan<Vec3> = {
    position: (u: number): Vec3 => {
      const th = thetaScale * u;
      return vec3(R * Math.cos(th), pitchTotal * u, R * Math.sin(th));
    },
    derivative: (u: number, order = 1): Vec3 => {
      const th = thetaScale * u;
      const s = Math.sin(th);
      const c = Math.cos(th);
      if (order === 1) {
        return vec3(-R * thetaScale * s, pitchTotal, R * thetaScale * c);
      }
      if (order === 2) {
        return vec3(
          -R * thetaScale * thetaScale * c,
          0,
          -R * thetaScale * thetaScale * s,
        );
      }
      if (order === 3) {
        return vec3(
          R * thetaScale * thetaScale * thetaScale * s,
          0,
          -R * thetaScale * thetaScale * thetaScale * c,
        );
      }
      return vec3(0, 0, 0);
    },
  };
  const elements: TrackElement[] = [{ id: "helix-0", span }];
  return compileTrack(elements, { samples });
}

describe("clearance-field spatial hash", () => {
  it("helix two-turn R30 pitch 12 smooth nonlocal close pair", () => {
    const track = makeHelixTrack();
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 2,
      maxWork: 200000,
      segmentIds: ["helix-0"],
    });
    expect(
      field.diagnostics.some(
        (d) => d.severity === "error" || d.severity === "fatal",
      ),
    ).toBe(false);
    expect(field.globalLowerM).toBeGreaterThanOrEqual(0.5);
    expect(field.globalLowerM).toBeLessThan(2);
    expect(field.globalUpperM).toBeLessThan(2);
    expect(field.globalUpperM).toBeGreaterThanOrEqual(field.globalLowerM);
    expect(field.globalSource).toBe("self");
    expect(field.globalRelatedIds.length).toBeGreaterThan(0);
    expect(field.globalRelatedIds).toContain("helix-0");
    expect(field.globalLowerSource).toBe("self");
    expect(field.work).toBeGreaterThan(0);
    expect(field.work).toBeLessThan(200000);
  });
});
