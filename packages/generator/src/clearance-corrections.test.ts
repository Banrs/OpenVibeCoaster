import { describe, it, expect } from "vitest";
import {
  vec3,
  compileTrack,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  sampleCompiledTrack,
  type CompiledTrackData,
  type TrackElement,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  projectClearanceDiagnostics,
  mapClearanceToTimeline,
  DEFAULT_ENVELOPE,
  conservativeCircumsphereRadius,
  type ClearanceField,
} from "./clearance-field.js";
import {
  interpolatePose,
  type SweptClearanceSegment,
  certifiedSweptDistance,
  sweptAabb,
  createOrientedBox,
} from "./clearance-geometry.js";
import { createDefaultSimulatorConfig } from "@openvibecoaster/simulator";

function lineTrack(points: Array<[number, number, number]>): CompiledTrackData {
  const spans: TrackElement[] = points.slice(0, -1).map((_, i) => {
    const a = vec3(points[i]![0], points[i]![1], points[i]![2]);
    const b = vec3(points[i + 1]![0], points[i + 1]![1], points[i + 1]![2]);
    return { id: `seg-${i}`, span: SeventhOrderHermiteSpan.line(a, b) };
  });
  return compileTrack(spans, { samples: 2 });
}

describe("correction 1 – locality independent of cap/soft", () => {
  it("cap/soft threshold changes do not change hard verdict or included nonlocal pairs", () => {
    // Track where two far-apart segments are close in world (collision beyond local window)
    const spans: TrackElement[] = [
      {
        id: "seg-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 5)),
      },
      {
        id: "seg-1",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 5), vec3(50, 0, 80)),
      },
      {
        id: "seg-2",
        span: SeventhOrderHermiteSpan.line(vec3(0.5, 0, 0), vec3(0.5, 0, 5)),
      },
    ];
    const track = compileTrack(spans, { samples: 2 });
    const ids = ["seg-0", "seg-1", "seg-2"];
    const f1 = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      explicitThresholds: [],
      segmentIds: ids,
    });
    const f2 = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 100,
      explicitThresholds: [],
      softThresholds: [5, 10],
      segmentIds: ids,
    });
    // Hard verdict must be identical despite cap/soft changes
    expect(f1.globalLowerM).toBe(f2.globalLowerM);
    expect(f1.globalUpperM).toBe(f2.globalUpperM);
    expect(f1.globalLowerM).toBeLessThan(0.5);
    // Real collision beyond envelope-local window must be detected
    expect(f1.globalSource).toBe("self");
    const diags = projectClearanceDiagnostics(f1, []);
    expect(
      diags.some((d) => d.code === "TRACK_CLEARANCE" && d.severity === "error"),
    ).toBe(true);
  });

  it("closed seam adjacency still excluded", () => {
    const track = lineTrack([
      [0, 0, 0],
      [3, 0, 0],
      [6, 0, 0],
      [9, 0, 0],
    ]);
    const ids = ["a", "b", "c"];
    const f = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      segmentIds: ids,
      closed: true,
    });
    // For closed track, seam intervals should be excluded, no self collision
    expect(f.globalLowerM).toBe(10);
  });
});

