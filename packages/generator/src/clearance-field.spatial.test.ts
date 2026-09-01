import { describe, it, expect } from "vitest";
import {
  vec3,
  compileTrack,
  SeventhOrderHermiteSpan,
  type CompiledTrackData,
  type TrackElement,
} from "@openvibecoaster/core";
import { computeClearanceField } from "./clearance-field.js";

function makeTrackForAdversarial(): CompiledTrackData {
  const a = SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 0.5));
  const b = SeventhOrderHermiteSpan.line(vec3(5, 0, 0), vec3(5, 0, 0.5));
  const spans: TrackElement[] = [
    { id: "seg-0", span: a },
    { id: "seg-1", span: b },
  ];
  const track = compileTrack(spans, { samples: 2 });
  return track;
}
function makeNonLocalCloseTrack(): CompiledTrackData {
  const spans: TrackElement[] = [];
  spans.push({
    id: "seg-0",
    span: SeventhOrderHermiteSpan.line(vec3(0, 0, 0), vec3(0, 0, 10)),
  });
  spans.push({
    id: "seg-1",
    span: SeventhOrderHermiteSpan.line(vec3(50, 0, 10), vec3(50, 0, 30)),
  });
  spans.push({
    id: "seg-2",
    span: SeventhOrderHermiteSpan.line(vec3(50, 0, 30), vec3(50, 0, 50)),
  });
  spans.push({
    id: "seg-3",
    span: SeventhOrderHermiteSpan.line(vec3(50, 0, 50), vec3(50, 0, 70)),
  });
  spans.push({
    id: "seg-4",
    span: SeventhOrderHermiteSpan.line(vec3(3.5, 0, 0), vec3(3.5, 0, 10)),
  });
  return compileTrack(spans, { samples: 2 });
}

describe("clearance-field spatial hash", () => {
  it("adversarial: centres >1 cell apart but extents within cap are still candidates (range insertion)", () => {
    const trackClose = makeNonLocalCloseTrack();
    const field = computeClearanceField(trackClose, {
      hardClearanceM: 0.5,
      displayCapM: 2,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1", "seg-2", "seg-3", "seg-4"],
    });
    expect(field.globalLowerM).toBeLessThan(2);
    const trackFar = makeTrackForAdversarial();
    const field2 = computeClearanceField(trackFar, {
      hardClearanceM: 0.5,
      displayCapM: 2,
      maxWork: 100000,
      segmentIds: ["seg-0", "seg-1"],
    });
    expect(field.work).toBeGreaterThan(0);
    void field2;
  });

  it("subquadratic candidates on long natural-station track", () => {
    const spans: TrackElement[] = [];
    const n = 20;
    const spacing = 50;
    for (let i = 0; i < n; i++) {
      const a = SeventhOrderHermiteSpan.line(
        vec3(i * spacing, 0, 0),
        vec3(i * spacing + 10, 0, 0),
      );
      spans.push({ id: `seg-${i}`, span: a });
    }
    const track = compileTrack(spans, { samples: 2 });
    const nSeg = track.distances.length - 1;
    const segmentIds = Array.from({ length: nSeg }, (_, i) => `seg-${i}`);
    const field = computeClearanceField(track, {
      hardClearanceM: 0.5,
      displayCapM: 10,
      maxWork: 1_000_000,
      segmentIds,
    });
    const allPairs = (nSeg * (nSeg - 1)) / 2;
    expect(field.work).toBeLessThan(allPairs * 20);
    expect(field.work).toBeLessThan(5000);
    expect(field.globalLowerM).toBe(10);
  });
});
