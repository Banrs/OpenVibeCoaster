import { describe, expect, it } from "vitest";
import { SeventhOrderHermiteSpan, vec3 } from "./index";

describe("c3Join seam endpoints regression (TDD RED)", () => {
  it("maps left u=1 to joined u=0 and right u=0 to joined u=1 for orders 0-3 (scalar)", () => {
    const left = new SeventhOrderHermiteSpan({
      p0: 0,
      d10: 1,
      d20: 2,
      d30: 3,
      p1: 100,
      d11: 101,
      d21: 102,
      d31: 103,
    });
    const right = new SeventhOrderHermiteSpan({
      p0: 200,
      d10: 201,
      d20: 202,
      d30: 203,
      p1: 300,
      d11: 301,
      d21: 302,
      d31: 303,
    });

    const joined = SeventhOrderHermiteSpan.c3Join(left, right);

    // left seam = left at u=1
    expect(joined.position(0)).toBe(100);
    expect(joined.derivative(0, 1)).toBe(101);
    expect(joined.derivative(0, 2)).toBe(102);
    expect(joined.derivative(0, 3)).toBe(103);

    // right seam = right at u=0
    expect(joined.position(1)).toBe(200);
    expect(joined.derivative(1, 1)).toBe(201);
    expect(joined.derivative(1, 2)).toBe(202);
    expect(joined.derivative(1, 3)).toBe(203);

    // negative checks: must not match the opposite (wrong) endpoints
    expect(joined.position(0)).not.toBe(0);
    expect(joined.position(1)).not.toBe(300);
  });

  it("maps left u=1 to joined u=0 and right u=0 to joined u=1 for orders 0-3 (Vec3)", () => {
    const left = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(1, 2, 3),
      d20: vec3(4, 5, 6),
      d30: vec3(7, 8, 9),
      p1: vec3(10, 11, 12),
      d11: vec3(13, 14, 15),
      d21: vec3(16, 17, 18),
      d31: vec3(19, 20, 21),
    });
    const right = new SeventhOrderHermiteSpan({
      p0: vec3(100, 101, 102),
      d10: vec3(103, 104, 105),
      d20: vec3(106, 107, 108),
      d30: vec3(109, 110, 111),
      p1: vec3(200, 201, 202),
      d11: vec3(203, 204, 205),
      d21: vec3(206, 207, 208),
      d31: vec3(209, 210, 211),
    });

    const joined = SeventhOrderHermiteSpan.c3Join(left, right);

    expect(joined.position(0)).toEqual([10, 11, 12]);
    expect(joined.derivative(0, 1)).toEqual([13, 14, 15]);
    expect(joined.derivative(0, 2)).toEqual([16, 17, 18]);
    expect(joined.derivative(0, 3)).toEqual([19, 20, 21]);

    expect(joined.position(1)).toEqual([100, 101, 102]);
    expect(joined.derivative(1, 1)).toEqual([103, 104, 105]);
    expect(joined.derivative(1, 2)).toEqual([106, 107, 108]);
    expect(joined.derivative(1, 3)).toEqual([109, 110, 111]);
  });
});
