import type { EnvironmentQuery, EnvironmentRaycast } from "./contracts";
import { aabbFromPoints, vec3 } from "./math";
import type { Aabb, Vec3 } from "./math";

export interface HeightfieldOptions {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly heights: ArrayLike<number>;
  readonly origin?: readonly [number, number];
}

const requireFinite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
};

const requireFiniteVector = (value: Vec3, label: string): Vec3 => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  )
    throw new RangeError(`${label} must be a finite 3-vector`);
  return value;
};

const requireDistanceCandidate = (value: number): number => {
  if (Number.isNaN(value))
    throw new RangeError("Heightfield distance candidate must not be NaN");
  if (value < 0)
    throw new RangeError("Heightfield distance candidate must be non-negative");
  return value;
};

const minimumDistance = (...values: readonly number[]): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) {
    requireDistanceCandidate(value);
    if (value < minimum) minimum = value;
  }
  return minimum;
};

interface HeightfieldTriangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly plane: Vec3;
  readonly normal: Vec3;
  readonly column: number;
  readonly row: number;
  readonly first: boolean;
}

interface RayTriangleCandidate {
  readonly distance: number;
  readonly point: Vec3;
  readonly triangle: HeightfieldTriangle;
}

interface GridVertex {
  readonly column: number;
  readonly row: number;
}

type ProductTerm = readonly [left: number, right: number];

interface DyadicFloat {
  readonly coefficient: bigint;
  readonly exponent: number;
}

const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);
const minimumNormal = 2 ** -1022;

const numberUlp = (value: number): number => {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return Number.MIN_VALUE;
  floatView.setFloat64(0, magnitude, false);
  const bits = floatView.getBigUint64(0, false);
  if (magnitude === Number.MAX_VALUE) {
    floatView.setBigUint64(0, bits - 1n, false);
    return magnitude - floatView.getFloat64(0, false);
  }
  floatView.setBigUint64(0, bits + 1n, false);
  return floatView.getFloat64(0, false) - magnitude;
};

const ulpTolerance = (factor: number, ...values: readonly number[]): number => {
  let tolerance = Number.MIN_VALUE;
  for (const value of values) tolerance = Math.max(tolerance, numberUlp(value));
  return factor * tolerance;
};

const decomposeFiniteFloat = (value: number): DyadicFloat => {
  floatView.setFloat64(0, value, false);
  const high = floatView.getUint32(0, false);
  const low = floatView.getUint32(4, false);
  const exponentBits = (high >>> 20) & 0x7ff;
  let coefficient = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  if (exponentBits !== 0) coefficient |= 1n << 52n;
  if ((high & 0x80000000) !== 0) coefficient = -coefficient;
  return { coefficient, exponent };
};

const exactProductSumSign = (terms: readonly ProductTerm[]): number => {
  const products: DyadicFloat[] = [];
  let minimumExponent = Number.POSITIVE_INFINITY;
  for (const [left, right] of terms) {
    const leftValue = decomposeFiniteFloat(left);
    const rightValue = decomposeFiniteFloat(right);
    const coefficient = leftValue.coefficient * rightValue.coefficient;
    if (coefficient === 0n) continue;
    const exponent = leftValue.exponent + rightValue.exponent;
    products.push({ coefficient, exponent });
    minimumExponent = Math.min(minimumExponent, exponent);
  }
  if (products.length === 0) return 0;

  let total = 0n;
  for (const product of products)
    total += product.coefficient << BigInt(product.exponent - minimumExponent);
  return total < 0n ? -1 : total > 0n ? 1 : 0;
};

const compensatedProductSum = (
  terms: readonly ProductTerm[],
): number | undefined => {
  let sum = 0;
  let correction = 0;
  for (const [left, right] of terms) {
    const product = left * right;
    if (!Number.isFinite(product)) return undefined;
    const next = sum + product;
    if (!Number.isFinite(next)) return undefined;
    correction +=
      Math.abs(sum) >= Math.abs(product)
        ? sum - next + product
        : product - next + sum;
    if (!Number.isFinite(correction)) return undefined;
    sum = next;
  }
  const result = sum + correction;
  return Number.isFinite(result) ? result : undefined;
};

const adaptiveProductSumSign = (terms: readonly ProductTerm[]): number => {
  let magnitude = 0;
  for (const [left, right] of terms) {
    const product = left * right;
    if (!Number.isFinite(product)) return exactProductSumSign(terms);
    if (
      (product === 0 && left !== 0 && right !== 0) ||
      (product !== 0 && Math.abs(product) < minimumNormal)
    )
      return exactProductSumSign(terms);
    magnitude += Math.abs(product);
    if (!Number.isFinite(magnitude)) return exactProductSumSign(terms);
  }
  const estimate = compensatedProductSum(terms);
  if (
    estimate !== undefined &&
    Math.abs(estimate) > 16 * Number.EPSILON * magnitude
  )
    return Math.sign(estimate);
  return exactProductSumSign(terms);
};

const adaptiveDotSign = (left: Vec3, right: Vec3): number =>
  adaptiveProductSumSign([
    [left[0], right[0]],
    [left[1], right[1]],
    [left[2], right[2]],
  ]);

const adaptivePlaneOffsetSign = (
  plane: Vec3,
  point: Vec3,
  anchor: Vec3,
): number =>
  adaptiveProductSumSign([
    [plane[0], point[0]],
    [-plane[0], anchor[0]],
    [plane[1], point[1]],
    [-plane[1], anchor[1]],
    [plane[2], point[2]],
    [-plane[2], anchor[2]],
  ]);

const subtractFinite = (left: Vec3, right: Vec3, label: string): Vec3 =>
  vec3(
    requireFinite(left[0] - right[0], label),
    requireFinite(left[1] - right[1], label),
    requireFinite(left[2] - right[2], label),
  );

