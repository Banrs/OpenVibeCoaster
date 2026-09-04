import { describe, expect, it, vi } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import type { ClearanceField } from "./clearance-field.js";

const exactCalls = vi.hoisted(() => ({
  count: 0,
  aabbLowerBounds: [] as number[],
}));

vi.mock("./clearance-geometry", async () => {
  const actual = await vi.importActual<typeof import("./clearance-geometry")>(
    "./clearance-geometry",
  );
  return {
    ...actual,
    certifiedSweptDistance: (
      ...args: Parameters<typeof actual.certifiedSweptDistance>
    ) => {
      exactCalls.count += 1;
      const first = actual.sweptAabb(args[0]);
      const second = actual.sweptAabb(args[1]);
      const gap = (axis: 0 | 1 | 2): number => {
        if (first.max[axis]! < second.min[axis]!)
          return second.min[axis]! - first.max[axis]!;
        if (second.max[axis]! < first.min[axis]!)
          return first.min[axis]! - second.max[axis]!;
        return 0;
      };
      exactCalls.aabbLowerBounds.push(Math.hypot(gap(0), gap(1), gap(2)));
      return actual.certifiedSweptDistance(...args);
    },
  };
});

import { computeClearanceField } from "./clearance-field.js";

function squareTrack() {
  const points = [
    vec3(0, 0, 0),
    vec3(8, 0, 0),
    vec3(8, 0, 8),
    vec3(0, 0, 8),
    vec3(0, 0, 0),
  ];
  return compileTrack(
    points.slice(0, -1).map((point, index) => ({
      id: `square-${index}`,
      span: SeventhOrderHermiteSpan.line(point, points[index + 1]!),
    })),
    { samples: 2 },
  );
}

function parallelThresholdTrack() {
  return compileTrack(
    [
      {
        id: "parallel-0",
        span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 10)),
      },
      {
        id: "spacer-1",
        span: SeventhOrderHermiteSpan.line(vec3(50, 0, 10), vec3(50, 0, 80)),
      },
      {
        id: "parallel-2",
        span: SeventhOrderHermiteSpan.line(vec3(5, 0, 10), vec3(5, 0, 0)),
      },
    ],
    { samples: 2 },
  );
}

function project(field: ClearanceField) {
  return {
    globalLowerM: field.globalLowerM,
    globalUpperM: field.globalUpperM,
    globalLowerSource: field.globalLowerSource,
    globalSource: field.globalSource,
    globalRelatedIds: [...field.globalRelatedIds],
    globalLowerRelatedIds: [...field.globalLowerRelatedIds],
    work: field.work,
    diagnostics: field.diagnostics,
    segments: field.segments.map((segment) => ({
      index: segment.index,
      lowerM: segment.lowerM,
      upperM: segment.upperM,
      source: segment.source,
      certified: segment.certified,
      work: segment.work,
      relatedIds: [...segment.relatedIds],
    })),
  };
}

describe("clearance field display-only self fast proof", () => {
  it("keeps an honest cap bracket without exact swept-distance refinement", () => {
    const track = squareTrack();
    const options = {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 100_000,
      closed: true,
      segmentIds: ["square-0", "square-1", "square-2", "square-3"],
    } as const;

    exactCalls.count = 0;
    exactCalls.aabbLowerBounds.length = 0;
    const first = computeClearanceField(track, options);
    const firstCalls = exactCalls.count;
    const firstDisplayOnlyCalls = exactCalls.aabbLowerBounds.filter(
      (lower) => lower >= options.hardClearanceM,
    );
    exactCalls.count = 0;
    exactCalls.aabbLowerBounds.length = 0;
    const second = computeClearanceField(track, options);
    const secondCalls = exactCalls.count;
    const secondDisplayOnlyCalls = exactCalls.aabbLowerBounds.filter(
      (lower) => lower >= options.hardClearanceM,
    );

    expect(firstCalls).toBeGreaterThan(0);
    expect(secondCalls).toBe(firstCalls);
    expect(firstDisplayOnlyCalls).toEqual([]);
    expect(secondDisplayOnlyCalls).toEqual([]);
    expect(first.diagnostics.some((item) => item.severity === "fatal")).toBe(
      false,
    );
    expect(first.globalLowerSource).toBe("self");
    expect(
      first.segments.every(
        (segment) =>
          Number.isFinite(segment.lowerM) &&
          Number.isFinite(segment.upperM) &&
          segment.lowerM <= segment.upperM,
      ),
    ).toBe(true);
    expect(project(second)).toEqual(project(first));
  });

  it("retains exact refinement when a real threshold exceeds the AABB proof", () => {
    exactCalls.count = 0;
    exactCalls.aabbLowerBounds.length = 0;
    const field = computeClearanceField(parallelThresholdTrack(), {
      hardClearanceM: 0.5,
      explicitThresholds: [3],
      displayCapM: 10,
      maxWork: 100_000,
      segmentIds: ["parallel-0", "spacer-1", "parallel-2"],
    });

    expect(exactCalls.count).toBeGreaterThan(0);
    expect(
      exactCalls.aabbLowerBounds.some((lower) => lower >= 0.5 && lower < 3),
    ).toBe(true);
    expect(field.diagnostics.some((item) => item.severity === "fatal")).toBe(
      false,
    );
  });
});
