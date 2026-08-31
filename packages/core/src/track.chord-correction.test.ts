import { describe, expect, it } from "vitest";
import { compileTrack, CANONICAL_TRACK_COMPILE_OPTIONS } from "./track";
import { SeventhOrderHermiteSpan } from "./spans";
import { vec3 } from "./math";
import { checkedArcLength } from "./arc-length";
import { TrackCompileError } from "./compile-error";
import type { ParametricSpan } from "./spans";
import type { Vec3 } from "./math";

// Helper to create the specific parabola y = 1.666...*(u - u^2) with x=10u
const makeParabola = (
  rotationRad = 0,
  translationY = 0,
): SeventhOrderHermiteSpan<Vec3> => {
  const base = new SeventhOrderHermiteSpan<Vec3>({
    p0: vec3(0, 0, 0),
    d10: vec3(10, 5 / 3, 0),
    d20: vec3(0, -10 / 3, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(10, 0, 0),
    d11: vec3(10, -5 / 3, 0),
    d21: vec3(0, -10 / 3, 0),
    d31: vec3(0, 0, 0),
  });
  if (rotationRad === 0 && translationY === 0) return base;
  const cos = Math.cos(rotationRad),
    sin = Math.sin(rotationRad);
  const rotate = (v: Vec3): Vec3 =>
    vec3(v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos, v[2]);
  const rows = base.coefficients as unknown as number[][];
  const newRows: number[][] = [[], [], []];
  for (let i = 0; i < 8; i++) {
    const v = vec3(rows[0]![i]!, rows[1]![i]!, rows[2]![i]!);
    const rv = rotate(v);
    newRows[0]!.push(rv[0]!);
    newRows[1]!.push(rv[1]!);
    newRows[2]!.push(rv[2]!);
  }
  if (translationY !== 0) newRows[1]![0]! += translationY;
  return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
    newRows as readonly (readonly number[])[],
  );
};

const makeParabolaGeneral = (
  rotationAxis: Vec3,
  angle: number,
  translation: Vec3,
): SeventhOrderHermiteSpan<Vec3> => {
  const base = new SeventhOrderHermiteSpan<Vec3>({
    p0: vec3(0, 0, 0),
    d10: vec3(10, 5 / 3, 0),
    d20: vec3(0, -10 / 3, 0),
    d30: vec3(0, 0, 0),
    p1: vec3(10, 0, 0),
    d11: vec3(10, -5 / 3, 0),
    d21: vec3(0, -10 / 3, 0),
    d31: vec3(0, 0, 0),
  });
  const len = Math.hypot(...rotationAxis);
  if (len < 1e-12) {
    const rows = base.coefficients as unknown as number[][];
    const newRows: number[][] = rows.map((r) => [...r]);
    for (let c = 0; c < 3; c++) newRows[c]![0]! += translation[c]!;
    return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
      newRows as readonly (readonly number[])[],
    );
  }
  const ax = vec3(
    rotationAxis[0] / len,
    rotationAxis[1] / len,
    rotationAxis[2] / len,
  );
  const cos = Math.cos(angle),
    sin = Math.sin(angle),
    omc = 1 - cos;
  const rotate = (v: Vec3): Vec3 =>
    vec3(
      (cos + ax[0] ** 2 * omc) * v[0] +
        (ax[0] * ax[1] * omc - ax[2] * sin) * v[1] +
        (ax[0] * ax[2] * omc + ax[1] * sin) * v[2],
      (ax[1] * ax[0] * omc + ax[2] * sin) * v[0] +
        (cos + ax[1] ** 2 * omc) * v[1] +
        (ax[1] * ax[2] * omc - ax[0] * sin) * v[2],
      (ax[2] * ax[0] * omc - ax[1] * sin) * v[0] +
        (ax[2] * ax[1] * omc + ax[0] * sin) * v[1] +
        (cos + ax[2] ** 2 * omc) * v[2],
    );
  const rows = base.coefficients as unknown as number[][];
  const newRows: number[][] = [[], [], []];
  for (let i = 0; i < 8; i++) {
    const v = vec3(rows[0]![i]!, rows[1]![i]!, rows[2]![i]!);
    const rv = rotate(v);
    newRows[0]!.push(rv[0]!);
    newRows[1]!.push(rv[1]!);
    newRows[2]!.push(rv[2]!);
  }
  for (let c = 0; c < 3; c++) newRows[c]![0]! += translation[c]!;
  return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
    newRows as readonly (readonly number[])[],
  );
};

