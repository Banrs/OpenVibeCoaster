import { describe, expect, it } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
  type EnvironmentQuery,
} from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";
import { nextUp } from "./polynomial-bounds.js";

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

describe("clearance field – terrain outward upper witness", () => {
  it("exposes outward SDF upper (nextUp) for finite exact witness", () => {
    const track = tinyTrack();
    const rawWitness = 1;
    const expectedUpper = nextUp(rawWitness);
    let calls = 0;
    const env: EnvironmentQuery = {
      signedDistance: () => {
        calls += 1;
        return rawWitness;
      },
      raycast: () => undefined,
    };
    const field = computeClearanceField(track, {
      environment: env,
      hardClearanceM: 2,
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["seg-0"],
    });
    expect(calls).toBeGreaterThan(0);
    expect(field.segments).toHaveLength(1);
    const seg = field.segments[0]!;
    // Outward invariant: exposed upper is strictly greater than raw witness.
    expect(seg.upperM).toBe(expectedUpper);
    expect(seg.upperM).toBeGreaterThan(rawWitness);
    expect(field.globalUpperM).toBe(expectedUpper);
    expect(field.globalUpperM).toBeGreaterThan(rawWitness);
    // Not vacuous: ordering and source remain terrain, witness association intact.
    expect(seg.lowerM).toBeLessThanOrEqual(seg.upperM);
    expect(field.globalLowerM).toBeLessThanOrEqual(field.globalUpperM);
    expect(seg.source).toBe("terrain");
    expect(field.globalSource).toBe("terrain");
    expect(Number.isFinite(seg.witnessS)).toBe(true);
    expect(Array.isArray(seg.witnessPosition)).toBe(true);
  });
});
