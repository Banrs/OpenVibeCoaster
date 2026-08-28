import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CoasterFileError,
  CompiledTrackData,
  HeightfieldEnvironment,
  SeventhOrderHermiteSpan,
  QuinticScalarSpan,
  Xoshiro128ss,
  aabbFromPoints,
  arcLength,
  compileTrack,
  createCoasterFileV1,
  deserializeCoasterFileV1,
  hashSeed,
  meters,
  metresPerSecond,
  parseCoasterFile,
  radians,
  sampleCompiledTrack,
  seconds,
  serializeCoasterFileV1,
  transportFrames,
  transportFramesAlongPath,
  buildArcLengthLut,
  invertArcLength,
  quatFromAxisAngle,
  quatRotateVector,
  vec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from "./index";
import type { Aabb, CompiledTrackDataInput, Vec3 } from "./index";

type MutableCompiledTrackDataInput = {
  -readonly [Key in keyof CompiledTrackDataInput]: CompiledTrackDataInput[Key];
};

const validCompiledTrackInput = (): CompiledTrackDataInput => ({
  positions: new Float64Array([0, 0, 0, 1, 0, 0]),
  tangents: new Float64Array([1, 0, 0, 1, 0, 0]),
  normals: new Float64Array([0, 1, 0, 0, 1, 0]),
  binormals: new Float64Array([0, 0, 1, 0, 0, 1]),
  distances: new Float64Array([0, 1]),
  curvature: new Float64Array([0, 0]),
  curvatureVector: new Float64Array(6),
  bank: new Float64Array([0, 0]),
  bankDerivative: new Float64Array([0, 0]),
  zoneMasks: new Uint32Array([0, 0]),
  zoneNames: ["lift"],
  elementIndices: new Uint32Array([0, 0]),
  elementBoundaries: new Uint32Array([0, 1]),
  parameters: new Float64Array([0, 1]),
  totalLength: 1,
});

describe("units and vectors", () => {
  it("constructs branded SI values without changing their numeric value", () => {
    expect(meters(2)).toBe(2);
    expect(seconds(3)).toBe(3);
    expect(metresPerSecond(4)).toBe(4);
    expect(radians(Math.PI)).toBe(Math.PI);
  });

  it("keeps right-handed vector algebra", () => {
    const x = vec3(1, 0, 0);
    const y = vec3(0, 1, 0);
    expect(vec3Cross(x, y)).toEqual([0, 0, 1]);
    expect(vec3Dot(x, y)).toBe(0);
    expect(vec3Add(x, y)).toEqual([1, 1, 0]);
    expect(vec3Sub(x, y)).toEqual([1, -1, 0]);
    expect(vec3Scale(x, 3)).toEqual([3, 0, 0]);
  });

  it("rotates rigidly with unit quaternions", () => {
    expect(
      quatRotateVector(
        quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2),
        vec3(1, 0, 0),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.closeTo(0, 10),
        0,
        expect.closeTo(-1, 10),
      ]),
    );
  });

  it("normalizes every non-zero finite vector", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({ min: -100, max: 100, noNaN: true }),
          fc.double({ min: -100, max: 100, noNaN: true }),
          fc.double({ min: -100, max: 100, noNaN: true }),
        ),
        ([x, y, z]) => {
          const input = vec3(x, y, z);
          if (vec3Length(input) < 1e-10) return;
          expect(vec3Length(vec3Normalize(input))).toBeCloseTo(1, 10);
        },
      ),
    );
  });

  it("builds immutable AABBs", () => {
    const box: Aabb = aabbFromPoints([vec3(-1, 2, 3), vec3(4, -2, 0)]);
    expect(box.min).toEqual([-1, -2, 0]);
    expect(box.max).toEqual([4, 2, 3]);
  });
});

