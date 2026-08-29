import type { EnvironmentQuery, EnvironmentRaycast } from "./contracts";
import { aabbFromPoints, vec3, vec3Normalize } from "./math";
import type { Aabb, Vec3 } from "./math";

export interface HeightfieldOptions {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly heights: ArrayLike<number>;
  readonly origin?: readonly [number, number];
}

const MAX_SAFE_GEOMETRY_COMPONENT = Math.sqrt(Number.MAX_VALUE) / 16;

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

interface TriangleClosestPoint {
  readonly barycentric: readonly [number, number, number];
  readonly distance: number;
}

const closestPointOnTriangle = (
  point: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): TriangleClosestPoint => {
  const subtract = (left: Vec3, right: Vec3): Vec3 =>
    vec3(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
  const dot = (left: Vec3, right: Vec3): number =>
    requireFinite(
      left[0] * right[0] + left[1] * right[1] + left[2] * right[2],
      "Heightfield triangle calculation",
    );
  const result = (
    first: number,
    second: number,
    third: number,
  ): TriangleClosestPoint => {
    const closest = vec3(
      first * a[0] + second * b[0] + third * c[0],
      first * a[1] + second * b[1] + third * c[1],
      first * a[2] + second * b[2] + third * c[2],
    );
    return {
      barycentric: [first, second, third],
      distance: requireFinite(
        Math.hypot(
          closest[0] - point[0],
          closest[1] - point[1],
          closest[2] - point[2],
        ),
        "Heightfield triangle distance",
      ),
    };
  };

  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const ap = subtract(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return result(1, 0, 0);

  const bp = subtract(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return result(0, 1, 0);

  const vc = requireFinite(
    d1 * d4 - d3 * d2,
    "Heightfield triangle calculation",
  );
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const along = d1 / (d1 - d3);
    return result(1 - along, along, 0);
  }

  const cp = subtract(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return result(0, 0, 1);

  const vb = requireFinite(
    d5 * d2 - d1 * d6,
    "Heightfield triangle calculation",
  );
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const along = d2 / (d2 - d6);
    return result(1 - along, 0, along);
  }

  const va = requireFinite(
    d3 * d6 - d5 * d4,
    "Heightfield triangle calculation",
  );
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const along = (d4 - d3) / (d4 - d3 + d5 - d6);
    return result(0, 1 - along, along);
  }

  const denominator = va + vb + vc;
  if (!(denominator > 0) || !Number.isFinite(denominator))
    throw new RangeError(
      "Heightfield triangle must be finite and non-degenerate",
    );
  const inverse = 1 / denominator;
  const second = vb * inverse;
  const third = vc * inverse;
  return result(1 - second - third, second, third);
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
    if (
      !Number.isFinite(maximumHeight - minimumHeight) ||
      Math.max(
        maximumX - origin[0],
        maximumZ - origin[1],
        maximumHeight - minimumHeight,
      ) > MAX_SAFE_GEOMETRY_COMPONENT
    )
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
    return requireFinite(
      (1 - localZ) * ((1 - localX) * h00 + localX * h10) +
        localZ * ((1 - localX) * h01 + localX * h11),
      "Heightfield interpolated height",
    );
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
    const columnOffset = requireFinite(
      point[1] - this.heightAt(point[0], point[2]),
      "Signed-distance sign",
    );
    const result = columnOffset >= 0 ? distance : -distance;
    return requireFinite(result, "Signed distance");
  }

  private closestSurfaceDistance(point: Vec3): number {
    // A bilinear patch differs from its two-triangle interpolant by at most
    // one quarter of the mixed corner difference. Subdivision drives that
    // Hausdorff bound down quadratically, so the smallest queued lower bound
    // certifies the global closest distance instead of trusting a local solve.
    type PatchNode = {
      readonly column: number;
      readonly row: number;
      readonly u0: number;
      readonly u1: number;
      readonly v0: number;
      readonly v1: number;
      readonly depth: number;
      readonly lowerBound: number;
    };

    const clampedX = Math.max(
      this.origin[0],
      Math.min(this.maximumX, point[0]),
    );
    const clampedZ = Math.max(
      this.origin[1],
      Math.min(this.maximumZ, point[2]),
    );
    const initialPoint = vec3(
      clampedX,
      this.heightAt(clampedX, clampedZ),
      clampedZ,
    );
    let bestDistance = requireFinite(
      Math.hypot(
        initialPoint[0] - point[0],
        initialPoint[1] - point[1],
        initialPoint[2] - point[2],
      ),
      "Signed distance",
    );

    const includeBoundarySegment = (
      coordinate: number,
      firstCoordinate: number,
      firstHeight: number,
      secondCoordinate: number,
      secondHeight: number,
    ): void => {
      const coordinateDelta = secondCoordinate - firstCoordinate;
      const heightDelta = secondHeight - firstHeight;
      const length = requireFinite(
        Math.hypot(coordinateDelta, heightDelta),
        "Heightfield boundary segment length",
      );
      const projection = requireFinite(
        (coordinate - firstCoordinate) * (coordinateDelta / length) +
          (point[1] - firstHeight) * (heightDelta / length),
        "Heightfield boundary projection",
      );
      const parameter = Math.max(0, Math.min(1, projection / length));
      bestDistance = Math.min(
        bestDistance,
        requireFinite(
          Math.hypot(
            firstCoordinate + parameter * coordinateDelta - coordinate,
            firstHeight + parameter * heightDelta - point[1],
          ),
          "Heightfield boundary distance",
        ),
      );
    };
    if (point[0] <= this.origin[0] || point[0] >= this.maximumX) {
      const column = point[0] <= this.origin[0] ? 0 : this.width - 1;
      for (let row = 0; row < this.depth - 1; row += 1)
        includeBoundarySegment(
          point[2],
          this.origin[1] + row * this.cellSize,
          this.sample(column, row),
          this.origin[1] + (row + 1) * this.cellSize,
          this.sample(column, row + 1),
        );
    }
    if (point[2] <= this.origin[1] || point[2] >= this.maximumZ) {
      const row = point[2] <= this.origin[1] ? 0 : this.depth - 1;
      for (let column = 0; column < this.width - 1; column += 1)
        includeBoundarySegment(
          point[0],
          this.origin[0] + column * this.cellSize,
          this.sample(column, row),
          this.origin[0] + (column + 1) * this.cellSize,
          this.sample(column + 1, row),
        );
    }
    if (
      (point[0] <= this.origin[0] || point[0] >= this.maximumX) &&
      (point[2] <= this.origin[1] || point[2] >= this.maximumZ)
    ) {
      const column = point[0] <= this.origin[0] ? 0 : this.width - 1;
      const row = point[2] <= this.origin[1] ? 0 : this.depth - 1;
      bestDistance = Math.min(
        bestDistance,
        requireFinite(
          Math.abs(point[1] - this.sample(column, row)),
          "Heightfield corner distance",
        ),
      );
    }
    if (bestDistance > MAX_SAFE_GEOMETRY_COMPONENT)
      throw new RangeError("Signed-distance input exceeds finite query range");
    const tolerance =
      1e-10 +
      256 *
        Number.EPSILON *
        Math.max(
          1,
          this.cellSize,
          bestDistance,
          Math.abs(point[0]),
          Math.abs(point[1]),
          Math.abs(point[2]),
        );
    const nodes: PatchNode[] = [];

    const pointInPatch = (
      column: number,
      row: number,
      u: number,
      v: number,
    ): Vec3 =>
      vec3(
        requireFinite(
          this.origin[0] + (column + u) * this.cellSize,
          "Heightfield surface x coordinate",
        ),
        this.heightInCell(column, row, u, v),
        requireFinite(
          this.origin[1] + (row + v) * this.cellSize,
          "Heightfield surface z coordinate",
        ),
      );
    const axisDistance = (value: number, minimum: number, maximum: number) =>
      value < minimum ? minimum - value : value > maximum ? value - maximum : 0;

    const evaluate = (node: Omit<PatchNode, "lowerBound">): void => {
      const p00 = pointInPatch(node.column, node.row, node.u0, node.v0);
      const p10 = pointInPatch(node.column, node.row, node.u1, node.v0);
      const p01 = pointInPatch(node.column, node.row, node.u0, node.v1);
      const p11 = pointInPatch(node.column, node.row, node.u1, node.v1);
      const minimumX = p00[0];
      const maximumX = p11[0];
      const minimumZ = p00[2];
      const maximumZ = p11[2];
      const minimumY = Math.min(p00[1], p10[1], p01[1], p11[1]);
      const maximumY = Math.max(p00[1], p10[1], p01[1], p11[1]);
      const boxLowerBound = Math.hypot(
        axisDistance(point[0], minimumX, maximumX),
        axisDistance(point[1], minimumY, maximumY),
        axisDistance(point[2], minimumZ, maximumZ),
      );
      if (boxLowerBound >= bestDistance - tolerance) return;

      const triangleCandidate = (
        a: Vec3,
        b: Vec3,
        c: Vec3,
        uvA: readonly [number, number],
        uvB: readonly [number, number],
        uvC: readonly [number, number],
      ): number => {
        const closest = closestPointOnTriangle(point, a, b, c);
        const [first, second, third] = closest.barycentric;
        const u = first * uvA[0] + second * uvB[0] + third * uvC[0];
        const v = first * uvA[1] + second * uvB[1] + third * uvC[1];
        const candidate = pointInPatch(node.column, node.row, u, v);
        bestDistance = Math.min(
          bestDistance,
          requireFinite(
            Math.hypot(
              candidate[0] - point[0],
              candidate[1] - point[1],
              candidate[2] - point[2],
            ),
            "Signed-distance candidate",
          ),
        );
        return closest.distance;
      };
      const firstTriangleDistance = triangleCandidate(
        p00,
        p10,
        p11,
        [node.u0, node.v0],
        [node.u1, node.v0],
        [node.u1, node.v1],
      );
      const secondTriangleDistance = triangleCandidate(
        p00,
        p11,
        p01,
        [node.u0, node.v0],
        [node.u1, node.v1],
        [node.u0, node.v1],
      );
      const approximationError =
        Math.abs(
          requireFinite(
            p00[1] - p10[1] - p01[1] + p11[1],
            "Heightfield bilinear deviation",
          ),
        ) / 4;
      const lowerBound = Math.max(
        boxLowerBound,
        0,
        Math.min(firstTriangleDistance, secondTriangleDistance) -
          approximationError,
      );
      if (lowerBound < bestDistance - tolerance)
        nodes.push({ ...node, lowerBound });
    };

    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1)
        evaluate({ column, row, u0: 0, u1: 1, v0: 0, v1: 1, depth: 0 });

    let iterations = 0;
    while (nodes.length > 0) {
      let minimumIndex = 0;
      for (let index = 1; index < nodes.length; index += 1)
        if (nodes[index]!.lowerBound < nodes[minimumIndex]!.lowerBound)
          minimumIndex = index;
      const node = nodes[minimumIndex]!;
      nodes.splice(minimumIndex, 1);
      if (node.lowerBound >= bestDistance - tolerance) break;
      if (node.depth >= 52 || iterations >= 1_000_000)
        throw new RangeError("Signed-distance global search did not converge");
      iterations += 1;
      const middleU = (node.u0 + node.u1) / 2;
      const middleV = (node.v0 + node.v1) / 2;
      const childDepth = node.depth + 1;
      evaluate({
        ...node,
        u1: middleU,
        v1: middleV,
        depth: childDepth,
      });
      evaluate({
        ...node,
        u0: middleU,
        v1: middleV,
        depth: childDepth,
      });
      evaluate({
        ...node,
        u1: middleU,
        v0: middleV,
        depth: childDepth,
      });
      evaluate({
        ...node,
        u0: middleU,
        v0: middleV,
        depth: childDepth,
      });
    }
    return requireFinite(bestDistance, "Signed distance");
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

  private gradientAt(x: number, z: number): readonly [number, number] {
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
    const h00 = this.sample(x0, z0);
    const h10 = this.sample(x0 + 1, z0);
    const h01 = this.sample(x0, z0 + 1);
    const h11 = this.sample(x0 + 1, z0 + 1);
    return [
      requireFinite(
        ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / this.cellSize,
        "Heightfield x gradient",
      ),
      requireFinite(
        ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / this.cellSize,
        "Heightfield z gradient",
      ),
    ];
  }

  public normalAt(x: number, z: number): Vec3 {
    const [dx, dz] = this.gradientAt(x, z);
    const normal = vec3Normalize(vec3(-dx, 1, -dz));
    return requireFiniteVector(normal, "Heightfield normal");
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
    if (directionLength < 1e-15)
      throw new RangeError("Raycast direction must be non-zero");
    const dir = vec3Normalize(direction);
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
    const columnValue = (distance: number): number => {
      const point = pointAt(distance);
      return requireFinite(
        point[1] - this.heightAt(point[0], point[2]),
        "Raycast height difference",
      );
    };
    const valueTolerance = 1e-10;
    if (Math.abs(columnValue(0)) <= valueTolerance) {
      const point = pointAt(0);
      return {
        distance: 0,
        point,
        normal: this.normalAt(point[0], point[2]),
      };
    }
    const breakpoints = [0, maxDistance];
    const addGridCrossings = (
      axisOrigin: number,
      axisDirection: number,
      sampleCount: number,
      gridOrigin: number,
    ): void => {
      if (axisDirection === 0) return;
      for (let index = 0; index < sampleCount; index += 1) {
        const distance =
          (gridOrigin + index * this.cellSize - axisOrigin) / axisDirection;
        if (distance > 0 && distance < maxDistance) breakpoints.push(distance);
      }
    };
    addGridCrossings(origin[0], dir[0], this.width, this.origin[0]);
    addGridCrossings(origin[2], dir[2], this.depth, this.origin[1]);
    breakpoints.sort((a, b) => a - b);
    const sortedBreakpoints: number[] = [];
    for (const breakpoint of breakpoints)
      if (
        sortedBreakpoints.length === 0 ||
        breakpoint > sortedBreakpoints[sortedBreakpoints.length - 1]!
      )
        sortedBreakpoints.push(breakpoint);

    const findRoot = (
      low: number,
      high: number,
      coefficients: readonly [number, number, number],
    ): number | undefined => {
      const quadratic = requireFinite(
        coefficients[0],
        "Raycast quadratic coefficient",
      );
      const linear = requireFinite(
        coefficients[1],
        "Raycast linear coefficient",
      );
      const constant = requireFinite(
        coefficients[2],
        "Raycast constant coefficient",
      );
      const scale = Math.max(
        Math.abs(quadratic),
        Math.abs(linear),
        Math.abs(constant),
      );
      if (scale === 0) return low;
      const a = quadratic / scale;
      const b = linear / scale;
      const c = constant / scale;
      const roots: number[] = [];
      if (a === 0) {
        if (b === 0) return undefined;
        roots.push(-c / b);
      } else {
        let discriminant = b * b - 4 * a * c;
        const discriminantTolerance =
          64 * Number.EPSILON * (b * b + Math.abs(4 * a * c) + 1);
        if (discriminant < -discriminantTolerance) return undefined;
        if (Math.abs(discriminant) <= discriminantTolerance) discriminant = 0;
        const squareRoot = Math.sqrt(discriminant);
        if (squareRoot === 0) roots.push(-b / (2 * a));
        else {
          const q = -0.5 * (b + Math.sign(b || 1) * squareRoot);
          roots.push(q / a);
          if (q !== 0) roots.push(c / q);
        }
      }
      const intervalTolerance = 1e-10;
      let earliest: number | undefined;
      for (const root of roots) {
        requireFinite(root, "Raycast generated root");
        if (
          root >= low - intervalTolerance &&
          root <= high + intervalTolerance
        ) {
          const candidate = Math.max(low, Math.min(high, root));
          if (earliest === undefined || candidate < earliest)
            earliest = candidate;
        }
      }
      return earliest;
    };

    let hitDistance: number | undefined;
    for (
      let interval = 0;
      interval + 1 < sortedBreakpoints.length;
      interval += 1
    ) {
      const low = sortedBreakpoints[interval]!;
      const high = sortedBreakpoints[interval + 1]!;
      const middle = (low + high) / 2;
      const middlePoint = pointAt(middle);
      const rawX = requireFinite(
        (middlePoint[0] - this.origin[0]) / this.cellSize,
        "Raycast local x coordinate",
      );
      const rawZ = requireFinite(
        (middlePoint[2] - this.origin[1]) / this.cellSize,
        "Raycast local z coordinate",
      );
      const clampedX = Math.max(0, Math.min(this.width - 1, rawX));
      const clampedZ = Math.max(0, Math.min(this.depth - 1, rawZ));
      const cellX = Math.min(this.width - 2, Math.floor(clampedX));
      const cellZ = Math.min(this.depth - 2, Math.floor(clampedZ));
      const xSlope =
        rawX > 0 && rawX < this.width - 1 ? dir[0] / this.cellSize : 0;
      const zSlope =
        rawZ > 0 && rawZ < this.depth - 1 ? dir[2] / this.cellSize : 0;
      const xIntercept =
        (xSlope === 0 ? clampedX - cellX : rawX - cellX) - xSlope * middle;
      const zIntercept =
        (zSlope === 0 ? clampedZ - cellZ : rawZ - cellZ) - zSlope * middle;
      const h00 = this.sample(cellX, cellZ);
      const h10 = this.sample(cellX + 1, cellZ);
      const h01 = this.sample(cellX, cellZ + 1);
      const h11 = this.sample(cellX + 1, cellZ + 1);
      const xHeight = h10 - h00;
      const zHeight = h01 - h00;
      const crossHeight = h11 - h10 - h01 + h00;
      const heightConstant =
        h00 +
        xHeight * xIntercept +
        zHeight * zIntercept +
        crossHeight * xIntercept * zIntercept;
      const heightLinear =
        xHeight * xSlope +
        zHeight * zSlope +
        crossHeight * (xIntercept * zSlope + zIntercept * xSlope);
      const heightQuadratic = crossHeight * xSlope * zSlope;
      const coefficients = [
        -heightQuadratic,
        dir[1] - heightLinear,
        origin[1] - heightConstant,
      ] as const;
      const root = findRoot(low, high, coefficients);
      if (root !== undefined) {
        const rootScale = requireFinite(
          Math.abs(coefficients[0] * root * root) +
            Math.abs(coefficients[1] * root) +
            Math.abs(coefficients[2]),
          "Raycast root scale",
        );
        const rootTolerance = 64 * Number.EPSILON * rootScale;
        if (Math.abs(columnValue(root)) <= rootTolerance) {
          hitDistance = root;
          break;
        }
      }
    }
    if (hitDistance === undefined) return undefined;
    const hitPoint = pointAt(hitDistance);
    const result = {
      distance: requireFinite(hitDistance, "Raycast hit distance"),
      point: hitPoint,
      normal: this.normalAt(hitPoint[0], hitPoint[2]),
    };
    requireFiniteVector(result.point, "Raycast hit point");
    requireFiniteVector(result.normal, "Raycast hit normal");
    return result;
  }
}
