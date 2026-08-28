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
    return point[1] >= closest[1] ? distance : -distance;
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
    let previous = this.signedDistance(origin);
    if (Math.abs(previous) <= 1e-10)
      return {
        distance: 0,
        point: origin,
        normal: this.normalAt(origin[0], origin[2]),
      };
    const step = Math.max(this.cellSize / 64, maxDistance / 8192);
    const steps = Math.ceil(maxDistance / step);
    for (let index = 1; index <= steps; index += 1) {
      const distance = Math.min(maxDistance, index * step);
      const point = pointAt(distance);
      const current = this.signedDistance(point);
      if (previous === 0 || previous * current <= 0) {
        let low = distance - Math.min(step, distance);
        let high = distance;
        for (let iteration = 0; iteration < 60; iteration += 1) {
          const middle = (low + high) / 2;
          const middleValue = this.signedDistance(pointAt(middle));
          if (Math.abs(middleValue) <= 1e-10 || high - low <= 1e-10) {
            low = middle;
            high = middle;
            break;
          }
          if (previous * middleValue <= 0) high = middle;
          else low = middle;
        }
        const hitDistance = (low + high) / 2;
        const hitPoint = pointAt(hitDistance);
        return {
          distance: hitDistance,
          point: hitPoint,
          normal: this.normalAt(hitPoint[0], hitPoint[2]),
        };
      }
      previous = current;
    }
    return undefined;
  }
}