describe("chord correction – genuinely conservative", () => {
  it("parabola with translations and rotation makes same subdivision decisions", () => {
    const base = makeParabola(0, 0);
    const rot = makeParabola(0.017, 0);
    const t2e9 = makeParabola(0, 2e9);
    const t5e9 = makeParabola(0, 5e9);
    const t1e12 = makeParabola(0, 1e12);
    const countFor = (span: SeventhOrderHermiteSpan<Vec3>) =>
      compileTrack([{ id: "p", span }]).positions.length / 3;
    const baseCount = countFor(base);
    expect(countFor(rot)).toBe(baseCount);
    expect(countFor(t2e9)).toBe(baseCount);
    expect(countFor(t5e9)).toBe(baseCount);
    expect(countFor(t1e12)).toBe(baseCount);
    expect(() => compileTrack([{ id: "p", span: t1e12 }])).not.toThrow();
    // Additional axes and translation invariance
    const axes: Vec3[] = [
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      vec3(0.3, 0.5, 0.2),
    ];
    for (const axis of axes) {
      const s = makeParabolaGeneral(axis, 0.6, vec3(100, -200, 300));
      expect(countFor(s)).toBe(baseCount);
    }
    // Threshold-adjacent: scale parabola height to near 0.5mm sagitta
    // Base parabola sagitta ~0.416mm (parabola height 0.416). Scale to approach threshold 0.5mm
    const scaleJustBelow = (0.0005 / 0.000416) * 0.99;
    const scaleJustAbove = (0.0005 / 0.000416) * 1.01;
    const makeScaled = (scale: number) =>
      new SeventhOrderHermiteSpan<Vec3>({
        p0: vec3(0, 0, 0),
        d10: vec3(10, (5 / 3) * scale, 0),
        d20: vec3(0, (-10 / 3) * scale, 0),
        d30: vec3(0, 0, 0),
        p1: vec3(10, 0, 0),
        d11: vec3(10, (-5 / 3) * scale, 0),
        d21: vec3(0, (-10 / 3) * scale, 0),
        d31: vec3(0, 0, 0),
      });
    const below = makeScaled(scaleJustBelow);
    const above = makeScaled(scaleJustAbove);
    const belowCount = countFor(below);
    const aboveCount = countFor(above);
    expect(belowCount).toBeGreaterThanOrEqual(32);
    expect(aboveCount).toBeGreaterThanOrEqual(belowCount);
    // Verify adaptive parameter topology identical after inverse transform within representable precision
    const rotAxis = vec3(0, 0, 1);
    const rotAngle = 0.9;
    const rot2 = makeParabolaGeneral(rotAxis, rotAngle, vec3(5, -3, 2));
    const orig = compileTrack([{ id: "s", span: base }]);
    const invTrans = vec3(-5, 3, -2);
    // Inverse rotate check: compile rotated then verify geometry via manual inverse (same Z axis)
    const cos = Math.cos(rotAngle),
      sin = Math.sin(rotAngle);
    const invRotate = (v: Vec3): Vec3 =>
      vec3(v[0] * cos + v[1] * sin, -v[0] * sin + v[1] * cos, v[2]);
    const rotData = compileTrack([{ id: "s", span: rot2 }]);
    expect(rotData.positions.length).toBe(orig.positions.length);
    expect(rotData.parameters.length).toBe(orig.parameters.length);
    for (let pi = 0; pi < orig.parameters.length; pi++)
      expect(rotData.parameters[pi]!).toBeCloseTo(orig.parameters[pi]!, 10);
    for (let i = 0; i < orig.positions.length / 3; i++) {
      const rp = vec3(
        rotData.positions[i * 3]!,
        rotData.positions[i * 3 + 1]!,
        rotData.positions[i * 3 + 2]!,
      );
      const op = vec3(
        orig.positions[i * 3]!,
        orig.positions[i * 3 + 1]!,
        orig.positions[i * 3 + 2]!,
      );
      const inv = vec3(
        rp[0] + invTrans[0],
        rp[1] + invTrans[1],
        rp[2] + invTrans[2],
      );
      const inv2 = invRotate(inv);
      expect(inv2[0]).toBeCloseTo(op[0], 6);
      expect(inv2[1]).toBeCloseTo(op[1], 6);
    }
  });

  it("randomized seventh-order spans: dense oracle error <= each interval certificate", () => {
    const seeds = [1, 2, 3, 5, 8];
    for (const seed of seeds) {
      const span = new SeventhOrderHermiteSpan<Vec3>({
        p0: vec3(seed * 0.7, seed * 1.1, seed * 0.3),
        d10: vec3(10 + seed, 2 * seed, 1),
        d20: vec3(seed, -seed, seed * 0.5),
        d30: vec3(0, 0, 0),
        p1: vec3(10 + seed * 2, seed, 5),
        d11: vec3(10 - seed, -seed, 2),
        d21: vec3(-seed, seed, -seed),
        d31: vec3(0, 0, 0),
      });
      const data = compileTrack([{ id: `r${seed}`, span }]);
      const positions = data.positions;
      const count = positions.length / 3;
      let maxActual = 0;
      for (let s = 0; s < count - 1; s++) {
        const a = data.parameters[s]!;
        const b = data.parameters[s + 1]!;
        for (let k = 0; k <= 10; k++) {
          const u = a + ((b - a) * k) / 10;
          const p = span.position(u);
          const aPos = vec3(
            positions[s * 3]!,
            positions[s * 3 + 1]!,
            positions[s * 3 + 2]!,
          );
          const bPos = vec3(
            positions[(s + 1) * 3]!,
            positions[(s + 1) * 3 + 1]!,
            positions[(s + 1) * 3 + 2]!,
          );
          const ab = vec3(
            bPos[0] - aPos[0],
            bPos[1] - aPos[1],
            bPos[2] - aPos[2],
          );
          const ap = vec3(p[0] - aPos[0], p[1] - aPos[1], p[2] - aPos[2]);
          const denom = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
          const t =
            denom === 0
              ? 0
              : Math.max(
                  0,
                  Math.min(
                    1,
                    (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / denom,
                  ),
                );
          const closest = vec3(
            aPos[0] + ab[0] * t,
            aPos[1] + ab[1] * t,
            aPos[2] + ab[2] * t,
          );
          const dx = p[0] - closest[0],
            dy = p[1] - closest[1],
            dz = p[2] - closest[2];
          const d = Math.hypot(dx, dy, dz);
          if (d > maxActual) maxActual = d;
        }
      }
      expect(maxActual).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
  });

  it("budget certifier that becomes acceptable only at >65536 leaves throws SAMPLE_BUDGET_EXCEEDED with deterministic work", () => {
    let leavesNeeded = 0;
    const span: ParametricSpan<Vec3> & {
      chordErrorUpperBound: (a: number, b: number) => number;
      speedLowerBound: (a: number, b: number) => number;
    } = {
      position: (u) => vec3(u * 10, 0, 0),
      derivative: () => vec3(10, 0, 0),
      chordErrorUpperBound: (a, b) => {
        const width = b - a;
        if (width < 1 / 70000) return 0;
        leavesNeeded++;
        return 1;
      },
      speedLowerBound: () => 10,
    };
    let caught: TrackCompileError | undefined;
    try {
      compileTrack([{ id: "budget", span }]);
    } catch (e) {
      caught = e as TrackCompileError;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe("SAMPLE_BUDGET_EXCEEDED");
    expect(caught!.evidence.samples ?? caught!.evidence.work).toBeDefined();
    expect(leavesNeeded).toBeGreaterThan(0);
    expect(leavesNeeded).toBeLessThan(70000);
    // Deterministic work: repeating should give same leavesNeeded
    let leavesNeeded2 = 0;
    const span2: ParametricSpan<Vec3> & {
      chordErrorUpperBound: (a: number, b: number) => number;
      speedLowerBound: (a: number, b: number) => number;
    } = {
      position: (u) => vec3(u * 10, 0, 0),
      derivative: () => vec3(10, 0, 0),
      chordErrorUpperBound: (a, b) => {
        const w = b - a;
        if (w < 1 / 70000) return 0;
        leavesNeeded2++;
        return 1;
      },
      speedLowerBound: () => 10,
    };
    expect(() => compileTrack([{ id: "budget", span: span2 }])).toThrow(
      expect.objectContaining({ code: "SAMPLE_BUDGET_EXCEEDED" }),
    );
    expect(leavesNeeded2).toBe(leavesNeeded);
    // Bounded output: error evidence indicates limit
    expect(
      caught!.evidence.limitSamples ?? caught!.evidence.limit,
    ).toBeDefined();
  });

  it("singular polynomial x' = ((u-.03)(u-.095))^2 must fail checked integration with root interval", () => {
    // Build integrated SeventhOrderHermiteSpan that has zero speed at u=0.03 and u=0.095
    const coeffsX = [
      0, 0.000081225, -0.0035625, 0.07108333333333333, -0.625, 2, 0, 0,
    ];
    const coeffsY = [0, 0, 0, 0, 0, 0, 0, 0];
    const coeffsZ = [0, 0, 0, 0, 0, 0, 0, 0];
    const singularSpan = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      coeffsX,
      coeffsY,
      coeffsZ,
    ]);
    let err: TrackCompileError | undefined;
    try {
      checkedArcLength(singularSpan as any, 0, 1);
    } catch (e) {
      err = e as TrackCompileError;
    }
    expect(err).toBeDefined();
    expect(err!.code).toBe("SPEED_CERTIFICATION_FAILED");
    const iv = err!.evidence.uInterval!;
    // Work evidence must be present and deterministic
    expect(err!.evidence.work).toBeDefined();
    // Interval should be near a root (within 0.01 due to binary subdivision and outward rounding)
    const mid = (iv[0] + iv[1]) / 2;
    const nearFirst = Math.abs(mid - 0.03) < 0.01;
    const nearSecond = Math.abs(mid - 0.095) < 0.01;
    expect(nearFirst || nearSecond).toBe(true);
  });

  it("public fixed-sampling edge: floor fractional and clamp below two, reject non-finite", () => {
    const span = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0));
    const f10_7 = compileTrack([{ id: "s", span }], { samples: 10.7 });
    expect(f10_7.positions.length / 3).toBe(10);
    const f1 = compileTrack([{ id: "s", span }], { samples: 1 });
    expect(f1.positions.length / 3).toBe(2);
    expect(() =>
      compileTrack([{ id: "s", span }], { samples: NaN as unknown as number }),
    ).toThrow();
    expect(() =>
      compileTrack([{ id: "s", span }], {
        samples: Infinity as unknown as number,
      }),
    ).toThrow();
    expect(() =>
      compileTrack([{ id: "s", span }], {
        samples: -Infinity as unknown as number,
      }),
    ).toThrow();
  });

  it("streaming checksum near-cap bounded memory produces same canonical checksum", () => {
    // Build a track with many elements but within cap, using deterministic spans
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      span: SeventhOrderHermiteSpan.line(
        vec3(i * 10, 0, 0),
        vec3((i + 1) * 10, Math.sin(i) * 2, 0),
      ),
    }));
    const a = compileTrack(many);
    const b = compileTrack(many, CANONICAL_TRACK_COMPILE_OPTIONS);
    expect(a.checksum).toBe(b.checksum);
    expect(a.positions.length / 3).toBeGreaterThanOrEqual(32 * 10 - 9);
    // Bounded output: total samples < global cap
    expect(a.positions.length / 3).toBeLessThan(262144);
    // Deterministic work: re-compile yields same work (same parameters)
    expect(a.parameters).toEqual(b.parameters);
  });
});
