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

  private slopeBound(): readonly [number, number] {
    let maximumX = 0;
    let maximumZ = 0;
    for (let row = 0; row < this.depth - 1; row += 1)
      for (let column = 0; column < this.width - 1; column += 1) {
        const at = (sampleColumn: number, sampleRow: number): number =>
          this.heights[sampleRow * this.width + sampleColumn];
        const h00 = at(column, row);
        const h10 = at(column + 1, row);
        const h01 = at(column, row + 1);
        const h11 = at(column + 1, row + 1);
        maximumX = Math.max(
          maximumX,
          Math.abs(h10 - h00) / this.cellSize,
          Math.abs(h11 - h01) / this.cellSize,
        );
        maximumZ = Math.max(
          maximumZ,
          Math.abs(h01 - h00) / this.cellSize,
          Math.abs(h11 - h10) / this.cellSize,
        );
      }
    return [maximumX, maximumZ];
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
    const initialValue = columnValue(0);
    if (Math.abs(initialValue) <= 1e-10)
      return {
        distance: 0,
        point: origin,
        normal: this.normalAt(origin[0], origin[2]),
      };
    const [maximumX, maximumZ] = this.slopeBound();
    const lipschitz =
      Math.abs(dir[1]) +
      Math.abs(dir[0]) * maximumX +
      Math.abs(dir[2]) * maximumZ;
    const valueTolerance = 1e-10;
    const distanceTolerance = 1e-10;
    type RootBracket = {
      readonly low: number;
      readonly high: number;
      readonly lowValue: number;
      readonly highValue: number;
    };
    const findEarliestBracket = (
      low: number,
      high: number,
      lowValue: number,
      highValue: number,
      depth: number,
    ): RootBracket | undefined => {
      if (Math.abs(lowValue) <= valueTolerance)
        return { low, high: low, lowValue, highValue: lowValue };
      if (Math.abs(highValue) <= valueTolerance)
        return { low: high, high, lowValue: highValue, highValue };
      if (lowValue * highValue <= 0 && high - low <= distanceTolerance)
        return { low, high, lowValue, highValue };
      if (high - low <= distanceTolerance || depth >= 64) return undefined;

      const middle = (low + high) / 2;
      const middleValue = columnValue(middle);
      if (Math.abs(middleValue) <= valueTolerance)
        return {
          low: middle,
          high: middle,
          lowValue: middleValue,
          highValue: middleValue,
        };
      const halfWidth = (high - low) / 2;
      if (Math.abs(middleValue) > lipschitz * halfWidth + valueTolerance)
        return undefined;

      const leftMayContainRoot =
        lowValue * middleValue <= 0 ||
        Math.abs(middleValue) <= lipschitz * (middle - low) + valueTolerance;
      if (leftMayContainRoot) {
        const left = findEarliestBracket(
          low,
          middle,
          lowValue,
          middleValue,
          depth + 1,
        );
        if (left) return left;
      }
      const rightMayContainRoot =
        middleValue * highValue <= 0 ||
        Math.abs(middleValue) <= lipschitz * (high - middle) + valueTolerance;
      return rightMayContainRoot
        ? findEarliestBracket(middle, high, middleValue, highValue, depth + 1)
        : undefined;
    };
    const bracket = findEarliestBracket(
      0,
      maxDistance,
      initialValue,
      columnValue(maxDistance),
      0,
    );
    if (!bracket) return undefined;
    let low = bracket.low;
    let high = bracket.high;
    let lowValue = bracket.lowValue;
    if (low !== high) {
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const middle = (low + high) / 2;
        const middleValue = columnValue(middle);
        if (Math.abs(middleValue) <= valueTolerance) {
          low = middle;
          high = middle;
          break;
        }
        if (lowValue * middleValue <= 0) high = middle;
        else {
          low = middle;
          lowValue = middleValue;
        }
        if (high - low <= distanceTolerance) break;
      }
    }
    const hitDistance = (low + high) / 2;
    const hitPoint = pointAt(hitDistance);
    return {
      distance: hitDistance,
      point: hitPoint,
      normal: this.normalAt(hitPoint[0], hitPoint[2]),
    };
  }
}
