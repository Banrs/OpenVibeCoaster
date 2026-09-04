import { describe, it, expect, vi } from "vitest";

vi.mock("./clearance-field.js", async () => {
  const actual = await vi.importActual<typeof import("./clearance-field.js")>(
    "./clearance-field.js",
  );
  return {
    ...actual,
    computeClearanceField: vi.fn(),
  };
});

import {
  createDesignIntentV1,
  vec3,
  type ConstraintV1,
} from "@openvibecoaster/core";
import { generateCoaster } from "./pipeline.js";
import { computeClearanceField } from "./clearance-field.js";
import type { ClearanceField } from "./clearance-field.js";

function alignedField(
  track: ClearanceField["track"],
  segmentIds: readonly string[] | undefined,
  globalLowerM: number,
  globalUpperM: number,
): ClearanceField {
  const n = track.distances.length - 1;
  const boundaries: Uint32Array = track.elementBoundaries;
  const indices: Uint32Array = track.elementIndices;
  const nElements = boundaries.length / 2;
  const segments = Array.from({ length: n }, (_, i) => {
    let ei = -1;
    for (let e = 0; e < nElements; e++) {
      const s = boundaries[e * 2]!;
      const e1 = boundaries[e * 2 + 1]!;
      if (i >= s && i < e1) {
        ei = e;
        break;
      }
    }
    if (ei === -1) {
      const nxt = indices[i + 1];
      if (nxt !== undefined) ei = nxt;
      else {
        const cur = indices[i];
        ei = cur !== undefined ? cur : 0;
      }
    }
    const id =
      segmentIds &&
      ei < segmentIds.length &&
      typeof segmentIds[ei] === "string" &&
      segmentIds[ei]!.trim().length > 0
        ? segmentIds[ei]!
        : `element-${ei}`;
    const startS = track.distances[i]!;
    const endS = track.distances[i + 1]!;
    const px = track.positions[i * 3]!;
    const py = track.positions[i * 3 + 1]!;
    const pz = track.positions[i * 3 + 2]!;
    return {
      index: i,
      startS,
      endS,
      lowerM: globalLowerM,
      upperM: globalUpperM,
      witnessS: startS,
      witnessPosition: vec3(px, py, pz),
      relatedIds: Object.freeze([id]),
      work: 1,
      certified: true,
      source: "self" as const,
    };
  });
  const firstRelated = segments[0]?.relatedIds ?? ["seg-0"];
  const wPos = vec3(
    track.positions[0]!,
    track.positions[1]!,
    track.positions[2]!,
  );
  return {
    track,
    segments: Object.freeze(segments),
    globalLowerM,
    globalUpperM,
    minClearanceM: globalUpperM,
    globalWitnessS: track.distances[0]!,
    globalWitnessPosition: wPos,
    globalRelatedIds: Object.freeze([...firstRelated]),
    globalSource: "self",
    globalLowerRelatedIds: Object.freeze([...firstRelated]),
    globalLowerSource: "self",
    globalLowerWitnessS: track.distances[0]!,
    globalLowerWitnessPosition: wPos,
    effectiveCap: 10,
    diagnostics: Object.freeze([]),
    work: n,
    closed: false,
  } as ClearanceField;
}

describe("pipeline candidate skip mocked", () => {
  it("candidate0 fails then later passes with soft harmless", () => {
    const mock = vi.mocked(computeClearanceField);
    mock.mockReset();
    mock.mockImplementationOnce(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.2, 0.3),
    );
    mock.mockImplementationOnce(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.7, 0.8),
    );
    mock.mockImplementation(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.7, 0.8),
    );

    const softHarmless = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "full-auto",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [
        { id: "soft-len", kind: "total-length", target: 9999, hard: false },
      ],
      constraints: [],
      pinnedElementIds: [],
    });
    const r = generateCoaster(softHarmless);
    expect(r.candidatesTested).toBe(2);
    expect(r.feasible).toBe(true);
    const firstTrack = r.clearanceField?.track;
    expect(firstTrack).toBeDefined();
    expect(r.clearanceField?.segments.length).toBe(
      firstTrack!.distances.length - 1,
    );

    mock.mockReset();
    mock.mockImplementationOnce(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.2, 0.3),
    );
    mock.mockImplementationOnce(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.7, 0.8),
    );
    mock.mockImplementation(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.7, 0.8),
    );
    const r2 = generateCoaster(softHarmless);
    expect(r2.candidatesTested).toBe(2);
    expect(r2.clearanceField?.segments.length).toBe(
      r.clearanceField?.segments.length,
    );
  });

  it("doubly failing candidate still records hard clearance ID and diagnostic", () => {
    const mock = vi.mocked(computeClearanceField);
    mock.mockReset();
    mock.mockImplementation(
      (
        track: ClearanceField["track"],
        opts?: { segmentIds?: readonly string[] },
      ) => alignedField(track, opts?.segmentIds, 0.2, 0.3),
    );

    const doublyFailing = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 7,
      mode: "directed",
      family: "steel-sitdown-lsm-v1",
      elements: [
        {
          id: "station-0",
          kind: "station",
          type: "station",
          parameters: { length: 10, closed: false },
        },
      ],
      gates: [],
      targets: [],
      constraints: [
        { id: "hard-req-stall", kind: "required-stall", hard: true },
        { id: "hard-clear-1", kind: "track-clearance", value: 1.0, hard: true },
      ] satisfies readonly ConstraintV1[],
      pinnedElementIds: [],
    });

    const r = generateCoaster(doublyFailing);
    expect(r.feasible).toBe(false);
    expect(mock).toHaveBeenCalled();
    const diagClear = r.diagnostics.find((d) =>
      d.relatedIds?.includes("hard-clear-1"),
    );
    expect(diagClear).toBeDefined();
    expect(
      diagClear!.severity === "error" || diagClear!.severity === "fatal",
    ).toBe(true);
    const diagReq = r.diagnostics.find((d) =>
      d.relatedIds?.includes("hard-req-stall"),
    );
    expect(diagReq).toBeDefined();
    expect(r.clearanceField).toBeDefined();
    const alignedLen = r.clearanceField!.track.distances.length - 1;
    expect(r.clearanceField!.segments.length).toBe(alignedLen);
    expect(r.clearanceField!.track.checksum).toBe(r.track.checksum);
    expect(
      r.relaxationEvidence.some((e) => e.change.includes("hard-clear-1")),
    ).toBe(true);
  });
});