describe("deterministic random streams", () => {
  it("hashes seeds and forks named streams deterministically", () => {
    expect(hashSeed("track")).toBe(hashSeed("track"));
    const a = new Xoshiro128ss(hashSeed("seed"));
    const b = new Xoshiro128ss(hashSeed("seed"));
    expect(Array.from({ length: 8 }, () => a.nextUint32())).toEqual(
      Array.from({ length: 8 }, () => b.nextUint32()),
    );
    expect(new Xoshiro128ss(1).fork("geometry").nextUint32()).toBe(
      new Xoshiro128ss(1).fork("geometry").nextUint32(),
    );
    expect(new Xoshiro128ss(1).nextFloat()).toBeGreaterThanOrEqual(0);
    expect(new Xoshiro128ss(1).nextFloat()).toBeLessThan(1);
  });

  it("keeps named streams independent", () => {
    const geometry = new Xoshiro128ss(123).fork("geometry");
    const bank = new Xoshiro128ss(123).fork("bank");
    expect(Array.from({ length: 8 }, () => geometry.nextUint32())).not.toEqual(
      Array.from({ length: 8 }, () => bank.nextUint32()),
    );
  });
});

describe("analytic spans and arc length", () => {
  it("matches seventh-order position derivatives at both endpoints", () => {
    const span = new SeventhOrderHermiteSpan({
      p0: 0,
      d10: 2,
      d20: 3,
      d30: 4,
      p1: 10,
      d11: -2,
      d21: 5,
      d31: -6,
    });
    expect(span.position(0)).toBe(0);
    expect(span.derivative(0, 1)).toBe(2);
    expect(span.derivative(0, 2)).toBe(3);
    expect(span.derivative(0, 3)).toBe(4);
    expect(span.position(1)).toBe(10);
    expect(span.derivative(1, 1)).toBe(-2);
    expect(span.derivative(1, 2)).toBe(5);
    expect(span.derivative(1, 3)).toBe(-6);
  });

  it("constructs a C3 join and quintic bank endpoints", () => {
    const left = SeventhOrderHermiteSpan.line(0, 10);
    const right = SeventhOrderHermiteSpan.line(10, 20);
    expect(
      SeventhOrderHermiteSpan.c3Join(left, right).derivative(1, 1),
    ).toBeCloseTo(10);
    const bank = new QuinticScalarSpan({
      v0: 0,
      d10: 0,
      d20: 0,
      v1: 0.5,
      d11: 0.2,
      d21: -0.1,
    });
    expect(bank.value(0)).toBe(0);
    expect(bank.derivative(0, 1)).toBe(0);
    expect(bank.derivative(0, 2)).toBe(0);
    expect(bank.value(1)).toBe(0.5);
    expect(bank.derivative(1, 1)).toBe(0.2);
    expect(bank.derivative(1, 2)).toBe(-0.1);
  });

  it("integrates a line and a circle and inverts arc length", () => {
    const line = {
      position: (u: number) => vec3(u * 10, 0, 0),
      derivative: () => vec3(10, 0, 0),
    };
    expect(arcLength(line, 0, 1)).toBeCloseTo(10, 10);
    const radius = 3;
    const circle = {
      position: (u: number) =>
        vec3(radius * Math.cos(u), 0, radius * Math.sin(u)),
      derivative: (u: number) =>
        vec3(-radius * Math.sin(u), 0, radius * Math.cos(u)),
    };
    expect(arcLength(circle, 0, Math.PI * 2)).toBeCloseTo(
      2 * Math.PI * radius,
      8,
    );
    const helix = {
      position: (u: number) =>
        vec3(
          Math.cos(2 * Math.PI * u),
          2 * Math.PI * u,
          Math.sin(2 * Math.PI * u),
        ),
      derivative: (u: number) =>
        vec3(
          -2 * Math.PI * Math.sin(2 * Math.PI * u),
          2 * Math.PI,
          2 * Math.PI * Math.cos(2 * Math.PI * u),
        ),
    };
    const helixLut = buildArcLengthLut(helix, 32);
    expect(helixLut.totalLength).toBeCloseTo(Math.sqrt(2) * Math.PI * 2, 7);
    expect(
      invertArcLength(helix, helixLut, helixLut.totalLength / 2),
    ).toBeCloseTo(0.5, 7);
  });

  it("handles a high-curvature arc without losing inverse accuracy", () => {
    const radius = 0.01;
    const span = {
      position: (u: number) =>
        vec3(radius * Math.cos(20 * u), radius * Math.sin(20 * u), 0),
      derivative: (u: number) =>
        vec3(
          -20 * radius * Math.sin(20 * u),
          20 * radius * Math.cos(20 * u),
          0,
        ),
    };
    const lut = buildArcLengthLut(span, 8, 1e-10);
    expect(lut.totalLength).toBeCloseTo(radius * 20, 9);
    expect(invertArcLength(span, lut, lut.totalLength * 0.37)).toBeCloseTo(
      0.37,
      8,
    );
  });
});

