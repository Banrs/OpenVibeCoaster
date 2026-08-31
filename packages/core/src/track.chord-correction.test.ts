import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_MAX_CHORD_ERROR_M,
  _checksumForTest,
  chordErrorUpperBoundSeventhOrder,
  compileTrack,
} from "./track";
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
    // Threshold-adjacent using actual certified bound: find scale where leaf bound crosses 0.0005
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
    const probeA = 15 / 31;
    const probeB = 16 / 31;
    let lo = 0,
      hi = 1;
    while (
      chordErrorUpperBoundSeventhOrder(makeScaled(hi), probeA, probeB) <=
      ADAPTIVE_MAX_CHORD_ERROR_M
    )
      hi *= 2;
    for (let iter = 0; iter < 30; iter++) {
      const mid = (lo + hi) / 2;
      const b = chordErrorUpperBoundSeventhOrder(
        makeScaled(mid),
        probeA,
        probeB,
      );
      if (b <= ADAPTIVE_MAX_CHORD_ERROR_M) lo = mid;
      else hi = mid;
    }
    const scaleBelow = lo * 0.995;
    const scaleAbove = hi * 1.005;
    const below = makeScaled(scaleBelow);
    const above = makeScaled(scaleAbove);
    const boundBelow = chordErrorUpperBoundSeventhOrder(below, probeA, probeB);
    const boundAbove = chordErrorUpperBoundSeventhOrder(above, probeA, probeB);
    expect(boundBelow).toBeLessThanOrEqual(ADAPTIVE_MAX_CHORD_ERROR_M);
    expect(boundAbove).toBeGreaterThan(ADAPTIVE_MAX_CHORD_ERROR_M);
    const belowCount = countFor(below);
    const aboveCount = countFor(above);
    expect(belowCount).toBeGreaterThanOrEqual(32);
    expect(aboveCount).toBeGreaterThan(belowCount);
    // Verify adaptive parameter topology identical after inverse transform within representable precision
    const rotAxis = vec3(0, 0, 1);
    const rotAngle = 0.9;
    const rot2 = makeParabolaGeneral(rotAxis, rotAngle, vec3(5, -3, 2));
    const orig = compileTrack([{ id: "s", span: base }]);
    const invTrans = vec3(-5, 3, -2);
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
      let maxCertified = 0;
      for (let s = 0; s < count - 1; s++) {
        const a = data.parameters[s]!;
        const b = data.parameters[s + 1]!;
        const cert = chordErrorUpperBoundSeventhOrder(span, a, b);
        expect(cert).toBeLessThanOrEqual(ADAPTIVE_MAX_CHORD_ERROR_M + 1e-12);
        if (cert > maxCertified) maxCertified = cert;
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
          expect(d).toBeLessThanOrEqual(cert + 1e-9);
        }
      }
      expect(maxActual).toBeLessThanOrEqual(ADAPTIVE_MAX_CHORD_ERROR_M + 1e-9);
      expect(maxActual).toBeLessThanOrEqual(maxCertified + 1e-9);
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
    expect(
      caught!.evidence.limitSamples ?? caught!.evidence.limit,
    ).toBeDefined();
  });

  it("singular polynomial x' = ((u-.03)(u-.095))^2 must fail checked integration with root interval", () => {
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
      checkedArcLength(singularSpan, 0, 1);
    } catch (e) {
      err = e as TrackCompileError;
    }
    expect(err).toBeDefined();
    expect(err!.code).toBe("SPEED_CERTIFICATION_FAILED");
    const iv = err!.evidence.uInterval!;
    expect(err!.evidence.work).toBeDefined();
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

  it("streaming checksum: byte-for-byte vs legacy and bounded large-array", () => {
    const small = {
      positions: new Float64Array([0, 0, 0, 10, 0, 0]),
      tangents: new Float64Array([1, 0, 0, 1, 0, 0]),
      normals: new Float64Array([0, 1, 0, 0, 1, 0]),
      binormals: new Float64Array([0, 0, 1, 0, 0, 1]),
      distances: new Float64Array([0, 10]),
      curvature: new Float64Array([0, 0]),
      curvatureVector: new Float64Array([0, 0, 0, 0, 0, 0]),
      bank: new Float64Array([0, 0]),
      bankDerivative: new Float64Array([0, 0]),
      zoneMasks: new Uint32Array([0, 0]),
      zoneNames: ["a"] as const,
      elementIndices: new Uint32Array([0, 0]),
      elementBoundaries: new Uint32Array([0, 1]),
      parameters: new Float64Array([0, 1]),
      totalLength: 10,
    };
    const encodeUtf8 = (text: string): Uint8Array => {
      const bytes: number[] = [];
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800)
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code < 0x10000)
          bytes.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        else
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
      }
      return new Uint8Array(bytes);
    };
    const hashText = (text: string): string => {
      const bytes = encodeUtf8(text);
      let hash = 0x811c9dc5;
      for (const b of bytes) hash = Math.imul(hash ^ b, 0x01000193);
      return (hash >>> 0).toString(16).padStart(8, "0");
    };
    const legacy = hashText(
      JSON.stringify({
        positions: Array.from(small.positions),
        tangents: Array.from(small.tangents),
        normals: Array.from(small.normals),
        binormals: Array.from(small.binormals),
        distances: Array.from(small.distances),
        curvature: Array.from(small.curvature),
        curvatureVector: Array.from(small.curvatureVector),
        bank: Array.from(small.bank),
        bankDerivative: Array.from(small.bankDerivative),
        zoneMasks: Array.from(small.zoneMasks),
        zoneNames: [...small.zoneNames],
        elementIndices: Array.from(small.elementIndices),
        elementBoundaries: Array.from(small.elementBoundaries),
        parameters: Array.from(small.parameters),
        totalLength: small.totalLength,
      }),
    );
    expect(_checksumForTest(small as any)).toBe(legacy);
    // Large: 262144 numbers (positions 262144*3 would be huge, test with 262144 total numbers across one array)
    const largePositions = new Float64Array(262144);
    for (let i = 0; i < largePositions.length; i++)
      largePositions[i] = i * 0.001;
    const large: any = {
      positions: largePositions,
      tangents: new Float64Array(262144),
      normals: new Float64Array(262144),
      binormals: new Float64Array(262144),
      distances: new Float64Array(262144 / 3),
      curvature: new Float64Array(262144 / 3),
      curvatureVector: new Float64Array(262144),
      bank: new Float64Array(262144 / 3),
      bankDerivative: new Float64Array(262144 / 3),
      zoneMasks: new Uint32Array(262144 / 3),
      zoneNames: [] as const,
      elementIndices: new Uint32Array(262144 / 3),
      elementBoundaries: new Uint32Array([0, 262144 / 3 - 1]),
      parameters: new Float64Array(262144 / 3),
      totalLength: 100,
    };
    const c1 = _checksumForTest(large);
    const c2 = _checksumForTest(large);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[0-9a-f]{8}$/);
  });
});
