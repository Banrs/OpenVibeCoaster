import { describe, expect, it } from "vitest";
import {
  CompiledTrackData,
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
  type CompiledTrackDataInput,
  type Diagnostic,
  type EnvironmentQuery,
  type TrackElement,
  type Vec3,
} from "@openvibecoaster/core";
import {
  computeClearanceField,
  type ClearanceField,
} from "./clearance-field.js";

const TRACK_SNAPSHOT_GETTERS = [
  "positions",
  "tangents",
  "normals",
  "binormals",
  "distances",
  "elementIndices",
  "elementBoundaries",
] as const;

type TrackSnapshotGetterName = (typeof TRACK_SNAPSHOT_GETTERS)[number];

const trackGetterCounts: Record<TrackSnapshotGetterName, number> =
  Object.fromEntries(
    TRACK_SNAPSHOT_GETTERS.map((name) => [name, 0]),
  ) as Record<TrackSnapshotGetterName, number>;

class CountingCompiledTrackData extends CompiledTrackData {
  public override get positions(): Float64Array {
    trackGetterCounts.positions += 1;
    return super.positions;
  }

  public override get tangents(): Float64Array {
    trackGetterCounts.tangents += 1;
    return super.tangents;
  }

  public override get normals(): Float64Array {
    trackGetterCounts.normals += 1;
    return super.normals;
  }

  public override get binormals(): Float64Array {
    trackGetterCounts.binormals += 1;
    return super.binormals;
  }

  public override get distances(): Float64Array {
    trackGetterCounts.distances += 1;
    return super.distances;
  }

  public override get elementIndices(): Uint32Array {
    trackGetterCounts.elementIndices += 1;
    return super.elementIndices;
  }

  public override get elementBoundaries(): Uint32Array {
    trackGetterCounts.elementBoundaries += 1;
    return super.elementBoundaries;
  }
}

function buildSnapshotElements(): TrackElement[] {
  return [
    {
      id: "leg-a",
      span: SeventhOrderHermiteSpan.line(vec3(0, 2, 0), vec3(0, 2, 20)),
    },
    {
      id: "cross",
      span: SeventhOrderHermiteSpan.line(vec3(0, 2, 20), vec3(10, 2, 20)),
    },
    {
      id: "leg-b",
      span: SeventhOrderHermiteSpan.line(vec3(10, 2, 20), vec3(10, 2, 0)),
    },
    {
      id: "return",
      span: SeventhOrderHermiteSpan.line(vec3(10, 2, 0), vec3(0.6, 2, 0)),
    },
  ];
}

function createPlaneEnvironment(counter: { calls: number }): EnvironmentQuery {
  return {
    signedDistance: (p: Vec3): number => {
      counter.calls += 1;
      return p[1];
    },
    raycast: () => undefined,
    bounds: () => ({
      min: vec3(-100, -10, -100),
      max: vec3(100, 0, 100),
    }),
  };
}

function snapshotInputOf(track: CompiledTrackData): CompiledTrackDataInput {
  return {
    positions: track.positions,
    tangents: track.tangents,
    normals: track.normals,
    binormals: track.binormals,
    distances: track.distances,
    curvature: track.curvature,
    curvatureVector: track.curvatureVector,
    bank: track.bank,
    bankDerivative: track.bankDerivative,
    zoneMasks: track.zoneMasks,
    zoneNames: [...track.zoneNames],
    elementIndices: track.elementIndices,
    elementBoundaries: track.elementBoundaries,
    parameters: track.parameters,
    totalLength: track.totalLength,
  };
}

function projectDiagnostic(d: Diagnostic) {
  return {
    code: d.code,
    severity: d.severity,
    provenance: d.provenance,
    message: d.message,
    relatedIds: d.relatedIds ? [...d.relatedIds] : undefined,
    location: d.location
      ? {
          s: d.location.s,
          position: d.location.position
            ? [...d.location.position]
            : undefined,
          time: d.location.time,
        }
      : undefined,
    actual: d.actual,
    limit: d.limit,
    margin: d.margin,
  };
}

function projectSegment(s: ClearanceField["segments"][number]) {
  return {
    index: s.index,
    startS: s.startS,
    endS: s.endS,
    lowerM: s.lowerM,
    upperM: s.upperM,
    witnessS: s.witnessS,
    witnessPosition: [...s.witnessPosition],
    relatedIds: [...s.relatedIds],
    work: s.work,
    certified: s.certified,
    source: s.source,
  };
}

function projectField(field: ClearanceField) {
  return {
    globalLowerM: field.globalLowerM,
    globalUpperM: field.globalUpperM,
    globalSource: field.globalSource,
    globalLowerSource: field.globalLowerSource,
    globalWitnessS: field.globalWitnessS,
    globalWitnessPosition: [...field.globalWitnessPosition],
    globalRelatedIds: [...field.globalRelatedIds],
    globalLowerWitnessS: field.globalLowerWitnessS,
    globalLowerWitnessPosition: [...field.globalLowerWitnessPosition],
    globalLowerRelatedIds: [...field.globalLowerRelatedIds],
    effectiveCap: field.effectiveCap,
    work: field.work,
    closed: field.closed,
    diagnostics: field.diagnostics.map(projectDiagnostic),
    segments: field.segments.map(projectSegment),
  };
}

describe("clearance field – track snapshot (RED)", () => {
  it("snapshots canonical arrays once with identical clearance result", () => {
    const elements = buildSnapshotElements();
    const segmentIds = elements.map((element) => element.id);
    const baseTrack = compileTrack(elements, { samples: 8 });
    expect(baseTrack.distances.length).toBeGreaterThan(4);
    expect(segmentIds).toEqual(["leg-a", "cross", "leg-b", "return"]);

    const expectedSdf = { calls: 0 };
    const countedSdf = { calls: 0 };
    const expected = computeClearanceField(baseTrack, {
      environment: createPlaneEnvironment(expectedSdf),
      segmentIds,
    });

    expect(expected.segments.length).toBe(baseTrack.distances.length - 1);
    expect(expectedSdf.calls).toBeGreaterThan(0);
    expect(expected.work).toBeGreaterThan(0);
    expect(
      expected.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("budget"),
      ),
    ).toBe(false);

    const countedTrack = new CountingCompiledTrackData(
      snapshotInputOf(baseTrack),
    );
    expect(countedTrack.checksum).toBe(baseTrack.checksum);

    for (const name of TRACK_SNAPSHOT_GETTERS) {
      trackGetterCounts[name] = 0;
    }
    countedSdf.calls = 0;

    const counted = computeClearanceField(countedTrack, {
      environment: createPlaneEnvironment(countedSdf),
      segmentIds: [...segmentIds],
    });

    expect(countedSdf.calls).toBeGreaterThan(0);
    expect(projectField(counted)).toEqual(projectField(expected));

    const countsSnapshot = { ...trackGetterCounts };
    for (const name of TRACK_SNAPSHOT_GETTERS) {
      expect(countsSnapshot[name]).toBeLessThanOrEqual(1);
    }
  });
});