const robustNormalize = (value: Vec3, label: string): Vec3 => {
  const scale = Math.max(
    Math.abs(value[0]),
    Math.abs(value[1]),
    Math.abs(value[2]),
  );
  if (!(scale > 0) || !Number.isFinite(scale))
    throw new RangeError(`${label} must be finite and non-zero`);
  const x = value[0] / scale;
  const y = value[1] / scale;
  const z = value[2] / scale;
  const length = Math.hypot(x, y, z);
  return requireFiniteVector(
    vec3(
      x === 0 ? 0 : x / length,
      y === 0 ? 0 : y / length,
      z === 0 ? 0 : z / length,
    ),
    label,
  );
};

const scaledProductSumCandidate = (
  terms: readonly ProductTerm[],
  label: string,
): number => {
  const direct = compensatedProductSum(terms);
  if (direct !== undefined) return direct;
  let scale = 0;
  for (const [, right] of terms) scale = Math.max(scale, Math.abs(right));
  if (scale === 0) return 0;
  const scaled = compensatedProductSum(
    terms.map(([left, right]): ProductTerm => [left, right / scale]),
  );
  const result = scaled === undefined ? Number.NaN : scaled * scale;
  if (Number.isNaN(result)) throw new RangeError(`${label} must not be NaN`);
  return result;
};

const scaledDotCandidate = (left: Vec3, right: Vec3, label: string): number =>
  scaledProductSumCandidate(
    [
      [left[0], right[0]],
      [left[1], right[1]],
      [left[2], right[2]],
    ],
    label,
  );

const scaledDot = (left: Vec3, right: Vec3, label: string): number =>
  requireFinite(scaledDotCandidate(left, right, label), label);

const pointDistance = (point: Vec3, target: Vec3): number => {
  const difference = vec3(
    point[0] - target[0],
    point[1] - target[1],
    point[2] - target[2],
  );
  return requireDistanceCandidate(
    Math.hypot(difference[0], difference[1], difference[2]),
  );
};

const pointSegmentDistance = (point: Vec3, a: Vec3, b: Vec3): number => {
  const edge = subtractFinite(b, a, "Heightfield edge difference");
  if (edge[0] === 0 && edge[1] === 0 && edge[2] === 0)
    return pointDistance(point, a);
  const direction = robustNormalize(edge, "Heightfield edge direction");
  const differenceFromA = vec3(
    point[0] - a[0],
    point[1] - a[1],
    point[2] - a[2],
  );
  if (differenceFromA.some((value) => !Number.isFinite(value)))
    return Number.POSITIVE_INFINITY;
  const alongFromA = scaledDotCandidate(
    direction,
    differenceFromA,
    "Heightfield edge projection",
  );
  if (alongFromA <= 0) return pointDistance(point, a);
  const differenceFromB = vec3(
    point[0] - b[0],
    point[1] - b[1],
    point[2] - b[2],
  );
  if (differenceFromB.some((value) => !Number.isFinite(value)))
    return Number.POSITIVE_INFINITY;
  const alongFromB = scaledDotCandidate(
    direction,
    differenceFromB,
    "Heightfield edge projection",
  );
  if (alongFromB >= 0) return pointDistance(point, b);
  if (!Number.isFinite(alongFromA) || !Number.isFinite(alongFromB))
    return Number.POSITIVE_INFINITY;
  const remaining = -alongFromB;
  const ratioScale = Math.max(alongFromA, remaining);
  const along =
    alongFromA /
    ratioScale /
    (alongFromA / ratioScale + remaining / ratioScale);
  return pointDistance(
    point,
    vec3(
      a[0] + edge[0] * along,
      a[1] + edge[1] * along,
      a[2] + edge[2] * along,
    ),
  );
};

