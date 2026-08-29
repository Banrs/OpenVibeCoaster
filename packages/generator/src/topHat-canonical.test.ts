import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  createCoasterFileV1,
  QuinticScalarSpan,
  serializeCoasterFileV1,
  serializeSolvedSpanV1,
  SeventhOrderHermiteSpan,
  vec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from "@openvibecoaster/core";
import {
  compileSemanticChain,
  createElement,
  diagnoseSeams,
  type Pose,
} from "./index";

const startPose: Pose = {
  position: vec3(17, -11, 29),
  tangent: vec3(1, 2, 3),
  normal: vec3(-2, 3, -1),
  bank: 0.31,
};

const elements = [
  createElement("station", "station-000", { length: 12, bank: 0.31 }),
  createElement("topHat", "topHat-001", { width: 40, bank: 0.73 }),
  createElement("station", "station-002", { length: 12, bank: 0.73 }),
] as const;

const positionFromCoefficients = (span: {
  readonly positionCoefficients?: readonly (readonly number[])[];
}) => {
  if (!span.positionCoefficients)
    throw new Error("Missing position coefficients");
  return SeventhOrderHermiteSpan.fromCoefficients(span.positionCoefficients);
};

const rollFromCoefficients = (span: {
  readonly rollCoefficients?: readonly number[];
}) => {
  if (!span.rollCoefficients) throw new Error("Missing roll coefficients");
  return QuinticScalarSpan.fromCoefficients(span.rollCoefficients);
};