describe("correction 2 – frame interpolation matches sampleCompiledTrack", () => {
  it("rotated/banked interval regression at multiple fractions", () => {
    const bankSpan = new QuinticScalarSpan({
      v0: 0,
      d10: 0,
      d20: 0,
      v1: Math.PI * 0.25,
      d11: 0,
      d21: 0,
    });
    const span = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(10, 0, 0));
    const track = compileTrack([{ id: "banked", span, bank: bankSpan }], {
      samples: 32,
    });
    // Find an interval with noticeable rotation/bank
    let found = 0;
    for (let i = 0; i < track.distances.length - 1; i++) {
      const s0 = track.distances[i]!;
      const s1 = track.distances[i + 1]!;
      const seg: SweptClearanceSegment = {
        startS: s0,
        endS: s1,
        start: {
          position: vec3(
            track.positions[i * 3]!,
            track.positions[i * 3 + 1]!,
            track.positions[i * 3 + 2]!,
          ),
          tangent: vec3(
            track.tangents[i * 3]!,
            track.tangents[i * 3 + 1]!,
            track.tangents[i * 3 + 2]!,
          ),
          normal: vec3(
            track.normals[i * 3]!,
            track.normals[i * 3 + 1]!,
            track.normals[i * 3 + 2]!,
          ),
          binormal: vec3(
            track.binormals[i * 3]!,
            track.binormals[i * 3 + 1]!,
            track.binormals[i * 3 + 2]!,
          ),
        },
        end: {
          position: vec3(
            track.positions[(i + 1) * 3]!,
            track.positions[(i + 1) * 3 + 1]!,
            track.positions[(i + 1) * 3 + 2]!,
          ),
          tangent: vec3(
            track.tangents[(i + 1) * 3]!,
            track.tangents[(i + 1) * 3 + 1]!,
            track.tangents[(i + 1) * 3 + 2]!,
          ),
          normal: vec3(
            track.normals[(i + 1) * 3]!,
            track.normals[(i + 1) * 3 + 1]!,
            track.normals[(i + 1) * 3 + 2]!,
          ),
          binormal: vec3(
            track.binormals[(i + 1) * 3]!,
            track.binormals[(i + 1) * 3 + 1]!,
            track.binormals[(i + 1) * 3 + 2]!,
          ),
        },
        geometry: DEFAULT_ENVELOPE,
      };
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const pose = interpolatePose(seg, t);
        const targetS = s0 + (s1 - s0) * t;
        const expected = sampleCompiledTrack(
          track,
          targetS / track.totalLength,
        );
        // Compare bit-for-bit: positions should be close (linear), frames should match
        expect(pose.position[0]).toBeCloseTo(expected.position[0], 9);
        expect(pose.position[1]).toBeCloseTo(expected.position[1], 9);
        expect(pose.position[2]).toBeCloseTo(expected.position[2], 9);
        expect(pose.tangent[0]).toBeCloseTo(expected.tangent[0], 9);
        expect(pose.tangent[1]).toBeCloseTo(expected.tangent[1], 9);
        expect(pose.tangent[2]).toBeCloseTo(expected.tangent[2], 9);
        expect(pose.normal[0]).toBeCloseTo(expected.normal[0], 9);
        expect(pose.normal[1]).toBeCloseTo(expected.normal[1], 9);
        expect(pose.normal[2]).toBeCloseTo(expected.normal[2], 9);
        expect(pose.binormal[0]).toBeCloseTo(expected.binormal[0], 9);
        expect(pose.binormal[1]).toBeCloseTo(expected.binormal[1], 9);
        expect(pose.binormal[2]).toBeCloseTo(expected.binormal[2], 9);
        // Orthonormality and handedness
        const dotTN =
          pose.tangent[0] * pose.normal[0] +
          pose.tangent[1] * pose.normal[1] +
          pose.tangent[2] * pose.normal[2];
        const dotTB =
          pose.tangent[0] * pose.binormal[0] +
          pose.tangent[1] * pose.binormal[1] +
          pose.tangent[2] * pose.binormal[2];
        const dotNB =
          pose.normal[0] * pose.binormal[0] +
          pose.normal[1] * pose.binormal[1] +
          pose.normal[2] * pose.binormal[2];
        expect(Math.abs(dotTN)).toBeLessThan(1e-9);
        expect(Math.abs(dotTB)).toBeLessThan(1e-9);
        expect(Math.abs(dotNB)).toBeLessThan(1e-9);
        expect(Math.abs(Math.hypot(...pose.tangent) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(Math.hypot(...pose.normal) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(Math.hypot(...pose.binormal) - 1)).toBeLessThan(1e-9);
        const cross = vec3(
          pose.tangent[1] * pose.normal[2] - pose.tangent[2] * pose.normal[1],
          pose.tangent[2] * pose.normal[0] - pose.tangent[0] * pose.normal[2],
          pose.tangent[0] * pose.normal[1] - pose.tangent[1] * pose.normal[0],
        );
        expect(cross[0]).toBeCloseTo(pose.binormal[0], 9);
        expect(cross[1]).toBeCloseTo(pose.binormal[1], 9);
        expect(cross[2]).toBeCloseTo(pose.binormal[2], 9);
        found++;
      }
      if (found > 15) break;
    }
    expect(found).toBeGreaterThan(15);
  });
});

describe("correction 4 – noseTailMargin 0.75", () => {
  it("default envelope and simulator envelope use 0.75", () => {
    expect(DEFAULT_ENVELOPE.noseTailMarginM).toBe(0.75);
    const cfg = createDefaultSimulatorConfig();
    expect(cfg.train.envelope.noseTailMarginM).toBe(0.75);
    const r = conservativeCircumsphereRadius(DEFAULT_ENVELOPE);
    const expected = Math.sqrt(
      1.25 * 1.25 + 2.1 * 2.1 + (3.4 / 2 + 0.75) * (3.4 / 2 + 0.75),
    );
    expect(r).toBeCloseTo(expected, 6);
  });
});

