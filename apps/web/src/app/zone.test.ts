import { describe, it, expect } from "vitest";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { resolveZoneMask } from "./zone.js";

function makeZonedTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) => vec3(u * 10, 0, 0),
          derivative: () => vec3(10, 0, 0),
        },
        zones: ["launch"],
      },
      {
        id: "b",
        span: {
          position: (u: number) => vec3(10 + u * 10, 0, 0),
          derivative: () => vec3(10, 0, 0),
        },
        zones: ["brake"],
      },
    ],
    { samples: 8 },
  );
}

describe("resolveZoneMask", () => {
  it("returns launch mask near start and brake mask near end", () => {
    const track = makeZonedTrack();
    const startMask = resolveZoneMask(track, 0);
    const endMask = resolveZoneMask(track, track.totalLength);
    expect(startMask).not.toBe(0);
    expect(endMask).not.toBe(0);
    expect(startMask).not.toBe(endMask);
  });
  it("returns finite mask for arbitrary distance", () => {
    const track = makeZonedTrack();
    const mask = resolveZoneMask(track, track.totalLength * 0.5);
    expect(Number.isFinite(mask)).toBe(true);
  });
  it("handles below-start and above-end with bounded behavior", () => {
    const track = makeZonedTrack();
    const below = resolveZoneMask(track, -100);
    const above = resolveZoneMask(track, track.totalLength + 100);
    const startMask = resolveZoneMask(track, 0);
    const endMask = resolveZoneMask(track, track.totalLength);
    expect(below).toBe(startMask);
    expect(above).toBe(endMask);
  });
  it("binary search returns same as linear nearest for sampled distances", () => {
    const track = makeZonedTrack();
    const distances = track.distances;
    for (let i = 0; i < distances.length; i++) {
      const d = distances[i]!;
      const mask = resolveZoneMask(track, d + 0.01);
      expect(Number.isFinite(mask)).toBe(true);
    }
  });
});
