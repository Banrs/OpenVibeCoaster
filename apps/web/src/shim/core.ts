// Self-contained core shim for web typecheck – implements minimal CompiledTrackData contracts without importing real core source (to keep noUnchecked strict).
// Runtime behavior matches core for tests; visual decisions remain restrained.

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type EnvironmentQuery = {
  signedDistance(point: Vec3): number;
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): { distance: number; point: Vec3; normal: Vec3 } | undefined;
};

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return Object.freeze([x, y, z]) as Vec3;
}
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export class Xoshiro128ss {
  private s: Uint32Array;
  constructor(seed: number) {
    this.s = new Uint32Array([
      seed,
      seed ^ 0x9e3779b9,
      seed ^ 0x85ebca6b,
      seed ^ 0xc2b2ae35,
    ]);
    if (
      (this.s[0] ?? 0) === 0 &&
      (this.s[1] ?? 0) === 0 &&
      (this.s[2] ?? 0) === 0 &&
      (this.s[3] ?? 0) === 0
    )
      this.s[0] = 1;
  }
  fork(name: string): Xoshiro128ss {
    return new Xoshiro128ss(hashSeed(String(this.s[0] ?? 0) + name));
  }
  nextUint32(): number {
    const s = this.s;
    const s0 = s[0] ?? 0;
    const s1 = s[1] ?? 0;
    const result = Math.imul(Math.imul(s0, 5), 0x9e3779b9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s[2] = (s[2] ?? 0) ^ s0;
    s[3] = (s[3] ?? 0) ^ s1;
    s[1] = s1 ^ (s[2] ?? 0);
    s[0] = s0 ^ (s[3] ?? 0);
    s[2] = (s[2] ?? 0) ^ t;
    s[3] = ((s[3] ?? 0) * 11) >>> 0;
    return result >>> 0;
  }
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }
}

// Minimal HeightfieldEnvironment – sufficient for support raycasts in tests
export class HeightfieldEnvironment implements EnvironmentQuery {
  width: number;
  depth: number;
  cellSize: number;
  heights: Float64Array;
  origin: readonly [number, number];
  constructor(options: {
    width: number;
    depth: number;
    cellSize: number;
    heights: ArrayLike<number>;
    origin?: readonly [number, number];
  }) {
    this.width = options.width;
    this.depth = options.depth;
    this.cellSize = options.cellSize;
    this.heights = new Float64Array(options.heights);
    this.origin = options.origin ?? [0, 0];
  }
  heightAt(x: number, z: number): number {
    const localX = (x - this.origin[0]) / this.cellSize;
    const localZ = (z - this.origin[1]) / this.cellSize;
    const clampedX = Math.max(0, Math.min(this.width - 1, localX));
    const clampedZ = Math.max(0, Math.min(this.depth - 1, localZ));
    const x0 = Math.min(this.width - 2, Math.floor(clampedX));
    const z0 = Math.min(this.depth - 2, Math.floor(clampedZ));
    const tx = clampedX - x0;
    const tz = clampedZ - z0;
    const at = (c: number, r: number) => this.heights[r * this.width + c] ?? 0;
    return (
      (1 - tz) * ((1 - tx) * at(x0, z0) + tx * at(x0 + 1, z0)) +
      tz * ((1 - tx) * at(x0, z0 + 1) + tx * at(x0 + 1, z0 + 1))
    );
  }
  signedDistance(point: Vec3): number {
    const h = this.heightAt(point[0], point[2]);
    return point[1] - h;
  }
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): { distance: number; point: Vec3; normal: Vec3 } | undefined {
    const dirLen = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const dx = direction[0] / dirLen;
    const dy = direction[1] / dirLen;
    const dz = direction[2] / dirLen;
    // Only handle vertical down ray for tests; fallback to simple
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9 && dy < 0) {
      const h = this.heightAt(origin[0], origin[2]);
      const dist = origin[1] - h;
      if (dist >= 0 && dist <= maxDistance) {
        return {
          distance: dist,
          point: vec3(origin[0], h, origin[2]),
          normal: vec3(0, 1, 0),
        };
      }
      return undefined;
    }
    // Generic step
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const t = (maxDistance * i) / steps;
      const x = origin[0] + dx * t;
      const y = origin[1] + dy * t;
      const z = origin[2] + dz * t;
      const h = this.heightAt(x, z);
      if (y <= h) {
        return { distance: t, point: vec3(x, h, z), normal: vec3(0, 1, 0) };
      }
    }
    return undefined;
  }
}