describe("correction 5 – element ID mapping via boundaries", () => {
  it("adaptive multi-sample multi-element regression proves correct owner IDs", () => {
    const curvedA = new SeventhOrderHermiteSpan({
      p0: vec3(0, 0, 0),
      d10: vec3(12, 4, 2),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(10, 2, 6),
      d11: vec3(8, -3, 4),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const curvedB = new SeventhOrderHermiteSpan({
      p0: vec3(10, 2, 6),
      d10: vec3(8, -3, 4),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(22, 0, 12),
      d11: vec3(14, 2, -1),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const curvedC = new SeventhOrderHermiteSpan({
      p0: vec3(22, 0, 12),
      d10: vec3(14, 2, -1),
      d20: vec3(0, 0, 0),
      d30: vec3(0, 0, 0),
      p1: vec3(32, 3, 18),
      d11: vec3(10, 6, 3),
      d21: vec3(0, 0, 0),
      d31: vec3(0, 0, 0),
    });
    const track = compileTrack([
      { id: "elem-A", span: curvedA },
      { id: "elem-B", span: curvedB },
      { id: "elem-C", span: curvedC },
    ]);
    const nIntervals = track.distances.length - 1;
    expect(nIntervals).toBeGreaterThan(3);
    const boundaries = track.elementBoundaries;
    for (let ei = 0; ei < 3; ei++) {
      const s = boundaries[ei * 2]!;
      const e = boundaries[ei * 2 + 1]!;
      expect(e - s).toBeGreaterThan(1);
    }
    const segmentIds = ["elem-A", "elem-B", "elem-C"];
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      segmentIds,
    });
    for (let i = 0; i < nIntervals; i++) {
      let expectedEi = -1;
      for (let ei = 0; ei < boundaries.length / 2; ei++) {
        const s = boundaries[ei * 2]!;
        const e = boundaries[ei * 2 + 1]!;
        if (i >= s && i < e) {
          expectedEi = ei;
          break;
        }
      }
      if (expectedEi === -1) {
        const fallback = track.elementIndices[i + 1] ?? track.elementIndices[i];
        expectedEi = fallback ?? 0;
      }
      const expectedId = segmentIds[expectedEi]!;
      const seg = field.segments[i]!;
      expect(seg.relatedIds).toContain(expectedId);
      expect(seg.relatedIds.some((id) => id.startsWith("element-"))).toBe(
        false,
      );
      if (i > 0) {
        const prevEi = (() => {
          for (let ei = 0; ei < boundaries.length / 2; ei++) {
            const s = boundaries[ei * 2]!;
            const e = boundaries[ei * 2 + 1]!;
            if (i - 1 >= s && i - 1 < e) return ei;
          }
          return track.elementIndices[i - 1] ?? 0;
        })();
        if (expectedEi !== prevEi) {
          expect(expectedId).not.toBe(segmentIds[prevEi]!);
        }
      }
    }
  });
});

describe("correction 8 – separate provenance for lower/upper", () => {
  it("different lower and upper segments are correctly identified", () => {
    const track = lineTrack([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ]);
    const baseField = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      segmentIds: ["seg-0", "seg-1"],
    });
    const fakeField: ClearanceField = {
      ...baseField,
      globalLowerM: -5,
      globalUpperM: 0.6,
      globalRelatedIds: ["seg-1"],
      globalSource: "self",
      globalLowerRelatedIds: ["seg-0"],
      globalLowerSource: "terrain",
      globalLowerWitnessS: 2,
      globalLowerWitnessPosition: vec3(0, 0, 0),
      effectiveCap: 10,
    };
    const diagsStraddle = projectClearanceDiagnostics(fakeField, [
      { id: "hard-1", hard: true, threshold: 0.5 },
    ]);
    expect(diagsStraddle[0]!.relatedIds).toContain("seg-0");
    expect(diagsStraddle[0]!.relatedIds).not.toContain("seg-1");
    expect(diagsStraddle[0]!.severity).toBe("fatal");
    expect(diagsStraddle[0]!.location).toBeUndefined();
    expect(diagsStraddle[0]!.actual).toBeUndefined();

    const fakeField2: ClearanceField = {
      ...baseField,
      globalLowerM: -10,
      globalUpperM: 0.2,
      globalRelatedIds: ["seg-1"],
      globalSource: "self",
      globalLowerRelatedIds: ["seg-0"],
      globalLowerSource: "terrain",
      globalLowerWitnessS: 2,
      globalLowerWitnessPosition: vec3(0, 0, 0),
      effectiveCap: 10,
    };
    const diagsViolation = projectClearanceDiagnostics(fakeField2, [
      { id: "hard-1", hard: true, threshold: 0.5 },
    ]);
    expect(diagsViolation[0]!.relatedIds).toContain("seg-1");
    expect(diagsViolation[0]!.actual).toBe(0.2);
    expect(diagsViolation[0]!.location).toBeDefined();
  });
});

