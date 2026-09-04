import { describe, expect, it } from "vitest";
import { HeightfieldEnvironment } from "./environment.js";
import type { Aabb } from "./math.js";

describe("heightfield certified surface bounds", () => {
  it("publishes the exact finite deterministic surface AABB", () => {
    const environment = new HeightfieldEnvironment({
      width: 3,
      depth: 2,
      cellSize: 5,
      origin: [-5, 10],
      heights: [-8, -7, -6, -5, -4, -3],
    });
    const certified = Reflect.get(environment, "certifiedSurfaceBounds") as
      | (() => Aabb)
      | undefined;

    expect(certified).toBeTypeOf("function");
    const first = certified!.call(environment);
    const second = certified!.call(environment);
    expect(first).toEqual(environment.bounds());
    expect(second).toEqual(first);
    expect([...first.min, ...first.max].every(Number.isFinite)).toBe(true);
    expect(first).not.toBe(second);
  });
});
