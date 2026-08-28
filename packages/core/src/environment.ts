import type { EnvironmentQuery, EnvironmentRaycast } from "./contracts";
import { vec3, vec3Normalize } from "./math";
import type { Vec3 } from "./math";

export interface HeightfieldOptions {
  readonly width: number;
  readonly depth: number;
  readonly cellSize: number;
  readonly heights: ArrayLike<number>;
  readonly origin?: readonly [number, number];
}

export class HeightfieldEnvironment implements EnvironmentQuery {
  public readonly width: number;
  public readonly depth: number;
  public readonly cellSize: number;
  public readonly heights: Float64Array;
  public readonly origin: readonly [number, number];

  public constructor(options: HeightfieldOptions) {
    if (
      !Number.isInteger(options.width) ||
      !Number.isInteger(options.depth) ||
      options.width < 2 ||
      options.depth < 2
    )
      throw new RangeError("Heightfield dimensions must be at least 2 by 2");
    if (options.heights.length !== options.width * options.depth)
      throw new RangeError(
        "Heightfield sample count does not match dimensions",
      );
    if (!Number.isFinite(options.cellSize) || options.cellSize <= 0)
      throw new RangeError("Heightfield cell size must be positive and finite");
    for (let index = 0; index < options.heights.length; index += 1)
      if (!Number.isFinite(options.heights[index]))
        throw new RangeError("Heightfield heights must be finite");
    this.width = options.width;
    this.depth = options.depth;
    this.cellSize = options.cellSize;
    this.heights = new Float64Array(options.heights);
    this.origin = options.origin ?? [0, 0];
  }

  public heightAt(x: number, z: number): number {
    const localX = (x - this.origin[0]) / this.cellSize;
    const localZ = (z - this.origin[1]) / this.cellSize;
    const clampedX = Math.max(0, Math.min(this.width - 1, localX));
    const clampedZ = Math.max(0, Math.min(this.depth - 1, localZ));
    const x0 = Math.min(this.width - 2, Math.floor(clampedX));
    const z0 = Math.min(this.depth - 2, Math.floor(clampedZ));
    const tx = clampedX - x0;
    const tz = clampedZ - z0;
    const at = (column: number, row: number): number =>
      this.heights[row * this.width + column];
    return (
      (1 - tz) * ((1 - tx) * at(x0, z0) + tx * at(x0 + 1, z0)) +
      tz * ((1 - tx) * at(x0, z0 + 1) + tx * at(x0 + 1, z0 + 1))
    );
  }

  public signedDistance(point: Vec3): number {
    // The returned value is the signed distance to the bilinear heightfield
    // surface, found by Gauss-Newton projection. The iteration is stopped at
    // a 1e-10 m projected-point update or after 24 iterations; the sign is
    // positive above the closest surface point and negative below it.
    const closest = this.closestSurfacePoint(point);
    const delta = vec3(
      closest[0] - point[0],
      closest[1] - point[1],
      closest[2] - point[2],
    );
    const distance = Math.hypot(delta[0], delta[1], delta[2]);
    return point[1] - this.heightAt(point[0], point[2]) >= 0
      ? distance
      : -distance;
  }

  private gradientAt(x: number, z: number): readonly [number, number] {
    const localX = Math.max(
      0,
      Math.min(this.width - 1, (x - this.origin[0]) / this.cellSize),
    );
    const localZ = Math.max(
      0,
      Math.min(this.depth - 1, (z - this.origin[1]) / this.cellSize),
    );
    const x0 = Math.min(this.width - 2, Math.floor(localX));
    const z0 = Math.min(this.depth - 2, Math.floor(localZ));
    const tx = localX - x0;
    const tz = localZ - z0;
    const at = (column: number, row: number): number =>
      this.heights[row * this.width + column];
    const h00 = at(x0, z0);
    const h10 = at(x0 + 1, z0);
    const h01 = at(x0, z0 + 1);
    const h11 = at(x0 + 1, z0 + 1);
    return [
      ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / this.cellSize,
      ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / this.cellSize,
    ];
  }

