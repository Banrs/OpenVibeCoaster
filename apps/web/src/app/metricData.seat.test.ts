import { describe, it, expect } from "vitest";
import {
  compileTrack,
  vec3,
  createDesignIntentV1,
  createCoasterFileV1,
} from "@openvibecoaster/core";
import { RideTimeline } from "@openvibecoaster/simulator";
import {
  deriveSeatMetricData,
  getSeatMetricSeries,
  getSeatCarIndex,
} from "./metricData.js";
import type { AuthoritativeExperienceResult } from "../experienceController.js";

function makeTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) => vec3(u * 20, 5, 0),
          derivative: () => vec3(20, 0, 0),
        },
      },
    ],
    { samples: 8 },
  );
}

function makeTimeline(carCount: number, withPerCar: boolean) {
  const len = 4;
  const timeSeconds = new Float64Array([0, 1, 2, 3]);
  const headDistanceM = new Float64Array([0, 5, 10, 15]);
  const speedMps = new Float64Array([5, 5, 5, 5]);
  const positions = new Float64Array(len * carCount * 3);
  const tangents = new Float64Array(len * carCount * 3);
  const normals = new Float64Array(len * carCount * 3);
  const binormals = new Float64Array(len * carCount * 3);
  for (let i = 0; i < len * carCount; i++) {
    const off = i * 3;
    tangents[off] = 1;
    normals[off + 1] = 1;
    binormals[off + 2] = 1;
  }
  const perCarRoll = withPerCar
    ? new Float64Array(len * carCount)
    : new Float64Array(0);
  const perCarVert = withPerCar
    ? new Float64Array(len * carCount)
    : new Float64Array(0);
  if (withPerCar) {
    for (let t = 0; t < len; t++) {
      for (let c = 0; c < carCount; c++) {
        const idx = t * carCount + c;
        perCarRoll[idx] = c * 0.1 + t * 0.01;
        perCarVert[idx] = 1 + c * 0.5 + t * 0.05; // signed vertical G
      }
    }
  }
  return new RideTimeline({
    sampleRateHz: 1,
    timeSeconds,
    headDistanceM,
    speedMps,
    carCount,
    carPositionsXYZ: positions,
    carTangentsXYZ: tangents,
    carNormalsXYZ: normals,
    carBinormalsXYZ: binormals,
    perCarRollRateRadPerSec: perCarRoll,
    perCarVerticalG: perCarVert,
    perCarLongitudinalG: withPerCar
      ? new Float64Array(len * carCount)
      : new Float64Array(0),
    perCarLateralG: withPerCar
      ? new Float64Array(len * carCount)
      : new Float64Array(0),
    perCarBankRad: withPerCar
      ? new Float64Array(len * carCount)
      : new Float64Array(0),
    perCarSpecificForceXYZ: withPerCar
      ? new Float64Array(len * carCount * 3)
      : new Float64Array(0),
    perCarJerkXYZ: withPerCar
      ? new Float64Array(len * carCount * 3)
      : new Float64Array(0),
    frames: [],
  });
}

function makeResult(
  track: ReturnType<typeof makeTrack>,
  timeline: RideTimeline,
  clearanceM: Float64Array | null = null,
): AuthoritativeExperienceResult {
  const intent = createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed: 1,
    mode: "insta",
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    terrainProfileId: "rolling-highlands-v1",
    pinnedElementIds: [],
  });
  const file = createCoasterFileV1({
    name: "test",
    intent,
    solvedSpans: [],
    seed: 1,
    generatorVersion: "generator-v1",
    profileVersion: "profile-v1",
    researchSnapshotIds: [],
    compiledDataChecksum: track.checksum,
  });
  const result: AuthoritativeExperienceResult = {
    track,
    timeline,
    clearanceM,
    file,
    diagnostics: [],
    relaxations: [],
    spanHashes: { dummy: "00000000" },
  };
  return result;
}

