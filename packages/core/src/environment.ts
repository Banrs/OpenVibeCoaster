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

interface HeightfieldTriangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly normal: Vec3;
  readonly column: number;
  readonly row: number;
  readonly first: boolean;
}

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

const scaledDot = (left: Vec3, right: Vec3, label: string): number => {
  const scale = Math.max(
    Math.abs(right[0]),
    Math.abs(right[1]),
    Math.abs(right[2]),
  );
  if (scale === 0) return 0;
  return requireFinite(
    (left[0] * (right[0] / scale) +
      left[1] * (right[1] / scale) +
      left[2] * (right[2] / scale)) *
      scale,
    label,
  );
};

const scaledDotRoundoff = (left: Vec3, right: Vec3): number => {
  const scale = Math.max(
    Math.abs(right[0]),
    Math.abs(right[1]),
    Math.abs(right[2]),
  );
  if (scale === 0) return 0;
  const magnitude =
    Math.abs(left[0] * (right[0] / scale)) +
    Math.abs(left[1] * (right[1] / scale)) +
    Math.abs(left[2] * (right[2] / scale));
  return scale * (16 * Number.EPSILON * magnitude);
};

const pointDistance = (point: Vec3, target: Vec3): number => {
  const difference = subtractFinite(
    point,
    target,
    "Heightfield distance difference",
  );
  return requireFinite(
    Math.hypot(difference[0], difference[1], difference[2]),
    "Signed distance",
  );
};

