// @ts-nocheck
import * as THREE from "three";
import type { CompiledTrackData } from "@openvibecoaster/core";

export type MetricId = "speed" | "gForce" | "height" | "energy";

export interface BuildTrackOptions {
  metric?: MetricId;
  selectedElementIndex?: number;
  seamIndices?: number[];
}

export interface TrackGeometries {
  leftRail: THREE.BufferGeometry;
  rightRail: THREE.BufferGeometry;
  spine: THREE.BufferGeometry;
  ties: THREE.BufferGeometry;
  drawCalls: number;
  triangles: number;
  buildTimeMs: number;
  // marker to assert no second spline invades
  splineCount: number;
}

const GAUGE = 1.2; // meters between rail centers
const RAIL_RADIUS = 0.06;
const SPINE_RADIUS = 0.09;
const RAIL_SEGMENTS = 6; // around circumference
const TIE_INTERVAL = 6; // every N samples
const SPINE_OFFSET = -0.42; // below rail plane along -normal

function metricValue(
  data: CompiledTrackData,
  index: number,
  metric: MetricId,
): number {
  const positions = data.positions;
  const curvature = data.curvature;
  // Use curvature as proxy for gForce, height for height, distance for speed placeholder, bank for energy
  // In real integration, telemetry would supply speed; here we derive a deterministic stand-in from curvature/distance
  // to keep vertex coloring functional without inventing simulation numbers.
  switch (metric) {
    case "height":
      return positions[index * 3 + 1];
    case "gForce":
      return curvature[index] * 12; // scale curvature to ~g
    case "energy":
      return data.bank[index] ?? 0;
    case "speed":
    default: {
      // Approximate speed proxy: normalized distance along track
      const d = data.distances[index];
      return d / Math.max(1, data.totalLength);
    }
  }
}

function colorForMetric(t: number, metric: MetricId): [number, number, number] {
  // Clamp t to 0..1 via linear remap per metric range
  // Use simple gradient palettes restrained for PBR coherence
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const tt = clamp01(t);
  switch (metric) {
    case "speed":
      // blue -> cyan -> yellow
      return [0.2 + tt * 0.8, 0.45 + tt * 0.45, 1 - tt * 0.6];
    case "gForce":
      // green -> yellow -> red
      return [tt, 1 - Math.abs(tt - 0.5), 0.15];
    case "height":
      // dark green -> light
      return [0.2 + tt * 0.4, 0.35 + tt * 0.4, 0.2 + tt * 0.2];
    case "energy":
      // purple -> pinkish
      return [0.55 + tt * 0.3, 0.35 + tt * 0.2, 0.75];
    default:
      return [0.6, 0.6, 0.65];
  }
}

function normalizeMetricValues(
  data: CompiledTrackData,
  metric: MetricId,
): { values: Float64Array; min: number; max: number } {
  const count = data.distances.length;
  const vals = new Float64Array(count);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = metricValue(data, i, metric);
    vals[i] = v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { values: vals, min, max };
}

