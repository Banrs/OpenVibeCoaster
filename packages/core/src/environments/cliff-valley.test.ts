import { expect, test } from "vitest";
import {
  CLIFF_VALLEY_TERRAIN_PROFILE_ID,
  createCliffValleyEnvironment,
} from "./cliff-valley.js";

test("cliff-valley extent, summit height, and determinism stay pure core", () => {
  expect(CLIFF_VALLEY_TERRAIN_PROFILE_ID).toBe("cliff-valley-v1");
  const first = createCliffValleyEnvironment();
  const repeated = createCliffValleyEnvironment();

  expect(first.width).toBe(420);
  expect(first.depth).toBe(280);
  expect(first.cellSize).toBe(10);
  expect((first.width - 1) * first.cellSize).toBe(4190);
  expect((first.depth - 1) * first.cellSize).toBe(2790);
  expect(first.heights).toHaveLength(117_600);
  expect(first.origin).toEqual([-2095, -1395]);
  expect(first.heights).toEqual(repeated.heights);
  expect(first.heightAt(0, 980)).toBe(repeated.heightAt(0, 980));
  expect(first.heightAt(0, 980)).toBeGreaterThanOrEqual(224.4);
  expect(first.heightAt(0, 980)).toBeLessThanOrEqual(226);
  expect(first.heightAt(0, 0)).toBeLessThan(0);
});
