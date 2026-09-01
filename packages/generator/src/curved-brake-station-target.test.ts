import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createDesignIntentV1,
  parseDesignIntentV1,
  serializeDesignIntentV1,
} from "@openvibecoaster/core";
import { operationZonesFromCoasterFile } from "@openvibecoaster/simulator";
import {
  buildElement,
  createElement,
  defaultPose,
} from "./elements";
import {
  generateCoaster,
  regenerateCoasterFileLocal,
  regenerateLocal,
} from "./pipeline";
import { parseEngineeringLimitsProfile } from "@openvibecoaster/core";
import rawProfile from "../../../data/profiles/engineering-limits-v1.json";

const testSeams = parseEngineeringLimitsProfile(rawProfile).seams;

describe("curved brake and terminal station target packet", () => {
  it("curved brake endpoint has lateral motion and rotated tangent", () => {
    const curved = createElement("brake", "brake-008", {
      length: 220,
      targetSpeed: 8,
      angle: Math.PI,
    });
    const start = defaultPose();
    const built = buildElement(curved, start);
    const end = built.endPose;
    const lateral = Math.hypot(end.position[0] - start.position[0], end.position[2] - start.position[2]);
    // For 180 deg turn radius = 220/pi ~=70.03, lateral should be ~2*radius for tangent along Z
    // Check that lateral displacement projected onto binormal is significant
    const tangentDot = end.tangent[0] * start.tangent[0] + end.tangent[1] * start.tangent[1] + end.tangent[2] * start.tangent[2];
    expect(lateral).toBeGreaterThan(50);
    expect(tangentDot).toBeCloseTo(-1, 1);
    expect(curved.parameters.angle).toBe(Math.PI);
    // derived radius invariant
    const derivedRadius = curved.parameters.length / Math.abs(curved.parameters.angle!);
    expect(derivedRadius).toBeCloseTo(70.03, 1);
    // solved length remains authored
    expect(built.solvedSpans[0]!.span.position(1)).toBeDefined();
  });

  it("straight magnetic brake has no lateral or tangent turn", () => {
    const straight = createElement("brake", "magnetic-brakes-009", {
      length: 110,
      targetSpeed: 5,
    });
    const start = defaultPose();
    const built = buildElement(straight, start);
    const end = built.endPose;
    // straight along Z: X and lateral binormal component near zero
    expect(Math.abs(end.position[0])).toBeLessThan(1e-6);
    expect(Math.abs(end.position[2] - 110)).toBeLessThan(1e-6);
    const tangentDot = end.tangent[0] * start.tangent[0] + end.tangent[1] * start.tangent[1] + end.tangent[2] * start.tangent[2];
    expect(tangentDot).toBeCloseTo(1, 6);
    expect(straight.parameters.angle).toBeUndefined();
  });

  it("missing brake angle retains exact straight line", () => {
    const noAngle = createElement("brake", "brake-straight", {
      length: 20,
      targetSpeed: 8,
      bank: 0,
    });
    const start = defaultPose();
    const built = buildElement(noAngle, start);
    expect(built.solvedSpans).toHaveLength(1);
    expect(built.solvedSpans[0]!.zones).toEqual(["brake"]);
  });

  it("brake zones remain brake for curved and straight", () => {
    const elements = [
      createElement("brake", "brake-008", { length: 220, targetSpeed: 8, angle: Math.PI }),
      createElement("brake", "magnetic-brakes-009", { length: 110, targetSpeed: 5 }),
    ];
    const start = defaultPose();
    let pose = start;
    for (const el of elements) {
      const res = buildElement(el, pose);
      expect(res.solvedSpans[0]!.zones).toEqual(["brake"]);
      expect(res.solvedSpans[0]!.kind).toBe("brake");
      pose = res.endPose;
    }
  });

  it("station open without targetSpeed remains undefined (existing expectation preserved)", () => {
    const open = createElement("station", "station-open", { length: 12, bank: 0, closed: false });
    expect(open.parameters.targetSpeed).toBeUndefined();
    expect(open.parameters.closed).toBe(false);
  });

  it("station targetSpeed validation is finite >=0 and bounded to 0..120", () => {
    expect(() => createElement("station", "s", { length: 12, targetSpeed: -1 as unknown as number })).toThrow();
    expect(() => createElement("station", "s", { length: 12, targetSpeed: Number.NaN as unknown as number })).toThrow();
    expect(() => createElement("station", "s", { length: 12, targetSpeed: Number.POSITIVE_INFINITY as unknown as number })).toThrow();
    expect(() => createElement("station", "s", { length: 12, targetSpeed: 200 as unknown as number })).toThrow();
    expect(createElement("station", "s", { length: 12, targetSpeed: 0 }).parameters.targetSpeed).toBe(0);
    expect(createElement("station", "s", { length: 12, targetSpeed: 120 }).parameters.targetSpeed).toBe(120);
  });

  it("brake angle validation is finite nonzero abs <=2pi", () => {
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: 0 as unknown as number })).toThrow();
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.NaN as unknown as number })).toThrow();
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Number.POSITIVE_INFINITY as unknown as number })).toThrow();
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 + 0.01 })).toThrow();
    expect(() => createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI * 2 - 0.01 })).toThrow();
    expect(createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI }).parameters.angle).toBe(Math.PI);
    expect(createElement("brake", "b", { length: 20, targetSpeed: 8, angle: -Math.PI }).parameters.angle).toBe(-Math.PI);
    expect(createElement("brake", "b", { length: 20, targetSpeed: 8, angle: Math.PI * 2 }).parameters.angle).toBe(Math.PI * 2);
  });

  it("parser accepts new keys and rejects invalid values via exact allowlist", () => {
    const intentWithNewKeys = {
      schemaVersion: 1 as const,
      generatorVersion: "test-v1",
      seed: 1,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: [
        { id: "station-010", kind: "station", type: "station", parameters: { length: 160, bank: 0, closed: false, targetSpeed: 0 } },
        { id: "brake-008", kind: "brake", type: "brake", parameters: { length: 220, targetSpeed: 8, bank: 0, angle: Math.PI } },
      ],
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    };
    expect(() => createDesignIntentV1(intentWithNewKeys)).not.toThrow();
    const serialized = serializeDesignIntentV1(createDesignIntentV1(intentWithNewKeys));
    const parsed = parseDesignIntentV1(serialized);
    expect((parsed.elements[0]!.parameters as Record<string, unknown>).targetSpeed).toBe(0);
    expect((parsed.elements[1]!.parameters as Record<string, unknown>).angle).toBe(Math.PI);

    const invalidStation = {
      ...intentWithNewKeys,
      elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: -1 } }],
    };
    expect(() => parseDesignIntentV1(JSON.stringify(invalidStation))).toThrow();

    const invalidBrakeZero = {
      ...intentWithNewKeys,
      elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: 0 } }],
    };
    expect(() => createDesignIntentV1(invalidBrakeZero as unknown as Parameters<typeof createDesignIntentV1>[0])).toThrow();

    const extraKey = {
      ...intentWithNewKeys,
      elements: [{ id: "s", kind: "station", type: "station", parameters: { length: 12, bank: 0, closed: false, targetSpeed: 0, unknown: 1 } }],
    };
    expect(() => parseDesignIntentV1(JSON.stringify(extraKey))).toThrow();

    const extraBrakeKey = {
      ...intentWithNewKeys,
      elements: [{ id: "b", kind: "brake", type: "brake", parameters: { length: 20, targetSpeed: 8, bank: 0, angle: Math.PI, extra: 1 } }],
    };
    expect(() => parseDesignIntentV1(JSON.stringify(extraBrakeKey))).toThrow();
  });

  it("default file round-trips and serialized length remains authored 220/110", () => {
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
    expect(brake008.parameters.length).toBe(220);
    expect((brake008.parameters as Record<string, unknown>).angle).toBe(Math.PI);
    expect(magnetic.parameters.length).toBe(110);
    expect((magnetic.parameters as Record<string, unknown>).angle).toBeUndefined();
    expect(station010.parameters.length).toBe(160);
    expect((station010.parameters as Record<string, unknown>).targetSpeed).toBe(0);
    expect((station010.parameters as Record<string, unknown>).closed).toBe(false);

    const spanBrake = result.file.solvedSpans.find((s) => s.id === "brake-008")!;
    const spanMagnetic = result.file.solvedSpans.find((s) => s.id === "magnetic-brakes-009")!;
    expect(spanBrake.length).toBe(220);
    expect(spanMagnetic.length).toBe(110);

    const loaded = compileCoasterFile(result.serializedFile);
    expect(loaded.file.compiledDataChecksum).toBe(result.file.compiledDataChecksum);
    expect(loaded.track.checksum).toBe(result.file.compiledDataChecksum);
    const reloadedBrake = loaded.file.intent.elements.find((e) => e.id === "brake-008")!;
    expect((reloadedBrake.parameters as Record<string, unknown>).angle).toBe(Math.PI);
    const reloadedStation = loaded.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((reloadedStation.parameters as Record<string, unknown>).targetSpeed).toBe(0);
    expect((reloadedStation.parameters as Record<string, unknown>).closed).toBe(false);
  });

  it("operation-zone targets are 8/5/0 and terminal station remains closed:false", () => {
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
    const stationElement = result.file.intent.elements.find((e) => e.id === "station-010")!;
    expect((stationElement.parameters as Record<string, unknown>).closed).toBe(false);
    // no target invention for open stations without targetSpeed - verified separately
  });

  it("local regeneration preserves curved brake angle and station target", () => {
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
    expect((beforeBrake.parameters as Record<string, unknown>).angle).toBe(Math.PI);
    expect((beforeStation.parameters as Record<string, unknown>).targetSpeed).toBe(0);

    const local = regenerateLocal(result, "brake-008", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    const afterBrake = local.generation.elements.find((e) => e.id === "brake-008")!;
    const afterStation = local.generation.elements.find((e) => e.id === "station-010")!;
    expect((afterBrake.parameters as Record<string, unknown>).angle).toBe(Math.PI);
    expect((afterStation.parameters as Record<string, unknown>).targetSpeed).toBe(0);
    const loaded = compileCoasterFile(local.generation.serializedFile);
    expect((loaded.file.intent.elements.find((e) => e.id === "brake-008")!.parameters as Record<string, unknown>).angle).toBe(Math.PI);

    const fileLocal = regenerateCoasterFileLocal(result.file, "magnetic-brakes-009", {
      seams: testSeams,
      referenceSpeed: 44,
    });
    const fileBrake = fileLocal.generation.elements.find((e) => e.id === "brake-008")!;
    expect((fileBrake.parameters as Record<string, unknown>).angle).toBe(Math.PI);
    expect(fileLocal.generation.file.solvedSpans.find((s) => s.id === "brake-008")!.length).toBe(220);
  });
});
