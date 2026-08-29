import * as THREE from "three";
import type { CompiledTrackData } from "@openvibecoaster/core";

export type MetricId =
  "speed" | "gForce" | "rollRate" | "clearance" | "height" | "energy";

export interface MetricData {
  speed?: Float64Array | undefined;
  gForce?: Float64Array | undefined;
  rollRate?: Float64Array | undefined;
  clearance?: Float64Array | undefined;
  energy?: Float64Array | undefined;
}

export interface BuildTrackOptions {
  metric?: MetricId | undefined;
  metricData?: MetricData | undefined;
  selectedElementIndex?: number | undefined;
  seamIndices?: number[] | undefined;
  seamInspectionEnabled?: boolean | undefined;
}

export interface TrackGeometries {
  leftRail: THREE.BufferGeometry;
  rightRail: THREE.BufferGeometry;
  spine: THREE.BufferGeometry;
  ties: THREE.BufferGeometry;
  drawCalls: number;
  triangles: number;
  buildTimeMs: number;
  metricAvailable: boolean;
  metric: MetricId;
}

const GAUGE = 1.2;
const RAIL_RADIUS = 0.06;
const SPINE_RADIUS = 0.09;
const RAIL_SEGMENTS = 6;
const TIE_INTERVAL = 6;
const SPINE_OFFSET = -0.42;
const NEUTRAL = [0.6, 0.6, 0.64] as const;

function colorForMetric(t: number, metric: MetricId): [number, number, number] {
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
  const tt = clamp01(t);
  switch (metric) {
    case "speed":
      // blue -> cyan -> yellow (sequential)
      return [0.18 + tt * 0.78, 0.42 + tt * 0.38, 0.95 - tt * 0.65];
    case "gForce": {
      // diverging: low g (cyan-blue) -> neutral (pale) -> high g (red)
      if (tt < 0.5) {
        const u = tt * 2;
        return [0.05 + u * 0.45, 0.58 + u * 0.22, 0.92 - u * 0.32];
      }
      const u = (tt - 0.5) * 2;
      return [0.65 + u * 0.35, 0.8 - u * 0.55, 0.6 - u * 0.4];
    }
    case "rollRate": {
      // diverging distinct from gForce: negative teal -> neutral light -> positive magenta-purple
      if (tt < 0.5) {
        const u = tt * 2;
        return [0.12 + u * 0.38, 0.55 + u * 0.25, 0.78 - u * 0.18];
      }
      const u = (tt - 0.5) * 2;
      return [0.68 + u * 0.27, 0.32 + u * 0.08, 0.82 - u * 0.12];
    }
    case "clearance": {
      // danger direction: low clearance = red, high = safe green/blue
      // t=0 is low margin danger
      const r = 1.0 - tt * 0.75;
      const g = 0.18 + tt * 0.62;
      const b = 0.2 + tt * 0.45;
      return [r, g, b];
    }
    case "height":
      return [0.16 + tt * 0.36, 0.34 + tt * 0.42, 0.18 + tt * 0.22];
    case "energy":
      return [0.52 + tt * 0.36, 0.28 + tt * 0.28, 0.68 + tt * 0.18];
    default:
      return [0.6, 0.6, 0.65];
  }
}

