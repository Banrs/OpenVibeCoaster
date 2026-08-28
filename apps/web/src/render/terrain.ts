import * as THREE from "three";
import {
  HeightfieldEnvironment,
  hashSeed,
  Xoshiro128ss,
} from "../shim/core.js";

export function createDeterministicHeightfield(
  seed: string | number,
  width = 32,
  depth = 32,
  cellSize = 4,
): HeightfieldEnvironment {
  const seedValue = typeof seed === "number" ? seed : hashSeed(String(seed));
  const rng = new Xoshiro128ss(seedValue).fork("terrain");
  const heights = new Float64Array(width * depth);
  // Deterministic multi-octave noise: simple value noise via rng + bilinear interpolation is too flat.
  // Use seeded random offsets plus smooth falloff toward edges for containment.
  const baseFreq = 0.08;
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x / (width - 1)) * 2 - 1;
      const nz = (z / (depth - 1)) * 2 - 1;
      // Simple fbm using rng-sampled gradients on grid - deterministic per seed
      // We'll generate heights via summed sine waves with seeded phases/amplitudes
      const phase1 = rng.nextFloat() * Math.PI * 2;
      const phase2 = rng.nextFloat() * Math.PI * 2;
      // Use x,z to generate coherent value via seeded pseudo-random but coherent via hashing of coordinates
      // Mix in coordinate-dependent term so adjacent cells correlate
      const hNoise =
        Math.sin(x * baseFreq * 2 + phase1) * 2 +
        Math.cos(z * baseFreq * 2 + phase2) * 2 +
        Math.sin((x + z) * 0.05 + phase1 * 0.5) * 1.5;
      // Bowl falloff to keep track area roughly elevated
      const radial = Math.sqrt(nx * nx + nz * nz);
      const bowl = Math.max(0, 1 - radial * 0.3) * 3;
      heights[z * width + x] = hNoise + bowl;
    }
  }
  // Smooth with a single bilinear pass for less spike
  const smoothed = new Float64Array(heights);
  for (let z = 1; z < depth - 1; z += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = z * width + x;
      smoothed[idx] =
        ((heights[idx] ?? 0) * 4 +
          (heights[idx - 1] ?? 0) +
          (heights[idx + 1] ?? 0) +
          (heights[idx - width] ?? 0) +
          (heights[idx + width] ?? 0)) /
        8;
    }
  }
  const origin: readonly [number, number] = [
    -((width - 1) * cellSize) / 2,
    -((depth - 1) * cellSize) / 2,
  ];
  return new HeightfieldEnvironment({
    width,
    depth,
    cellSize,
    heights: smoothed,
    origin,
  });
}

export function buildTerrainMesh(
  env: HeightfieldEnvironment,
): THREE.BufferGeometry {
  const { width, depth, cellSize, heights, origin } = env;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(width * depth * 3);
  const normals = new Float32Array(width * depth * 3);
  const uvs = new Float32Array(width * depth * 2);
  const indices: number[] = [];

  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = z * width + x;
      const worldX = (origin[0] ?? 0) + x * cellSize;
      const worldZ = (origin[1] ?? 0) + z * cellSize;
      const h = heights[idx] ?? 0;
      positions[idx * 3] = worldX;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = worldZ;
      uvs[idx * 2] = x / (width - 1);
      uvs[idx * 2 + 1] = z / (depth - 1);
    }
  }

  for (let z = 0; z < depth - 1; z += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = z * width + x;
      const b = z * width + x + 1;
      const c = (z + 1) * width + x;
      const d = (z + 1) * width + x + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

  geometry.computeVertexNormals();
  // Overwrite computed normals into array for completeness
  const computed = geometry.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = 0; i < normals.length; i++)
    normals[i] = (computed.array as unknown as number[])[i] ?? 0;
  // Ensure we keep computed normals
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

  // Vertex colors: simple height-based tint for visual coherence without external assets
  const colors = new Float32Array(width * depth * 3);
  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of heights) {
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
  }
  const range = Math.max(1e-6, maxH - minH);
  for (let i = 0; i < heights.length; i++) {
    const t = ((heights[i] ?? 0) - minH) / range;
    // muted terrain palette: low = darker green/brown, high = lighter
    const r = 0.22 + t * 0.15;
    const g = 0.32 + t * 0.2;
    const b = 0.22 + t * 0.1;
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export interface TerrainGroup {
  mesh: THREE.Mesh;
  grid: THREE.GridHelper;
  env: HeightfieldEnvironment;
}

export function createTerrainGroup(env: HeightfieldEnvironment): TerrainGroup {
  const geometry = buildTerrainMesh(env);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.userData.isTerrain = true;
  mesh.name = "terrain";

  const size = Math.max(env.width, env.depth) * env.cellSize;
  const divisions = 20;
  const grid = new THREE.GridHelper(size, divisions, 0x3a4f5a, 0x2a3a44);
  // Place grid slightly above terrain center height
  const centerH = env.heightAt(0, 0);
  grid.position.set(0, centerH + 0.08, 0);
  grid.userData.isTerrainGrid = true;

  return { mesh, grid, env };
}