const pointSegmentDistance = (point: Vec3, a: Vec3, b: Vec3): number => {
  const edge = subtractFinite(b, a, "Heightfield edge difference");
  if (edge[0] === 0 && edge[1] === 0 && edge[2] === 0)
    return pointDistance(point, a);
  const direction = robustNormalize(edge, "Heightfield edge direction");
  const alongFromA = scaledDot(
    direction,
    subtractFinite(point, a, "Heightfield distance difference"),
    "Heightfield edge projection",
  );
  if (alongFromA <= 0) return pointDistance(point, a);
  const alongFromB = scaledDot(
    direction,
    subtractFinite(point, b, "Heightfield distance difference"),
    "Heightfield edge projection",
  );
  if (alongFromB >= 0) return pointDistance(point, b);
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

export class HeightfieldEnvironment implements EnvironmentQuery {
  public readonly width: number;
  public readonly depth: number;
  public readonly cellSize: number;
  public readonly heights: Float64Array;
  public readonly origin: readonly [number, number];
  private readonly maximumX: number;
  private readonly maximumZ: number;

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
    const xSlope = requireFinite(
      ((first ? p10[1] : p11[1]) - (first ? p00[1] : p01[1])) / this.cellSize,
      "Heightfield x gradient",
    );
    const zSlope = requireFinite(
      ((first ? p11[1] : p01[1]) - (first ? p10[1] : p00[1])) / this.cellSize,
      "Heightfield z gradient",
    );
    return {
      a: p00,
      b: first ? p10 : p11,
      c: first ? p11 : p01,
      normal: robustNormalize(vec3(-xSlope, 1, -zSlope), "Heightfield normal"),
      column,
      row,
      first,
    };
  }

  private triangleContainsProjection(
    triangle: HeightfieldTriangle,
    x: number,
    z: number,
  ): boolean {
    const cellX = this.origin[0] + triangle.column * this.cellSize;
    const cellZ = this.origin[1] + triangle.row * this.cellSize;
    const localX = (x - cellX) / this.cellSize;
    const localZ = (z - cellZ) / this.cellSize;
    if (!Number.isFinite(localX) || !Number.isFinite(localZ)) return false;
    return (
      localX >= 0 &&
      localX <= 1 &&
      localZ >= 0 &&
      localZ <= 1 &&
      (triangle.first ? localZ <= localX : localX <= localZ)
    );
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
    const relative = subtractFinite(
      point,
      triangle.a,
      "Heightfield triangle difference",
    );
    const planeDistance = scaledDot(
      triangle.normal,
      relative,
      "Heightfield triangle distance",
    );
    const projectedX = point[0] - planeDistance * triangle.normal[0];
    const projectedZ = point[2] - planeDistance * triangle.normal[2];
    if (
      Number.isFinite(projectedX) &&
      Number.isFinite(projectedZ) &&
      this.triangleContainsProjection(triangle, projectedX, projectedZ)
    )
      return Math.abs(planeDistance);
    return Math.min(
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
    const relativeX = requireFinite(
      point[0] - a[0],
      "Heightfield curtain difference",
    );
    const relativeZ = requireFinite(
      point[2] - a[2],
      "Heightfield curtain difference",
    );
    const along = requireFinite(
      relativeX * directionX + relativeZ * directionZ,
      "Heightfield curtain projection",
    );
    const perpendicular = requireFinite(
      relativeX * -directionZ + relativeZ * directionX,
      "Heightfield curtain projection",
    );
    if (along >= 0 && along <= edgeLength) {
      const top = requireFinite(
        a[1] + (b[1] - a[1]) * (along / edgeLength),
        "Heightfield curtain top",
      );
      if (point[1] <= top) return Math.abs(perpendicular);
    }

    const upwardA =
      point[1] <= a[1]
        ? 0
        : requireFinite(point[1] - a[1], "Heightfield curtain height");
    const upwardB =
      point[1] <= b[1]
        ? 0
        : requireFinite(point[1] - b[1], "Heightfield curtain height");
    const verticalRayDistance = Math.min(
      Math.hypot(along, upwardA),
      Math.hypot(along - edgeLength, upwardB),
    );
    const planarDistance =
      point[1] <= Math.min(a[1], b[1])
        ? verticalRayDistance
        : Math.min(
            verticalRayDistance,
            pointSegmentDistance(
              vec3(along, point[1], 0),
              vec3(0, a[1], 0),
              vec3(edgeLength, b[1], 0),
            ),
          );
    return requireFinite(
      Math.hypot(perpendicular, planarDistance),
      "Signed distance",
    );
  }

  private closestSurfaceDistance(point: Vec3): number {
    let closest = Number.POSITIVE_INFINITY;
    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1)
        for (const first of [true, false])
          closest = Math.min(
            closest,
            this.triangleDistance(point, this.triangle(column, row, first)),
          );

    for (let column = 0; column < this.width - 1; column += 1) {
      closest = Math.min(
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
      closest = Math.min(
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

  private isSelectedTriangleAt(
    triangle: HeightfieldTriangle,
    x: number,
    z: number,
  ): boolean {
    const selected = this.triangleAt(x, z);
    return (
      selected.column === triangle.column &&
      selected.row === triangle.row &&
      selected.first === triangle.first
    );
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
      const localX = requireFinite(
        (origin[0] - cellX) / this.cellSize,
        "Raycast local x coordinate",
      );
      const localZ = requireFinite(
        (origin[2] - cellZ) / this.cellSize,
        "Raycast local z coordinate",
      );
      const xSlope = dir[0] / this.cellSize;
      const zSlope = dir[2] / this.cellSize;
      const halfspaces = [
        [localX, xSlope],
        [localZ, zSlope],
        [1 - localX, -xSlope],
        [1 - localZ, -zSlope],
        triangle.first
          ? [localX - localZ, xSlope - zSlope]
          : [localZ - localX, zSlope - xSlope],
      ] as const;
      let low = 0;
      let high = maxDistance;
      for (const [value, slope] of halfspaces) {
        if (slope === 0) {
          if (value < 0) return undefined;
          continue;
        }
        const crossing = -value / slope;
        if (slope > 0) low = Math.max(low, crossing);
        else high = Math.min(high, crossing);
        if (low > high) return undefined;
      }
      return low === 0 ? 0 : low;
    };

    let hitDistance: number | undefined;
    let hitNormal: Vec3 | undefined;
    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1)
        for (const first of [true, false]) {
          const triangle = this.triangle(column, row, first);
          const originDifference = subtractFinite(
            origin,
            triangle.a,
            "Raycast triangle difference",
          );
          const originOffset = scaledDot(
            triangle.normal,
            originDifference,
            "Raycast plane offset",
          );
          const denominator = requireFinite(
            triangle.normal[0] * dir[0] +
              triangle.normal[1] * dir[1] +
              triangle.normal[2] * dir[2],
            "Raycast plane direction",
          );
          const parallel =
            Math.abs(denominator) <= scaledDotRoundoff(triangle.normal, dir);
          const root = parallel
            ? Math.abs(originOffset) <=
              scaledDotRoundoff(triangle.normal, originDifference)
              ? coplanarEntry(triangle)
              : undefined
            : -originOffset / denominator;
          if (
            root === undefined ||
            !Number.isFinite(root) ||
            root < 0 ||
            root > maxDistance ||
            (hitDistance !== undefined && root >= hitDistance)
          )
            continue;
          const candidateDistance = root === 0 ? 0 : root;
          const candidatePoint = pointAt(candidateDistance);
          if (
            candidatePoint[0] < this.origin[0] ||
            candidatePoint[0] > this.maximumX ||
            candidatePoint[2] < this.origin[1] ||
            candidatePoint[2] > this.maximumZ ||
            !this.isSelectedTriangleAt(
              triangle,
              candidatePoint[0],
              candidatePoint[2],
            ) ||
            !this.triangleContainsProjection(
              triangle,
              candidatePoint[0],
              candidatePoint[2],
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
          hitDistance = candidateDistance;
          hitNormal = triangle.normal;
        }
    if (hitDistance === undefined || hitNormal === undefined) return undefined;
    const hitPoint = pointAt(hitDistance);
    const result = {
      distance: requireFinite(hitDistance, "Raycast hit distance"),
      point: hitPoint,
      normal: hitNormal,
    };
    requireFiniteVector(result.point, "Raycast hit point");
    requireFiniteVector(result.normal, "Raycast hit normal");
    return result;
  }
}