describe("seat metricData", () => {
  it("getSeatCarIndex middle floor((n-1)/2)", () => {
    expect(getSeatCarIndex("front", 2)).toBe(0);
    expect(getSeatCarIndex("middle", 2)).toBe(0);
    expect(getSeatCarIndex("rear", 2)).toBe(1);
    expect(getSeatCarIndex("middle", 6)).toBe(2);
    expect(getSeatCarIndex("rear", 6)).toBe(5);
    expect(getSeatCarIndex("middle", 3)).toBe(1);
  });

  it("gForce uses signed vertical G per car not magnitude", () => {
    const track = makeTrack();
    const timeline = makeTimeline(2, true);
    const result = makeResult(track, timeline);
    const frontSeries = getSeatMetricSeries("gForce", result, "front");
    const rearSeries = getSeatMetricSeries("gForce", result, "rear");
    expect(frontSeries.available).toBe(true);
    expect(rearSeries.available).toBe(true);
    // front verticalG at t0 =1, rear=1.5
    expect(frontSeries.values[0]).toBeCloseTo(1);
    expect(rearSeries.values[0]).toBeCloseTo(1.5);
    expect(frontSeries.values[0]).not.toBe(rearSeries.values[0]);
    // deriveSeatMetricData resamples onto track distances
    const frontData = deriveSeatMetricData("gForce", result, "front");
    const rearData = deriveSeatMetricData("gForce", result, "rear");
    expect(frontData?.gForce).toBeDefined();
    expect(rearData?.gForce).toBeDefined();
    expect(frontData!.gForce![0]).toBeCloseTo(1);
    expect(rearData!.gForce![0]).toBeCloseTo(1.5);
    // hash should differ between seats (rail colors diverge)
    let differs = false;
    for (let i = 0; i < frontData!.gForce!.length; i++)
      if (frontData!.gForce![i] !== rearData!.gForce![i]) {
        differs = true;
        break;
      }
    expect(differs).toBe(true);
  });

  it("rollRate per car resampling exact values", () => {
    const track = makeTrack();
    const timeline = makeTimeline(3, true);
    const result = makeResult(track, timeline);
    const seriesFront = getSeatMetricSeries("rollRate", result, "front");
    const seriesRear = getSeatMetricSeries("rollRate", result, "rear");
    expect(seriesFront.values[0]).toBeCloseTo(0);
    expect(seriesRear.values[0]).toBeCloseTo(0.2);
    const dataFront = deriveSeatMetricData("rollRate", result, "front");
    expect(dataFront?.rollRate).toBeDefined();
    // resampling: track distances include 0 which exactly matches timeline distance 0 -> exact value
    expect(dataFront!.rollRate![0]).toBeCloseTo(
      seriesFront.values[0] as number,
    );
  });

  it("missing perCar buffers yields unavailable not fiction", () => {
    const track = makeTrack();
    const timeline = makeTimeline(2, false);
    const result = makeResult(track, timeline);
    const s = getSeatMetricSeries("gForce", result, "front");
    expect(s.available).toBe(false);
    expect(deriveSeatMetricData("gForce", result, "front")).toBeUndefined();
    const r = getSeatMetricSeries("rollRate", result, "rear");
    expect(r.available).toBe(false);
    expect(deriveSeatMetricData("rollRate", result, "rear")).toBeUndefined();
  });

  it("speed/energy/clearance remain train-wide", () => {
    const track = makeTrack();
    const timeline = makeTimeline(2, true);
    const result = makeResult(track, timeline);
    const speedSeriesFront = getSeatMetricSeries("speed", result, "front");
    const speedSeriesRear = getSeatMetricSeries("speed", result, "rear");
    // both should be train-wide derived from head speed timeline via getMetricSeries, not per-car
    expect(speedSeriesFront.values).toEqual(speedSeriesRear.values);
    expect(speedSeriesFront.available).toBe(true);
  });

  it("deriveSeatMetricData preserves unavailable as undefined without train fallback", () => {
    const track = makeTrack();
    const timeline = makeTimeline(2, false);
    const result = makeResult(track, timeline);
    // G/roll with missing per-car must stay unavailable, not fallback to head magnitude
    expect(deriveSeatMetricData("gForce", result, "front")).toBeUndefined();
    expect(deriveSeatMetricData("rollRate", result, "front")).toBeUndefined();
    // Train-wide still available via direct deriveMetricData path (speed) – but via seat path, speed remains train-wide
    const speedViaSeat = deriveSeatMetricData("speed", result, "front");
    expect(speedViaSeat?.speed).toBeDefined();
  });
});