describe("rotation-minimizing frames", () => {
  it("transports an orthonormal frame continuously through zero curvature and applies bank", () => {
    const frames = transportFrames(
      [vec3(1, 0, 0), vec3(1, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1)],
      [0, 0.2, 0.4, 0.6],
      (u) => (u * Math.PI) / 2,
    );
    for (const frame of frames) {
      expect(vec3Length(frame.tangent)).toBeCloseTo(1, 10);
      expect(vec3Length(frame.normal)).toBeCloseTo(1, 10);
      expect(vec3Dot(frame.tangent, frame.normal)).toBeCloseTo(0, 10);
      expect(
        vec3Dot(vec3Cross(frame.tangent, frame.normal), frame.binormal),
      ).toBeCloseTo(1, 10);
    }
    expect(frames[0]!.bank).toBeCloseTo(0);
    expect(frames[3]!.bank).toBeCloseTo((Math.PI * 3) / 10);
  });

  it("uses double reflection across a changing path without frame flips", () => {
    const positions = [
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      vec3(1.5, 0.5, 0),
      vec3(1.5, 1, 1),
      vec3(1, 1.5, 1),
    ];
    const tangents = [
      vec3(1, 0, 0),
      vec3(1, 0.2, 0),
      vec3(0.7, 0.7, 0),
      vec3(0, 0.7, 0.7),
      vec3(-0.2, 0.7, 0.7),
    ];
    const frames = transportFramesAlongPath(
      positions,
      tangents,
      [0, 1, 2, 3, 4],
      () => 0,
    );
    for (let index = 0; index < frames.length; index += 1) {
      expect(vec3Length(frames[index]!.normal)).toBeCloseTo(1, 10);
      expect(
        vec3Dot(frames[index]!.tangent, frames[index]!.normal),
      ).toBeCloseTo(0, 10);
      expect(
        vec3Dot(
          vec3Cross(frames[index]!.tangent, frames[index]!.normal),
          frames[index]!.binormal,
        ),
      ).toBeCloseTo(1, 10);
      if (index > 0)
        expect(
          vec3Dot(frames[index - 1]!.normal, frames[index]!.normal),
        ).toBeGreaterThan(0);
    }
    expect(frames).toHaveLength(positions.length);
  });

  it("rejects sparse or non-finite frame inputs deterministically", () => {
    const sparseTangents: Vec3[] = [];
    sparseTangents.length = 1;
    expect(() => transportFrames(sparseTangents)).toThrow(
      "Frame tangent samples must contain finite 3-vectors",
    );
    const sparseBanks: number[] = [];
    sparseBanks.length = 1;
    expect(() =>
      transportFramesAlongPath(
        [vec3(0, 0, 0)],
        [vec3(1, 0, 0)],
        [0],
        sparseBanks,
      ),
    ).toThrow("Frame bank samples must be finite numbers");
    expect(() =>
      transportFrames(
        [vec3(1, 0, 0)],
        [0],
        null as unknown as ArrayLike<number>,
      ),
    ).toThrow("Frame bank samples must be an array-like value");
    expect(() =>
      transportFrames([vec3(1, 0, 0)], [0], () => Number.NaN),
    ).toThrow("Frame bank samples must be finite numbers");
  });
});