  private closestSurfacePoint(point: Vec3): Vec3 {
    const clampX = (x: number): number =>
      this.origin[0] +
      Math.max(
        0,
        Math.min(this.width - 1, (x - this.origin[0]) / this.cellSize),
      ) *
        this.cellSize;
    const clampZ = (z: number): number =>
      this.origin[1] +
      Math.max(
        0,
        Math.min(this.depth - 1, (z - this.origin[1]) / this.cellSize),
      ) *
        this.cellSize;
    let x = clampX(point[0]);
    let z = clampZ(point[2]);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const height = this.heightAt(x, z);
      const [dx, dz] = this.gradientAt(x, z);
      const residual = height - point[1];
      const denominator = 1 + dx * dx + dz * dz;
      const gradientX = x - point[0] + residual * dx;
      const gradientZ = z - point[2] + residual * dz;
      const correction = (dx * gradientX + dz * gradientZ) / denominator;
      const stepX = gradientX - dx * correction;
      const stepZ = gradientZ - dz * correction;
      const nextX = clampX(x - stepX);
      const nextZ = clampZ(z - stepZ);
      if (Math.hypot(nextX - x, nextZ - z) <= 1e-10) {
        x = nextX;
        z = nextZ;
        break;
      }
      x = nextX;
      z = nextZ;
    }
    return vec3(x, this.heightAt(x, z), z);
  }

  public normalAt(x: number, z: number): Vec3 {
    const [dx, dz] = this.gradientAt(x, z);
    return vec3Normalize(vec3(-dx, 1, -dz));
  }

  public raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): EnvironmentRaycast | undefined {
    if (!Number.isFinite(maxDistance) || maxDistance < 0)
      throw new RangeError(
        "Raycast max distance must be non-negative and finite",
      );
    const dir = vec3Normalize(direction);
    const pointAt = (distance: number): Vec3 =>
      vec3(
        origin[0] + dir[0] * distance,
        origin[1] + dir[1] * distance,
        origin[2] + dir[2] * distance,
      );
    const columnValue = (distance: number): number =>
      origin[1] +
      dir[1] * distance -
      this.heightAt(
        origin[0] + dir[0] * distance,
        origin[2] + dir[2] * distance,
      );
    const valueTolerance = 1e-10;
    if (Math.abs(columnValue(0)) <= valueTolerance)
      return {
        distance: 0,
        point: origin,
        normal: this.normalAt(origin[0], origin[2]),
      };
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
        breakpoint > sortedBreakpoints[sortedBreakpoints.length - 1]
      )
        sortedBreakpoints.push(breakpoint);

    const at = (column: number, row: number): number =>
      this.heights[row * this.width + column];
    const findRoot = (
      low: number,
      high: number,
      coefficients: readonly [number, number, number],
    ): number | undefined => {
      const [quadratic, linear, constant] = coefficients;
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
      for (const root of roots)
        if (
          root >= low - intervalTolerance &&
          root <= high + intervalTolerance
        ) {
          const candidate = Math.max(low, Math.min(high, root));
          if (earliest === undefined || candidate < earliest)
            earliest = candidate;
        }
      return earliest;
    };

    let hitDistance: number | undefined;
    for (
      let interval = 0;
      interval + 1 < sortedBreakpoints.length;
      interval += 1
    ) {
      const low = sortedBreakpoints[interval];
      const high = sortedBreakpoints[interval + 1];
      const middle = (low + high) / 2;
      const rawX =
        (origin[0] + dir[0] * middle - this.origin[0]) / this.cellSize;
      const rawZ =
        (origin[2] + dir[2] * middle - this.origin[1]) / this.cellSize;
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
      const h00 = at(cellX, cellZ);
      const h10 = at(cellX + 1, cellZ);
      const h01 = at(cellX, cellZ + 1);
      const h11 = at(cellX + 1, cellZ + 1);
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
        const rootScale =
          Math.abs(coefficients[0] * root * root) +
          Math.abs(coefficients[1] * root) +
          Math.abs(coefficients[2]);
        const rootTolerance = 64 * Number.EPSILON * rootScale;
        if (Math.abs(columnValue(root)) <= rootTolerance) {
          hitDistance = root;
          break;
        }
      }
    }
    if (hitDistance === undefined) return undefined;
    const hitPoint = pointAt(hitDistance);
    return {
      distance: hitDistance,
      point: hitPoint,
      normal: this.normalAt(hitPoint[0], hitPoint[2]),
    };
  }
}
