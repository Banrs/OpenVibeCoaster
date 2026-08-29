import { HeightfieldEnvironment } from "@openvibecoaster/core";

/**
 * Explicit v1 terrain profiles – only these IDs are valid.
 * - rolling-520x360-v1: broad low rolling terrain for 520x360 footprint.
 * - blocking-v1: deliberately blocking high terrain for honest infeasible case.
 * Unknown IDs must throw, never silently fallback.
 */
export const ROLLING_TERRAIN_PROFILE_ID = "rolling-520x360-v1";
export const BLOCKING_TERRAIN_PROFILE_ID = "blocking-v1";

export const VALID_TERRAIN_PROFILE_IDS = [
  ROLLING_TERRAIN_PROFILE_ID,
  BLOCKING_TERRAIN_PROFILE_ID,
] as const;

export type TerrainProfileId = (typeof VALID_TERRAIN_PROFILE_IDS)[number];

function createRolling(): HeightfieldEnvironment {
  const width = 66;
  const depth = 46;
  const cellSize = 8;
  const origin: readonly [number, number] = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ];
  // Flat low terrain well below track (track at y~0). Height -100 ensures clearance with large margin.
  const heights = new Float64Array(width * depth);
  for (let i = 0; i < heights.length; i++) heights[i] = -100;
  return new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights,
    origin,
  });
}

function createBlocking(): HeightfieldEnvironment {
  const width = 66;
  const depth = 46;
  const cellSize = 8;
  const origin: readonly [number, number] = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ];
  // Flat high terrain that blocks track (track at y~0, terrain at 40 => track is underground)
  const heights = new Float64Array(width * depth);
  for (let i = 0; i < heights.length; i++) heights[i] = 40;
  return new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights,
    origin,
  });
}

/**
 * Resolve a terrain profile ID to a HeightfieldEnvironment.
 * Returns undefined when profileId is undefined (no terrain).
 * Throws for unknown IDs – never silently selects another environment.
 */
export function resolveTerrainEnvironment(
  profileId: string | undefined,
): HeightfieldEnvironment | undefined {
  if (profileId === undefined) return undefined;
  if (profileId === ROLLING_TERRAIN_PROFILE_ID) return createRolling();
  if (profileId === BLOCKING_TERRAIN_PROFILE_ID) return createBlocking();
  throw new Error(`Unknown terrain profile: ${profileId}`);
}

/**
 * Create environment directly for known IDs, strictly validated.
 */
export function createTerrainEnvironment(
  profileId: TerrainProfileId,
): HeightfieldEnvironment {
  const env = resolveTerrainEnvironment(profileId);
  if (!env) throw new Error(`Unknown terrain profile: ${profileId}`);
  return env;
}