function createTubeGeometry(
  centers: Float32Array,
  frames: { normal: Float32Array; binormal: Float32Array },
  radius: number,
  radialSegments: number,
  closed: boolean,
  colors: Float32Array | null,
): THREE.BufferGeometry {
  const pointCount = centers.length / 3;
  const vertexCount = pointCount * radialSegments;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colorArray = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  for (let i = 0; i < pointCount; i++) {
    const cx = centers[i * 3];
    const cy = centers[i * 3 + 1];
    const cz = centers[i * 3 + 2];
    const nx = frames.normal[i * 3];
    const ny = frames.normal[i * 3 + 1];
    const nz = frames.normal[i * 3 + 2];
    const bx = frames.binormal[i * 3];
    const by = frames.binormal[i * 3 + 1];
    const bz = frames.binormal[i * 3 + 2];
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // ring offset = normal * cos * r + binormal * sin * r
      const ox = nx * cos * radius + bx * sin * radius;
      const oy = ny * cos * radius + by * sin * radius;
      const oz = nz * cos * radius + bz * sin * radius;
      const vi = i * radialSegments + r;
      positions[vi * 3] = cx + ox;
      positions[vi * 3 + 1] = cy + oy;
      positions[vi * 3 + 2] = cz + oz;
      // normal is normalized offset direction
      const len = Math.hypot(ox, oy, oz) || 1;
      normals[vi * 3] = ox / len;
      normals[vi * 3 + 1] = oy / len;
      normals[vi * 3 + 2] = oz / len;
      if (colors) {
        // colors per point replicated around ring
        colorArray[vi * 3] = colors[i * 3];
        colorArray[vi * 3 + 1] = colors[i * 3 + 1];
        colorArray[vi * 3 + 2] = colors[i * 3 + 2];
      } else {
        colorArray[vi * 3] = 0.62;
        colorArray[vi * 3 + 1] = 0.62;
        colorArray[vi * 3 + 2] = 0.64;
      }
    }
  }

  for (let i = 0; i < pointCount - 1; i++) {
    for (let r = 0; r < radialSegments; r++) {
      const nextR = (r + 1) % radialSegments;
      const a = i * radialSegments + r;
      const b = i * radialSegments + nextR;
      const c = (i + 1) * radialSegments + nextR;
      const d = (i + 1) * radialSegments + r;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }
  if (closed && pointCount > 2) {
    const last = pointCount - 1;
    for (let r = 0; r < radialSegments; r++) {
      const nextR = (r + 1) % radialSegments;
      const a = last * radialSegments + r;
      const b = last * radialSegments + nextR;
      const c = nextR;
      const d = r;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colorArray, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildTrackGeometries(
  data: CompiledTrackData,
  options: BuildTrackOptions = {},
): TrackGeometries {
  const start = performance.now();
  const metric: MetricId = options.metric ?? "speed";
  const count = data.distances.length;
  if (count < 2) throw new RangeError("CompiledTrackData has too few samples");

  const positions = data.positions;
  const normalsArr = data.normals;
  const binormalsArr = data.binormals;

  // Compute per-sample metric colors with highlight
  const { values, min, max } = normalizeMetricValues(data, metric);
  const range = Math.max(1e-6, max - min);
  const isSelected = (idx: number): boolean => {
    if (options.selectedElementIndex === undefined) return false;
    return data.elementIndices[idx] === options.selectedElementIndex;
  };
  const seamSet = new Set(options.seamIndices ?? []);
  // Also consider element boundaries as seams
  const elementBoundaries = data.elementBoundaries;
  for (let i = 0; i < elementBoundaries.length; i++)
    seamSet.add(elementBoundaries[i]);

  const baseColors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = (values[i] - min) / range;
    let [r, g, b] = colorForMetric(t, metric);
    // highlight selected element: brighten
    if (isSelected(i)) {
      r = Math.min(1, r * 1.35 + 0.12);
      g = Math.min(1, g * 1.35 + 0.12);
      b = Math.min(1, b * 1.35 + 0.12);
    }
    // highlight seam: make distinctly white/yellowish outline
    if (seamSet.has(i)) {
      r = 1;
      g = 0.96;
      b = 0.45;
    }
    baseColors[i * 3] = r;
    baseColors[i * 3 + 1] = g;
    baseColors[i * 3 + 2] = b;
  }

  // Compute rail centers offset from centerline along binormal (track width)
  const halfGauge = GAUGE / 2;
  const leftCenters = new Float32Array(count * 3);
  const rightCenters = new Float32Array(count * 3);
  const spineCenters = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const bx = binormalsArr[i * 3];
    const by = binormalsArr[i * 3 + 1];
    const bz = binormalsArr[i * 3 + 2];
    const nx = normalsArr[i * 3];
    const ny = normalsArr[i * 3 + 1];
    const nz = normalsArr[i * 3 + 2];
    leftCenters[i * 3] = px + bx * halfGauge;
    leftCenters[i * 3 + 1] = py + by * halfGauge;
    leftCenters[i * 3 + 2] = pz + bz * halfGauge;
    rightCenters[i * 3] = px - bx * halfGauge;
    rightCenters[i * 3 + 1] = py - by * halfGauge;
    rightCenters[i * 3 + 2] = pz - bz * halfGauge;
    spineCenters[i * 3] = px + nx * SPINE_OFFSET;
    spineCenters[i * 3 + 1] = py + ny * SPINE_OFFSET;
    spineCenters[i * 3 + 2] = pz + nz * SPINE_OFFSET;
  }

  // normalsArr/binormals are Float64; convert to Float32 for tube builder
  const normalF32 = new Float32Array(normalsArr);
  const binormalF32 = new Float32Array(binormalsArr);
  const frame32 = { normal: normalF32, binormal: binormalF32 };

  const leftRail = createTubeGeometry(
    leftCenters,
    frame32,
    RAIL_RADIUS,
    RAIL_SEGMENTS,
    false,
    baseColors,
  );
  const rightRail = createTubeGeometry(
    rightCenters,
    frame32,
    RAIL_RADIUS,
    RAIL_SEGMENTS,
    false,
    baseColors,
  );
  const spine = createTubeGeometry(
    spineCenters,
    frame32,
    SPINE_RADIUS,
    RAIL_SEGMENTS,
    false,
    baseColors,
  );

  // Ties: simple boxes between rails at intervals, oriented per frame
  const tieCount = Math.floor(count / TIE_INTERVAL);
  const tieGeometry = new THREE.BufferGeometry();
  if (tieCount > 0) {
    const tieVerts: number[] = [];
    const tieNormals: number[] = [];
    const tieColors: number[] = [];
    const tieIndices: number[] = [];
    let vertexBase = 0;
    const tieWidth = GAUGE + 0.6;
    const tieHeight = 0.08;
    const tieDepth = 0.18;
    for (let t = 0; t < tieCount; t++) {
      const i = t * TIE_INTERVAL;
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      // Build oriented box around center point, aligned to frame
      const tx = data.tangents[i * 3];
      const ty = data.tangents[i * 3 + 1];
      const tz = data.tangents[i * 3 + 2];
      const nx = normalF32[i * 3];
      const ny = normalF32[i * 3 + 1];
      const nz = normalF32[i * 3 + 2];
      const bx = binormalF32[i * 3];
      const by = binormalF32[i * 3 + 1];
      const bz = binormalF32[i * 3 + 2];

      // 8 corners of box: offset along binormal (width), tangent (depth), normal (height)
      const corners: [number, number, number][] = [];
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const cx =
              px +
              bx * sx * (tieWidth / 2) +
              tx * sy * (tieDepth / 2) +
              nx * sz * (tieHeight / 2) +
              nx * (SPINE_OFFSET / 2);
            const cy =
              py +
              by * sx * (tieWidth / 2) +
              ty * sy * (tieDepth / 2) +
              ny * sz * (tieHeight / 2) +
              ny * (SPINE_OFFSET / 2);
            const cz =
              pz +
              bz * sx * (tieWidth / 2) +
              tz * sy * (tieDepth / 2) +
              nz * sz * (tieHeight / 2) +
              nz * (SPINE_OFFSET / 2);
            corners.push([cx, cy, cz]);
          }
        }
      }
      // box faces indices (12 triangles)
      const faces = [
        [0, 1, 3, 2],
        [4, 6, 7, 5],
        [0, 4, 5, 1],
        [2, 3, 7, 6],
        [0, 2, 6, 4],
        [1, 5, 7, 3],
      ];
      for (const face of faces) {
        const idx0 = vertexBase;
        // compute face normal
        const p0 = corners[face[0]] as [number, number, number];
        const p1 = corners[face[1]] as [number, number, number];
        const p2 = corners[face[2]] as [number, number, number];
        const ux = p1[0] - p0[0];
        const uy = p1[1] - p0[1];
        const uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0];
        const vy = p2[1] - p0[1];
        const vz = p2[2] - p0[2];
        let fnx = uy * vz - uz * vy;
        let fny = uz * vx - ux * vz;
        let fnz = ux * vy - uy * vx;
        const fl = Math.hypot(fnx, fny, fnz) || 1;
        fnx /= fl;
        fny /= fl;
        fnz /= fl;
        for (const cornerIdx of face) {
          const c = corners[cornerIdx] as [number, number, number];
          tieVerts.push(c[0], c[1], c[2]);
          tieNormals.push(fnx, fny, fnz);
          // color per tie uses base color at sample, darkened for wood/metal
          const r = baseColors[i * 3] * 0.5;
          const g = baseColors[i * 3 + 1] * 0.45;
          const b = baseColors[i * 3 + 2] * 0.4;
          tieColors.push(r, g, b);
        }
        tieIndices.push(idx0, idx0 + 1, idx0 + 2, idx0, idx0 + 2, idx0 + 3);
        vertexBase += 4;
      }
    }
    tieGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(tieVerts), 3),
    );
    tieGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(tieNormals), 3),
    );
    tieGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(tieColors), 3),
    );
    tieGeometry.setIndex(tieIndices);
    tieGeometry.computeBoundingBox();
    tieGeometry.computeBoundingSphere();
  } else {
    tieGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(0), 3),
    );
  }

  // Mark userData for identification
  leftRail.name = "leftRail";
  rightRail.name = "rightRail";
  spine.name = "spine";
  tieGeometry.name = "ties";
  for (const g of [leftRail, rightRail, spine, tieGeometry])
    g.userData.isTrack = true;

  const end = performance.now();
  const countIndices = (g: THREE.BufferGeometry): number =>
    g.getIndex()?.count ?? 0;
  const triangles =
    countIndices(leftRail) / 3 +
    countIndices(rightRail) / 3 +
    countIndices(spine) / 3 +
    countIndices(tieGeometry) / 3;

  return {
    leftRail,
    rightRail,
    spine,
    ties: tieGeometry,
    drawCalls: 4,
    triangles,
    buildTimeMs: end - start,
    splineCount: 1,
  };
}
