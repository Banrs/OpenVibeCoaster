import { describe, expect, it, vi } from "vitest";
import { HeightfieldEnvironment, createDesignIntentV1 } from "@openvibecoaster/core";

const exactProbe = vi.hoisted(() => ({
  calls: 0,
  work: 0,
  maximumWork: 0,
}));

vi.mock("./clearance-geometry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clearance-geometry.js")>();
  return {
    ...actual,
    certifiedSweptDistance: (
      ...args: Parameters<typeof actual.certifiedSweptDistance>
    ): ReturnType<typeof actual.certifiedSweptDistance> => {
      const result = actual.certifiedSweptDistance(...args);
      exactProbe.calls += 1;
      exactProbe.work += result.work;
      exactProbe.maximumWork = Math.max(exactProbe.maximumWork, result.work);
      return result;
    },
  };
});

import {
  generateCoasterForBenchmark,
  type GenerationBenchmarkEvent,
} from "./pipeline.js";

declare const console: { log(message: string): void };

function rollingTerrain(): HeightfieldEnvironment {
  const width = 66;
  const depth = 46;
  const cellSize = 8;
  const origin: readonly [number, number] = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ];
  const heights = new Float64Array(width * depth);
  for (let z = 0; z < depth; z += 1)
    for (let x = 0; x < width; x += 1) {
      const worldX = origin[0] + x * cellSize;
      const worldZ = origin[1] + z * cellSize;
      heights[z * width + x] =
        -9.5 + Math.sin(worldX * 0.02) * 0.6 + Math.cos(worldZ * 0.02) * 0.6;
    }
  return new HeightfieldEnvironment({ width, depth, cellSize, heights, origin });
}

describe("diagnostic-only Insta stage profile", () => {
  it(
    "reports exact seed-1337 rolling-terrain stage boundaries",
    { timeout: 300_000 },
    () => {
      const intent = createDesignIntentV1({
        generatorVersion: "generator-v1",
        seed: 1337,
        mode: "insta",
        family: "steel-sitdown-lsm-v1",
        elements: [],
        gates: [],
        targets: [],
        constraints: [],
        terrainProfileId: "rolling-highlands-v1",
        pinnedElementIds: [],
      });
      const start = performance.now();
      const events: GenerationBenchmarkEvent[] = [];
      const result = generateCoasterForBenchmark(
        intent,
        { environment: rollingTerrain() },
        (event) => {
          events.push(event);
          console.log(`STAGE ${event} ${(performance.now() - start).toFixed(3)}ms`);
        },
      );
      console.log(
        `RESULT feasible=${result.feasible} length=${result.track.totalLength.toFixed(3)} diagnostics=${result.diagnostics.length}`,
      );
      const field = result.clearanceField;
      console.log(
        `CLEARANCE work=${field?.work ?? -1} segments=${field?.segments.length ?? -1} terrainWork=${field?.segments.filter((segment) => segment.source === "terrain").reduce((sum, segment) => sum + segment.work, 0) ?? -1} selfWork=${field?.segments.filter((segment) => segment.source === "self").reduce((sum, segment) => sum + segment.work, 0) ?? -1} uncertified=${field?.segments.filter((segment) => !segment.certified).length ?? -1}`,
      );
      console.log(
        `EXACT calls=${exactProbe.calls} work=${exactProbe.work} maximumWork=${exactProbe.maximumWork}`,
      );
      expect(events.at(-1)).toBe("total:end");
    },
  );
});
