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
    return point[1] - this.heightAt(point[0], point[2]);
  }

  public normalAt(x: number, z: number): Vec3 {
    const delta = this.cellSize * 0.01;
    const dx =
      (this.heightAt(x + delta, z) - this.heightAt(x - delta, z)) / (2 * delta);
    const dz =
      (this.heightAt(x, z + delta) - this.heightAt(x, z - delta)) / (2 * delta);
    return vec3Normalize(vec3(-dx, 1, -dz));
  }

  public raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): EnvironmentRaycast | undefined {
    const dir = vec3Normalize(direction);
    if (Math.abs(dir[1]) > 1e-12) {
      const distance =
        (this.heightAt(origin[0], origin[2]) - origin[1]) / dir[1];
      if (distance >= 0 && distance <= maxDistance) {
        const point = vec3(
          origin[0] + dir[0] * distance,
          origin[1] + dir[1] * distance,
          origin[2] + dir[2] * distance,
        );
        return { distance, point, normal: this.normalAt(point[0], point[2]) };
      }
    }
    const step = Math.max(this.cellSize / 8, maxDistance / 2048);
    let previous = this.signedDistance(origin);
    for (let distance = step; distance <= maxDistance; distance += step) {
      const point = vec3(
        origin[0] + dir[0] * distance,
        origin[1] + dir[1] * distance,
        origin[2] + dir[2] * distance,
      );
      const current = this.signedDistance(point);
      if (previous >= 0 && current <= 0)
        return { distance, point, normal: this.normalAt(point[0], point[2]) };
      previous = current;
    }
    return undefined;
  }
}