function resolveMetricAvailability(
  data: CompiledTrackData,
  metric: MetricId,
  metricData: MetricData | undefined,
): { available: boolean; values: Float64Array | null } {
  const count = data.distances.length;
  if (metric === "height") {
    const vals = new Float64Array(count);
    const pos = data.positions;
    for (let i = 0; i < count; i++) {
      const v = pos[i * 3 + 1];
      if (v === undefined || !Number.isFinite(v))
        return { available: false, values: null };
      vals[i] = v;
    }
    // verify height is finite across samples; neutral fallback handled by caller via available flag
    return { available: true, values: vals };
  }
  let arr: Float64Array | undefined;
  if (metric === "speed") arr = metricData?.speed;
  else if (metric === "gForce") arr = metricData?.gForce;
  else if (metric === "rollRate") arr = metricData?.rollRate;
  else if (metric === "clearance") arr = metricData?.clearance;
  else if (metric === "energy") arr = metricData?.energy;
  if (!arr || !(arr instanceof Float64Array) || arr.length !== count)
    return { available: false, values: null };
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === undefined || !Number.isFinite(v))
      return { available: false, values: null };
  }
  return { available: true, values: arr };
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
    const cx = centers[i * 3] ?? 0;
    const cy = centers[i * 3 + 1] ?? 0;
    const cz = centers[i * 3 + 2] ?? 0;
    const nx = frames.normal[i * 3] ?? 0;
    const ny = frames.normal[i * 3 + 1] ?? 0;
    const nz = frames.normal[i * 3 + 2] ?? 0;
    const bx = frames.binormal[i * 3] ?? 0;
    const by = frames.binormal[i * 3 + 1] ?? 0;
    const bz = frames.binormal[i * 3 + 2] ?? 0;
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const ox = nx * cos * radius + bx * sin * radius;
      const oy = ny * cos * radius + by * sin * radius;
      const oz = nz * cos * radius + bz * sin * radius;
      const vi = i * radialSegments + r;
      positions[vi * 3] = cx + ox;
      positions[vi * 3 + 1] = cy + oy;
      positions[vi * 3 + 2] = cz + oz;
      const len = Math.hypot(ox, oy, oz) || 1;
      normals[vi * 3] = ox / len;
      normals[vi * 3 + 1] = oy / len;
      normals[vi * 3 + 2] = oz / len;
      if (colors) {
        colorArray[vi * 3] = colors[i * 3] ?? NEUTRAL[0];
        colorArray[vi * 3 + 1] = colors[i * 3 + 1] ?? NEUTRAL[1];
        colorArray[vi * 3 + 2] = colors[i * 3 + 2] ?? NEUTRAL[2];
      } else {
        colorArray[vi * 3] = NEUTRAL[0];
        colorArray[vi * 3 + 1] = NEUTRAL[1];
        colorArray[vi * 3 + 2] = NEUTRAL[2];
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
  try {
    geometry.setIndex(indices);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colorArray, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  } catch (e) {
    try {
      geometry.dispose();
    } catch {
      // ignore
    }
    throw e;
  }
}