const bvhNextDown = (value: number): number => {
  if (Number.isNaN(value)) throw new RangeError("bvhNextDown received NaN");
  if (value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return -Number.MIN_VALUE;
  floatView.setFloat64(0, value, false);
  let word = floatView.getBigUint64(0, false);
  word = value > 0 ? word - 1n : word + 1n;
  floatView.setBigUint64(0, word, false);
  return floatView.getFloat64(0, false);
};

const pointToAabbLower = (point: Vec3, min: Vec3, max: Vec3): number => {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (point[0] < min[0]) dx = bvhNextDown(min[0] - point[0]);
  else if (point[0] > max[0]) dx = bvhNextDown(point[0] - max[0]);
  if (point[1] < min[1]) dy = bvhNextDown(min[1] - point[1]);
  else if (point[1] > max[1]) dy = bvhNextDown(point[1] - max[1]);
  if (point[2] < min[2]) dz = bvhNextDown(min[2] - point[2]);
  else if (point[2] > max[2]) dz = bvhNextDown(point[2] - max[2]);
  if (dx < 0) dx = 0;
  if (dy < 0) dy = 0;
  if (dz < 0) dz = 0;
  if (dx === 0 && dy === 0 && dz === 0) return 0;
  const dx2 = bvhNextDown(dx * dx);
  const dy2 = bvhNextDown(dy * dy);
  const dz2 = bvhNextDown(dz * dz);
  const sum = bvhNextDown(bvhNextDown(dx2 + dy2) + dz2);
  if (sum <= 0) return 0;
  return bvhNextDown(Math.sqrt(sum));
};

interface BvhNode {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly left: number;
  readonly right: number;
  readonly triangles: readonly number[] | undefined;
}

export class HeightfieldEnvironment implements EnvironmentQuery {
  public readonly width: number;
  public readonly depth: number;
  public readonly cellSize: number;
  public readonly heights: Float64Array;
  public readonly origin: readonly [number, number];
  private readonly maximumX: number;
  private readonly maximumZ: number;
  private readonly triangleList: HeightfieldTriangle[];
  private readonly triangleAabbs: Array<{ min: Vec3; max: Vec3 }>;
  private readonly triangleCentroids: Vec3[];
  private readonly bvhNodes: BvhNode[];
  private readonly bvhRoot: number;

  public constructor(options: HeightfieldOptions) {
    if (options === null || typeof options !== "object")
      throw new RangeError("Heightfield options must be an object");
    if (
      !Number.isSafeInteger(options.width) ||
      !Number.isSafeInteger(options.depth) ||
      options.width < 2 ||
      options.depth < 2 ||
      options.width > 0xffffffff / options.depth
    )
      throw new RangeError("Heightfield dimensions must be at least 2 by 2");
    if (
      options.heights === null ||
      typeof options.heights !== "object" ||
      !Number.isSafeInteger(options.heights.length) ||
      options.heights.length < 0
    )
      throw new RangeError("Heightfield heights must be an array-like value");
    if (options.heights.length !== options.width * options.depth)
      throw new RangeError(
        "Heightfield sample count does not match dimensions",
      );
    if (!Number.isFinite(options.cellSize) || options.cellSize <= 0)
      throw new RangeError("Heightfield cell size must be positive and finite");
    const origin = options.origin ?? [0, 0];
    if (
      !Array.isArray(origin) ||
      origin.length !== 2 ||
      !origin.every(Number.isFinite)
    )
      throw new RangeError("Heightfield origin must be a finite 2-vector");
    for (let index = 0; index < options.heights.length; index += 1)
      if (!Number.isFinite(options.heights[index]))
        throw new RangeError("Heightfield heights must be finite");
    const maximumX = origin[0] + (options.width - 1) * options.cellSize;
    const maximumZ = origin[1] + (options.depth - 1) * options.cellSize;
    if (
      !Number.isFinite(maximumX) ||
      !Number.isFinite(maximumZ) ||
      maximumX <= origin[0] ||
      maximumZ <= origin[1]
    )
      throw new RangeError("Heightfield generated bounds must be finite");

    let minimumHeight = options.heights[0]!;
    let maximumHeight = minimumHeight;
    for (let row = 0; row < options.depth; row += 1)
      for (let column = 0; column < options.width; column += 1) {
        const height = options.heights[row * options.width + column]!;
        minimumHeight = Math.min(minimumHeight, height);
        maximumHeight = Math.max(maximumHeight, height);
        if (column + 1 < options.width) {
          const difference =
            options.heights[row * options.width + column + 1]! - height;
          if (
            !Number.isFinite(difference) ||
            !Number.isFinite(difference / options.cellSize)
          )
            throw new RangeError(
              "Heightfield generated horizontal slopes must be finite",
            );
        }
        if (row + 1 < options.depth) {
          const difference =
            options.heights[(row + 1) * options.width + column]! - height;
          if (
            !Number.isFinite(difference) ||
            !Number.isFinite(difference / options.cellSize)
          )
            throw new RangeError(
              "Heightfield generated depth slopes must be finite",
            );
        }
      }
    if (!Number.isFinite(maximumHeight - minimumHeight))
      throw new RangeError("Heightfield generated geometry must be finite");
    this.width = options.width;
    this.depth = options.depth;
    this.cellSize = options.cellSize;
    this.heights = new Float64Array(options.heights);
    this.origin = Object.freeze([origin[0], origin[1]]);
    this.maximumX = maximumX;
    this.maximumZ = maximumZ;

    const tris: HeightfieldTriangle[] = [];
    const aabbs: Array<{ min: Vec3; max: Vec3 }> = [];
    const centroids: Vec3[] = [];
    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1)
        for (const first of [true, false] as const) {
          const tri = this.buildTriangle(column, row, first);
          tris.push(tri);
          const min = vec3(
            Math.min(tri.a[0], tri.b[0], tri.c[0]),
            Math.min(tri.a[1], tri.b[1], tri.c[1]),
            Math.min(tri.a[2], tri.b[2], tri.c[2]),
          );
          const max = vec3(
            Math.max(tri.a[0], tri.b[0], tri.c[0]),
            Math.max(tri.a[1], tri.b[1], tri.c[1]),
            Math.max(tri.a[2], tri.b[2], tri.c[2]),
          );
          aabbs.push({ min, max });
          centroids.push(
            vec3(
              (tri.a[0] + tri.b[0] + tri.c[0]) / 3,
              (tri.a[1] + tri.b[1] + tri.c[1]) / 3,
              (tri.a[2] + tri.b[2] + tri.c[2]) / 3,
            ),
          );
        }
    this.triangleList = tris;
    this.triangleAabbs = aabbs;
    this.triangleCentroids = centroids;
    const built = this.buildBvh();
    this.bvhNodes = built.nodes;
    this.bvhRoot = built.root;
  }

  private buildTriangle(
    column: number,
    row: number,
    first: boolean,
  ): HeightfieldTriangle {
    const p00 = this.surfacePoint(column, row);
    const p10 = this.surfacePoint(column + 1, row);
    const p01 = this.surfacePoint(column, row + 1);
    const p11 = this.surfacePoint(column + 1, row + 1);
    const xDifference = requireFinite(
      (first ? p10[1] : p11[1]) - (first ? p00[1] : p01[1]),
      "Heightfield x difference",
    );
    const zDifference = requireFinite(
      (first ? p11[1] : p01[1]) - (first ? p10[1] : p00[1]),
      "Heightfield z difference",
    );
    const plane = vec3(-xDifference, this.cellSize, -zDifference);
    return {
      a: p00,
      b: first ? p10 : p11,
      c: first ? p11 : p01,
      plane,
      normal: robustNormalize(plane, "Heightfield normal"),
      column,
      row,
      first,
    };
  }

  private buildBvh(): { nodes: BvhNode[]; root: number } {
    const n = this.triangleList.length;
    const nodes: BvhNode[] = [];
    const LEAF_SIZE = 8;
    const build = (indices: number[]): number => {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (const idx of indices) {
        const ab = this.triangleAabbs[idx]!;
        minX = Math.min(minX, ab.min[0]);
        minY = Math.min(minY, ab.min[1]);
        minZ = Math.min(minZ, ab.min[2]);
        maxX = Math.max(maxX, ab.max[0]);
        maxY = Math.max(maxY, ab.max[1]);
        maxZ = Math.max(maxZ, ab.max[2]);
      }
      const min = vec3(minX, minY, minZ);
      const max = vec3(maxX, maxY, maxZ);
      if (indices.length <= LEAF_SIZE) {
        const node: BvhNode = {
          min,
          max,
          left: -1,
          right: -1,
          triangles: Object.freeze([...indices]),
        };
        const id = nodes.length;
        nodes.push(node);
        return id;
      }
      const extentX = maxX - minX;
      const extentY = maxY - minY;
      const extentZ = maxZ - minZ;
      let axis: 0 | 1 | 2 = 0;
      if (extentY > extentX && extentY >= extentZ) axis = 1;
      else if (extentZ > extentX && extentZ > extentY) axis = 2;
      const sorted = [...indices].sort((a, b) => {
        const ca = this.triangleCentroids[a]![axis];
        const cb = this.triangleCentroids[b]![axis];
        if (ca < cb) return -1;
        if (ca > cb) return 1;
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });
      const mid = Math.floor(sorted.length / 2);
      const leftIdx = build(sorted.slice(0, mid));
      const rightIdx = build(sorted.slice(mid));
      const node: BvhNode = {
        min,
        max,
        left: leftIdx,
        right: rightIdx,
        triangles: undefined,
      };
      const id = nodes.length;
      nodes.push(node);
      return id;
    };
    const all = Array.from({ length: n }, (_, i) => i);
    const root = build(all);
    return { nodes, root };
  }

  private sample(column: number, row: number): number {
    return requireFinite(
      this.heights[row * this.width + column]!,
      "Heightfield sample",
    );
  }

  private surfacePoint(column: number, row: number): Vec3 {
    return vec3(
      requireFinite(
        this.origin[0] + column * this.cellSize,
        "Heightfield surface x coordinate",
      ),
      this.sample(column, row),
      requireFinite(
        this.origin[1] + row * this.cellSize,
        "Heightfield surface z coordinate",
      ),
    );
  }

  private triangle(
    column: number,
    row: number,
    first: boolean,
  ): HeightfieldTriangle {
    const p00 = this.surfacePoint(column, row);
    const p10 = this.surfacePoint(column + 1, row);
    const p01 = this.surfacePoint(column, row + 1);
    const p11 = this.surfacePoint(column + 1, row + 1);
    const xDifference = requireFinite(
      (first ? p10[1] : p11[1]) - (first ? p00[1] : p01[1]),
      "Heightfield x difference",
    );
    const zDifference = requireFinite(
      (first ? p11[1] : p01[1]) - (first ? p10[1] : p00[1]),
      "Heightfield z difference",
    );
    const plane = vec3(-xDifference, this.cellSize, -zDifference);
    return {
      a: p00,
      b: first ? p10 : p11,
      c: first ? p11 : p01,
      plane,
      normal: robustNormalize(plane, "Heightfield normal"),
      column,
      row,
      first,
    };
  }

  private triangleContainsProjection(
    triangle: HeightfieldTriangle,
    x: number,
    z: number,
    xTolerance = 0,
    zTolerance = 0,
  ): boolean {
    const cellX = this.origin[0] + triangle.column * this.cellSize;
    const cellZ = this.origin[1] + triangle.row * this.cellSize;
    const maximumCellX = cellX + this.cellSize;
    const maximumCellZ = cellZ + this.cellSize;
    if (
      (x < cellX && cellX - x > xTolerance) ||
      (x > maximumCellX && x - maximumCellX > xTolerance) ||
      (z < cellZ && cellZ - z > zTolerance) ||
      (z > maximumCellZ && z - maximumCellZ > zTolerance)
    )
      return false;
    const localX = x - cellX;
    const localZ = z - cellZ;
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return false;
    const diagonal = localX - localZ;
    return triangle.first
      ? diagonal >= -(xTolerance + zTolerance)
      : diagonal <= xTolerance + zTolerance;
  }

  private localCoordinate(
    value: number,
    axisOrigin: number,
    axisMaximum: number,
    sampleCount: number,
  ): number {
    if (value <= axisOrigin) return 0;
    if (value >= axisMaximum) return sampleCount - 1;
    return requireFinite(
      (value - axisOrigin) / this.cellSize,
      "Heightfield local coordinate",
    );
  }

  private heightInCell(
    column: number,
    row: number,
    localX: number,
    localZ: number,
  ): number {
    const h00 = this.sample(column, row);
    const h10 = this.sample(column + 1, row);
    const h01 = this.sample(column, row + 1);
    const h11 = this.sample(column + 1, row + 1);
    const height =
      localX >= localZ
        ? h00 + (h10 - h00) * localX + (h11 - h10) * localZ
        : h00 + (h11 - h01) * localX + (h01 - h00) * localZ;
    return requireFinite(height, "Heightfield interpolated height");
  }

  public heightAt(x: number, z: number): number {
    requireFinite(x, "Heightfield x coordinate");
    requireFinite(z, "Heightfield z coordinate");
    const clampedX = this.localCoordinate(
      x,
      this.origin[0],
      this.maximumX,
      this.width,
    );
    const clampedZ = this.localCoordinate(
      z,
      this.origin[1],
      this.maximumZ,
      this.depth,
    );
    const x0 = Math.min(this.width - 2, Math.floor(clampedX));
    const z0 = Math.min(this.depth - 2, Math.floor(clampedZ));
    const tx = clampedX - x0;
    const tz = clampedZ - z0;
    return this.heightInCell(x0, z0, tx, tz);
  }

  public signedDistance(point: Vec3): number {
    requireFiniteVector(point, "Signed-distance point");
    const distance = this.closestSurfaceDistance(point);
    const inside =
      point[0] > this.origin[0] &&
      point[0] < this.maximumX &&
      point[2] > this.origin[1] &&
      point[2] < this.maximumZ &&
      point[1] < this.heightAt(point[0], point[2]);
    const result = inside ? -distance : distance;
    return requireFinite(result, "Signed distance");
  }

  private triangleDistance(point: Vec3, triangle: HeightfieldTriangle): number {
    const relative = vec3(
      point[0] - triangle.a[0],
      point[1] - triangle.a[1],
      point[2] - triangle.a[2],
    );
    if (relative.some((value) => !Number.isFinite(value)))
      return Number.POSITIVE_INFINITY;
    const planeDistance = scaledDotCandidate(
      triangle.normal,
      relative,
      "Heightfield triangle distance",
    );
    if (!Number.isFinite(planeDistance)) return Number.POSITIVE_INFINITY;
    const projectedX = point[0] - planeDistance * triangle.normal[0];
    const projectedZ = point[2] - planeDistance * triangle.normal[2];
    if (
      Number.isFinite(projectedX) &&
      Number.isFinite(projectedZ) &&
      this.triangleContainsProjection(triangle, projectedX, projectedZ)
    )
      return Math.abs(planeDistance);
    return minimumDistance(
      pointSegmentDistance(point, triangle.a, triangle.b),
      pointSegmentDistance(point, triangle.b, triangle.c),
      pointSegmentDistance(point, triangle.c, triangle.a),
    );
  }

  private curtainDistance(point: Vec3, a: Vec3, b: Vec3): number {
    const edgeX = requireFinite(b[0] - a[0], "Heightfield curtain edge");
    const edgeZ = requireFinite(b[2] - a[2], "Heightfield curtain edge");
    const edgeLength = requireFinite(
      Math.hypot(edgeX, edgeZ),
      "Heightfield curtain edge length",
    );
    const directionX = edgeX / edgeLength;
    const directionZ = edgeZ / edgeLength;
    const relativeX = point[0] - a[0];
    const relativeZ = point[2] - a[2];
    if (!Number.isFinite(relativeX) || !Number.isFinite(relativeZ))
      return Number.POSITIVE_INFINITY;
    const relative = vec3(relativeX, 0, relativeZ);
    const along = scaledDotCandidate(
      vec3(directionX, 0, directionZ),
      relative,
      "Heightfield curtain projection",
    );
    const perpendicular = scaledDotCandidate(
      vec3(-directionZ, 0, directionX),
      relative,
      "Heightfield curtain projection",
    );
    if (!Number.isFinite(along) || !Number.isFinite(perpendicular))
      return Number.POSITIVE_INFINITY;
    if (along >= 0 && along <= edgeLength) {
      const top = requireFinite(
        a[1] + (b[1] - a[1]) * (along / edgeLength),
        "Heightfield curtain top",
      );
      if (point[1] <= top) return Math.abs(perpendicular);
    }

    const upwardA = point[1] <= a[1] ? 0 : point[1] - a[1];
    const upwardB = point[1] <= b[1] ? 0 : point[1] - b[1];
    if (!Number.isFinite(upwardA) || !Number.isFinite(upwardB))
      return Number.POSITIVE_INFINITY;
    const verticalRayDistance = minimumDistance(
      Math.hypot(along, upwardA),
      Math.hypot(along - edgeLength, upwardB),
    );
    const planarDistance =
      point[1] <= Math.min(a[1], b[1])
        ? verticalRayDistance
        : minimumDistance(
            verticalRayDistance,
            pointSegmentDistance(
              vec3(along, point[1], 0),
              vec3(0, a[1], 0),
              vec3(edgeLength, b[1], 0),
            ),
          );
    return requireDistanceCandidate(Math.hypot(perpendicular, planarDistance));
  }

  private closestTriangleDistance(point: Vec3): number {
    let best = Number.POSITIVE_INFINITY;
    type HeapEntry = { node: number; lower: number; seq: number };
    const heap: HeapEntry[] = [];
    let seq = 0;
    const rootNode = this.bvhNodes[this.bvhRoot]!;
    const rootLower = pointToAabbLower(point, rootNode.min, rootNode.max);
    const push = (nodeIdx: number, lower: number): void => {
      if (lower >= best) return;
      heap.push({ node: nodeIdx, lower, seq: seq++ });
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        const a = heap[i]!;
        const b = heap[p]!;
        if (a.lower > b.lower || (a.lower === b.lower && a.seq >= b.seq))
          break;
        heap[i] = b;
        heap[p] = a;
        i = p;
      }
    };
    const pop = (): HeapEntry | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let smallest = i;
          if (l < heap.length) {
            const a = heap[l]!;
            const b = heap[smallest]!;
            if (a.lower < b.lower || (a.lower === b.lower && a.seq < b.seq))
              smallest = l;
          }
          if (r < heap.length) {
            const a = heap[r]!;
            const b = heap[smallest]!;
            if (a.lower < b.lower || (a.lower === b.lower && a.seq < b.seq))
              smallest = r;
          }
          if (smallest === i) break;
          const tmp = heap[i]!;
          heap[i] = heap[smallest]!;
          heap[smallest] = tmp;
          i = smallest;
        }
      }
      return top;
    };
    push(this.bvhRoot, rootLower);
    while (heap.length > 0) {
      const cur = pop()!;
      if (cur.lower >= best) break;
      const node = this.bvhNodes[cur.node]!;
      if (node.triangles !== undefined) {
        for (const triIdx of node.triangles) {
          const d = this.triangleDistance(point, this.triangleList[triIdx]!);
          if (d < best) best = d;
        }
      } else {
        const left = this.bvhNodes[node.left]!;
        const right = this.bvhNodes[node.right]!;
        const lLower = pointToAabbLower(point, left.min, left.max);
        const rLower = pointToAabbLower(point, right.min, right.max);
        if (lLower < rLower) {
          if (rLower < best) push(node.right, rLower);
          if (lLower < best) push(node.left, lLower);
        } else {
          if (lLower < best) push(node.left, lLower);
          if (rLower < best) push(node.right, rLower);
        }
      }
    }
    return best;
  }

  private closestSurfaceDistance(point: Vec3): number {
    let closest = this.closestTriangleDistance(point);
    for (let column = 0; column < this.width - 1; column += 1) {
      closest = minimumDistance(
        closest,
        this.curtainDistance(
          point,
          this.surfacePoint(column, 0),
          this.surfacePoint(column + 1, 0),
        ),
        this.curtainDistance(
          point,
          this.surfacePoint(column, this.depth - 1),
          this.surfacePoint(column + 1, this.depth - 1),
        ),
      );
    }
    for (let row = 0; row < this.depth - 1; row += 1) {
      closest = minimumDistance(
        closest,
        this.curtainDistance(
          point,
          this.surfacePoint(0, row),
          this.surfacePoint(0, row + 1),
        ),
        this.curtainDistance(
          point,
          this.surfacePoint(this.width - 1, row),
          this.surfacePoint(this.width - 1, row + 1),
        ),
      );
    }
    return requireFinite(closest, "Signed distance");
  }

  public sampleSolid(point: Vec3): number {
    return this.signedDistance(point);
  }

  public bounds(): Aabb {
    let minimum = this.sample(0, 0);
    let maximum = minimum;
    for (let row = 0; row < this.depth; row += 1)
      for (let column = 0; column < this.width; column += 1) {
        const height = this.sample(column, row);
        minimum = Math.min(minimum, height);
        maximum = Math.max(maximum, height);
      }
    const result = aabbFromPoints([
      vec3(this.origin[0], minimum, this.origin[1]),
      vec3(this.maximumX, maximum, this.maximumZ),
    ]);
    requireFiniteVector(result.min, "Heightfield minimum bound");
    requireFiniteVector(result.max, "Heightfield maximum bound");
    return result;
  }

  private triangleAt(x: number, z: number): HeightfieldTriangle {
    requireFinite(x, "Heightfield normal x coordinate");
    requireFinite(z, "Heightfield normal z coordinate");
    const localX = this.localCoordinate(
      x,
      this.origin[0],
      this.maximumX,
      this.width,
    );
    const localZ = this.localCoordinate(
      z,
      this.origin[1],
      this.maximumZ,
      this.depth,
    );
    const x0 = Math.min(this.width - 2, Math.floor(localX));
    const z0 = Math.min(this.depth - 2, Math.floor(localZ));
    const tx = localX - x0;
    const tz = localZ - z0;
    return this.triangle(x0, z0, tx >= tz);
  }

  private projectionTolerances(
    triangle: HeightfieldTriangle,
    x: number,
    z: number,
  ): readonly [x: number, z: number] {
    const cellX = this.origin[0] + triangle.column * this.cellSize;
    const cellZ = this.origin[1] + triangle.row * this.cellSize;
    return [
      ulpTolerance(32, x, cellX, cellX + this.cellSize, this.cellSize),
      ulpTolerance(32, z, cellZ, cellZ + this.cellSize, this.cellSize),
    ];
  }

  private triangleVertices(
    triangle: HeightfieldTriangle,
  ): readonly GridVertex[] {
    const p00 = { column: triangle.column, row: triangle.row };
    const p11 = { column: triangle.column + 1, row: triangle.row + 1 };
    return triangle.first
      ? [p00, { column: triangle.column + 1, row: triangle.row }, p11]
      : [p00, p11, { column: triangle.column, row: triangle.row + 1 }];
  }

  private sharedVertices(
    left: HeightfieldTriangle,
    right: HeightfieldTriangle,
  ): readonly GridVertex[] {
    const rightVertices = this.triangleVertices(right);
    return this.triangleVertices(left).filter((leftVertex) =>
      rightVertices.some(
        (rightVertex) =>
          leftVertex.column === rightVertex.column &&
          leftVertex.row === rightVertex.row,
      ),
    );
  }

  private pointOnSharedFeature(
    point: Vec3,
    vertices: readonly GridVertex[],
    xTolerance: number,
    yTolerance: number,
    zTolerance: number,
  ): boolean {
    if (vertices.length === 0) return false;
    const firstX = this.origin[0] + vertices[0]!.column * this.cellSize;
    const firstY = this.sample(vertices[0]!.column, vertices[0]!.row);
    const firstZ = this.origin[1] + vertices[0]!.row * this.cellSize;
    if (vertices.length === 1)
      return (
        Math.abs(point[0] - firstX) <= xTolerance &&
        Math.abs(point[1] - firstY) <= yTolerance &&
        Math.abs(point[2] - firstZ) <= zTolerance
      );
    if (vertices.length === 3) return true;

    const secondX = this.origin[0] + vertices[1]!.column * this.cellSize;
    const secondY = this.sample(vertices[1]!.column, vertices[1]!.row);
    const secondZ = this.origin[1] + vertices[1]!.row * this.cellSize;
    if (
      (point[0] < Math.min(firstX, secondX) &&
        Math.min(firstX, secondX) - point[0] > xTolerance) ||
      (point[0] > Math.max(firstX, secondX) &&
        point[0] - Math.max(firstX, secondX) > xTolerance) ||
      (point[2] < Math.min(firstZ, secondZ) &&
        Math.min(firstZ, secondZ) - point[2] > zTolerance) ||
      (point[2] > Math.max(firstZ, secondZ) &&
        point[2] - Math.max(firstZ, secondZ) > zTolerance)
    )
      return false;
    if (firstX === secondX && Math.abs(point[0] - firstX) > xTolerance)
      return false;
    if (firstZ === secondZ && Math.abs(point[2] - firstZ) > zTolerance)
      return false;
    if (
      firstX !== secondX &&
      firstZ !== secondZ &&
      Math.abs(point[0] - firstX - (point[2] - firstZ)) >
        xTolerance + zTolerance
    )
      return false;

    const interpolation =
      firstX === secondX
        ? (point[2] - firstZ) / (secondZ - firstZ)
        : (point[0] - firstX) / (secondX - firstX);
    const clampedInterpolation = Math.min(1, Math.max(0, interpolation));
    const featureHeight = firstY + (secondY - firstY) * clampedInterpolation;
    return Math.abs(point[1] - featureHeight) <= yTolerance;
  }

  private candidatesShareFeature(
    left: RayTriangleCandidate,
    right: RayTriangleCandidate,
  ): boolean {
    if (
      Math.abs(left.distance - right.distance) >
      ulpTolerance(32, left.distance, right.distance)
    )
      return false;
    const vertices = this.sharedVertices(left.triangle, right.triangle);
    if (vertices.length === 0) return false;
    const vertexXs = vertices.map(
      (vertex) => this.origin[0] + vertex.column * this.cellSize,
    );
    const vertexZs = vertices.map(
      (vertex) => this.origin[1] + vertex.row * this.cellSize,
    );
    const xTolerance = ulpTolerance(
      4,
      left.point[0],
      right.point[0],
      this.cellSize,
      ...vertexXs,
    );
    const zTolerance = ulpTolerance(
      4,
      left.point[2],
      right.point[2],
      this.cellSize,
      ...vertexZs,
    );
    const yTolerance = ulpTolerance(
      4,
      left.point[1],
      right.point[1],
      this.cellSize,
      left.triangle.a[1],
      left.triangle.b[1],
      left.triangle.c[1],
      right.triangle.a[1],
      right.triangle.b[1],
      right.triangle.c[1],
    );
    if (
      !this.pointOnSharedFeature(
        left.point,
        vertices,
        xTolerance,
        yTolerance,
        zTolerance,
      ) ||
      !this.pointOnSharedFeature(
        right.point,
        vertices,
        xTolerance,
        yTolerance,
        zTolerance,
      )
    )
      return false;
    return Math.abs(left.point[1] - right.point[1]) <= yTolerance;
  }

  private canonicalCandidate(
    candidates: readonly RayTriangleCandidate[],
  ): RayTriangleCandidate {
    let selected = candidates[0]!;
    for (const candidate of candidates.slice(1)) {
      const selectedTriangle = selected.triangle;
      const candidateTriangle = candidate.triangle;
      if (
        candidateTriangle.column > selectedTriangle.column ||
        (candidateTriangle.column === selectedTriangle.column &&
          candidateTriangle.row > selectedTriangle.row) ||
        (candidateTriangle.column === selectedTriangle.column &&
          candidateTriangle.row === selectedTriangle.row &&
          candidateTriangle.first &&
          !selectedTriangle.first)
      )
        selected = candidate;
    }
    return selected;
  }

  public normalAt(x: number, z: number): Vec3 {
    return this.triangleAt(x, z).normal;
  }

  public raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): EnvironmentRaycast | undefined {
    requireFiniteVector(origin, "Raycast origin");
    requireFiniteVector(direction, "Raycast direction");
    if (!Number.isFinite(maxDistance) || maxDistance < 0)
      throw new RangeError(
        "Raycast max distance must be non-negative and finite",
      );
    const directionLength = requireFinite(
      Math.hypot(direction[0], direction[1], direction[2]),
      "Raycast direction length",
    );
    if (directionLength === 0)
      throw new RangeError("Raycast direction must be non-zero");
    const dir = vec3(
      direction[0] / directionLength,
      direction[1] / directionLength,
      direction[2] / directionLength,
    );
    const pointAt = (distance: number): Vec3 => {
      requireFinite(distance, "Raycast generated distance");
      return requireFiniteVector(
        vec3(
          origin[0] + dir[0] * distance,
          origin[1] + dir[1] * distance,
          origin[2] + dir[2] * distance,
        ),
        "Raycast generated point",
      );
    };
    pointAt(maxDistance);
    const coplanarEntry = (
      triangle: HeightfieldTriangle,
    ): number | undefined => {
      const cellX = this.origin[0] + triangle.column * this.cellSize;
      const cellZ = this.origin[1] + triangle.row * this.cellSize;
      const maximumCellX = cellX + this.cellSize;
      const maximumCellZ = cellZ + this.cellSize;
      const localX = scaledProductSumCandidate(
        [
          [1, origin[0]],
          [-1, cellX],
        ],
        "Raycast half-space value",
      );
      const localZ = scaledProductSumCandidate(
        [
          [1, origin[2]],
          [-1, cellZ],
        ],
        "Raycast half-space value",
      );
      const remainingX = scaledProductSumCandidate(
        [
          [1, maximumCellX],
          [-1, origin[0]],
        ],
        "Raycast half-space value",
      );
      const remainingZ = scaledProductSumCandidate(
        [
          [1, maximumCellZ],
          [-1, origin[2]],
        ],
        "Raycast half-space value",
      );
      const diagonalValue = scaledProductSumCandidate(
        triangle.first
          ? [
              [1, origin[0]],
              [-1, cellX],
              [-1, origin[2]],
              [1, cellZ],
            ]
          : [
              [1, origin[2]],
              [-1, cellZ],
              [-1, origin[0]],
              [1, cellX],
            ],
        "Raycast half-space value",
      );
      const diagonalSlope = scaledProductSumCandidate(
        triangle.first
          ? [
              [1, dir[0]],
              [-1, dir[2]],
            ]
          : [
              [1, dir[2]],
              [-1, dir[0]],
            ],
        "Raycast half-space slope",
      );
      const halfspaces = [
        [localX, dir[0]],
        [localZ, dir[2]],
        [remainingX, -dir[0]],
        [remainingZ, -dir[2]],
        [diagonalValue, diagonalSlope],
      ] as const;
      let low = 0;
      let high = maxDistance;
      for (const [value, slope] of halfspaces) {
        if (Number.isNaN(value) || Number.isNaN(slope))
          throw new RangeError(
            "Raycast half-space calculation must not be NaN",
          );
        if (slope === 0) {
          if (value < 0) return undefined;
          continue;
        }
        const crossing = -value / slope;
        if (Number.isNaN(crossing))
          throw new RangeError(
            "Raycast half-space calculation must not be NaN",
          );
        if (slope > 0) low = Math.max(low, crossing);
        else high = Math.min(high, crossing);
        if (low > high) return undefined;
      }
      return low === 0 ? 0 : low;
    };

    const candidates: RayTriangleCandidate[] = [];
    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1)
        for (const first of [true, false]) {
          const triangle = this.triangle(column, row, first);
          const directionSign = adaptiveDotSign(triangle.plane, direction);
          const originSign = adaptivePlaneOffsetSign(
            triangle.plane,
            origin,
            triangle.a,
          );
          let root: number | undefined;
          if (directionSign === 0)
            root = originSign === 0 ? coplanarEntry(triangle) : undefined;
          else if (originSign === 0) root = 0;
          else {
            const normalizedDirectionSign = adaptiveDotSign(
              triangle.plane,
              dir,
            );
            const planeScale = Math.max(
              Math.abs(triangle.plane[0]),
              Math.abs(triangle.plane[1]),
              Math.abs(triangle.plane[2]),
            );
            const scaledPlane = vec3(
              triangle.plane[0] / planeScale,
              triangle.plane[1] / planeScale,
              triangle.plane[2] / planeScale,
            );
            const originOffset = scaledProductSumCandidate(
              [
                [scaledPlane[0], origin[0]],
                [-scaledPlane[0], triangle.a[0]],
                [scaledPlane[1], origin[1]],
                [-scaledPlane[1], triangle.a[1]],
                [scaledPlane[2], origin[2]],
                [-scaledPlane[2], triangle.a[2]],
              ],
              "Raycast plane offset",
            );
            const denominator = scaledDotCandidate(
              scaledPlane,
              dir,
              "Raycast plane direction",
            );
            root =
              normalizedDirectionSign === 0 ||
              originOffset === 0 ||
              Math.sign(originOffset) !== originSign ||
              denominator === 0 ||
              Math.sign(denominator) !== normalizedDirectionSign
                ? undefined
                : -originOffset / denominator;
          }
          if (
            root === undefined ||
            !Number.isFinite(root) ||
            root < 0 ||
            root > maxDistance
          )
            continue;
          const candidateDistance = root === 0 ? 0 : root;
          const candidatePoint = pointAt(candidateDistance);
          const [xTolerance, zTolerance] = this.projectionTolerances(
            triangle,
            candidatePoint[0],
            candidatePoint[2],
          );
          if (
            !this.triangleContainsProjection(
              triangle,
              candidatePoint[0],
              candidatePoint[2],
              xTolerance,
              zTolerance,
            )
          )
            continue;
          const residual = scaledDot(
            triangle.normal,
            subtractFinite(
              candidatePoint,
              triangle.a,
              "Raycast triangle difference",
            ),
            "Raycast plane residual",
          );
          const residualTolerance =
            64 *
            Number.EPSILON *
            Math.max(
              this.cellSize,
              Math.abs(candidatePoint[1]),
              Math.abs(triangle.a[1]),
              Math.abs(triangle.b[1]),
              Math.abs(triangle.c[1]),
            );
          if (Math.abs(residual) > residualTolerance) continue;
          candidates.push({
            distance: candidateDistance,
            point: candidatePoint,
            triangle,
          });
        }
    if (candidates.length === 0) return undefined;
    candidates.sort((left, right) =>
      left.distance < right.distance
        ? -1
        : left.distance > right.distance
          ? 1
          : 0,
    );
    const earliest = candidates[0]!;
    const tiedCandidates = candidates.filter((candidate) =>
      this.candidatesShareFeature(earliest, candidate),
    );
    const canonical = this.canonicalCandidate(tiedCandidates);
    const result = {
      distance: requireFinite(earliest.distance, "Raycast hit distance"),
      point: earliest.point,
      normal: canonical.triangle.normal,
    };
    requireFiniteVector(result.point, "Raycast hit point");
    requireFiniteVector(result.normal, "Raycast hit normal");
    return result;
  }
}
