import { describe, expect, it } from "vitest";
import {
  compileCoasterFile,
  compileTrack,
  createCoasterFileV1,
  QuinticScalarSpan,
  reconstructSolvedSpan,
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
  type SolvedSpan,
  type Vec3,
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

const positionFromCoefficients = (span: SolvedSpan) => {
  const coefficients =
    span.positionCoefficients ??
    (span.span instanceof SeventhOrderHermiteSpan
      ? span.span.coefficients
      : undefined);
  if (!coefficients) throw new Error("Missing position coefficients");
  return SeventhOrderHermiteSpan.fromCoefficients<Vec3>(coefficients);
};

const rollFromCoefficients = (span: SolvedSpan) => {
  if (!span.rollCoefficients) throw new Error("Missing roll coefficients");
  return QuinticScalarSpan.fromCoefficients(span.rollCoefficients);
};

const analyticCurvatureGradient = (span: SolvedSpan, u: number): Vec3 => {
  const position = positionFromCoefficients(span);
  const d1 = position.derivative(u, 1);
  const d2 = position.derivative(u, 2);
  const d3 = position.derivative(u, 3);
  const speedSquared = vec3Dot(d1, d1);
  if (speedSquared <= 1e-24) return vec3(0, 0, 0);
  const projection = vec3Dot(d1, d2);
  const projectionDerivative = vec3Dot(d2, d2) + vec3Dot(d1, d3);
  const derivative = vec3Add(
    vec3Scale(d3, 1 / speedSquared),
    vec3Add(
      vec3Scale(d2, (-3 * projection) / speedSquared ** 2),
      vec3Scale(
        d1,
        -projectionDerivative / speedSquared ** 2 +
          (4 * projection ** 2) / speedSquared ** 3,
      ),
    ),
  );
  return vec3Scale(derivative, 1 / Math.sqrt(speedSquared));
};

const topHatSpans = (spans: readonly SolvedSpan[]): readonly SolvedSpan[] =>
  spans.filter((span) => span.id.startsWith("topHat-001#"));

const trackVector = (values: Float64Array, index: number): Vec3 =>
  vec3(values[index * 3]!, values[index * 3 + 1]!, values[index * 3 + 2]!);

describe("canonical top-hat coefficients", () => {
  it("preserves authored-frame ownership when an element ID contains #", () => {
    const plain = compileSemanticChain(
      [createElement("topHat", "plain", { width: 40, bank: 0.73 })],
      { startPose, samples: 32 },
    );
    const hashed = compileSemanticChain(
      [createElement("topHat", "hat#primary", { width: 40, bank: 0.73 })],
      { startPose, samples: 32 },
    );

    expect(hashed.solvedSpans.map((span) => span.id)).toEqual([
      "hat#primary#0",
      "hat#primary#1",
    ]);
    expect(hashed.solvedSpans.map((span) => span.rollCoefficients)).toEqual(
      plain.solvedSpans.map((span) => span.rollCoefficients),
    );
    expect(hashed.track?.normals).toEqual(plain.track?.normals);
    expect(hashed.track?.binormals).toEqual(plain.track?.binormals);
  });

  it("applies arbitrary authored-frame correction once across both children", () => {
    const result = compileSemanticChain(
      [createElement("topHat", "topHat-001", { width: 40, bank: 0.73 })],
      { startPose, samples: 32 },
    );
    const children = topHatSpans(result.solvedSpans);
    expect(children.map((span) => span.id)).toEqual([
      "topHat-001#0",
      "topHat-001#1",
    ]);
    const first = children[0]!;
    const second = children[1]!;
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
    const storedStartBank = first.bank!.position(0);
    const storedApexBank = first.bank!.position(1);
    expect(storedStartBank).toBeCloseTo(startPose.bank + correction, 12);
    expect(second.bank!.position(0)).toBeCloseTo(storedApexBank, 12);
    expect(storedApexBank - storedStartBank).toBeCloseTo(Math.PI, 12);
    expect(second.bank!.position(1)).toBeCloseTo(0.73, 12);
    for (const child of children) {
      expect(child.bank).toBeInstanceOf(QuinticScalarSpan);
      expect((child.bank as QuinticScalarSpan).coefficients).toEqual(
        child.rollCoefficients,
      );
    }
    for (const order of [0, 1, 2])
      expect(first.bank!.derivative(1, order)).toBeCloseTo(
        second.bank!.derivative(0, order),
        12,
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
      vec3Dot(expectedNormal, trackVector(result.track!.normals, 0)),
    ).toBeCloseTo(1, 10);
    const apexIndex = result.track!.elementBoundaries[1]!;
    expect(result.track!.bank[apexIndex]! - result.track!.bank[0]!).toBeCloseTo(
      Math.PI,
      12,
    );
  });

  it("uses two stored C3 position polynomials with one exact global apex", () => {
    const result = compileSemanticChain(elements, { startPose, samples: 32 });
    expect(result.feasible).toBe(true);
    const children = topHatSpans(result.solvedSpans);
    expect(children.map((span) => span.id)).toEqual([
      "topHat-001#0",
      "topHat-001#1",
    ]);
    for (const child of children) {
      const position = positionFromCoefficients(child);
      const roll = rollFromCoefficients(child);
      for (const u of [0, 0.1, 0.35, 0.5, 0.65, 0.9, 1]) {
        for (const order of [0, 1, 2, 3])
          expect(child.span.derivative(u, order)).toEqual(
            position.derivative(u, order),
          );
        for (const order of [0, 1, 2])
          expect(child.bank!.derivative(u, order)).toBeCloseTo(
            roll.derivative(u, order),
            14,
          );
      }
    }
    for (const order of [0, 1, 2, 3])
      expect(
        vec3Length(
          vec3Sub(
            children[0]!.span.derivative(1, order),
            children[1]!.span.derivative(0, order),
          ),
        ),
      ).toBeLessThan(1e-10);

    const authoredNormal = result.startPose.normal;
    const authoredStart = children[0]!.span.position(0);
    const positionAt = (u: number): Vec3 =>
      u <= 0.5
        ? children[0]!.span.position(u * 2)
        : children[1]!.span.position(u * 2 - 1);
    const heightAt = (u: number): number =>
      vec3Dot(vec3Sub(positionAt(u), authoredStart), authoredNormal);
    const apexHeight = heightAt(0.5);
    const offApexHeights = Array.from(
      { length: 2001 },
      (_, index) => index / 2000,
    )
      .filter((u) => u !== 0.5)
      .map(heightAt);
    expect(apexHeight).toBeCloseTo(80, 10);
    expect(Math.max(...offApexHeights)).toBeLessThan(apexHeight);
  });

  it("reports analytic curvature-vector gradient jumps from stored d1/d2/d3", () => {
    const incoming = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [-40, 40, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const rejectedSingleSpan = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [0, 40, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 5120, -15360, 15360, -5120, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const shortcutRegression = diagnoseSeams([
      { id: "incoming", span: incoming },
      { id: "rejected", span: rejectedSingleSpan },
    ])[0]!;
    expect(shortcutRegression.curvatureGradientPerM2).toBeCloseTo(0.48, 12);

    const result = compileSemanticChain(elements, { startPose, samples: 32 });
    const seams = diagnoseSeams(result.solvedSpans);
    expect(seams).toHaveLength(result.solvedSpans.length - 1);
    seams.forEach((seam, index) => {
      const expected = vec3Length(
        vec3Sub(
          analyticCurvatureGradient(result.solvedSpans[index]!, 1),
          analyticCurvatureGradient(result.solvedSpans[index + 1]!, 0),
        ),
      );
      expect(seam.positionM).toBeLessThan(1e-10);
      expect(seam.tangentRad).toBeLessThan(1e-10);
      expect(seam.curvaturePerM).toBeLessThan(1e-10);
      expect(seam.curvatureVectorJumpPerM).toBeLessThan(1e-10);
      expect(seam.curvatureGradientPerM2).toBeCloseTo(expected, 12);
      expect(expected).toBeLessThan(1e-10);
      expect(seam.bankRad).toBeLessThan(1e-10);
      expect(seam.bankDerivativeRadPerM).toBeLessThan(1e-10);
    });
  });

  it("keeps degenerate-speed curvature-gradient diagnostics finite", () => {
    const zeroPosition = SeventhOrderHermiteSpan.fromCoefficients<Vec3>([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
    const zeroBank = QuinticScalarSpan.fromCoefficients([0, 0, 0, 0, 0, 0]);
    const degenerate: SolvedSpan = {
      id: "degenerate",
      span: zeroPosition,
      bank: zeroBank,
      positionCoefficients: zeroPosition.coefficients,
      rollCoefficients: zeroBank.coefficients,
    };
    const diagnostic = diagnoseSeams([degenerate, degenerate])[0]!;
    expect(Number.isFinite(diagnostic.curvatureGradientPerM2)).toBe(true);
  });

  it("round-trips every canonical child without re-solving", () => {
    const compiled = compileSemanticChain(elements, { startPose });
    expect(compiled.track).toBeDefined();
    const solvedSpans = compiled.solvedSpans.map((span) =>
      serializeSolvedSpanV1(span, span.kind, span.kind === "topHat" ? 20 : 12),
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
    const reconstructed = solvedSpans.map(reconstructSolvedSpan);
    const reconstructedTrack = compileTrack(reconstructed);
    expect(reconstructedTrack.positions).toEqual(compiled.track!.positions);
    expect(reconstructedTrack.tangents).toEqual(compiled.track!.tangents);
    expect(reconstructedTrack.normals).toEqual(compiled.track!.normals);
    expect(reconstructedTrack.binormals).toEqual(compiled.track!.binormals);
    expect(reconstructedTrack.bank).toEqual(compiled.track!.bank);
    expect(reconstructedTrack.bankDerivative).toEqual(
      compiled.track!.bankDerivative,
    );
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
    expect(topHatSpans(loaded.solvedSpans).map((span) => span.id)).toEqual(
      topHatSpans(compiled.solvedSpans).map((span) => span.id),
    );
    expect(
      topHatSpans(loaded.solvedSpans).map((span) => span.rollCoefficients),
    ).toEqual(
      topHatSpans(compiled.solvedSpans).map((span) => span.rollCoefficients),
    );
    expect(
      topHatSpans(loaded.solvedSpans).map((span) => span.positionCoefficients),
    ).toEqual(
      topHatSpans(compiled.solvedSpans).map(
        (span) => span.positionCoefficients,
      ),
    );
  });
});
