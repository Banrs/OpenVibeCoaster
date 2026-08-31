import { describe, expect, it } from "vitest";
import { compileTrack, sampleCompiledTrack, vec3 } from "./index";

describe("compileTrack equivariance with initialNormal", () => {
  it("rotates tangent/normal/binormal equivariantly with rotated geometry and rotated initialNormal", () => {
    const initialNormal = vec3(0, 1, 0);
    const axis = vec3(1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14));
    const angle = 0.7;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const oneMinusCosine = 1 - cosine;
    const rotateVector = (value: ReturnType<typeof vec3>) => {
      const [x, y, z] = value;
      return vec3(
        (cosine + axis[0] ** 2 * oneMinusCosine) * x +
          (axis[0] * axis[1] * oneMinusCosine - axis[2] * sine) * y +
          (axis[0] * axis[2] * oneMinusCosine + axis[1] * sine) * z,
        (axis[1] * axis[0] * oneMinusCosine + axis[2] * sine) * x +
          (cosine + axis[1] ** 2 * oneMinusCosine) * y +
          (axis[1] * axis[2] * oneMinusCosine - axis[0] * sine) * z,
        (axis[2] * axis[0] * oneMinusCosine - axis[1] * sine) * x +
          (axis[2] * axis[1] * oneMinusCosine + axis[0] * sine) * y +
          (cosine + axis[2] ** 2 * oneMinusCosine) * z,
      );
    };
    const translation = vec3(3, -4, 7);
    const rotatePosition = (value: ReturnType<typeof vec3>) => {
      const r = rotateVector(value);
      return vec3(
        r[0] + translation[0],
        r[1] + translation[1],
        r[2] + translation[2],
      );
    };

    const span = {
      position: (u: number) => vec3(u * 10, u * u * 3, u * 2),
      derivative: (u: number, order = 1) =>
        order === 1 ? vec3(10, 6 * u, 2) : vec3(0, 6, 0),
    };
    const rotatedSpan = {
      position: (u: number) => rotatePosition(span.position(u)),
      derivative: (u: number, order = 1) =>
        rotateVector(span.derivative(u, order)),
    };

    const original = compileTrack([{ id: "3d", span }], {
      samples: 64,
      initialNormal,
    });
    const rotated = compileTrack([{ id: "3d", span: rotatedSpan }], {
      samples: 64,
      initialNormal: rotateVector(initialNormal),
    });

    expect(rotated.totalLength).toBeCloseTo(original.totalLength, 10);

    const count = original.positions.length / 3;
    for (let i = 0; i < count; i += 1) {
      const origT = vec3(
        original.tangents[i * 3]!,
        original.tangents[i * 3 + 1]!,
        original.tangents[i * 3 + 2]!,
      );
      const rotT = vec3(
        rotated.tangents[i * 3]!,
        rotated.tangents[i * 3 + 1]!,
        rotated.tangents[i * 3 + 2]!,
      );
      const expT = rotateVector(origT);
      expect(rotT[0]).toBeCloseTo(expT[0], 8);
      expect(rotT[1]).toBeCloseTo(expT[1], 8);
      expect(rotT[2]).toBeCloseTo(expT[2], 8);

      const origN = vec3(
        original.normals[i * 3]!,
        original.normals[i * 3 + 1]!,
        original.normals[i * 3 + 2]!,
      );
      const rotN = vec3(
        rotated.normals[i * 3]!,
        rotated.normals[i * 3 + 1]!,
        rotated.normals[i * 3 + 2]!,
      );
      const expN = rotateVector(origN);
      expect(rotN[0]).toBeCloseTo(expN[0], 8);
      expect(rotN[1]).toBeCloseTo(expN[1], 8);
      expect(rotN[2]).toBeCloseTo(expN[2], 8);

      const origB = vec3(
        original.binormals[i * 3]!,
        original.binormals[i * 3 + 1]!,
        original.binormals[i * 3 + 2]!,
      );
      const rotB = vec3(
        rotated.binormals[i * 3]!,
        rotated.binormals[i * 3 + 1]!,
        rotated.binormals[i * 3 + 2]!,
      );
      const expB = rotateVector(origB);
      expect(rotB[0]).toBeCloseTo(expB[0], 8);
      expect(rotB[1]).toBeCloseTo(expB[1], 8);
      expect(rotB[2]).toBeCloseTo(expB[2], 8);
    }

    for (const t of [0, 0.17, 0.37, 0.71, 1]) {
      const a = sampleCompiledTrack(original, t);
      const b = sampleCompiledTrack(rotated, t);
      const expT = rotateVector(a.tangent);
      const expN = rotateVector(a.normal);
      const expB = rotateVector(a.binormal);
      expect(b.tangent[0]).toBeCloseTo(expT[0], 6);
      expect(b.tangent[1]).toBeCloseTo(expT[1], 6);
      expect(b.tangent[2]).toBeCloseTo(expT[2], 6);
      expect(b.normal[0]).toBeCloseTo(expN[0], 6);
      expect(b.normal[1]).toBeCloseTo(expN[1], 6);
      expect(b.normal[2]).toBeCloseTo(expN[2], 6);
      expect(b.binormal[0]).toBeCloseTo(expB[0], 6);
      expect(b.binormal[1]).toBeCloseTo(expB[1], 6);
      expect(b.binormal[2]).toBeCloseTo(expB[2], 6);
    }
  });

  it("rejects an explicit initialNormal parallel to the first tangent", () => {
    const span = {
      position: (u: number) => vec3(u * 10, 0, 0),
      derivative: () => vec3(10, 0, 0),
    };
    expect(() =>
      compileTrack([{ id: "line", span }], {
        samples: 16,
        initialNormal: vec3(10, 0, 0),
      }),
    ).toThrow(/Frame initial normal.*orthogonal/i);
    expect(() =>
      compileTrack([{ id: "line", span }], {
        samples: 16,
        initialNormal: vec3(-5, 0, 0),
      }),
    ).toThrow(RangeError);
  });
});
