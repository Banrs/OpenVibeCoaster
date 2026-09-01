import { describe, expect, it } from "vitest";
import {
  arcLength,
  compileCoasterFile,
  compileTrack,
  createDesignIntentV1,
  parseDesignIntentV1,
  parseEngineeringLimitsProfile,
  reconstructSolvedSpan,
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

const HARD_SEAM_KEYS = [
  "positionM",
  "tangentRad",
  "curvaturePerM",
  "curvatureVectorJumpPerM",
  "curvatureGradientPerM2",
  "bankRad",
  "bankDerivativeRadPerM",
  "bankSecondDerivativeRadPerM2",
  "specificForceJumpG",
] as const;

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

    expect(curved.parameters.angle).toBe(Math.PI);
    expect(curved.parameters.length).toBe(220);
    expect(curved.parameters.targetSpeed).toBe(8);

    const radius = curved.parameters.length / Math.abs(curved.parameters.angle!);
    expect(radius).toBeCloseTo(70.028, 2);

    expect(Math.abs(end.position[0] + 2 * radius)).toBeLessThan(1e-6);
    expect(Math.abs(end.position[1])).toBeLessThan(1e-6);
    expect(Math.abs(end.position[2])).toBeLessThan(1e-6);
    const lateral = Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2]);
    expect(lateral).toBeCloseTo(2 * radius, 5);
    expect(lateral).toBeCloseTo(140.06, 1);

    const tangentDot =
      end.tangent[0] * start.tangent[0] +
      end.tangent[1] * start.tangent[1] +
      end.tangent[2] * start.tangent[2];
    expect(tangentDot).toBeCloseTo(-1, 5);
    expect(tangentDot).toBeLessThan(-0.999);

    expect(built.solvedSpans[0]!.bank!.position(0)).toBeCloseTo(0, 6);
    expect(built.solvedSpans[0]!.bank!.position(1)).toBeCloseTo(0, 6);

    expect(built.solvedSpans).toHaveLength(1);
    expect(built.solvedSpans[0]!.zones).toEqual(["brake"]);
    expect(built.solvedSpans[0]!.kind).toBe("brake");

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

    // physical length authority: each stored coefficient span length equals its real arcLength
    for (const span of generated.file.solvedSpans) {
      const reconstructed = reconstructSolvedSpan(span);
      const physical = arcLength(reconstructed.span, 0, 1, 1e-9);
      expect(
        Math.abs(span.length - physical),
        `span ${span.id} stored length ${span.length} vs arcLength ${physical}`,
      ).toBeLessThan(1e-9);
    }

    // stored length sum agrees with compiled track totalLength
    const reconstructedSpans = generated.file.solvedSpans.map(reconstructSolvedSpan);
    const compiled = compileTrack(reconstructedSpans);
    const storedSum = generated.file.solvedSpans.reduce((sum, s) => sum + s.length, 0);
    expect(
      Math.abs(storedSum - compiled.totalLength),
      `stored sum ${storedSum} vs track.totalLength ${compiled.totalLength}`,
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(storedSum - generated.track.totalLength),
      `stored sum vs generated.track.totalLength`,
    ).toBeLessThan(1e-9);

    // every operation zone end is within track length
    const zones = operationZonesFromCoasterFile(generated.file);
    for (const zone of zones) {
      expect(
        zone.endDistanceM,
        `zone ${zone.id} end ${zone.endDistanceM} exceeds track ${compiled.totalLength}`,
      ).toBeLessThanOrEqual(compiled.totalLength + 1e-9);
    }

    // each operation-zone width equals sum of its physical stored spans
    const physicalByOwner = new Map<string, number>();
    for (const span of generated.file.solvedSpans) {
      const m = span.id.match(/#\d+$/);
      const actualOwner = m ? span.id.slice(0, -m[0].length) : span.id;
      physicalByOwner.set(actualOwner, (physicalByOwner.get(actualOwner) ?? 0) + span.length);
    }
    for (const zone of zones) {
      const expected = physicalByOwner.get(zone.id);
      expect(expected, `no physical sum for zone ${zone.id}`).toBeDefined();
      const width = zone.endDistanceM - zone.startDistanceM;
      expect(
        Math.abs(width - expected!),
        `zone ${zone.id} width ${width} vs physical sum ${expected}`,
      ).toBeLessThan(1e-9);
    }

    // seam diagnostics at adjacent boundaries under project seam semantics - exactly two hard seams
    const seams = diagnoseSeams(generated.solvedSpans);
    const adjacent = seams.filter(
      (s) => s.seamId === "stall-007->brake-008" || s.seamId === "brake-008->magnetic-brakes-009",
    );
    expect(adjacent, `expected exactly 2 curved-brake seams, got ${seams.map((s) => s.seamId).join(", ")}`).toHaveLength(2);
    for (const seam of adjacent) {
      for (const key of HARD_SEAM_KEYS) {
        const actual = seam[key] as number;
        const hardActual = (seam.hardResiduals as Record<string, number>)[key] as number;
        const limit = (testSeams as Record<string, number>)[key] as number;
        expect(
          actual,
          `${seam.seamId} ${key} actual ${actual} exceeds limit ${limit}`,
        ).toBeLessThanOrEqual(limit);
        expect(
          hardActual,
          `${seam.seamId} hardResiduals.${key} ${hardActual} exceeds limit ${limit}`,
        ).toBeLessThanOrEqual(limit);
      }
      // sustainedForceDeviationG is soft - reflected via softResiduals, not hard limit
      const softActual = seam.softResiduals.sustainedForceDeviationG;
      const softLimit = testSeams.sustainedForceDeviationG;
      expect(
        softActual,
        `${seam.seamId} soft sustainedForceDeviationG ${softActual} exceeds ${softLimit}`,
      ).toBeLessThanOrEqual(softLimit);
      // also check seam.sustainedForceDeviationG matches soft
      expect(
        seam.sustainedForceDeviationG,
        `${seam.seamId} sustainedForceDeviationG`,
      ).toBeLessThanOrEqual(softLimit);
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

    expect(noAngle.parameters.angle).toBeUndefined();
    expect(straightMagnetic.parameters.angle).toBeUndefined();

    const builtNoAngle = buildElement(noAngle, start);
    const builtMagnetic = buildElement(straightMagnetic, start);

    for (const built of [builtNoAngle, builtMagnetic]) {
      expect(built.solvedSpans).toHaveLength(1);
      expect(built.solvedSpans[0]!.zones).toEqual(["brake"]);
      expect(built.solvedSpans[0]!.kind).toBe("brake");
    }

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
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: 0 as unknown as number })).toThrow(/angle.*zero|zero.*angle/i);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.NaN as unknown as number })).toThrow(/finite|angle/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.POSITIVE_INFINITY as unknown as number })).toThrow(/finite|angle/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 + 0.01 })).toThrow(/angle.*2π|angle.*between/);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI * 2 - 0.01 })).toThrow(/angle/);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI }).parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI }).parameters as BrakeParameters).angle).toBe(-Math.PI);
    expect((createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 }).parameters as BrakeParameters).angle).toBe(Math.PI * 2);
    // overbankedTurn allows larger angle while brake still rejects >2pi
    expect(() => createElement("overbankedTurn", "ot", { radius: 28, angle: 3 * Math.PI, bank: 0 })).not.toThrow();
    expect((createElement("overbankedTurn", "ot2", { radius: 28, angle: 3 * Math.PI, bank: 0 }).parameters).angle).toBe(3 * Math.PI);
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: 3 * Math.PI })).toThrow(/angle/);
    expect(() => createElement("overbankedTurn", "ot3", { radius: 28, angle: Math.PI * 4 + 0.01, bank: 0 })).toThrow(/angle/);
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
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: 0, unknown: 1 } }] }))).toThrow(/no extra field|extra/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: Math.PI, extra: 1 } }] }))).toThrow(/no extra field|extra/);
    const invalidBrakeZero = { ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: 0 } }] };
    expect(() => createDesignIntentV1(invalidBrakeZero as unknown as Parameters<typeof createDesignIntentV1>[0])).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify(invalidBrakeZero))).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: Math.PI * 2 + 0.01 } }] }))).toThrow(/angle/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: -Math.PI * 2 - 0.01 } }] }))).toThrow(/angle/);
    // overbankedTurn valid 3pi via core parser, brake rejects same value
    const overbankedValid = {
      ...intentWithNewKeys,
      elements: [{ id: "ot-001", kind: "overbankedTurn", type: "overbankedTurn", parameters: { radius: 28, angle: 3 * Math.PI, bank: 0.6 } }],
    };
    expect(() => parseDesignIntentV1(JSON.stringify(overbankedValid))).not.toThrow();
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: 3 * Math.PI } }] }))).toThrow(/angle/);
    // finite rejection via parser for station
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: Number.NaN } }] }))).toThrow(/finite/);
    expect(() => parseDesignIntentV1(JSON.stringify({ ...intentWithNewKeys, elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: Number.POSITIVE_INFINITY } }] }))).toThrow(/finite/);
  });

  it("default file round-trips, preserves authored lengths and operation targets with physical lengths", () => {
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

    // physical length proof: each stored span length equals reconstructed arcLength
    for (const span of result.file.solvedSpans) {
      const reconstructed = reconstructSolvedSpan(span);
      const physical = arcLength(reconstructed.span, 0, 1, 1e-9);
      expect(
        Math.abs(span.length - physical),
        `span ${span.id} stored ${span.length} vs physical ${physical}`,
      ).toBeLessThan(1e-9);
    }
    const reconstructedSpans = result.file.solvedSpans.map(reconstructSolvedSpan);
    const compiled = compileTrack(reconstructedSpans);
    const storedSum = result.file.solvedSpans.reduce((sum, s) => sum + s.length, 0);
    expect(Math.abs(storedSum - compiled.totalLength), `stored sum vs compiled totalLength`).toBeLessThan(1e-9);

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
    for (const zone of zones) {
      expect(
        zone.endDistanceM,
        `zone ${zone.id} end ${zone.endDistanceM} > total ${compiled.totalLength}`,
      ).toBeLessThanOrEqual(compiled.totalLength + 1e-9);
    }
    // each zone width equals sum of its physical stored spans
    const byOwner = new Map<string, number>();
    for (const span of result.file.solvedSpans) {
      const m = span.id.match(/#\d+$/);
      const actualOwner = m ? span.id.slice(0, -m[0].length) : span.id;
      byOwner.set(actualOwner, (byOwner.get(actualOwner) ?? 0) + span.length);
    }
    for (const zone of [brakeZone, magneticZone, stationZone]) {
      const expected = byOwner.get(zone.id);
      expect(expected, `no physical sum for ${zone.id}`).toBeDefined();
      const width = zone.endDistanceM - zone.startDistanceM;
      expect(Math.abs(width - expected!), `zone ${zone.id} width ${width} vs physical ${expected}`).toBeLessThan(1e-9);
    }
    const stationElement = result.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((stationElement.parameters as StationParameters).closed).toBe(false);

    // round-trip preserves semantic parameters plus physical reconstructed lengths
    const loaded = compileCoasterFile(result.serializedFile);
    const reloadedBrake = loaded.file.intent.elements.find((e) => e.id === "brake-008")!;
    const reloadedStation = loaded.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((reloadedBrake.parameters as BrakeParameters).angle).toBe(Math.PI);
    expect((reloadedStation.parameters as StationParameters).targetSpeed).toBe(0);
    expect((reloadedStation.parameters as StationParameters).closed).toBe(false);
    expect((reloadedBrake.parameters as BrakeParameters).length).toBe(220);
    expect((loaded.file.intent.elements.find((e) => e.id === "magnetic-brakes-009")!.parameters as BrakeParameters).length).toBe(110);
    for (const span of loaded.file.solvedSpans) {
      const reconstructed = reconstructSolvedSpan(span);
      const physical = arcLength(reconstructed.span, 0, 1, 1e-9);
      expect(
        Math.abs(span.length - physical),
        `round-trip span ${span.id} stored ${span.length} vs physical ${physical}`,
      ).toBeLessThan(1e-9);
    }
    const loadedReconstructed = loaded.file.solvedSpans.map(reconstructSolvedSpan);
    const loadedCompiled = compileTrack(loadedReconstructed);
    const loadedSum = loaded.file.solvedSpans.reduce((s, sp) => s + sp.length, 0);
    expect(Math.abs(loadedSum - loadedCompiled.totalLength)).toBeLessThan(1e-9);
    for (const zone of operationZonesFromCoasterFile(loaded.file)) {
      expect(zone.endDistanceM).toBeLessThanOrEqual(loadedCompiled.totalLength + 1e-9);
    }
  });

  it("local regeneration preserves curved brake angle, station target and physical lengths", () => {
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
    expect((afterBrake.parameters as BrakeParameters).length).toBe(220);
    for (const span of local.generation.file.solvedSpans) {
      const reconstructed = reconstructSolvedSpan(span);
      const physical = arcLength(reconstructed.span, 0, 1, 1e-9);
      expect(
        Math.abs(span.length - physical),
        `local span ${span.id} stored ${span.length} vs physical ${physical}`,
      ).toBeLessThan(1e-9);
    }
    const localReconstructed = local.generation.file.solvedSpans.map(reconstructSolvedSpan);
    const localCompiled = compileTrack(localReconstructed);
    const localSum = local.generation.file.solvedSpans.reduce((s, sp) => s + sp.length, 0);
    expect(Math.abs(localSum - localCompiled.totalLength)).toBeLessThan(1e-9);
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
    expect((fileBrake.parameters as BrakeParameters).length).toBe(220);
    for (const span of fileLocal.generation.file.solvedSpans) {
      const reconstructed = reconstructSolvedSpan(span);
      const physical = arcLength(reconstructed.span, 0, 1, 1e-9);
      expect(
        Math.abs(span.length - physical),
        `fileLocal span ${span.id} stored ${span.length} vs physical ${physical}`,
      ).toBeLessThan(1e-9);
    }
    const fileLocalReconstructed = fileLocal.generation.file.solvedSpans.map(reconstructSolvedSpan);
    const fileLocalCompiled = compileTrack(fileLocalReconstructed);
    const fileLocalSum = fileLocal.generation.file.solvedSpans.reduce((s, sp) => s + sp.length, 0);
    expect(Math.abs(fileLocalSum - fileLocalCompiled.totalLength)).toBeLessThan(1e-9);
    const fileStation = fileLocal.generation.elements.find((e) => e.id === "station-010")!;
    expect((fileStation.parameters as StationParameters).targetSpeed).toBe(0);
    expect((fileStation.parameters as StationParameters).closed).toBe(false);
  });
});