// Minimal CompiledTrackData – mirrors core's shape for tests
export class CompiledTrackData {
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly distances: Float64Array;
  readonly curvature: Float64Array;
  readonly bank: Float64Array;
  readonly bankDerivative: Float64Array;
  readonly zoneMasks: Uint32Array;
  readonly zoneNames: readonly string[];
  readonly elementIndices: Uint32Array;
  readonly elementBoundaries: Uint32Array;
  readonly parameters: Float64Array;
  readonly totalLength: number;
  readonly checksum: string;
  constructor(input: {
    positions: Float64Array;
    tangents: Float64Array;
    normals: Float64Array;
    binormals: Float64Array;
    distances: Float64Array;
    curvature: Float64Array;
    bank: Float64Array;
    bankDerivative: Float64Array;
    zoneMasks: Uint32Array;
    zoneNames: readonly string[];
    elementIndices: Uint32Array;
    elementBoundaries: Uint32Array;
    parameters: Float64Array;
    totalLength: number;
  }) {
    this.positions = new Float64Array(input.positions);
    this.tangents = new Float64Array(input.tangents);
    this.normals = new Float64Array(input.normals);
    this.binormals = new Float64Array(input.binormals);
    this.distances = new Float64Array(input.distances);
    this.curvature = new Float64Array(input.curvature);
    this.bank = new Float64Array(input.bank);
    this.bankDerivative = new Float64Array(input.bankDerivative);
    this.zoneMasks = new Uint32Array(input.zoneMasks);
    this.zoneNames = Object.freeze([...input.zoneNames]);
    this.elementIndices = new Uint32Array(input.elementIndices);
    this.elementBoundaries = new Uint32Array(input.elementBoundaries);
    this.parameters = new Float64Array(input.parameters);
    this.totalLength = input.totalLength;
    this.checksum = String(this.totalLength) + "-" + this.positions.length;
    Object.freeze(this);
  }
}

export function compileTrack(
  elements: readonly {
    id: string;
    span: {
      position: (u: number) => Vec3;
      derivative: (u: number, order?: number) => Vec3;
    };
    bank?: unknown;
    zones?: readonly string[];
  }[],
  options: { samples?: number } = {},
): CompiledTrackData {
  const perElement = Math.max(2, Math.floor(options.samples ?? 16));
  const count = elements.length * (perElement - 1) + 1;
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  const binormals = new Float64Array(count * 3);
  const distances = new Float64Array(count);
  const curvature = new Float64Array(count);
  const bank = new Float64Array(count);
  const bankDerivative = new Float64Array(count);
  const zoneMasks = new Uint32Array(count);
  const zoneNames: string[] = [];
  const elementIndices = new Uint32Array(count);
  const elementBoundaries = new Uint32Array(elements.length * 2);
  const parameters = new Float64Array(count);
  let total = 0;
  const luts: { totalLength: number }[] = [];
  // Build per-element lengths via simple sampling
  for (let ei = 0; ei < elements.length; ei++) {
    const el = elements[ei]!;
    let len = 0;
    const steps = 32;
    let prev = el.span.position(0);
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const p = el.span.position(u);
      len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      prev = p;
    }
    luts.push({ totalLength: len });
    total += len;
  }
  let offset = 0;
  for (let ei = 0; ei < elements.length; ei++) {
    const el = elements[ei]!;
    const startIdx = ei * (perElement - 1);
    elementBoundaries[ei * 2] = startIdx;
    elementBoundaries[ei * 2 + 1] = startIdx + perElement - 1;
    for (let s = 0; s < perElement; s++) {
      if (ei > 0 && s === 0) continue;
      const idx = startIdx + s;
      const u = s / (perElement - 1);
      const pos = el.span.position(u);
      const der = el.span.derivative(u, 1);
      const len = Math.hypot(der[0], der[1], der[2]) || 1;
      positions[idx * 3] = pos[0];
      positions[idx * 3 + 1] = pos[1];
      positions[idx * 3 + 2] = pos[2];
      tangents[idx * 3] = der[0] / len;
      tangents[idx * 3 + 1] = der[1] / len;
      tangents[idx * 3 + 2] = der[2] / len;
      // simple frame: normal = up, binormal = cross
      const t: Vec3 = vec3(der[0] / len, der[1] / len, der[2] / len);
      const up: Vec3 = Math.abs(t[1]) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      const nRaw: Vec3 = vec3(
        up[0] - t[0] * (up[0] * t[0] + up[1] * t[1] + up[2] * t[2]),
        up[1] - t[1] * (up[0] * t[0] + up[1] * t[1] + up[2] * t[2]),
        up[2] - t[2] * (up[0] * t[0] + up[1] * t[1] + up[2] * t[2]),
      );
      const nLen = Math.hypot(nRaw[0], nRaw[1], nRaw[2]) || 1;
      const n: Vec3 = vec3(nRaw[0] / nLen, nRaw[1] / nLen, nRaw[2] / nLen);
      const b: Vec3 = vec3(
        t[1] * n[2] - t[2] * n[1],
        t[2] * n[0] - t[0] * n[2],
        t[0] * n[1] - t[1] * n[0],
      );
      normals[idx * 3] = n[0];
      normals[idx * 3 + 1] = n[1];
      normals[idx * 3 + 2] = n[2];
      binormals[idx * 3] = b[0];
      binormals[idx * 3 + 1] = b[1];
      binormals[idx * 3 + 2] = b[2];
      distances[idx] = offset + (luts[ei]!.totalLength * s) / (perElement - 1);
      parameters[idx] = u;
      elementIndices[idx] = ei;
      curvature[idx] = 0;
      bank[idx] = 0;
      bankDerivative[idx] = 0;
    }
    offset += luts[ei]!.totalLength;
  }
  return new CompiledTrackData({
    positions,
    tangents,
    normals,
    binormals,
    distances,
    curvature,
    bank,
    bankDerivative,
    zoneMasks,
    zoneNames,
    elementIndices,
    elementBoundaries,
    parameters,
    totalLength: total,
  });
}

