import { describe, expect, it } from "vitest";
import {
  arcLength,
  compileCoasterFile,
  createDesignIntentV1,
  parseDesignIntentV1,
  parseEngineeringLimitsProfile,
  serializeDesignIntentV1,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "@openvibecoaster/simulator";
import { buildElement, createElement, defaultPose } from "./elements";
import {
  generateCoaster,
  regenerateCoasterFileLocal,
  regenerateLocal,
} from "./pipeline";
import { diagnoseSeams } from "./solver";
import rawProfile from "../../../data/profiles/engineering-limits-v1.json";
import type { BrakeParameters, StationParameters } from "./types";

const testSeams = parseEngineeringLimitsProfile(rawProfile).seams;

describe("curved brake and terminal station target packet", () => {
  it("curved brake preserves seventh-order seam-friendly geometry, rotates tangent ~pi and displaces ~2r while keeping authored length", () => {
    const curved = createElement("brake", "brake-008", {
      length: 220,
      targetSpeed: 8,
      angle: Math.PI,
    });
    const start = defaultPose();
    const built = buildElement(curved, start);
    const end = built.endPose;

    // typed parameter allowlist preserved: brake has only optional angle
    expect(curved.parameters.angle).toBe(Math.PI);
    expect(curved.parameters.length).toBe(220);
    expect(curved.parameters.targetSpeed).toBe(8);

    // derived radius invariant radius=length/abs(angle)
    const radius = curved.parameters.length / Math.abs(curved.parameters.angle!);
    expect(radius).toBeCloseTo(70.028, 2);

    // endpoint: for half-turn, displacement should be ~2r along binormal (world -X)
    // p0 (0,0,0) -> p1 (-2r,0,0) within tight tolerance, not merely >50
    expect(Math.abs(end.position[0] + 2 * radius)).toBeLessThan(1e-6);
    expect(Math.abs(end.position[1])).toBeLessThan(1e-6);
    expect(Math.abs(end.position[2])).toBeLessThan(1e-6);
    const lateral = Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2]);
    expect(lateral).toBeCloseTo(2 * radius, 5);
    expect(lateral).toBeCloseTo(140.06, 1);

    // tangent rotation tight: near -1 not precision 1
    const tangentDot =
      end.tangent[0] * start.tangent[0] +
      end.tangent[1] * start.tangent[1] +
      end.tangent[2] * start.tangent[2];
    expect(tangentDot).toBeCloseTo(-1, 5);
    expect(tangentDot).toBeLessThan(-0.999);

    // bank law retained
    expect(built.solvedSpans[0]!.bank!.position(0)).toBeCloseTo(0, 6);
    expect(built.solvedSpans[0]!.bank!.position(1)).toBeCloseTo(0, 6);

    expect(built.solvedSpans).toHaveLength(1);
    expect(built.solvedSpans[0]!.zones).toEqual(["brake"]);
    expect(built.solvedSpans[0]!.kind).toBe("brake");

    // compiled geometric arc length: positive, near authored 220 but not falsely claimed exact
    // seventh-order Hermite with speed=length sacrifices exact arc length for C2 continuity; allow defensible tolerance
    const geometricLength = arcLength(built.solvedSpans[0]!.span);
    expect(geometricLength).toBeGreaterThan(0);
    expect(Math.abs(geometricLength - 220)).toBeLessThan(10); // <4.5% for seam-friendly transition

    // authored serialized length remains 220 (pipeline length authority)
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 1,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const generated = generateCoaster(intent);
    const brakeSpan = generated.file.solvedSpans.find((s) => s.id === "brake-008")!;
    expect(brakeSpan.length).toBe(220);

    // seam diagnostics at adjacent boundaries under project seam semantics
    const seams = diagnoseSeams(generated.solvedSpans);
    const adjacent = seams.filter((s) => s.seamId.includes("brake-008"));
    expect(adjacent.length).toBeGreaterThanOrEqual(2);
    for (const seam of adjacent) {
      expect(seam.positionM, seam.seamId).toBeLessThan(testSeams.positionM + 1e-6);
      expect(seam.tangentRad, seam.seamId).toBeLessThan(testSeams.tangentRad + 1e-6);
      expect(seam.bankRad, seam.seamId).toBeLessThan(testSeams.bankRad + 1e-6);
      expect(seam.bankDerivativeRadPerM, seam.seamId).toBeLessThan(
        testSeams.bankDerivativeRadPerM + 1e-6,
      );
    }
  });

  it("missing angle retains exact straight line and magnetic brake stays straight", () => {
    const start = defaultPose();
    const noAngle = createElement("brake", "brake-straight", {
      length: 20,
      targetSpeed: 8,
      bank: 0,
    });
    const straightMagnetic = createElement("brake", "magnetic-brakes-009", {
      length: 110,
      targetSpeed: 5,
    });

    // typed optional angle remains undefined
    expect(noAngle.parameters.angle).toBeUndefined();
    expect(straightMagnetic.parameters.angle).toBeUndefined();

    const builtNoAngle = buildElement(noAngle, start);
    const builtMagnetic = buildElement(straightMagnetic, start);

    for (const built of [builtNoAngle, builtMagnetic]) {
      expect(built.solvedSpans).toHaveLength(1);
      expect(built.solvedSpans[0]!.zones).toEqual(["brake"]);
      expect(built.solvedSpans[0]!.kind).toBe("brake");
    }

    // straight along Z: no lateral displacement
    expect(Math.abs(builtNoAngle.endPose.position[0])).toBeLessThan(1e-6);
    expect(Math.abs(builtMagnetic.endPose.position[0])).toBeLessThan(1e-6);
    expect(Math.abs(builtMagnetic.endPose.position[2] - 110)).toBeLessThan(1e-6);
    const dotNoAngle =
      builtNoAngle.endPose.tangent[0] * start.tangent[0] +
      builtNoAngle.endPose.tangent[1] * start.tangent[1] +
      builtNoAngle.endPose.tangent[2] * start.tangent[2];
    const dotMagnetic =
      builtMagnetic.endPose.tangent[0] * start.tangent[0] +
      builtMagnetic.endPose.tangent[1] * start.tangent[1] +
      builtMagnetic.endPose.tangent[2] * start.tangent[2];
    expect(dotNoAngle).toBeCloseTo(1, 6);
    expect(dotMagnetic).toBeCloseTo(1, 6);
  });

  it("station targetSpeed and brake angle validation rejects out-of-range, zero and non-finite with named range errors", () => {
    expect(() => createElement("station", "s", { length: 12, targetSpeed: -1 as unknown as number })).toThrow(/targetSpeed.*0.*120/);
    expect(() => createElement("station", "s", { length: 12, targetSpeed: 200 as unknown as number })).toThrow(/targetSpeed/);
    expect(() => createElement("station", "s", { length: 12, targetSpeed: Number.NaN as unknown as number })).toThrow(/targetSpeed|finite/);
    expect(() => createElement("station", "s", { length: 12, targetSpeed: Number.POSITIVE_INFINITY as unknown as number })).toThrow(/finite/);
    expect(createElement("station", "s", { length: 12, targetSpeed: 0 }).parameters.targetSpeed).toBe(0);
    expect(createElement("station", "s", { length: 12, targetSpeed: 120 }).parameters.targetSpeed).toBe(120);
    const open = createElement("station", "station-open", { length: 12, bank: 0, closed: false });
    expect((open.parameters as StationParameters).targetSpeed).toBeUndefined();
    expect((open.parameters as StationParameters).closed).toBe(false);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: 0 as unknown as number })).toThrow(/angle.*non-zero|angle.*0/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.NaN as unknown as number })).toThrow(/finite|angle/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.POSITIVE_INFINITY as unknown as number })).toThrow(/finite|angle/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 + 0.01 })).toThrow(/angle.*2π|angle.*between/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI * 2 - 0.01 })).toThrow(/angle/);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI }).parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI }).parameters as BrakeParameters).angle).toBe(-Math.PI);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 }).parameters as BrakeParameters).angle).toBe(Math.PI * 2);
  });

  it("parser exact allowlist accepts new keys and rejects invalid values and unknown fields via core validation", () => {
    const intentWithNewKeys = {
      schemaVersion: 1 as const, generatorVersion: "test-v1", seed: 1, mode: "directed" as const, family: "steel-sitdown-lsm-v1" as const,
      elements: [
        { id: "station-010", kind: "station", type: "station", parameters: { length: 160, bank: 0, closed: false, targetSpeed: 0 } },
        { id: "brake-008", kind: "brake", type: "brake", parameters: { length: 220, targetSpeed: 8, bank: 0, angle: Math.PI } },
      ], gates: [], targets: [], constraints: [], pinnedElementIds: [],
    };
    expect(() => createDesignIntentV1(intentWithNewKeys)).not.toThrow();
    const serialized = serializeDesignIntentV1(createDesignIntentV1(intentWithNewKeys));
    const parsed = parseDesignIntentV1(serialized);
    expect((parsed.elements[0]!.parameters as StationParameters).targetSpeed).toBe(0);
    expect((parsed.elements[1]!.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: -1 } }] }))).toThrow(/targetSpeed/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: 200 } }] }))).toThrow(/targetSpeed/);
    const invalidBrakeZero = { ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: 0 } }] };
    expect(() => createDesignIntentV1(invalidBrakeZero as unknown as Parameters<typeof createDesignIntentV1>[0])).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify(invalidBrakeZero))).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: Math.PI * 2 + 0.01 } }] }))).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: -Math.PI * 2 - 0.01 } }] }))).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: 0, unknown: 1 } }] }))).toThrow(/no extra field|extra/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: Math.PI, extra: 1 } }] }))).toThrow(/no extra field|extra/);
  });

  it("default file round-trips, preserves authored lengths 220/110, distances 220/110 and operation targets 8/5/0 with closed:false", () => {
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 1,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const result = generateCoaster(intent);
    const brake008 = result.elements.find((e) => e.id === "brake-008")!;
    const magnetic = result.elements.find((e) => e.id === "magnetic-brakes-009")!;
    const station010 = result.elements.find((e) => e.id === "station-010")!;
    const brakeParams = brake008.parameters as BrakeParameters;
    const magneticParams = magnetic.parameters as BrakeParameters;
    const stationParams = station010.parameters as StationParameters;
    expect(brakeParams.length).toBe(220);
    expect(brakeParams.angle).toBe(Math.PI);
    expect(brakeParams.targetSpeed).toBe(8);
    expect(magneticParams.length).toBe(110);
    expect(magneticParams.angle).toBeUndefined();
    expect(magneticParams.targetSpeed).toBe(5);
    expect(stationParams.length).toBe(160);
    expect(stationParams.targetSpeed).toBe(0);
    expect(stationParams.closed).toBe(false);

    const spanBrake = result.file.solvedSpans.find((s) => s.id === "brake-008")!;
    const spanMagnetic = result.file.solvedSpans.find((s) => s.id === "magnetic-brakes-009")!;
    const spanStation = result.file.solvedSpans.find((s) => s.id === "station-010")!;
    expect(spanBrake.length).toBe(220);
    expect(spanMagnetic.length).toBe(110);
    expect(spanStation.length).toBe(160);

    // operation-zone distances authored, not invented
    const zones = operationZonesFromCoasterFile(result.file);
    const brakeZone = zones.find((z) => z.id === "brake-008")!;
    const magneticZone = zones.find((z) => z.id === "magnetic-brakes-009")!;
    const stationZone = zones.find((z) => z.id === "station-010")!;
    expect(brakeZone.kind).toBe("brake");
    expect(magneticZone.kind).toBe("brake");
    expect(stationZone.kind).toBe("station");
    expect(brakeZone.targetSpeedMps).toBe(8);
    expect(magneticZone.targetSpeedMps).toBe(5);
    expect(stationZone.targetSpeedMps).toBe(0);
    expect(brakeZone.endDistanceM - brakeZone.startDistanceM).toBe(220);
    expect(magneticZone.endDistanceM - magneticZone.startDistanceM).toBe(110);
    expect(stationZone.endDistanceM - stationZone.startDistanceM).toBe(160);
    const stationElement = result.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((stationElement.parameters as StationParameters).closed).toBe(false);

    // round-trip preserves angle, station target, semantic length, checksum
    const loaded = compileCoasterFile(result.serializedFile);
    expect(loaded.file.compiledDataChecksum).toBe(result.file.compiledDataChecksum);
    expect(loaded.track.checksum).toBe(result.file.compiledDataChecksum);
    const reloadedBrake = loaded.file.intent.elements.find((e) => e.id === "brake-008")!;
    const reloadedStation = loaded.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((reloadedBrake.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((reloadedStation.parameters as StationParameters).targetSpeed).toBe(0);
    expect((reloadedStation.parameters as StationParameters).closed).toBe(false);
    expect(loaded.file.solvedSpans.find((s) => s.id === "brake-008")!.length).toBe(220);
    expect(loaded.file.solvedSpans.find((s) => s.id === "magnetic-brakes-009")!.length).toBe(110);
  });

  it("local regeneration preserves curved brake angle, station target and authored length", () => {
    const intent = createDesignIntentV1({
      generatorVersion: "test-v1",
      seed: 1,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    });
    const result = generateCoaster(intent);
    const beforeBrake = result.elements.find((e) => e.id === "brake-008")!;
    const beforeStation = result.elements.find((e) => e.id === "station-010")!;
    expect((beforeBrake.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((beforeStation.parameters as StationParameters).targetSpeed).toBe(0);

    const local = regenerateLocal(result, "brake-008", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    const afterBrake = local.generation.elements.find((e) => e.id === "brake-008")!;
    const afterStation = local.generation.elements.find((e) => e.id === "station-010")!;
    expect((afterBrake.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((afterStation.parameters as StationParameters).targetSpeed).toBe(0);
    expect(local.generation.file.solvedSpans.find((s) => s.id === "brake-008")!.length).toBe(220);
    const loaded = compileCoasterFile(local.generation.serializedFile);
    expect((loaded.file.intent.elements.find((e) => e.id === "brake-008")!.parameters as BrakeParameters).angle).toBe(
      Math.PI,
    );

    const fileLocal = regenerateCoasterFileLocal(result.file, "magnetic-brakes-009", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    const fileBrake = fileLocal.generation.elements.find((e) => e.id === "brake-008")!;
    expect((fileBrake.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect(fileLocal.generation.file.solvedSpans.find((s) => s.id === "brake-008")!.length).toBe(220);
    const fileStation = fileLocal.generation.elements.find((e) => e.id === "station-010")!;
    expect((fileStation.parameters as StationParameters).targetSpeed).toBe(0);
    expect((fileStation.parameters as StationParameters).closed).toBe(false);
  });
});
