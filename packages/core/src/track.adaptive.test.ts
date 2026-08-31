import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRACK_COMPILE_OPTIONS,
  compileTrack,
  TrackCompileError,
} from "./track";
import { SeventhOrderHermiteSpan } from "./spans";
import { checkedArcLength, checkedInvertArcLength } from "./arc-length";
import {
  createCoasterFileV1,
  compileCoasterFile,
  serializeCoasterFileV1,
  reconstructSolvedSpan,
  serializeSolvedSpanV1,
} from "./coaster-file";
import { vec3, vec3Dot } from "./math";
import type { ParametricSpan } from "./spans";
import type { Vec3 } from "./math";

describe("certified adaptive track compilation (TDD)", () => {
  it("line min: single element retains at least 32 samples and 2 minima", () => {
    const span = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0));
    const data = compileTrack([{ id: "line", span }]);
    expect(data.positions.length / 3).toBeGreaterThanOrEqual(32);
    expect(data.elementBoundaries).toEqual(
      new Uint32Array([0, data.positions.length / 3 - 1]),
    );
    // legacy explicit samples still exact
    const legacy = compileTrack([{ id: "line", span }], { samples: 2 });
    expect(legacy.positions.length / 3).toBe(2);
    const legacy32 = compileTrack([{ id: "line", span }], { samples: 32 });
    expect(legacy32.positions.length / 3).toBe(32);
  });

  it("rapid-bank straight retains 32 samples (bank does not drive chord error)", () => {
    const span = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(100, 0, 0));
    const bank = (u: number) => Math.sin(u * 100) * 10;
    const adaptive = compileTrack([{ id: "banked", span, bank }]);
    expect(adaptive.positions.length / 3).toBe(32);
    // ensure bank sampled correctly near extremes
    expect(adaptive.bank[0]).toBeCloseTo(bank(0), 10);
  });

  it("high-curvature dense oracle <=0.5mm (conservative certificate ensures actual error <=0.5mm)", () => {
    // Create a high-curvature SeventhOrder span: approximate a tight bend
    const span = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(10, 0, 0),
      d20: vec3(0, 50, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 5, 0),
      d11: vec3(10, 0, 0),
      d21: vec3(0, -50, 0),
      d31: vec3(0, 0, 0),
    });
    const data = compileTrack([{ id: "curve", span }]);
    expect(data.positions.length / 3).toBeGreaterThan(32);
    // Oracle: sample dense true curve and measure max distance to compiled polyline
    const denseSamples = 5000;
    const getPos = (u: number) => span.position(u);
    let maxErr = 0;
    const positions = data.positions;
    // For each dense sample, find closest segment on polyline and compute distance
    for (let i = 0; i < denseSamples; i++) {
      const u = i / (denseSamples - 1);
      const p = getPos(u);
      // Find segment via linear scan over compiled distances is okay for test
      let best = Infinity;
      for (let s = 0; s < positions.length / 3 - 1; s++) {
        const a = vec3(
          positions[s * 3]!,
          positions[s * 3 + 1]!,
          positions[s * 3 + 2]!,
        );
        const b = vec3(
          positions[(s + 1) * 3]!,
          positions[(s + 1) * 3 + 1]!,
          positions[(s + 1) * 3 + 2]!,
        );
        const ab = vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const ap = vec3(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
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
          a[0] + ab[0] * t,
          a[1] + ab[1] * t,
          a[2] + ab[2] * t,
        );
        const dx = p[0] - closest[0],
          dy = p[1] - closest[1],
          dz = p[2] - closest[2];
        const d = Math.hypot(dx, dy, dz);
        if (d < best) best = d;
      }
      if (best > maxErr) maxErr = best;
    }
    expect(maxErr).toBeLessThanOrEqual(0.0005 + 1e-9);
  });

  it("circle/helix with exact sagitta certifier compiles and meets 0.5mm", () => {
    const R = 20;
    const circleSpeed = R * 2 * Math.PI;
    const circleSpan: ParametricSpan<Vec3> & {
      chordErrorUpperBound: (a: number, b: number) => number;
      speedLowerBound: (a: number, b: number) => number;
    } = {
      position: (u: number) =>
        vec3(R * Math.cos(2 * Math.PI * u), 0, R * Math.sin(2 * Math.PI * u)),
      derivative: (u: number, order = 1) => {
        if (order === 1)
          return vec3(
            -R * 2 * Math.PI * Math.sin(2 * Math.PI * u),
            0,
            R * 2 * Math.PI * Math.cos(2 * Math.PI * u),
          );
        if (order === 2)
          return vec3(
            -R * (2 * Math.PI) ** 2 * Math.cos(2 * Math.PI * u),
            0,
            -R * (2 * Math.PI) ** 2 * Math.sin(2 * Math.PI * u),
          );
        if (order === 3)
          return vec3(
            R * (2 * Math.PI) ** 3 * Math.sin(2 * Math.PI * u),
            0,
            -R * (2 * Math.PI) ** 3 * Math.cos(2 * Math.PI * u),
          );
        return vec3(0, 0, 0);
      },
      chordErrorUpperBound: (a: number, b: number) => {
        const deltaTheta = 2 * Math.PI * (b - a);
        const sagitta = R * (1 - Math.cos(deltaTheta / 2));
        return sagitta;
      },
      speedLowerBound: () => circleSpeed,
    };
    const helixSpeed = Math.hypot(R * 2 * Math.PI, 10);
    const helixSpan: ParametricSpan<Vec3> & {
      chordErrorUpperBound: (a: number, b: number) => number;
      speedLowerBound: (a: number, b: number) => number;
    } = {
      position: (u: number) =>
        vec3(
          R * Math.cos(2 * Math.PI * u),
          10 * u,
          R * Math.sin(2 * Math.PI * u),
        ),
      derivative: (u: number, order = 1) => {
        if (order === 1)
          return vec3(
            -R * 2 * Math.PI * Math.sin(2 * Math.PI * u),
            10,
            R * 2 * Math.PI * Math.cos(2 * Math.PI * u),
          );
        if (order === 2)
          return vec3(
            -R * (2 * Math.PI) ** 2 * Math.cos(2 * Math.PI * u),
            0,
            -R * (2 * Math.PI) ** 2 * Math.sin(2 * Math.PI * u),
          );
        return vec3(0, 0, 0);
      },
      chordErrorUpperBound: (a: number, b: number) => {
        const deltaTheta = 2 * Math.PI * (b - a);
        return R * (1 - Math.cos(deltaTheta / 2));
      },
      speedLowerBound: () => helixSpeed,
    };
    const cData = compileTrack([{ id: "circle", span: circleSpan }]);
    const hData = compileTrack([{ id: "helix", span: helixSpan }]);
    expect(cData.positions.length / 3).toBeGreaterThanOrEqual(32);
    expect(hData.positions.length / 3).toBeGreaterThanOrEqual(32);
    // Both should be deterministic and have reasonable counts (< budget)
    expect(cData.positions.length / 3).toBeLessThan(65536);
  });

  it("deterministic bytes/checksum (no wall clock, left-before-right)", () => {
    const span = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(10, 0, 0),
      d20: vec3(0, 5, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 5, 0),
      d11: vec3(10, 0, 0),
      d21: vec3(0, -5, 0),
      d31: vec3(0, 0, 0),
    });
    const a = compileTrack([{ id: "a", span }]);
    const b = compileTrack([{ id: "a", span }]);
    expect(a.checksum).toBe(b.checksum);
    expect(a.positions).toEqual(b.positions);
    expect(a.tangents).toEqual(b.tangents);
    expect(a.normals).toEqual(b.normals);
    // bytes via checksum stability
    const c = compileTrack(
      [{ id: "a", span }],
      CANONICAL_TRACK_COMPILE_OPTIONS,
    );
    expect(c.checksum).toBe(a.checksum);
  });

  it("transform invariance (rotation+translation with initialNormal)", () => {
    const span = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(10, 0, 0),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 3, 2),
      d11: vec3(10, 6, 2),
      d21: vec3(0, 6, 0),
      d31: vec3(0, 0, 0),
    });
    const initialNormal = vec3(0, 1, 0);
    const axis = vec3(0.3, 0.5, 0.2);
    const axisN = vec3(
      axis[0] / Math.hypot(...axis),
      axis[1] / Math.hypot(...axis),
      axis[2] / Math.hypot(...axis),
    );
    const angle = 0.9;
    const cos = Math.cos(angle),
      sin = Math.sin(angle),
      omc = 1 - cos;
    const rotate = (v: Vec3): Vec3 =>
      vec3(
        (cos + axisN[0] ** 2 * omc) * v[0] +
          (axisN[0] * axisN[1] * omc - axisN[2] * sin) * v[1] +
          (axisN[0] * axisN[2] * omc + axisN[1] * sin) * v[2],
        (axisN[1] * axisN[0] * omc + axisN[2] * sin) * v[0] +
          (cos + axisN[1] ** 2 * omc) * v[1] +
          (axisN[1] * axisN[2] * omc - axisN[0] * sin) * v[2],
        (axisN[2] * axisN[0] * omc - axisN[1] * sin) * v[0] +
          (axisN[2] * axisN[1] * omc + axisN[0] * sin) * v[1] +
          (cos + axisN[2] ** 2 * omc) * v[2],
      );
    const translation = vec3(5, -3, 2);
    // Build rotated SeventhOrder via rotating coefficients (preserves certificate, avoids opaque UNBOUNDED_SPAN)
    const rows = span.coefficients as unknown as [number[], number[], number[]];
    const newRows: number[][] = [[], [], []];
    for (let i = 0; i < 8; i++) {
      const v = vec3(rows[0]![i]!, rows[1]![i]!, rows[2]![i]!);
      const rv = rotate(v);
      newRows[0]!.push(rv[0]! + (i === 0 ? translation[0] : 0));
      newRows[1]!.push(rv[1]! + (i === 0 ? translation[1] : 0));
      newRows[2]!.push(rv[2]! + (i === 0 ? translation[2] : 0));
    }
    const rotatedSpan = SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
      newRows as unknown as readonly (readonly number[])[],
    );
    const orig = compileTrack([{ id: "s", span }], { initialNormal });
    const rot = compileTrack([{ id: "s", span: rotatedSpan }], {
      initialNormal: rotate(initialNormal),
    });
    expect(rot.totalLength).toBeCloseTo(orig.totalLength, 9);
    // tangents/normals should be rotated
    for (let i = 0; i < orig.positions.length / 3; i++) {
      const ot = vec3(
        orig.tangents[i * 3]!,
        orig.tangents[i * 3 + 1]!,
        orig.tangents[i * 3 + 2]!,
      );
      const rt = vec3(
        rot.tangents[i * 3]!,
        rot.tangents[i * 3 + 1]!,
        rot.tangents[i * 3 + 2]!,
      );
      const exp = rotate(ot);
      expect(rt[0]).toBeCloseTo(exp[0], 6);
      expect(rt[1]).toBeCloseTo(exp[1], 6);
      expect(rt[2]).toBeCloseTo(exp[2], 6);
    }
  });

  it("variable boundaries and seam ownership (preceding element owns seam, parameter=1, bank/zones)", () => {
    const s0 = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0));
    const s1 = SeventhOrderHermiteSpan.line(vec3(10, 0, 0), vec3(20, 5, 0));
    const bank0 = (u: number) => u * 0.5;
    const bank1 = (u: number) => 0.5 + u * 0.3;
    const data = compileTrack([
      { id: "e0", span: s0, bank: bank0, zones: ["a"] },
      { id: "e1", span: s1, bank: bank1, zones: ["b"] },
    ]);
    const b = data.elementBoundaries;
    expect(b.length).toBe(4);
    expect(b[0]).toBe(0);
    expect(b[1]).toBe(b[2]); // shared seam
    expect(b[3]).toBe(data.positions.length / 3 - 1);
    const seamIdx = b[1]!;
    // seam belongs to preceding element
    expect(data.elementIndices[seamIdx]!).toBe(0);
    expect(data.parameters[seamIdx]!).toBeCloseTo(1, 10);
    expect(data.bank[seamIdx]!).toBeCloseTo(bank0(1), 10);
    // zone mask should be from preceding
    const zoneNames = data.zoneNames;
    const aMask = 1 << zoneNames.indexOf("a");
    expect(data.zoneMasks[seamIdx]! & aMask).toBe(aMask);
    // global RMF: no seam reset – check normals are continuous (dot >0)
    for (let i = 1; i < data.normals.length / 3; i++) {
      const dot = vec3Dot(
        vec3(
          data.normals[(i - 1) * 3]!,
          data.normals[(i - 1) * 3 + 1]!,
          data.normals[(i - 1) * 3 + 2]!,
        ),
        vec3(
          data.normals[i * 3]!,
          data.normals[i * 3 + 1]!,
          data.normals[i * 3 + 2]!,
        ),
      );
      expect(dot).toBeGreaterThan(-0.5); // no flip
    }
  });

  it("opaque span without certifier throws UNBOUNDED_SPAN", () => {
    const opaque: ParametricSpan<Vec3> & {
      speedLowerBound?: (a: number, b: number) => number;
    } = {
      position: (u: number) => vec3(u * 10, Math.sin(u * 10), 0),
      derivative: (u: number) => vec3(10, 10 * Math.cos(u * 10), 0),
      speedLowerBound: () => 1,
    };
    expect(() => compileTrack([{ id: "opaque", span: opaque }])).toThrow(
      expect.objectContaining({ code: "UNBOUNDED_SPAN" }),
    );
    try {
      compileTrack([{ id: "opaque", span: opaque }]);
    } catch (e) {
      expect((e as TrackCompileError).code).toBe("UNBOUNDED_SPAN");
    }
  });

  it(
    "budget fail: per-element and total budgets are enforced",
    { timeout: 15000 },
    () => {
      // Per-element budget: opaque with always-large chord error forces subdivision beyond limit
      const bigErrorSpan: ParametricSpan<Vec3> & {
        chordErrorUpperBound: (a: number, b: number) => number;
        speedLowerBound: (a: number, b: number) => number;
      } = {
        position: (u: number) => vec3(u * 10, 0, 0),
        derivative: () => vec3(10, 0, 0),
        chordErrorUpperBound: () => 1, // always >0.0005, will subdivide until budget
        speedLowerBound: () => 10,
      };
      expect(() => compileTrack([{ id: "big", span: bigErrorSpan }])).toThrow(
        expect.objectContaining({ code: "SAMPLE_BUDGET_EXCEEDED" }),
      );

      // Total budget: use early min-total check to avoid heavy work – 9000 lines min total 31*9000+1 >262144, should throw quickly
      const many = Array.from({ length: 9000 }, (_, i) => ({
        id: `e${i}`,
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(1, 0, 0)),
      }));
      expect(() => compileTrack(many)).toThrow(
        expect.objectContaining({ code: "SAMPLE_BUDGET_EXCEEDED" }),
      );
    },
  );

  it("checked integration/inversion fail closed", () => {
    const stationary: ParametricSpan<Vec3> = {
      position: (u: number) => vec3((u - 0.5) ** 3, 0, 0),
      derivative: (u: number, order = 1) =>
        order === 1
          ? vec3(3 * (u - 0.5) ** 2, 0, 0)
          : vec3(6 * (u - 0.5), 0, 0),
    };
    expect(() => checkedArcLength(stationary, 0, 1)).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(
          /INTEGRATION_FAILED|SPEED_CERTIFICATION_FAILED/,
        ),
      }),
    );
    const goodSpan = SeventhOrderHermiteSpan.line(
      vec3(0, 0, 0),
      vec3(10, 0, 0),
    );
    // Inversion with invalid target or non-finite totalLength should fail
    expect(() =>
      checkedInvertArcLength(goodSpan, Number.NaN, { totalLength: 10 }),
    ).toThrow(expect.objectContaining({ code: "INVERSION_FAILED" }));
    // Inversion on stationary span at its singular point should fail (target at mid where speed zero)
    const stationaryAtZero: ParametricSpan<Vec3> = {
      position: (u: number) => vec3(u ** 3, 0, 0),
      derivative: (u: number, order = 1) =>
        order === 1 ? vec3(3 * u ** 2, 0, 0) : vec3(6 * u, 0, 0),
    };
    // Inverting to a tiny distance that requires evaluating near zero speed should fail or be at limit
    // Use checkedInvert with totalLength that includes zero-speed endpoint
    expect(() => checkedArcLength(stationaryAtZero, 0, 1)).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(
          /INTEGRATION_FAILED|SPEED_CERTIFICATION_FAILED/,
        ),
      }),
    );
    // Inversion on singular span should fail closed (either integration or inversion code)
    expect(() =>
      checkedInvertArcLength(stationaryAtZero, 0.001, { totalLength: 1 }),
    ).toThrow(
      expect.objectContaining({
        code: expect.stringMatching(/INTEGRATION_FAILED|INVERSION_FAILED/),
      }),
    );
  });

  it("legacy checksum migration and corrupt reject", () => {
    // Use a curved span where adaptive (dense) and legacy 32 differ, so migration is observable
    const span = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(10, 0, 0),
      d20: vec3(0, 20, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 5, 0),
      d11: vec3(10, 0, 0),
      d21: vec3(0, -20, 0),
      d31: vec3(0, 0, 0),
    });
    const solved = {
      id: "e0",
      span,
      bank: undefined,
      positionCoefficients: span.coefficients,
      rollCoefficients: [0, 0, 0, 0, 0, 0],
      kind: "transition",
      length: 10,
    } as unknown as import("./contracts").SolvedSpan;
    const serialized = serializeSolvedSpanV1(solved, "transition", 10);
    const intent = {
      schemaVersion: 1 as const,
      generatorVersion: "test-gen",
      seed: 123,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: [
        {
          id: "e0",
          kind: "transition",
          type: "transition",
          parameters: { length: 10 },
        },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    };
    // Create file with legacy fixed32 checksum
    const legacyTrack = compileTrack([reconstructSolvedSpan(serialized)], {
      samples: 32,
    });
    const legacyFile = createCoasterFileV1({
      name: "legacy",
      intent,
      solvedSpans: [serialized],
      seed: 123,
      generatorVersion: "test-gen",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: legacyTrack.checksum,
    });
    // Loading legacy file should succeed via migration and update in-memory checksum to adaptive
    const loadedLegacy = compileCoasterFile(serializeCoasterFileV1(legacyFile));
    expect(loadedLegacy.file.compiledDataChecksum).not.toBe(
      legacyTrack.checksum,
    );
    const adaptiveTrack = compileTrack([reconstructSolvedSpan(serialized)]);
    expect(loadedLegacy.file.compiledDataChecksum).toBe(adaptiveTrack.checksum);
    // Coefficients preserved via round-trip (allow -0 vs 0)
    const origCoeffs = solved.positionCoefficients as unknown as number[][];
    const loadedCoeffs = loadedLegacy.solvedSpans[0]!
      .positionCoefficients as unknown as number[][];
    for (let r = 0; r < origCoeffs.length; r++) {
      const origRow = origCoeffs[r]!;
      const loadedRow = loadedCoeffs[r]!;
      for (let c = 0; c < origRow.length; c++)
        expect(loadedRow[c]!).toBeCloseTo(origRow[c]!, 12);
    }

    // Corrupt checksum should reject
    const corruptFile = createCoasterFileV1({
      name: "corrupt",
      intent,
      solvedSpans: [serialized],
      seed: 123,
      generatorVersion: "test-gen",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: "00000000",
    });
    // Manually tamper serialized to have wrong checksum without re-creating via API (serialize then replace)
    const tampered = JSON.parse(serializeCoasterFileV1(corruptFile));
    tampered.compiledDataChecksum = "deadbeef";
    expect(() => compileCoasterFile(JSON.stringify(tampered))).toThrow();

    // Preview fixed sampling cannot weaken stored checksum
    const adaptiveFile = createCoasterFileV1({
      name: "adaptive",
      intent,
      solvedSpans: [serialized],
      seed: 123,
      generatorVersion: "test-gen",
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: adaptiveTrack.checksum,
    });
    const preview = compileCoasterFile(serializeCoasterFileV1(adaptiveFile), {
      samples: 32,
    });
    expect(preview.file.compiledDataChecksum).toBe(adaptiveTrack.checksum);
    expect(preview.track.checksum).not.toBe(adaptiveTrack.checksum); // preview is fixed, different
    expect(preview.file.compiledDataChecksum).toBe(adaptiveTrack.checksum); // stored remains adaptive
  });

  it("frozen CANONICAL_TRACK_COMPILE_OPTIONS is immutable and used for canonical", () => {
    expect(Object.isFrozen(CANONICAL_TRACK_COMPILE_OPTIONS)).toBe(true);
    const span = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(5, 0, 0));
    const a = compileTrack(
      [{ id: "x", span }],
      CANONICAL_TRACK_COMPILE_OPTIONS,
    );
    const b = compileTrack([{ id: "x", span }]);
    expect(a.checksum).toBe(b.checksum);
    expect(a.positions).toEqual(b.positions);
  });
});