export function buildTrackGeometries(
  data: CompiledTrackData,
  options: BuildTrackOptions = {},
): TrackGeometries {
  const start = performance.now();
  const metric: MetricId = options.metric ?? "height";
  const count = data.distances.length;
  if (count < 2) throw new RangeError("CompiledTrackData has too few samples");

  const positions = data.positions;
  const normalsArr = data.normals;
  const binormalsArr = data.binormals;

  const metricRes = resolveMetricAvailability(data, metric, options.metricData);
  const available = metricRes.available;
  let min = Infinity;
  let max = -Infinity;
  if (available && metricRes.values) {
    for (let i = 0; i < metricRes.values.length; i++) {
      const v = metricRes.values[i] ?? 0;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const range = Math.max(1e-6, max - min);

  const isSelected = (idx: number): boolean => {
    if (options.selectedElementIndex === undefined) return false;
    return data.elementIndices[idx] === options.selectedElementIndex;
  };
  const seamSet = new Set<number>();
  const elementBoundaries = data.elementBoundaries;
  const canonicalSet = new Set<number>();
  for (let i = 0; i < elementBoundaries.length; i++) {
    const b = elementBoundaries[i];
    if (b !== undefined && Number.isInteger(b) && b >= 0 && b < count)
      canonicalSet.add(b);
  }
  if (options.seamInspectionEnabled === true) {
    for (const b of canonicalSet) seamSet.add(b);
    if (options.seamIndices) {
      for (const idx of options.seamIndices) {
        if (canonicalSet.has(idx)) seamSet.add(idx);
      }
    }
  } else if (options.seamInspectionEnabled === false) {
    // disabled: no seams
  } else {
    // legacy undefined: show explicitly supplied seamIndices only
    if (options.seamIndices) {
      for (const idx of options.seamIndices) {
        if (Number.isInteger(idx) && idx >= 0 && idx < count) seamSet.add(idx);
      }
    }
  }

  const baseColors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let r: number;
    let g: number;
    let b: number;
    if (!available || !metricRes.values) {
      r = NEUTRAL[0];
      g = NEUTRAL[1];
      b = NEUTRAL[2];
    } else {
      const v = metricRes.values[i] ?? 0;
      const t = (v - min) / range;
      [r, g, b] = colorForMetric(t, metric);
    }
    if (isSelected(i)) {
      r = Math.min(1, r * 1.35 + 0.12);
      g = Math.min(1, g * 1.35 + 0.12);
      b = Math.min(1, b * 1.35 + 0.12);
    }
    if (seamSet.has(i)) {
      r = 1;
      g = 0.96;
      b = 0.45;
    }
    baseColors[i * 3] = r;
    baseColors[i * 3 + 1] = g;
    baseColors[i * 3 + 2] = b;
  }

  const halfGauge = GAUGE / 2;
  const leftCenters = new Float32Array(count * 3);
  const rightCenters = new Float32Array(count * 3);
  const spineCenters = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] ?? 0;
    const py = positions[i * 3 + 1] ?? 0;
    const pz = positions[i * 3 + 2] ?? 0;
    const bx = binormalsArr[i * 3] ?? 0;
    const by = binormalsArr[i * 3 + 1] ?? 0;
    const bz = binormalsArr[i * 3 + 2] ?? 0;
    const nx = normalsArr[i * 3] ?? 0;
    const ny = normalsArr[i * 3 + 1] ?? 0;
    const nz = normalsArr[i * 3 + 2] ?? 0;
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

  const normalF32 = new Float32Array(normalsArr);
  const binormalF32 = new Float32Array(binormalsArr);
  const frame32 = { normal: normalF32, binormal: binormalF32 };

  let leftRail: THREE.BufferGeometry | null = null;
  let rightRail: THREE.BufferGeometry | null = null;
  let spine: THREE.BufferGeometry | null = null;
  let tieGeometry: THREE.BufferGeometry | null = null;
  try {
    leftRail = createTubeGeometry(
      leftCenters,
      frame32,
      RAIL_RADIUS,
      RAIL_SEGMENTS,
      false,
      baseColors,
    );
    rightRail = createTubeGeometry(
      rightCenters,
      frame32,
      RAIL_RADIUS,
      RAIL_SEGMENTS,
      false,
      baseColors,
    );
    spine = createTubeGeometry(
      spineCenters,
      frame32,
      SPINE_RADIUS,
      RAIL_SEGMENTS,
      false,
      baseColors,
    );

    const tieCount = Math.floor(count / TIE_INTERVAL);
    tieGeometry = new THREE.BufferGeometry();
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
        const px = positions[i * 3] ?? 0;
        const py = positions[i * 3 + 1] ?? 0;
        const pz = positions[i * 3 + 2] ?? 0;
        const tx = data.tangents[i * 3] ?? 0;
        const ty = data.tangents[i * 3 + 1] ?? 0;
        const tz = data.tangents[i * 3 + 2] ?? 0;
        const nx = normalF32[i * 3] ?? 0;
        const ny = normalF32[i * 3 + 1] ?? 0;
        const nz = normalF32[i * 3 + 2] ?? 0;
        const bx = binormalF32[i * 3] ?? 0;
        const by = binormalF32[i * 3 + 1] ?? 0;
        const bz = binormalF32[i * 3 + 2] ?? 0;

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
          const p0 = corners[face[0] as number] as [number, number, number];
          const p1 = corners[face[1] as number] as [number, number, number];
          const p2 = corners[face[2] as number] as [number, number, number];
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
            const c = corners[cornerIdx as number] as [number, number, number];
            tieVerts.push(c[0], c[1], c[2]);
            tieNormals.push(fnx, fny, fnz);
            const r = baseColors[i * 3] ?? NEUTRAL[0];
            const g2 = baseColors[i * 3 + 1] ?? NEUTRAL[1];
            const b2 = baseColors[i * 3 + 2] ?? NEUTRAL[2];
            tieColors.push(r * 0.5, g2 * 0.45, b2 * 0.4);
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

    const result = {
      leftRail,
      rightRail,
      spine,
      ties: tieGeometry,
      drawCalls: 4,
      triangles,
      buildTimeMs: end - start,
      metricAvailable: available,
      metric,
    };
    // prevent double dispose in catch
    leftRail = null;
    rightRail = null;
    spine = null;
    tieGeometry = null;
    return result;
  } catch (e) {
    if (leftRail) {
      try {
        leftRail.dispose();
      } catch {
        // ignore
      }
    }
    if (rightRail) {
      try {
        rightRail.dispose();
      } catch {
        // ignore
      }
    }
    if (spine) {
      try {
        spine.dispose();
      } catch {
        // ignore
      }
    }
    if (tieGeometry) {
      try {
        tieGeometry.dispose();
      } catch {
        // ignore
      }
    }
    throw e;
  }
}
