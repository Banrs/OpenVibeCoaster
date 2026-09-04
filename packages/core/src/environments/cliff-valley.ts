import { HeightfieldEnvironment } from "../environment.js";

export const CLIFF_VALLEY_TERRAIN_PROFILE_ID = "cliff-valley-v1";
export const CLIFF_VALLEY_RIDGE_SEED_Z_M = 980;
export const CLIFF_VALLEY_SUMMIT_RAIL_Y_M = 230;

let cachedEnvironment: HeightfieldEnvironment | undefined;

export function createCliffValleyEnvironment(): HeightfieldEnvironment {
  if (cachedEnvironment) return cachedEnvironment;
  const width = 420;
  const depth = 280;
  const cellSize = 10;
  const origin = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ] as const;
  const heights = new Float64Array(width * depth);

  for (let row = 0; row < depth; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const worldX = origin[0] + column * cellSize;
      const worldZ = origin[1] + row * cellSize;
      const ridge =
        240 * Math.exp(-(((worldZ - CLIFF_VALLEY_RIDGE_SEED_Z_M) / 120) ** 2));
      const detail = 0.6 * Math.sin(worldX * 0.02) * Math.cos(worldZ * 0.02);
      heights[row * width + column] = -15 + ridge + detail;
    }
  }

  cachedEnvironment = new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights,
    origin,
  });
  return cachedEnvironment;
}