describe("canonical top-hat coefficients", () => {
  it("adds arbitrary start-basis correction once to the canonical roll", () => {
    const result = compileSemanticChain(
      [createElement("topHat", "topHat-001", { width: 40, bank: 0.73 })],
      { startPose, samples: 32 },
    );
    const span = result.solvedSpans[0]!;
    const tangent = vec3Normalize(result.startPose.tangent);
    const reference =
      Math.abs(tangent[1]) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    const defaultNormal = vec3Normalize(
      vec3Sub(reference, vec3Scale(tangent, vec3Dot(reference, tangent))),
    );
    const correction = Math.atan2(
      vec3Dot(tangent, vec3Cross(defaultNormal, result.startPose.normal)),
      vec3Dot(defaultNormal, result.startPose.normal),
    );
    expect(span.bank!.position(0)).toBeCloseTo(startPose.bank + correction, 10);
    expect(span.bank!.position(1)).toBeCloseTo(0.73, 10);
    expect(span.bank).toBeInstanceOf(QuinticScalarSpan);
    expect((span.bank as QuinticScalarSpan).coefficients).toEqual(
      span.rollCoefficients,
    );

    const expectedNormal = vec3Normalize(
      vec3Add(
        vec3Scale(result.startPose.normal, Math.cos(startPose.bank)),
        vec3Scale(
          vec3Cross(tangent, result.startPose.normal),
          Math.sin(startPose.bank),
        ),
      ),
    );
    expect(
      vec3Dot(
        expectedNormal,
        vec3(
          result.track!.normals[0]!,
          result.track!.normals[1]!,
          result.track!.normals[2]!,
        ),
      ),
    ).toBeCloseTo(1, 10);
  });

  it("uses stored position and roll polynomials for runtime evaluation", () => {
    const result = compileSemanticChain(elements, { startPose, samples: 32 });
    expect(result.feasible).toBe(true);
    const span = result.solvedSpans[1]!;
    const position = positionFromCoefficients(span);
    const roll = rollFromCoefficients(span);

    for (const u of [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) {
      for (const order of [0, 1, 2, 3])
        expect(span.span.derivative(u, order)).toEqual(
          position.derivative(u, order),
        );
      for (const order of [0, 1, 2])
        expect(span.bank!.derivative(u, order)).toBe(roll.derivative(u, order));
    }

    const normal = result.startPose.normal;
    const heightAt = (u: number): number =>
      vec3Dot(vec3Sub(span.span.position(u), span.span.position(0)), normal);
    const apexHeight = heightAt(0.5);
    const offApexHeights = Array.from(
      { length: 1001 },
      (_, index) => index / 1000,
    )
      .filter((u) => u !== 0.5)
      .map(heightAt);
    expect(apexHeight).toBeCloseTo(80, 10);
    expect(Math.max(...offApexHeights)).toBeLessThan(apexHeight);
    expect(roll.position(0.5)).toBeCloseTo(startPose.bank + Math.PI, 8);
    expect(vec3Length(span.span.derivative(0, 1))).toBeGreaterThan(0);
    expect(vec3Length(span.span.derivative(1, 1))).toBeGreaterThan(0);

    const seams = diagnoseSeams(result.solvedSpans);
    expect(seams.every((seam) => seam.hardResiduals.positionM < 1e-4)).toBe(
      true,
    );
    expect(seams.every((seam) => seam.hardResiduals.tangentRad < 1e-5)).toBe(
      true,
    );
    expect(seams.every((seam) => seam.hardResiduals.curvaturePerM < 1e-4)).toBe(
      true,
    );
    expect(
      seams.every((seam) => seam.hardResiduals.curvatureGradientPerM2 < 1e-4),
    ).toBe(true);
    expect(
      seams.every((seam) => seam.hardResiduals.curvatureVectorJumpPerM < 1e-4),
    ).toBe(true);
    expect(seams.every((seam) => seam.hardResiduals.bankRad < 1e-4)).toBe(true);
    expect(
      seams.every((seam) => seam.hardResiduals.bankDerivativeRadPerM < 1e-4),
    ).toBe(true);
    expect(
      seams.every((seam) => seam.hardResiduals.specificForceJumpG < 0.05),
    ).toBe(true);
  });

  it("round-trips solved top-hat coefficients without re-solving", () => {
    const compiled = compileSemanticChain(elements, { startPose, samples: 32 });
    expect(compiled.track).toBeDefined();
    const solvedSpans = compiled.solvedSpans.map((span, index) =>
      serializeSolvedSpanV1(span, span.kind, index === 1 ? 40 : 12),
    );
    const intent = {
      schemaVersion: 1 as const,
      generatorVersion: "generator-v1",
      seed: 8,
      mode: "directed" as const,
      family: "steel-sitdown-lsm-v1" as const,
      elements: elements.map((element) => ({
        id: element.id,
        kind: element.type,
        type: element.type,
        parameters: element.parameters,
      })),
      gates: [],
      targets: [],
      constraints: [],
      pinnedElementIds: [],
    };
    const file = createCoasterFileV1({
      name: "canonical-top-hat",
      intent,
      solvedSpans,
      seed: intent.seed,
      generatorVersion: intent.generatorVersion,
      profileVersion: "profile-v1",
      researchSnapshotIds: [],
      compiledDataChecksum: compiled.track!.checksum,
    });
    const loaded = compileCoasterFile(serializeCoasterFileV1(file));

    expect(loaded.track.checksum).toBe(compiled.track!.checksum);
    expect(loaded.track.positions).toEqual(compiled.track!.positions);
    expect(loaded.track.tangents).toEqual(compiled.track!.tangents);
    expect(loaded.track.normals).toEqual(compiled.track!.normals);
    expect(loaded.track.binormals).toEqual(compiled.track!.binormals);
    expect(loaded.track.bank).toEqual(compiled.track!.bank);
    expect(loaded.track.bankDerivative).toEqual(compiled.track!.bankDerivative);
    expect(loaded.file.solvedSpans[1]!.rollCoefficients).toEqual(
      compiled.solvedSpans[1]!.rollCoefficients,
    );
    expect(loaded.file.solvedSpans[1]!.positionCoefficients).toEqual(
      compiled.solvedSpans[1]!.positionCoefficients,
    );
  });
});