export function sampleCompiledTrack(
  data: CompiledTrackData,
  t: number,
): {
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
  distance: number;
  curvature: number;
  bank: number;
  bankDerivative: number;
} {
  const n = data.distances.length;
  const clamped = Math.max(0, Math.min(1, t));
  const f = clamped * (n - 1);
  const low = Math.floor(f);
  const high = Math.min(n - 1, low + 1);
  const frac = f - low;
  const lerp = (a: number, b: number) => a * (1 - frac) + b * frac;
  const pos: Vec3 = vec3(
    lerp(data.positions[low * 3] ?? 0, data.positions[high * 3] ?? 0),
    lerp(data.positions[low * 3 + 1] ?? 0, data.positions[high * 3 + 1] ?? 0),
    lerp(data.positions[low * 3 + 2] ?? 0, data.positions[high * 3 + 2] ?? 0),
  );
  const tang: Vec3 = vec3(
    lerp(data.tangents[low * 3] ?? 0, data.tangents[high * 3] ?? 0),
    lerp(data.tangents[low * 3 + 1] ?? 0, data.tangents[high * 3 + 1] ?? 0),
    lerp(data.tangents[low * 3 + 2] ?? 0, data.tangents[high * 3 + 2] ?? 0),
  );
  const norm: Vec3 = vec3(
    lerp(data.normals[low * 3] ?? 0, data.normals[high * 3] ?? 0),
    lerp(data.normals[low * 3 + 1] ?? 0, data.normals[high * 3 + 1] ?? 0),
    lerp(data.normals[low * 3 + 2] ?? 0, data.normals[high * 3 + 2] ?? 0),
  );
  const bin: Vec3 = vec3(
    lerp(data.binormals[low * 3] ?? 0, data.binormals[high * 3] ?? 0),
    lerp(data.binormals[low * 3 + 1] ?? 0, data.binormals[high * 3 + 1] ?? 0),
    lerp(data.binormals[low * 3 + 2] ?? 0, data.binormals[high * 3 + 2] ?? 0),
  );
  return {
    position: pos,
    tangent: tang,
    normal: norm,
    binormal: bin,
    distance: lerp(data.distances[low] ?? 0, data.distances[high] ?? 0),
    curvature: lerp(data.curvature[low] ?? 0, data.curvature[high] ?? 0),
    bank: lerp(data.bank[low] ?? 0, data.bank[high] ?? 0),
    bankDerivative: lerp(
      data.bankDerivative[low] ?? 0,
      data.bankDerivative[high] ?? 0,
    ),
  };
}