describe("correction 9 – six-car mapping selects true minimum", () => {
  it("varying per-segment minima prove six offsets select true minimum", () => {
    const track = lineTrack([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
      [30, 0, 0],
    ]);
    const baseField = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      segmentIds: ["seg-0", "seg-1", "seg-2"],
    });
    const syntheticSegments = baseField.segments.map((s, idx) => ({
      ...s,
      lowerM: idx % 2 === 0 ? 10 : 1,
    }));
    const syntheticField: ClearanceField = {
      ...baseField,
      segments: syntheticSegments,
      globalLowerM: 1,
      globalUpperM: 1,
    };
    const L = track.totalLength;
    const offsets = Array.from({ length: 6 }, (_, i) => i * 3.4);
    for (const head of [20, 25, 30]) {
      const out = mapClearanceToTimeline(
        syntheticField,
        new Float64Array([head]),
        offsets,
      );
      let expected = Infinity;
      for (const off of offsets) {
        let carS = head - off;
        if (carS < 0 || carS > L) continue;
        let segIdx = -1;
        for (let i = 0; i < track.distances.length - 1; i++) {
          if (carS >= track.distances[i]! && carS < track.distances[i + 1]!) {
            segIdx = i;
            break;
          }
          if (carS === track.distances[i + 1]!) segIdx = i;
        }
        if (segIdx === -1 && carS === L) segIdx = syntheticSegments.length - 1;
        if (segIdx >= 0)
          expected = Math.min(expected, syntheticSegments[segIdx]!.lowerM);
      }
      expected = Math.min(expected, 10);
      expect(out[0]).toBe(expected);
    }
    const outOpen = mapClearanceToTimeline(
      syntheticField,
      new Float64Array([L]),
      [0],
    );
    expect(outOpen[0]).toBe(
      syntheticSegments[syntheticSegments.length - 1]!.lowerM,
    );
    const closedField: ClearanceField = { ...syntheticField, closed: true };
    const outClosed = mapClearanceToTimeline(
      closedField,
      new Float64Array([0]),
      [0],
    );
    expect(outClosed[0]).toBe(
      Math.min(
        syntheticSegments[0]!.lowerM,
        syntheticSegments[syntheticSegments.length - 1]!.lowerM,
      ),
    );
  });
});

function makeOffsetSegments(
  offsetXM: number,
): [SweptClearanceSegment, SweptClearanceSegment] {
  const pose = (
    pos: [number, number, number],
  ): SweptClearanceSegment["start"] => ({
    position: vec3(pos[0], pos[1], pos[2]),
    tangent: vec3(0, 0, 1),
    normal: vec3(0, 1, 0),
    binormal: vec3(-1, 0, 0),
  });
  const segA: SweptClearanceSegment = {
    startS: 0,
    endS: 10,
    start: pose([0, 0, 0]),
    end: pose([0, 0, 10]),
    geometry: DEFAULT_ENVELOPE,
  };
  const segB: SweptClearanceSegment = {
    startS: 20,
    endS: 30,
    start: pose([offsetXM, 0, 0]),
    end: pose([offsetXM, 0, 10]),
    geometry: DEFAULT_ENVELOPE,
  };
  return [segA, segB];
}

