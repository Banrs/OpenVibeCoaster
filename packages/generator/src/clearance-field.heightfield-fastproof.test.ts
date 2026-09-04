import { describe, expect, it } from "vitest";
import {
  compileTrack,
  HeightfieldEnvironment,
  SeventhOrderHermiteSpan,
  vec3,
  type EnvironmentQuery,
  type Vec3,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
} from "./clearance-field.js";

class CountingHeightfield extends HeightfieldEnvironment {
  public calls = 0;

  public override signedDistance(point: Vec3): number {
    this.calls += 1;
    return super.signedDistance(point);
  }
}

function shortTrack() {
  return compileTrack(
    [
      {
        id: "track-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, -2), vec3(0, 0, 2)),
      },
    ],
    { samples: 2 },
  );
}

function certifiedHeightfield() {
  const environment = new CountingHeightfield({
    width: 3,
    depth: 3,
    cellSize: 10,
    origin: [-10, -10],
    heights: Array.from({ length: 9 }, () => -8),
  });
  Reflect.set(environment, "certifiedSurfaceBounds", undefined);
  return Object.assign(environment, {
    certifiedSurfaceMaximumY: (): number => environment.bounds().max[1],
  });
}

describe("heightfield certified threshold fast proof", () => {
  it("skips below-cap SDF work only for explicitly certified surface bounds", () => {
    const options = {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["track-0"],
    } as const;
    const firstEnvironment = certifiedHeightfield();
    const secondEnvironment = certifiedHeightfield();

    const first = computeClearanceField(shortTrack(), {
      ...options,
      environment: firstEnvironment,
    });
    const second = computeClearanceField(shortTrack(), {
      ...options,
      environment: secondEnvironment,
    });

    expect(firstEnvironment.calls).toBe(0);
    expect(secondEnvironment.calls).toBe(0);
    expect(first.globalLowerM).toBeGreaterThanOrEqual(0.5);
    expect(first.globalLowerM).toBeLessThan(10);
    expect(first.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(first.globalLowerSource).toBe("terrain");
    expect(first.globalSource).toBe("terrain");
    expect(first.segments.every((segment) => segment.certified === false)).toBe(
      true,
    );
    expect(first.diagnostics.some((item) => item.severity === "fatal")).toBe(
      false,
    );
    expect(second.work).toBe(first.work);
    expect(second.globalLowerM).toBe(first.globalLowerM);
    expect(second.globalUpperM).toBe(first.globalUpperM);
    expect(second.segments).toEqual(first.segments);
  });

  it("never trusts ordinary bounds to hide a penetrating signed distance", () => {
    let calls = 0;
    const environment: EnvironmentQuery = {
      signedDistance: (point) => {
        calls += 1;
        return point[1] - 1;
      },
      bounds: () => ({ min: vec3(-10, -9, -10), max: vec3(10, -8, 10) }),
      raycast: () => undefined,
    };

    const field = computeClearanceField(shortTrack(), {
      environment,
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["track-0"],
    });
    const diagnostics = projectClearanceDiagnostics(field, []);

    expect(calls).toBeGreaterThan(0);
    expect(field.globalUpperM).toBeLessThan(0.5);
    expect(
      diagnostics.some(
        (item) =>
          item.code === "TERRAIN_CLEARANCE" &&
          item.actual !== undefined &&
          item.limit === 0.5 &&
          item.margin !== undefined &&
          item.margin < 0,
      ),
    ).toBe(true);
  });
});
