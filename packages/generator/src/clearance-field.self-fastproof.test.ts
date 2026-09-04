import { describe, expect, it, vi } from "vitest";
import {
  compileTrack,
  SeventhOrderHermiteSpan,
  vec3,
} from "@openvibecoaster/core";
import type { ClearanceField } from "./clearance-field.js";

const exactCalls = vi.hoisted(() => ({ count: 0 }));

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
    const first = computeClearanceField(track, options);
    const firstCalls = exactCalls.count;
    exactCalls.count = 0;
    const second = computeClearanceField(track, options);
    const secondCalls = exactCalls.count;

    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(0);
    expect(first.diagnostics.some((item) => item.severity === "fatal")).toBe(
      false,
    );
    expect(first.globalLowerM).toBeGreaterThanOrEqual(0.5);
    expect(first.globalLowerM).toBeLessThan(10);
    expect(first.globalUpperM).toBeGreaterThanOrEqual(10);
    expect(first.globalLowerSource).toBe("self");
    expect(first.globalSource).toBe("cap");

    const affected = first.segments.filter((segment) => segment.lowerM < 10);
    expect(affected.length).toBeGreaterThan(0);
    expect(
      affected.every(
        (segment) =>
          Number.isFinite(segment.lowerM) &&
          Number.isFinite(segment.upperM) &&
          segment.lowerM >= 0.5 &&
          segment.lowerM <= segment.upperM &&
          segment.upperM >= 10 &&
          segment.source === "cap" &&
          segment.certified === false,
      ),
    ).toBe(true);
    expect(project(second)).toEqual(project(first));
  });

  it("retains exact refinement when a real threshold exceeds the AABB proof", () => {
    exactCalls.count = 0;
    const field = computeClearanceField(squareTrack(), {
      hardClearanceM: 0.5,
      explicitThresholds: [6],
      displayCapM: 10,
      maxWork: 100_000,
      closed: true,
      segmentIds: ["square-0", "square-1", "square-2", "square-3"],
    });

    expect(exactCalls.count).toBeGreaterThan(0);
    expect(field.diagnostics.some((item) => item.severity === "fatal")).toBe(
      false,
    );
  });
});