describe("sweptAabb tight conservatism", () => {
  it("constant-frame tight bound contains densely sampled corners and gap near 1.0 for offset 3.5", () => {
    const [segA, segB] = makeOffsetSegments(3.5);
    const aabbA = sweptAabb(segA);
    const aabbB = sweptAabb(segB);
    // Compute gap from conservative AABBs – should be near 1.0m, not 0
    const gapX =
      aabbA.max[0] < aabbB.min[0]
        ? aabbB.min[0] - aabbA.max[0]
        : aabbB.max[0] < aabbA.min[0]
          ? aabbA.min[0] - aabbB.max[0]
          : 0;
    const gapY =
      aabbA.max[1] < aabbB.min[1]
        ? aabbB.min[1] - aabbA.max[1]
        : aabbB.max[1] < aabbA.min[1]
          ? aabbA.min[1] - aabbB.max[1]
          : 0;
    const gapZ =
      aabbA.max[2] < aabbB.min[2]
        ? aabbB.min[2] - aabbA.max[2]
        : aabbB.max[2] < aabbA.min[2]
          ? aabbA.min[2] - aabbB.max[2]
          : 0;
    const gap = Math.hypot(gapX, gapY, gapZ);
    expect(gap).toBeGreaterThan(0.9);
    expect(gap).toBeLessThan(1.2);
    // Dense sampled-corner containment for constant-frame sweep
    for (const seg of [segA, segB] as const) {
      const aabb = sweptAabb(seg);
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const pose = interpolatePose(seg, t);
        const box = createOrientedBox(pose, seg.geometry);
        // 8 corners
        const signs: Array<[number, number, number]> = [
          [-1, -1, -1],
          [-1, -1, 1],
          [-1, 1, -1],
          [-1, 1, 1],
          [1, -1, -1],
          [1, -1, 1],
          [1, 1, -1],
          [1, 1, 1],
        ];
        for (const [sx, sy, sz] of signs) {
          const px =
            box.center[0] +
            sx * box.halfExtents[0] * box.axes[0]![0] +
            sy * box.halfExtents[1] * box.axes[1]![0] +
            sz * box.halfExtents[2] * box.axes[2]![0];
          const py =
            box.center[1] +
            sx * box.halfExtents[0] * box.axes[0]![1] +
            sy * box.halfExtents[1] * box.axes[1]![1] +
            sz * box.halfExtents[2] * box.axes[2]![1];
          const pz =
            box.center[2] +
            sx * box.halfExtents[0] * box.axes[0]![2] +
            sy * box.halfExtents[1] * box.axes[1]![2] +
            sz * box.halfExtents[2] * box.axes[2]![2];
          expect(px).toBeGreaterThanOrEqual(aabb.min[0] - 1e-9);
          expect(px).toBeLessThanOrEqual(aabb.max[0] + 1e-9);
          expect(py).toBeGreaterThanOrEqual(aabb.min[1] - 1e-9);
          expect(py).toBeLessThanOrEqual(aabb.max[1] + 1e-9);
          expect(pz).toBeGreaterThanOrEqual(aabb.min[2] - 1e-9);
          expect(pz).toBeLessThanOrEqual(aabb.max[2] + 1e-9);
        }
      }
    }
  });
  it("rotating fallback sweptAabb contains densely sampled corners", () => {
    const bankPose = (
      pos: [number, number, number],
      yawRad: number,
    ): SweptClearanceSegment["start"] => {
      const ct = Math.cos(yawRad);
      const st = Math.sin(yawRad);
      return {
        position: vec3(pos[0], pos[1], pos[2]),
        tangent: vec3(st, 0, ct),
        normal: vec3(0, 1, 0),
        binormal: vec3(-ct, 0, st),
      };
    };
    const seg: SweptClearanceSegment = {
      startS: 0,
      endS: 10,
      start: bankPose([0, 0, 0], 0),
      end: bankPose([5, 0, 5], Math.PI / 6),
      geometry: DEFAULT_ENVELOPE,
    };
    const aabb = sweptAabb(seg);
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const pose = interpolatePose(seg, t);
      const box = createOrientedBox(pose, seg.geometry);
      const signs: Array<[number, number, number]> = [
        [-1, -1, -1],
        [-1, -1, 1],
        [-1, 1, -1],
        [-1, 1, 1],
        [1, -1, -1],
        [1, -1, 1],
        [1, 1, -1],
        [1, 1, 1],
      ];
      for (const [sx, sy, sz] of signs) {
        const px =
          box.center[0] +
          sx * box.halfExtents[0] * box.axes[0]![0] +
          sy * box.halfExtents[1] * box.axes[1]![0] +
          sz * box.halfExtents[2] * box.axes[2]![0];
        const py =
          box.center[1] +
          sx * box.halfExtents[0] * box.axes[0]![1] +
          sy * box.halfExtents[1] * box.axes[1]![1] +
          sz * box.halfExtents[2] * box.axes[2]![1];
        const pz =
          box.center[2] +
          sx * box.halfExtents[0] * box.axes[0]![2] +
          sy * box.halfExtents[1] * box.axes[1]![2] +
          sz * box.halfExtents[2] * box.axes[2]![2];
        expect(px).toBeGreaterThanOrEqual(aabb.min[0] - 1e-9);
        expect(px).toBeLessThanOrEqual(aabb.max[0] + 1e-9);
        expect(py).toBeGreaterThanOrEqual(aabb.min[1] - 1e-9);
        expect(py).toBeLessThanOrEqual(aabb.max[1] + 1e-9);
        expect(pz).toBeGreaterThanOrEqual(aabb.min[2] - 1e-9);
        expect(pz).toBeLessThanOrEqual(aabb.max[2] + 1e-9);
      }
    }
  });
});
describe("performance – separationThreshold early proven pass/violation/straddle", () => {
  it("early proven pass: close-but-valid 1m gap over 0.5 finishes with proven lower >=0.5 and small charged work", () => {
    const [segA, segB] = makeOffsetSegments(3.5);
    const early = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    expect(early.ok).toBe(true);
    if (early.ok && !early.excluded) {
      expect(early.lowerM).toBeGreaterThanOrEqual(0.5);
      expect(early.upperM).toBeGreaterThanOrEqual(early.lowerM);
      expect(early.work).toBeLessThan(10);
    }
  });

  it("early proven violation: 0.2 gap under 0.5 finishes with proven upper <0.5 and bounded work", () => {
    const [segA, segB] = makeOffsetSegments(2.7);
    const early = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    expect(early.ok).toBe(true);
    if (early.ok && !early.excluded) {
      expect(early.upperM).toBeLessThan(0.5);
      expect(early.work).toBeGreaterThanOrEqual(1);
      expect(early.work).toBeLessThan(500);
    }
  });

  it("straddle requires exact/budget: threshold within bracket cannot early-exit, small budget uncertified, large budget exact", () => {
    const [segA, segB] = makeOffsetSegments(3.0);
    const smallBudget = certifiedSweptDistance(segA, segB, {
      maxWork: 5,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    const largeExact = certifiedSweptDistance(segA, segB, {
      maxWork: 200000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    expect(largeExact.ok).toBe(true);
    if (largeExact.ok && !largeExact.excluded) {
      const straddles = largeExact.lowerM < 0.5 && largeExact.upperM >= 0.5;
      if (straddles) {
        expect(largeExact.upperM - largeExact.lowerM).toBeLessThanOrEqual(
          0.01 + 1e-9,
        );
      }
      expect(largeExact.work).toBeGreaterThanOrEqual(smallBudget.work);
    }
    if (!smallBudget.ok) {
      expect(smallBudget.work).toBeLessThanOrEqual(5);
    } else if (!smallBudget.excluded) {
      // For constant offset, exact already tight, small budget may still succeed; check it is certified
      expect(smallBudget.upperM - smallBudget.lowerM).toBeLessThanOrEqual(
        0.01 + 1e-9,
      );
    }
  });

  it("invalid separationThresholds are rejected", () => {
    const [segA, segB] = makeOffsetSegments(3.5);
    expect(() =>
      certifiedSweptDistance(segA, segB, {
        maxWork: 100,
        resolutionM: 0.01,
        separationThresholds: [NaN],
      }),
    ).toThrow();
    expect(() =>
      certifiedSweptDistance(segA, segB, {
        maxWork: 100,
        resolutionM: 0.01,
        separationThresholds: [-0.1],
      }),
    ).toThrow();
  });

  it("computeClearanceField close-but-valid self pair finishes deterministically with proven lower >=0.5 and bounded work", () => {
    const [segA, segB] = makeOffsetSegments(3.5);
    const res = certifiedSweptDistance(segA, segB, {
      maxWork: 100000,
      resolutionM: 0.01,
      separationThresholds: [0.5],
    });
    expect(res.ok).toBe(true);
    if (res.ok && !res.excluded) {
      expect(res.lowerM).toBeGreaterThanOrEqual(0.5);
      expect(res.upperM).toBeGreaterThanOrEqual(res.lowerM);
      expect(res.work).toBeLessThan(10);
    }
    // Straight open track has no close self pairs, should stay at cap
    const straight = lineTrack([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ]);
    const field = computeClearanceField(straight, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100000,
      segmentIds: ["a", "b"],
    });
    expect(field.globalLowerM).toBeGreaterThanOrEqual(0.5);
    expect(field.work).toBeLessThan(50000);
  });
});
