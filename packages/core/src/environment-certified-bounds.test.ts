import { describe, expect, it } from "vitest";
import { HeightfieldEnvironment } from "./environment.js";
import { vec3 } from "./math.js";

describe("heightfield certified surface maximum", () => {
  it("publishes the exact finite maximum without claiming finite curtain bounds", () => {
    const environment = new HeightfieldEnvironment({
      width: 3,
      depth: 2,
      cellSize: 5,
      origin: [-5, 10],
      heights: [-8, -7, -6, -5, -4, -3],
    });
    const certified = Reflect.get(environment, "certifiedSurfaceMaximumY") as
      (() => number) | undefined;

    expect(certified).toBeTypeOf("function");
    const first = certified!.call(environment);
    const second = certified!.call(environment);
    expect(first).toBe(environment.bounds().max[1]);
    expect(second).toEqual(first);
    expect(Number.isFinite(first)).toBe(true);
    expect(Reflect.get(environment, "certifiedSurfaceBounds")).toBeUndefined();

    const belowFiniteBounds = vec3(-5, -1_000, 12.5);
    expect(belowFiniteBounds[1]).toBeLessThan(environment.bounds().min[1]);
    expect(environment.signedDistance(belowFiniteBounds)).toBe(0);
  });
});