describe("compiled track and heightfield", () => {
  it("rejects malformed compiled track data at its public boundary", () => {
    const malformed = (
      change: (input: MutableCompiledTrackDataInput) => void,
    ) => {
      const input = validCompiledTrackInput() as MutableCompiledTrackDataInput;
      change(input);
      expect(() => new CompiledTrackData(input)).toThrow(
        "Invalid compiled track data",
      );
    };

    malformed((input) => {
      input.positions = new Float64Array();
    });
    malformed((input) => {
      input.bank = new Float64Array([0]);
    });
    malformed((input) => {
      input.positions = new Float64Array([
        0,
        0,
        0,
        Number.POSITIVE_INFINITY,
        0,
        0,
      ]);
    });
    malformed((input) => {
      input.distances = new Float64Array([0, 0.5]);
    });
    malformed((input) => {
      input.totalLength = 2;
    });
    malformed((input) => {
      input.elementBoundaries = new Uint32Array([0, 2]);
    });
    malformed((input) => {
      input.elementIndices = new Uint32Array([0, 1]);
    });
    malformed((input) => {
      input.zoneMasks = new Uint32Array([2, 0]);
    });
    malformed((input) => {
      input.tangents = new Float64Array([2, 0, 0, 1, 0, 0]);
    });
    malformed((input) => {
      input.normals = new Float64Array([0, 1, 0, 1, 0, 0]);
    });
    malformed((input) => {
      input.curvature = new Float64Array([-1, 0]);
    });
  });

  it("rejects adjacent tangent interpolation that is too close to zero", () => {
    const input = validCompiledTrackInput() as MutableCompiledTrackDataInput;
    input.tangents = new Float64Array([1, 0, 0, -1, 1e-13, 0]);
    expect(() => new CompiledTrackData(input)).toThrow(
      "adjacent tangent interpolation must remain non-zero",
    );
  });

  it("rejects a real two-sample U-turn before sampling can normalize zero", () => {
    const halfCircle = {
      position: (u: number) =>
        vec3(
          Math.sin(Math.PI * u) / Math.PI,
          (1 - Math.cos(Math.PI * u)) / Math.PI,
          0,
        ),
      derivative: (u: number, order = 1) =>
        order === 1
          ? vec3(Math.cos(Math.PI * u), Math.sin(Math.PI * u), 0)
          : vec3(
              -Math.PI * Math.sin(Math.PI * u),
              Math.PI * Math.cos(Math.PI * u),
              0,
            ),
    };
    expect(() =>
      compileTrack([{ id: "u-turn", span: halfCircle }], { samples: 2 }),
    ).toThrow("adjacent tangent interpolation must remain non-zero");
  });

  it("rejects non-finite span derivative magnitudes before frame construction", () => {
    expect(() =>
      compileTrack(
        [
          {
            id: "infinite-derivative",
            span: {
              position: (u: number) => vec3(u, 0, 0),
              derivative: (u: number) =>
                u === 0.5
                  ? vec3(Number.POSITIVE_INFINITY, 0, 0)
                  : vec3(1, 0, 0),
            },
          },
        ],
        { samples: 3 },
      ),
    ).toThrow("finite and non-zero");
  });

  it("rejects an interior stationary derivative during arc-length compilation", () => {
    const span = {
      position: (u: number) => vec3(u, 0, 0),
      derivative: (u: number) => (u === 0.5 ? vec3(0, 0, 0) : vec3(1, 0, 0)),
    };
    expect(() => buildArcLengthLut(span, 4)).toThrow("finite and non-zero");
  });

  it("rejects a smooth off-grid stationary derivative", () => {
    const stationaryParameter = 0.37;
    const span = {
      position: (u: number) => vec3((u - stationaryParameter) ** 3 / 3, 0, 0),
      derivative: (u: number, order = 1) =>
        order === 1
          ? vec3((u - stationaryParameter) ** 2, 0, 0)
          : vec3(2 * (u - stationaryParameter), 0, 0),
    };
    expect(() => buildArcLengthLut(span, 4)).toThrow("finite and non-zero");
  });

  it("samples positions and metadata by physical distance brackets", () => {
    const input = validCompiledTrackInput() as MutableCompiledTrackDataInput;
    input.positions = new Float64Array([0, 0, 0, 10, 0, 0, 100, 0, 0]);
    input.tangents = new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    input.normals = new Float64Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    input.binormals = new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    input.distances = new Float64Array([0, 1, 10]);
    input.curvature = new Float64Array([0, 1, 2]);
    input.curvatureVector = new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    input.bank = new Float64Array([0, 2, 18]);
    input.bankDerivative = new Float64Array([0, 3, 27]);
    input.zoneMasks = new Uint32Array([0, 0, 0]);
    input.elementIndices = new Uint32Array([0, 0, 0]);
    input.elementBoundaries = new Uint32Array([0, 2]);
    input.parameters = new Float64Array([0, 0.5, 1]);
    input.totalLength = 10;
    const data = new CompiledTrackData(input);

    const sample = sampleCompiledTrack(data, 0.5);
    expect(sample.distance).toBe(5);
    expect(sample.position[0]).toBeCloseTo(50, 12);
    expect(sample.curvature).toBeCloseTo(1 + 4 / 9, 12);
    expect(sample.bank).toBeCloseTo(2 + (18 - 2) * (4 / 9), 12);
    expect(sample.bankDerivative).toBeCloseTo(3 + (27 - 3) * (4 / 9), 12);
  });

  it("compiles deterministic immutable typed arrays and samples them", () => {
    const data = compileTrack(
      [
        {
          id: "line",
          span: {
            position: (u: number) => vec3(u * 10, 2, 0),
            derivative: () => vec3(10, 0, 0),
          },
          zones: ["lift"],
        },
      ],
      { samples: 9 },
    );
    expect(data.positions.length).toBe(27);
    expect(data.curvatureVector.length).toBe(27);
    expect(data.elementBoundaries).toEqual(new Uint32Array([0, 8]));
    expect(data.zoneMasks.length).toBe(9);
    expect(data.distances[0]).toBe(0);
    expect(data.distances[8]).toBeCloseTo(data.totalLength);
    expect(Object.isFrozen(data)).toBe(true);
    expect(sampleCompiledTrack(data, 0.5).position[0]).toBeCloseTo(5);
    const midpoint = sampleCompiledTrack(data, 0.5);
    expect(vec3Length(midpoint.tangent)).toBeCloseTo(1, 10);
    expect(vec3Length(midpoint.normal)).toBeCloseTo(1, 10);
    expect(vec3Dot(midpoint.tangent, midpoint.normal)).toBeCloseTo(0, 10);
    expect(
      vec3Dot(vec3Cross(midpoint.tangent, midpoint.normal), midpoint.binormal),
    ).toBeCloseTo(1, 10);
    expect(data.checksum).toBe(
      compileTrack(
        [
          {
            id: "line",
            span: {
              position: (u: number) => vec3(u * 10, 2, 0),
              derivative: () => vec3(10, 0, 0),
            },
            zones: ["lift"],
          },
        ],
        { samples: 9 },
      ).checksum,
    );
  });

  it("uses inverted parameters for non-uniform metadata", () => {
    const span = {
      position: (u: number) => vec3(u, u * u, 0),
      derivative: (u: number, order = 1) =>
        order === 1 ? vec3(1, 2 * u, 0) : vec3(0, 2, 0),
    };
    const data = compileTrack(
      [{ id: "curve", span, bank: (u: number) => u * u }],
      { samples: 5 },
    );
    const u = data.parameters[2]!;
    const expectedCurvature = 2 / (1 + 4 * u * u) ** 1.5;
    expect(u).not.toBeCloseTo(0.5, 3);
    expect(data.curvature[2]).toBeCloseTo(expectedCurvature, 9);
    expect(data.bank[2]).toBeCloseTo(u * u, 12);
  });

  it("exposes signed curvature vectors for a horizontal circle", () => {
    const radius = 4;
    const data = compileTrack(
      [
        {
          id: "circle",
          span: {
            position: (u: number) =>
              vec3(radius * Math.cos(u), 0, radius * Math.sin(u)),
            derivative: (u: number, order = 1) =>
              order === 1
                ? vec3(-radius * Math.sin(u), 0, radius * Math.cos(u))
                : vec3(-radius * Math.cos(u), 0, -radius * Math.sin(u)),
          },
        },
      ],
      { samples: 33 },
    );
    const index = 8;
    const u = data.parameters[index]!;
    const vector = vec3(
      data.curvatureVector[index * 3]!,
      data.curvatureVector[index * 3 + 1]!,
      data.curvatureVector[index * 3 + 2]!,
    );
    expect(vector[0]).toBeCloseTo(-Math.cos(u) / radius, 10);
    expect(vector[1]).toBeCloseTo(0, 10);
    expect(vector[2]).toBeCloseTo(-Math.sin(u) / radius, 10);
    expect(vec3Length(vector)).toBeCloseTo(1 / radius, 10);
    expect(data.curvature[index]).toBeCloseTo(1 / radius, 10);
    const sample = sampleCompiledTrack(
      data,
      data.distances[index]! / data.totalLength,
    );
    expect(sample.curvatureVector).toEqual(
      expect.arrayContaining([
        expect.closeTo(vector[0], 10),
        expect.closeTo(vector[1], 10),
        expect.closeTo(vector[2], 10),
      ]),
    );
  });

  it("points curvature down at a crest and up at a valley", () => {
    const makeSpan = (direction: -1 | 1) => ({
      position: (u: number) => vec3(u, direction * (u - 0.5) ** 2, 0),
      derivative: (u: number, order = 1) =>
        order === 1
          ? vec3(1, direction * 2 * (u - 0.5), 0)
          : vec3(0, direction * 2, 0),
    });
    const crest = compileTrack([{ id: "crest", span: makeSpan(-1) }], {
      samples: 5,
    });
    const valley = compileTrack([{ id: "valley", span: makeSpan(1) }], {
      samples: 5,
    });
    expect(crest.curvatureVector[2 * 3 + 1]).toBeCloseTo(-2, 10);
    expect(valley.curvatureVector[2 * 3 + 1]).toBeCloseTo(2, 10);
  });

  it("reports bank derivative in radians per metre", () => {
    const data = compileTrack(
      [
        {
          id: "banked-line",
          span: {
            position: (u: number) => vec3(u * 4, 0, 0),
            derivative: () => vec3(4, 0, 0),
          },
          bank: (u: number) => u * 2,
        },
      ],
      { samples: 5 },
    );
    expect(Array.from(data.bankDerivative)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(sampleCompiledTrack(data, 0.5).bankDerivative).toBeCloseTo(0.5, 10);
  });

  it("does not expose authoritative arrays and includes metadata in checksums", () => {
    const make = (zone: string) =>
      compileTrack(
        [
          {
            id: "line",
            span: {
              position: (u: number) => vec3(u * 10, 0, 0),
              derivative: () => vec3(10, 0, 0),
            },
            zones: [zone],
          },
        ],
        { samples: 3 },
      );
    const data = make("lift");
    const checksum = data.checksum;
    const exposed = data.positions;
    exposed[0] = 999;
    expect(data.positions[0]).toBe(0);
    expect(data.checksum).toBe(checksum);
    expect(make("brake").checksum).not.toBe(checksum);
  });

  it("samples from owned arrays without invoking clone-producing getters", () => {
    const data = compileTrack(
      [
        {
          id: "line",
          span: {
            position: (u: number) => vec3(u * 10, 0, 0),
            derivative: () => vec3(10, 0, 0),
          },
        },
      ],
      { samples: 9 },
    );
    const checksum = data.checksum;
    const prototype = Object.getPrototypeOf(data) as object;
    const keys = [
      "distances",
      "positions",
      "tangents",
      "normals",
      "binormals",
      "curvature",
      "curvatureVector",
      "bank",
      "bankDerivative",
    ];
    const descriptors = new Map<string, PropertyDescriptor>();
    let getterCalls = 0;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor) throw new Error(`Missing ${key} getter`);
      descriptors.set(key, descriptor);
      Object.defineProperty(prototype, key, {
        configurable: true,
        get: () => {
          getterCalls += 1;
          throw new Error(`Unexpected ${key} getter call`);
        },
      });
    }
    try {
      for (let iteration = 0; iteration < 100; iteration += 1)
        sampleCompiledTrack(data, iteration / 99);
    } finally {
      for (const [key, descriptor] of descriptors)
        Object.defineProperty(prototype, key, descriptor);
    }
    expect(getterCalls).toBe(0);

    const exposedDistances = data.distances;
    exposedDistances[0] = 999;
    expect(data.distances[0]).toBe(0);
    const exposedCurvatureVector = data.curvatureVector;
    exposedCurvatureVector[0] = 999;
    expect(data.curvatureVector[0]).toBe(0);
    expect(data.checksum).toBe(checksum);
  });

  it("answers heightfield distance and raycast queries", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 1, 2, 3]),
    });
    expect(env.signedDistance(vec3(0.5, 2, 0.5))).toBeCloseTo(
      0.5 / Math.sqrt(6),
    );
    expect(
      env.raycast(vec3(0.5, 10, 0.5), vec3(0, -1, 0), 20)?.distance,
    ).toBeCloseTo(8.5);
  });

  it("uses the original heightfield column to determine signed-distance sign", () => {
    const steep = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 10, 0, 10]),
    });
    expect(steep.signedDistance(vec3(0.1, 1.5, 0.5))).toBeGreaterThan(0);
    expect(steep.signedDistance(vec3(0.1, 0.5, 0.5))).toBeLessThan(0);

    const curvedRidge = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights: new Float64Array([0, 5, 0, 5, 20, 5, 0, 5, 0]),
    });
    expect(curvedRidge.signedDistance(vec3(1.84, 11, 0.86))).toBeGreaterThan(0);
    expect(curvedRidge.signedDistance(vec3(1.84, 3, 0.86))).toBeLessThan(0);
  });

  it("finds the earliest crossing of a narrow double-crossing ridge", () => {
    const env = new HeightfieldEnvironment({
      width: 3,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 10, 0, 0, 10, 0]),
    });
    const hit = env.raycast(vec3(0.0078125, 9.999, 0.5), vec3(1, 0, 0), 2);
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(0.9920875, 8);
    expect(hit ? env.signedDistance(hit.point) : 1).toBeCloseTo(0, 8);
  });

  it("returns the first of two symmetric crossings inside one bilinear cell", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 0, 0, -2 / 3]),
    });
    const direction = vec3(Math.sqrt(3 / 8), -0.5, Math.sqrt(3 / 8));
    const hit = env.raycast(vec3(0, 0.25 - 0.25 * 1e-8, 0), direction, 2);
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(0.9999, 8);
    expect(hit ? env.signedDistance(hit.point) : 1).toBeCloseTo(0, 8);
  });

  it("finds a tangential root without an endpoint sign change", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 0, 0, -2 / 3]),
    });
    const direction = vec3(Math.sqrt(3 / 8), -0.5, Math.sqrt(3 / 8));
    const hit = env.raycast(vec3(0, 0.25, 0), direction, 2);
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(1, 8);
    expect(hit ? env.signedDistance(hit.point) : 1).toBeCloseTo(0, 8);
  });

  it("accepts a valid root at extreme finite height scale", () => {
    const extremeHeight = 1e12 * Math.PI;
    const crossingCoordinate = 0.009;
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 0, 0, extremeHeight]),
    });
    const hit = env.raycast(
      vec3(0, extremeHeight * crossingCoordinate ** 2, 0),
      vec3(1, 0, 1),
      0.1,
    );
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(crossingCoordinate * Math.sqrt(2), 12);
  });

  it("bounds no-hit work for an extreme terrain slope", () => {
    const env = new HeightfieldEnvironment({
      width: 2,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 1e12, 0, 1e12]),
    });
    expect(env.raycast(vec3(0.25, 0, 0), vec3(0, 0, 1), 1e6)).toBeUndefined();
  });

  it("returns a root exactly on a shared grid edge", () => {
    const env = new HeightfieldEnvironment({
      width: 3,
      depth: 2,
      cellSize: 1,
      heights: new Float64Array([0, 1, 0, 0, 1, 0]),
    });
    const hit = env.raycast(vec3(0, 1, 0.5), vec3(1, 0, 0), 2);
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(1, 10);
    expect(hit ? env.signedDistance(hit.point) : 1).toBeCloseTo(0, 8);
  });

  it("measures geometric distance and refines arbitrary ray intersections", () => {
    const plane = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights: new Float64Array([0, 1, 2, 0, 1, 2, 0, 1, 2]),
    });
    expect(plane.signedDistance(vec3(0.5, 1.5, 0.5))).toBeCloseTo(
      1 / Math.sqrt(2),
      7,
    );
    const heights = new Float64Array(9);
    for (let z = 0; z < 3; z += 1)
      for (let x = 0; x < 3; x += 1) heights[z * 3 + x] = x + z * z * 0.1;
    const env = new HeightfieldEnvironment({
      width: 3,
      depth: 3,
      cellSize: 1,
      heights,
    });
    expect(env.signedDistance(vec3(0.5, 1.5, 0.5))).toBeLessThan(0.8);
    const direction = vec3Normalize(vec3(1, -1, 0));
    const hit = plane.raycast(vec3(0.2, 2, 0.5), direction, 10);
    expect(hit).toBeDefined();
    expect(hit?.distance).toBeCloseTo(1.8 / Math.sqrt(2), 6);
    expect(hit ? plane.signedDistance(hit.point) : 1).toBeCloseTo(0, 8);
  });
});

describe("coaster file v1", () => {
  it("round-trips and rejects unknown schema versions", () => {
    const file = createCoasterFileV1({
      name: "demo",
      seed: 42,
      design: { elements: [] },
    });
    const encoded = serializeCoasterFileV1(file);
    expect(deserializeCoasterFileV1(encoded)).toEqual(file);
    expect(() =>
      parseCoasterFile(JSON.stringify({ schemaVersion: 99 })),
    ).toThrow(CoasterFileError);
    expect(() =>
      parseCoasterFile(JSON.stringify({ schemaVersion: 1, name: "bad" })),
    ).toThrow("seed: expected uint32 integer");
  });

  it("rejects truncated UTF-8 input", () => {
    expect(() => parseCoasterFile(new Uint8Array([0xc2]))).toThrow(
      "Invalid UTF-8 encoding",
    );
  });

  it("rejects every malformed UTF-8 sequence before JSON parsing", () => {
    const malformed = [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x28, 0xa1],
      [0xf0, 0x9f, 0x92],
    ];
    for (const bytes of malformed)
      expect(() => parseCoasterFile(new Uint8Array(bytes))).toThrow(
        "Invalid UTF-8 encoding",
      );
  });

  it("rejects malformed nested fields with precise paths", () => {
    const malformed = (design: unknown) =>
      parseCoasterFile(
        JSON.stringify({ schemaVersion: 1, name: "demo", seed: 42, design }),
      );
    expect(() => malformed({ elements: [{ id: null }] })).toThrow(
      "design.elements[0].id: expected string",
    );
    expect(() => malformed([])).toThrow("design: expected object");
    expect(() => malformed({ elements: [[]] })).toThrow(
      "design.elements[0]: expected object",
    );
    expect(() =>
      malformed({ elements: [{ id: "e", parameters: [] }] }),
    ).toThrow("design.elements[0].parameters: expected object");
    expect(() => malformed({ elements: [], gates: [[]] })).toThrow(
      "design.gates[0]: expected object",
    );
    expect(() => malformed({ elements: [], constraints: [[]] })).toThrow(
      "design.constraints[0]: expected object",
    );
    expect(() => malformed({ elements: [], solvedSpans: [[]] })).toThrow(
      "design.solvedSpans[0]: expected object",
    );
    expect(() =>
      malformed({ elements: [], gates: [{ id: "g", at: "x", kind: "s" }] }),
    ).toThrow("design.gates[0].at: expected finite number");
    expect(() =>
      malformed({
        elements: [],
        constraints: [{ id: "c", kind: "g", value: 1, hard: null }],
      }),
    ).toThrow("design.constraints[0].hard: expected boolean");
    expect(() =>
      malformed({ elements: [{ id: "e", parameters: { width: null } }] }),
    ).toThrow("design.elements[0].parameters.width: expected primitive value");
    expect(() => malformed({ elements: [{ id: "e", target: null }] })).toThrow(
      "design.elements[0].target: expected string or finite number",
    );
    expect(() =>
      malformed({
        elements: [],
        gates: [{ id: "g", at: 0, kind: "s", pinned: null }],
      }),
    ).toThrow("design.gates[0].pinned: expected boolean");
    expect(() =>
      malformed({
        elements: [],
        solvedSpans: [{ id: "s", coefficients: [[1, null]] }],
      }),
    ).toThrow(
      "design.solvedSpans[0].coefficients[0][1]: expected finite number",
    );
    expect(() =>
      parseCoasterFile(
        JSON.stringify({
          schemaVersion: 1,
          name: "demo",
          seed: 4294967296,
          design: { elements: [] },
        }),
      ),
    ).toThrow("seed: expected uint32 integer");
  });
});
