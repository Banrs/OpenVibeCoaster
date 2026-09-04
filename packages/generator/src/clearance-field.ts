import type {
  CompiledTrackData,
  Diagnostic,
  EnvironmentQuery,
  Vec3,
} from "@openvibecoaster/core";
import { vec3 } from "@openvibecoaster/core";
import {
  areSweptIntervalsWithinLocality,
  certifiedSweptDistance,
  createClearanceTrainGeometry,
  interpolatePose,
  prepareTerrainSegmentEvaluator,
  sweptAabb,
  type ClearancePose,
  type ClearanceTrainGeometry,
  type PreparedTerrainSegmentEvaluator,
  type SweptClearanceSegment,
} from "./clearance-geometry";
import { nextDown, nextUp } from "./polynomial-bounds";

export const DEFAULT_ENVELOPE: ClearanceTrainGeometry = Object.freeze({
  halfWidthM: 1.25,
  aboveRailM: 2.1,
  belowRailM: 0.8,
  carPitchM: 3.4,
  noseTailMarginM: 0.75,
});

export const DEFAULT_HARD_CLEARANCE_M = 0.5;
export const CERTIFICATE_RESOLUTION_M = 0.01;
const MAX_TERRAIN_WORK_PER_SEGMENT = 512;
// Bounds proof search budget per terrain segment.
// Never certifies an unresolved hard constraint.
export const DEFAULT_DISPLAY_CAP_M = 10;
const CONSERVATIVE_LOWER_M = -Number.MAX_VALUE;

export interface ClearanceFieldSegment {
  readonly index: number;
  readonly startS: number;
  readonly endS: number;
  readonly lowerM: number;
  readonly upperM: number;
  readonly witnessS: number;
  readonly witnessPosition: Vec3;
  readonly relatedIds: readonly string[];
  readonly work: number;
  readonly certified: boolean;
  readonly source: "terrain" | "self" | "cap";
}

export interface ClearanceField {
  readonly track: CompiledTrackData;
  readonly segments: readonly ClearanceFieldSegment[];
  readonly globalLowerM: number;
  readonly globalUpperM: number;
  readonly globalWitnessS: number;
  readonly globalWitnessPosition: Vec3;
  readonly globalRelatedIds: readonly string[];
  readonly globalSource: "terrain" | "self" | "cap";
  readonly globalLowerRelatedIds: readonly string[];
  readonly globalLowerSource: "terrain" | "self" | "cap";
  readonly globalLowerWitnessS: number;
  readonly globalLowerWitnessPosition: Vec3;
  readonly effectiveCap: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly work: number;
  readonly closed: boolean;
}

export interface ClearanceFieldOptions {
  readonly envelope?: ClearanceTrainGeometry;
  readonly hardClearanceM?: number;
  readonly explicitThresholds?: readonly number[];
  readonly softThresholds?: readonly number[];
  readonly displayCapM?: number;
  readonly maxWork?: number;
  readonly environment?: EnvironmentQuery | undefined;
  readonly closed?: boolean;
  readonly segmentIds?: readonly string[];
}

export interface ClearanceConstraintDescriptor {
  readonly id: string;
  readonly hard: boolean;
  readonly threshold: number;
}

interface ClearanceTrackSnapshot {
  readonly positions: Float64Array;
  readonly tangents: Float64Array;
  readonly normals: Float64Array;
  readonly binormals: Float64Array;
  readonly distances: Float64Array;
  readonly elementIndices: Uint32Array;
  readonly elementBoundaries: Uint32Array;
  readonly totalLength: number;
}

function finite(v: number, label: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${label} must be finite`);
  return v;
}
function boundsMaxY(value: unknown, label: string): number {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { min: unknown }).min) ||
    !Array.isArray((value as { max: unknown }).max) ||
    (value as { min: readonly unknown[] }).min.length !== 3 ||
    (value as { max: readonly unknown[] }).max.length !== 3
  )
    throw new RangeError(`${label} must be Aabb`);
  const minimum = (value as { min: Vec3 }).min;
  const maximum = (value as { max: Vec3 }).max;
  if (![...minimum, ...maximum].every(Number.isFinite))
    throw new RangeError(`${label} components must be finite`);
  if (
    minimum[0]! > maximum[0]! ||
    minimum[1]! > maximum[1]! ||
    minimum[2]! > maximum[2]!
  )
    throw new RangeError(`${label} min greater than max`);
  return maximum[1]!;
}
function effectiveCapFor(
  displayCap: number,
  hard: number,
  thresholds: readonly number[],
  softThresholds: readonly number[] = [],
): number {
  let cap = Math.max(finite(displayCap, "displayCap"), 0.5, hard);
  for (const t of thresholds) {
    finite(t, "threshold");
    if (t < 0 || !Number.isFinite(t))
      throw new RangeError("explicit threshold must be non-negative finite");
    cap = Math.max(cap, t);
  }
  for (const t of softThresholds) {
    finite(t, "softThreshold");
    if (t < 0 || !Number.isFinite(t))
      throw new RangeError("soft threshold must be non-negative finite");
    cap = Math.max(cap, t);
  }
  return cap;
}
function trainGeometry(
  envelope: ClearanceTrainGeometry,
): ClearanceTrainGeometry {
  return createClearanceTrainGeometry(envelope);
}
function poseFromTrack(
  track: ClearanceTrackSnapshot,
  index: number,
): ClearancePose {
  return {
    position: vec3(
      track.positions[index * 3]!,
      track.positions[index * 3 + 1]!,
      track.positions[index * 3 + 2]!,
    ),
    tangent: vec3(
      track.tangents[index * 3]!,
      track.tangents[index * 3 + 1]!,
      track.tangents[index * 3 + 2]!,
    ),
    normal: vec3(
      track.normals[index * 3]!,
      track.normals[index * 3 + 1]!,
      track.normals[index * 3 + 2]!,
    ),
    binormal: vec3(
      track.binormals[index * 3]!,
      track.binormals[index * 3 + 1]!,
      track.binormals[index * 3 + 2]!,
    ),
  };
}
function elementIndexForInterval(
  track: ClearanceTrackSnapshot,
  intervalIdx: number,
): number {
  const boundaries = track.elementBoundaries;
  const nElements = boundaries.length / 2;
  for (let ei = 0; ei < nElements; ei++) {
    const s = boundaries[ei * 2]!;
    const e = boundaries[ei * 2 + 1]!;
    if (intervalIdx >= s && intervalIdx < e) return ei;
  }
  // Fallback: use elementIndices of interval start+1 for seam intervals, else start
  const next = track.elementIndices[intervalIdx + 1];
  if (next !== undefined) return next;
  const cur = track.elementIndices[intervalIdx];
  if (cur !== undefined) return cur;
  return 0;
}
function fallbackSegmentId(
  track: ClearanceTrackSnapshot,
  intervalIdx: number,
): string {
  const ei = elementIndexForInterval(track, intervalIdx);
  return `element-${ei}`;
}
function circumsphereRadius(g: ClearanceTrainGeometry): number {
  const hx = g.halfWidthM;
  const maxY = Math.max(g.aboveRailM, g.belowRailM);
  const hz = g.carPitchM / 2 + g.noseTailMarginM;
  return nextUp(Math.sqrt(nextUp(hx * hx + maxY * maxY + hz * hz)));
}
export function conservativeCircumsphereRadius(
  envelope: ClearanceTrainGeometry = DEFAULT_ENVELOPE,
): number {
  return circumsphereRadius(trainGeometry(envelope));
}
function sweptSegment(
  track: ClearanceTrackSnapshot,
  startIdx: number,
  endIdx: number,
  geometry: ClearanceTrainGeometry,
): SweptClearanceSegment {
  return {
    startS: track.distances[startIdx]!,
    endS: track.distances[endIdx]!,
    start: poseFromTrack(track, startIdx),
    end: poseFromTrack(track, endIdx),
    geometry,
  };
}
interface TerrainHeapNode {
  readonly u0: number;
  readonly u1: number;
  readonly lowerM: number;
  readonly upperM: number;
  readonly witnessPos: Vec3;
  readonly witnessS: number;
  readonly seq: number;
}
function evaluateTerrainSubinterval(
  seg: SweptClearanceSegment,
  u0: number,
  u1: number,
  terrain: PreparedTerrainSegmentEvaluator,
  env: EnvironmentQuery,
  radius: number,
): { lowerM: number; upperM: number; witnessPos: Vec3; witnessS: number } {
  const umid = (u0 + u1) / 2;
  const midPose = interpolatePose(seg, umid);
  const obb = terrain.obbAtPose(midPose);
  const centreSd = env.signedDistance(obb.center);
  if (!Number.isFinite(centreSd))
    throw new RangeError("signedDistance must be finite");
  const motion = terrain.motionBound(u0, u1);
  const lower = nextDown(centreSd - nextUp(radius + motion));
  const points: Vec3[] = [];
  for (const sx of [-1, 1] as const)
    for (const sy of [-1, 1] as const)
      for (const sz of [-1, 1] as const) {
        const px =
          obb.center[0] +
          sx * obb.halfExtents[0] * obb.axes[0][0] +
          sy * obb.halfExtents[1] * obb.axes[1][0] +
          sz * obb.halfExtents[2] * obb.axes[2][0];
        const py =
          obb.center[1] +
          sx * obb.halfExtents[0] * obb.axes[0][1] +
          sy * obb.halfExtents[1] * obb.axes[1][1] +
          sz * obb.halfExtents[2] * obb.axes[2][1];
        const pz =
          obb.center[2] +
          sx * obb.halfExtents[0] * obb.axes[0][2] +
          sy * obb.halfExtents[1] * obb.axes[1][2] +
          sz * obb.halfExtents[2] * obb.axes[2][2];
        points.push(vec3(px, py, pz));
      }
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1] as const) {
      const ax = obb.axes[axis]!;
      const he = obb.halfExtents[axis]!;
      points.push(
        vec3(
          obb.center[0] + s * he * ax[0],
          obb.center[1] + s * he * ax[1],
          obb.center[2] + s * he * ax[2],
        ),
      );
    }
  }
  let bestUpper = Infinity;
  let bestPos: Vec3 = points[0]!;
  for (const p of points) {
    const sd = env.signedDistance(p);
    if (!Number.isFinite(sd))
      throw new RangeError("signedDistance must be finite");
    const candidate = nextUp(sd);
    if (candidate < bestUpper) {
      bestUpper = candidate;
      bestPos = p;
    }
  }
  const witnessS = seg.startS + (seg.endS - seg.startS) * umid;
  return { lowerM: lower, upperM: bestUpper, witnessPos: bestPos, witnessS };
}
function thresholdsSeparated(
  globalLower: number,
  bestUpper: number,
  thresholds: readonly number[],
): boolean {
  for (const t of thresholds) {
    if (globalLower >= t) continue;
    if (bestUpper < t) continue;
    return false;
  }
  return true;
}
function safeBucketCoordinate(value: number, cellSize: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(cellSize) || cellSize <= 0)
    throw new RangeError("bucket coordinate must be finite");
  const q = value / cellSize;
  if (!Number.isFinite(q)) throw new RangeError("bucket quotient non-finite");
  const c = Math.floor(q);
  if (!Number.isSafeInteger(c))
    throw new RangeError("bucket coordinate unsafe");
  return c;
}
function bucketRanges(
  bounds: { min: Vec3; max: Vec3 },
  cellSize: number,
): readonly [number, number][] {
  return ([0, 1, 2] as const).map((axis) => [
    safeBucketCoordinate(bounds.min[axis]!, cellSize),
    safeBucketCoordinate(bounds.max[axis]!, cellSize),
  ]);
}
function rangeCount(range: readonly [number, number]): number {
  const cnt = range[1] - range[0] + 1;
  if (!Number.isSafeInteger(cnt) || cnt < 1)
    throw new RangeError("range overflows");
  if (cnt > 1_000_000) throw new RangeError("range too large");
  return cnt;
}
function checkedProduct(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0)
    throw new RangeError("product not safe");
  if (a !== 0 && b > Number.MAX_SAFE_INTEGER / a)
    throw new RangeError("product overflows");
  return a * b;
}

export function computeClearanceField(
  track: CompiledTrackData,
  options: ClearanceFieldOptions = {},
): ClearanceField {
  const snapshot: ClearanceTrackSnapshot = {
    positions: track.positions,
    tangents: track.tangents,
    normals: track.normals,
    binormals: track.binormals,
    distances: track.distances,
    elementIndices: track.elementIndices,
    elementBoundaries: track.elementBoundaries,
    totalLength: track.totalLength,
  };
  const geometry = trainGeometry(options.envelope ?? DEFAULT_ENVELOPE);
  const hard = finite(
    options.hardClearanceM ?? DEFAULT_HARD_CLEARANCE_M,
    "hardClearanceM",
  );
  if (hard < 0) throw new RangeError("hardClearanceM must be non-negative");
  const displayCap = finite(
    options.displayCapM ?? DEFAULT_DISPLAY_CAP_M,
    "displayCapM",
  );
  const thresholds = options.explicitThresholds ?? [];
  for (const t of thresholds) {
    finite(t, "threshold");
    if (t < 0) throw new RangeError("explicit threshold must be non-negative");
  }
  const softThresholds = options.softThresholds ?? [];
  for (const t of softThresholds) {
    finite(t, "softThreshold");
    if (t < 0) throw new RangeError("soft threshold must be non-negative");
  }
  const effectiveCap = effectiveCapFor(
    displayCap,
    hard,
    thresholds,
    softThresholds,
  );
  const maxWork = options.maxWork ?? 1_000_000;
  if (!Number.isSafeInteger(maxWork) || maxWork < 1)
    throw new RangeError("maxWork must be positive safe integer");
  const closed = options.closed ?? false;
  const env = options.environment;
  const radius = circumsphereRadius(geometry);
  const count = snapshot.distances.length;
  if (count < 2) throw new RangeError("Track must have at least two stations");
  const diagnostics: Diagnostic[] = [];
  let totalWork = 0;
  let remaining = maxWork;
  const charge = (n: number): boolean => {
    if (n <= 0) return true;
    if (remaining < n) return false;
    remaining -= n;
    totalWork += n;
    return true;
  };
  let budgetFatalIssued = false;
  const emitBudgetFatal = (
    witnessS: number | undefined,
    witnessPos: Vec3 | undefined,
    actual: number | undefined,
    limit: number,
    relatedIds: readonly string[],
  ): void => {
    if (budgetFatalIssued) return;
    budgetFatalIssued = true;
    const hasLocation =
      witnessS !== undefined &&
      witnessPos !== undefined &&
      Number.isFinite(witnessS);
    const hasActual = actual !== undefined && Number.isFinite(actual);
    const diag: Diagnostic = {
      code: "CLEARANCE_UNCERTIFIED",
      severity: "fatal",
      provenance: "PROJECT_ENGINEERING_LIMIT",
      message: hasLocation
        ? `Clearance work budget exhausted at s=${witnessS!.toFixed(6)}`
        : "Clearance work budget exhausted",
      relatedIds: [...relatedIds],
      ...(hasLocation
        ? { location: { s: witnessS!, position: witnessPos! } }
        : {}),
      ...(hasActual ? { actual: actual!, limit, margin: actual! - limit } : {}),
    };
    diagnostics.push(diag);
  };

  const segmentIds = options.segmentIds;
  const idForSegment = (idx: number): string => {
    const ei = elementIndexForInterval(snapshot, idx);
    if (
      segmentIds &&
      ei < segmentIds.length &&
      typeof segmentIds[ei] === "string" &&
      segmentIds[ei]!.trim().length > 0
    )
      return segmentIds[ei]!;
    return fallbackSegmentId(snapshot, idx);
  };

  const sweptSegments: SweptClearanceSegment[] = [];
  const sweptAabbs: Array<{ min: Vec3; max: Vec3 }> = [];
  for (let i = 0; i < count - 1; i++) {
    const seg = sweptSegment(snapshot, i, i + 1, geometry);
    sweptSegments.push(seg);
    sweptAabbs.push(sweptAabb(seg));
  }

  let terrainBroadPhaseProven = false;
  let envMaxY: number | undefined = undefined;
  if (env?.bounds) {
    try {
      envMaxY = boundsMaxY(env.bounds(), "bounds");
      let minSweptY = Infinity;
      for (let i = 0; i < count - 1; i++) {
        minSweptY = Math.min(minSweptY, sweptAabbs[i]!.min[1]!);
      }
      const proven = nextDown(minSweptY - nextUp(envMaxY));
      if (proven >= effectiveCap) terrainBroadPhaseProven = true;
    } catch {
      terrainBroadPhaseProven = false;
      envMaxY = undefined;
    }
  }
  let certifiedSurfaceMaxY: number | undefined = undefined;
  if (env?.certifiedSurfaceBounds) {
    try {
      certifiedSurfaceMaxY = boundsMaxY(
        env.certifiedSurfaceBounds(),
        "certifiedSurfaceBounds",
      );
    } catch {
      certifiedSurfaceMaxY = undefined;
    }
  }

  const perSegmentLower = new Float64Array(count - 1);
  const perSegmentUpper = new Float64Array(count - 1);
  const perSegmentWitnessS = new Float64Array(count - 1);
  const perSegmentWitnessPos: Vec3[] = Array.from({
    length: count - 1,
  }) as Vec3[];
  const perSegmentWork = new Float64Array(count - 1);
  const perSegmentRelatedIds: string[][] = Array.from({
    length: count - 1,
  }) as string[][];
  const perSegmentSource: Array<"terrain" | "self" | "cap"> = Array.from({
    length: count - 1,
  }) as Array<"terrain" | "self" | "cap">;
  const perSegmentLowerRelatedIds: string[][] = Array.from({
    length: count - 1,
  }) as string[][];
  const perSegmentLowerSource: Array<"terrain" | "self" | "cap"> = Array.from({
    length: count - 1,
  }) as Array<"terrain" | "self" | "cap">;
  const perSegmentLowerWitnessS = new Float64Array(count - 1);
  const perSegmentLowerWitnessPos: Vec3[] = Array.from({
    length: count - 1,
  }) as Vec3[];
  const terrainHardThresholds: readonly number[] = [hard, ...thresholds];
  const selfSeparationThresholds: readonly number[] = [
    hard,
    ...thresholds,
    ...softThresholds,
  ];
  const allThresholdsForSeparation = [
    ...selfSeparationThresholds,
    effectiveCap,
  ];

  if (env && !terrainBroadPhaseProven) {
    for (let segIdx = 0; segIdx < count - 1; segIdx++) {
      const seg = sweptSegments[segIdx]!;
      const segId = idForSegment(segIdx);
      const fallbackPos = vec3(
        snapshot.positions[segIdx * 3]!,
        snapshot.positions[segIdx * 3 + 1]!,
        snapshot.positions[segIdx * 3 + 2]!,
      );
      const fallbackS = snapshot.distances[segIdx]!;
      if (envMaxY !== undefined) {
        const sweptMinY = sweptAabbs[segIdx]!.min[1]!;
        const verticalLower = nextDown(sweptMinY - nextUp(envMaxY));
        if (verticalLower >= effectiveCap) {
          perSegmentLower[segIdx] = effectiveCap;
          perSegmentUpper[segIdx] = effectiveCap;
          perSegmentWitnessS[segIdx] = fallbackS;
          perSegmentWitnessPos[segIdx] = fallbackPos;
          perSegmentLowerWitnessS[segIdx] = fallbackS;
          perSegmentLowerWitnessPos[segIdx] = fallbackPos;
          perSegmentWork[segIdx] = 0;
          perSegmentRelatedIds[segIdx] = [segId];
          perSegmentSource[segIdx] = "cap";
          perSegmentLowerRelatedIds[segIdx] = [segId];
          perSegmentLowerSource[segIdx] = "cap";
          continue;
        }
      }
      if (certifiedSurfaceMaxY !== undefined) {
        const sweptMinY = sweptAabbs[segIdx]!.min[1]!;
        const verticalLower = nextDown(
          sweptMinY - nextUp(certifiedSurfaceMaxY),
        );
        if (
          verticalLower < effectiveCap &&
          selfSeparationThresholds.every(
            (threshold) => verticalLower >= threshold,
          )
        ) {
          perSegmentLower[segIdx] = verticalLower;
          perSegmentUpper[segIdx] = effectiveCap;
          perSegmentWitnessS[segIdx] = fallbackS;
          perSegmentWitnessPos[segIdx] = fallbackPos;
          perSegmentLowerWitnessS[segIdx] = fallbackS;
          perSegmentLowerWitnessPos[segIdx] = fallbackPos;
          perSegmentWork[segIdx] = 0;
          perSegmentRelatedIds[segIdx] = [segId];
          perSegmentSource[segIdx] = "terrain";
          perSegmentLowerRelatedIds[segIdx] = [segId];
          perSegmentLowerSource[segIdx] = "terrain";
          continue;
        }
      }
      if (remaining <= 0) {
        emitBudgetFatal(undefined, undefined, undefined, hard, [segId]);
        perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
        perSegmentUpper[segIdx] = effectiveCap;
        perSegmentWitnessS[segIdx] = fallbackS;
        perSegmentWitnessPos[segIdx] = fallbackPos;
        perSegmentLowerWitnessS[segIdx] = fallbackS;
        perSegmentLowerWitnessPos[segIdx] = fallbackPos;
        perSegmentWork[segIdx] = 0;
        perSegmentRelatedIds[segIdx] = [segId];
        perSegmentSource[segIdx] = "terrain";
        perSegmentLowerRelatedIds[segIdx] = [segId];
        perSegmentLowerSource[segIdx] = "terrain";
        continue;
      }
      if (!charge(1)) {
        emitBudgetFatal(undefined, undefined, undefined, hard, [segId]);
        perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
        perSegmentUpper[segIdx] = effectiveCap;
        perSegmentWitnessS[segIdx] = fallbackS;
        perSegmentWitnessPos[segIdx] = fallbackPos;
        perSegmentLowerWitnessS[segIdx] = fallbackS;
        perSegmentLowerWitnessPos[segIdx] = fallbackPos;
        perSegmentWork[segIdx] = 0;
        perSegmentRelatedIds[segIdx] = [segId];
        perSegmentSource[segIdx] = "terrain";
        perSegmentLowerRelatedIds[segIdx] = [segId];
        perSegmentLowerSource[segIdx] = "terrain";
        continue;
      }
      let terrain: PreparedTerrainSegmentEvaluator;
      let rootEval: {
        lowerM: number;
        upperM: number;
        witnessPos: Vec3;
        witnessS: number;
      };
      try {
        terrain = prepareTerrainSegmentEvaluator(seg);
        rootEval = evaluateTerrainSubinterval(seg, 0, 1, terrain, env, radius);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diagnostics.push({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Terrain SDF non-finite at segment ${segIdx}: ${msg}`,
          relatedIds: [segId],
        });
        perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
        perSegmentUpper[segIdx] = effectiveCap;
        perSegmentWitnessS[segIdx] = fallbackS;
        perSegmentWitnessPos[segIdx] = fallbackPos;
        perSegmentWork[segIdx] = 1;
        perSegmentRelatedIds[segIdx] = [segId];
        perSegmentSource[segIdx] = "terrain";
        continue;
      }
      let seq = 0;
      const heap: TerrainHeapNode[] = [];
      const push = (n: TerrainHeapNode): void => {
        heap.push(n);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          const a = heap[i]!;
          const b = heap[p]!;
          if (a.lowerM > b.lowerM || (a.lowerM === b.lowerM && a.seq >= b.seq))
            break;
          heap[i] = b;
          heap[p] = a;
          i = p;
        }
      };
      const pop = (): TerrainHeapNode => {
        const top = heap[0]!;
        const last = heap.pop()!;
        if (heap.length > 0) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = i * 2 + 1;
            const r = l + 1;
            let smallest = i;
            if (l < heap.length) {
              const a = heap[l]!;
              const b = heap[smallest]!;
              if (
                a.lowerM < b.lowerM ||
                (a.lowerM === b.lowerM && a.seq < b.seq)
              )
                smallest = l;
            }
            if (r < heap.length) {
              const a = heap[r]!;
              const b = heap[smallest]!;
              if (
                a.lowerM < b.lowerM ||
                (a.lowerM === b.lowerM && a.seq < b.seq)
              )
                smallest = r;
            }
            if (smallest === i) break;
            const tmp = heap[i]!;
            heap[i] = heap[smallest]!;
            heap[smallest] = tmp;
            i = smallest;
          }
        }
        return top;
      };
      let workUsed = 1;
      push({
        u0: 0,
        u1: 1,
        lowerM: rootEval.lowerM,
        upperM: rootEval.upperM,
        witnessPos: rootEval.witnessPos,
        witnessS: rootEval.witnessS,
        seq: seq++,
      });
      let bestUpper = rootEval.upperM;
      let bestNode: TerrainHeapNode = heap[0]!;
      const checkCertified = (): boolean => {
        const gl = heap.length > 0 ? heap[0]!.lowerM : bestNode.lowerM;
        return thresholdsSeparated(gl, bestUpper, terrainHardThresholds);
      };
      let certified = checkCertified();
      let abortedDueToBudget = false;
      let abortedDueToNonFinite = false;
      while (heap.length > 0 && !certified) {
        const globalLowerHeap = heap[0]!.lowerM;
        if (
          thresholdsSeparated(globalLowerHeap, bestUpper, terrainHardThresholds)
        ) {
          certified = true;
          break;
        }
        const cur = heap[0]!;
        if (cur.lowerM >= bestUpper) {
          pop();
          continue;
        }
        const midProbe = (cur.u0 + cur.u1) / 2;
        if (midProbe === cur.u0 || midProbe === cur.u1) break;
        if (workUsed + 2 > MAX_TERRAIN_WORK_PER_SEGMENT) break;
        if (!charge(2)) {
          abortedDueToBudget = true;
          break;
        }
        const node = pop();
        const mid = (node.u0 + node.u1) / 2;
        for (const [u0, u1] of [
          [node.u0, mid],
          [mid, node.u1],
        ] as const) {
          let ev: {
            lowerM: number;
            upperM: number;
            witnessPos: Vec3;
            witnessS: number;
          };
          try {
            ev = evaluateTerrainSubinterval(seg, u0, u1, terrain, env, radius);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            diagnostics.push({
              code: "CLEARANCE_UNCERTIFIED",
              severity: "fatal",
              provenance: "PROJECT_ENGINEERING_LIMIT",
              message: `Terrain SDF non-finite at segment ${segIdx}: ${msg}`,
              relatedIds: [segId],
            });
            heap.length = 0;
            abortedDueToNonFinite = true;
            break;
          }
          workUsed += 1;
          const child: TerrainHeapNode = {
            u0,
            u1,
            lowerM: ev.lowerM,
            upperM: ev.upperM,
            witnessPos: ev.witnessPos,
            witnessS: ev.witnessS,
            seq: seq++,
          };
          if (ev.upperM < bestUpper) {
            bestUpper = ev.upperM;
            bestNode = child;
          }
          if (child.lowerM < bestUpper) push(child);
        }
        if (abortedDueToNonFinite) break;
        if (heap.length === 0) break;
        if (checkCertified()) certified = true;
      }
      if (abortedDueToNonFinite) {
        perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
        perSegmentUpper[segIdx] = effectiveCap;
        perSegmentWitnessS[segIdx] = fallbackS;
        perSegmentWitnessPos[segIdx] = fallbackPos;
        perSegmentLowerWitnessS[segIdx] = fallbackS;
        perSegmentLowerWitnessPos[segIdx] = fallbackPos;
        perSegmentWork[segIdx] = workUsed;
        perSegmentRelatedIds[segIdx] = [segId];
        perSegmentSource[segIdx] = "terrain";
        perSegmentLowerRelatedIds[segIdx] = [segId];
        perSegmentLowerSource[segIdx] = "terrain";
        continue;
      }
      if (abortedDueToBudget || remaining <= 0) {
        const stillUncertified = !thresholdsSeparated(
          heap.length > 0 ? heap[0]!.lowerM : bestNode.lowerM,
          bestUpper,
          terrainHardThresholds,
        );
        if (stillUncertified) {
          emitBudgetFatal(undefined, undefined, undefined, hard, [segId]);
          perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
          perSegmentUpper[segIdx] = effectiveCap;
          perSegmentWitnessS[segIdx] = fallbackS;
          perSegmentWitnessPos[segIdx] = fallbackPos;
          perSegmentLowerWitnessS[segIdx] = fallbackS;
          perSegmentLowerWitnessPos[segIdx] = fallbackPos;
          perSegmentWork[segIdx] = workUsed;
          perSegmentRelatedIds[segIdx] = [segId];
          perSegmentSource[segIdx] = "terrain";
          perSegmentLowerRelatedIds[segIdx] = [segId];
          perSegmentLowerSource[segIdx] = "terrain";
          continue;
        }
      }
      const globalLower = heap.length > 0 ? heap[0]!.lowerM : bestNode.lowerM;
      const lowerWitness = heap.length > 0 ? heap[0]! : bestNode;
      perSegmentLower[segIdx] = globalLower;
      perSegmentUpper[segIdx] = bestUpper;
      perSegmentWitnessS[segIdx] = bestNode.witnessS;
      perSegmentWitnessPos[segIdx] = bestNode.witnessPos;
      perSegmentLowerWitnessS[segIdx] = lowerWitness.witnessS;
      perSegmentLowerWitnessPos[segIdx] = lowerWitness.witnessPos;
      perSegmentWork[segIdx] = workUsed;
      perSegmentRelatedIds[segIdx] = [segId];
      perSegmentSource[segIdx] = "terrain";
      perSegmentLowerRelatedIds[segIdx] = [segId];
      perSegmentLowerSource[segIdx] = "terrain";
      const isCert = thresholdsSeparated(
        globalLower,
        bestUpper,
        terrainHardThresholds,
      );
      if (!isCert) {
        if (remaining <= 0) {
          emitBudgetFatal(undefined, undefined, undefined, hard, [segId]);
          perSegmentLower[segIdx] = CONSERVATIVE_LOWER_M;
          perSegmentUpper[segIdx] = effectiveCap;
          perSegmentWitnessS[segIdx] = fallbackS;
          perSegmentWitnessPos[segIdx] = fallbackPos;
        } else {
          diagnostics.push({
            code: "CLEARANCE_UNCERTIFIED",
            severity: "fatal",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: `Terrain clearance uncertified at s=${bestNode.witnessS.toFixed(6)} lower=${globalLower.toFixed(6)} upper=${bestUpper.toFixed(6)}`,
            relatedIds: [segId],
          });
        }
      }
    }
  } else {
    for (let i = 0; i < count - 1; i++) {
      perSegmentLower[i] = effectiveCap;
      perSegmentUpper[i] = effectiveCap;
      perSegmentWitnessS[i] = snapshot.distances[i]!;
      perSegmentWitnessPos[i] = vec3(
        snapshot.positions[i * 3]!,
        snapshot.positions[i * 3 + 1]!,
        snapshot.positions[i * 3 + 2]!,
      );
      perSegmentLowerWitnessS[i] = snapshot.distances[i]!;
      perSegmentLowerWitnessPos[i] = vec3(
        snapshot.positions[i * 3]!,
        snapshot.positions[i * 3 + 1]!,
        snapshot.positions[i * 3 + 2]!,
      );
      perSegmentWork[i] = 0;
      perSegmentRelatedIds[i] = [idForSegment(i)];
      perSegmentSource[i] = "cap";
      perSegmentLowerRelatedIds[i] = [idForSegment(i)];
      perSegmentLowerSource[i] = "cap";
    }
  }

  const localityM = nextUp(2 * radius);
  let cellSize = 1;
  try {
    cellSize = nextUp(Math.max(1, effectiveCap));
    if (!Number.isFinite(cellSize) || cellSize <= 0) cellSize = 1;
  } catch {
    cellSize = 1;
  }

  const CHUNK_SIZE = 16;
  const maxSelfSeparationThreshold = Math.max(...selfSeparationThresholds);
  const chunkCount = Math.ceil(sweptAabbs.length / CHUNK_SIZE);
  const chunkAabbs: Array<{ min: Vec3; max: Vec3 }> = [];
  for (let c = 0; c < chunkCount; c++) {
    const startIdx = c * CHUNK_SIZE;
    const endIdx = Math.min((c + 1) * CHUNK_SIZE, sweptAabbs.length) - 1;
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let k = startIdx; k <= endIdx; k++) {
      const a = sweptAabbs[k]!;
      minX = Math.min(minX, a.min[0]!);
      minY = Math.min(minY, a.min[1]!);
      minZ = Math.min(minZ, a.min[2]!);
      maxX = Math.max(maxX, a.max[0]!);
      maxY = Math.max(maxY, a.max[1]!);
      maxZ = Math.max(maxZ, a.max[2]!);
    }
    chunkAabbs.push({
      min: vec3(nextDown(minX), nextDown(minY), nextDown(minZ)),
      max: vec3(nextUp(maxX), nextUp(maxY), nextUp(maxZ)),
    });
  }

  let candidatePairs: Array<[number, number]> = [];
  let hashBuilt = true;

  try {
    const cellMap = new Map<string, number[]>();
    for (let c = 0; c < chunkCount; c++) {
      const aabb = chunkAabbs[c]!;
      const ranges = bucketRanges(aabb, cellSize);
      const cx = rangeCount(ranges[0]!);
      const cy = rangeCount(ranges[1]!);
      const cz = rangeCount(ranges[2]!);
      const totalCells = checkedProduct(checkedProduct(cx, cy), cz);
      if (!charge(totalCells))
        throw new RangeError("work budget exhausted on hash insertion");
      for (let x = ranges[0]![0]; x <= ranges[0]![1]; x++) {
        for (let y = ranges[1]![0]; y <= ranges[1]![1]; y++) {
          for (let z = ranges[2]![0]; z <= ranges[2]![1]; z++) {
            const key = `${x},${y},${z}`;
            const list = cellMap.get(key);
            if (list) list.push(c);
            else cellMap.set(key, [c]);
          }
        }
      }
    }
    const chunkSeen = new Set<string>();
    const chunkCandidatePairs: Array<[number, number]> = [];
    for (let c = 0; c < chunkCount; c++) {
      const aabb = chunkAabbs[c]!;
      const expanded = {
        min: vec3(
          nextDown(aabb.min[0]! - effectiveCap),
          nextDown(aabb.min[1]! - effectiveCap),
          nextDown(aabb.min[2]! - effectiveCap),
        ),
        max: vec3(
          nextUp(aabb.max[0]! + effectiveCap),
          nextUp(aabb.max[1]! + effectiveCap),
          nextUp(aabb.max[2]! + effectiveCap),
        ),
      };
      const qRanges = bucketRanges(expanded, cellSize);
      const qx = rangeCount(qRanges[0]!);
      const qy = rangeCount(qRanges[1]!);
      const qz = rangeCount(qRanges[2]!);
      const qTotal = checkedProduct(checkedProduct(qx, qy), qz);
      if (!charge(qTotal))
        throw new RangeError("work budget exhausted on hash query");
      const candChunkSet = new Set<number>();
      for (let x = qRanges[0]![0]; x <= qRanges[0]![1]; x++) {
        for (let y = qRanges[1]![0]; y <= qRanges[1]![1]; y++) {
          for (let z = qRanges[2]![0]; z <= qRanges[2]![1]; z++) {
            const key = `${x},${y},${z}`;
            const list = cellMap.get(key);
            if (!list) continue;
            for (const j of list) {
              if (!charge(1))
                throw new RangeError(
                  "work budget exhausted on chunk bucket visits",
                );
              if (j < c) continue;
              const pairKey = `${Math.min(c, j)}:${Math.max(c, j)}`;
              if (chunkSeen.has(pairKey)) continue;
              // No chunk-level locality exclusion except self is always candidate; cross chunks are all candidates (conservative)
              // Self chunk is always included, cross chunk is included if AABB overlaps expanded
              if (j === c) {
                if (!candChunkSet.has(c)) candChunkSet.add(c);
              } else {
                candChunkSet.add(j);
              }
            }
          }
        }
      }
      // Add self chunk
      candChunkSet.add(c);
      if (!charge(candChunkSet.size))
        throw new RangeError("work budget exhausted on chunk candidate visits");
      const sortedChunks = [...candChunkSet].sort((a, b) => a - b);
      if (sortedChunks.length > 1) {
        const sortCost =
          sortedChunks.length * Math.ceil(Math.log2(sortedChunks.length + 1));
        if (!charge(sortCost))
          throw new RangeError("work budget exhausted on chunk candidate sort");
      }
      for (const j of sortedChunks) {
        const a = Math.min(c, j);
        const b = Math.max(c, j);
        const chunkPairKey = `${a}:${b}`;
        if (chunkSeen.has(chunkPairKey)) continue;
        if (!charge(1))
          throw new RangeError("work budget exhausted on chunk dedup");
        chunkSeen.add(chunkPairKey);
        if (!charge(1))
          throw new RangeError("work budget exhausted on chunk pair insertion");
        chunkCandidatePairs.push([a, b]);
      }
    }
    if (chunkCandidatePairs.length > 1) {
      const pairSortCost =
        chunkCandidatePairs.length *
        Math.ceil(Math.log2(chunkCandidatePairs.length + 1));
      if (!charge(pairSortCost))
        throw new RangeError("work budget exhausted on chunk pair sort");
    }
    chunkCandidatePairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const seenRaw = new Set<string>();
    for (const [ca, cb] of chunkCandidatePairs) {
      const startA = ca * CHUNK_SIZE;
      const endA = Math.min((ca + 1) * CHUNK_SIZE, sweptAabbs.length);
      const startB = cb * CHUNK_SIZE;
      const endB = Math.min((cb + 1) * CHUNK_SIZE, sweptAabbs.length);
      if (ca === cb) {
        for (let i = startA; i < endA; i++) {
          for (let j = i + 1; j < endA; j++) {
            if (!charge(1))
              throw new RangeError(
                "work budget exhausted on raw pair enumeration",
              );
            const segA = sweptSegments[i]!;
            const segB = sweptSegments[j]!;
            if (
              areSweptIntervalsWithinLocality(
                segA,
                segB,
                localityM,
                closed,
                snapshot.totalLength,
              )
            )
              continue;
            const aabbA = sweptAabbs[i]!;
            const aabbB = sweptAabbs[j]!;
            const gap = (axis: 0 | 1 | 2): number => {
              if (aabbA.max[axis]! < aabbB.min[axis]!)
                return aabbB.min[axis]! - aabbA.max[axis]!;
              if (aabbB.max[axis]! < aabbA.min[axis]!)
                return aabbA.min[axis]! - aabbB.max[axis]!;
              return 0;
            };
            const distLower = nextDown(Math.hypot(gap(0), gap(1), gap(2)));
            if (distLower > effectiveCap) continue;
            if (distLower >= maxSelfSeparationThreshold) {
              if (!charge(1))
                throw new RangeError(
                  "work budget exhausted on threshold-pass lower update",
                );
              if (distLower < perSegmentLower[i]!) {
                perSegmentLower[i] = distLower;
                perSegmentLowerRelatedIds[i] = [
                  idForSegment(i),
                  idForSegment(j),
                ];
                perSegmentLowerSource[i] = "self";
                perSegmentLowerWitnessS[i] = sweptSegments[i]!.startS;
                perSegmentLowerWitnessPos[i] = sweptSegments[i]!.start.position;
              }
              if (distLower < perSegmentLower[j]!) {
                perSegmentLower[j] = distLower;
                perSegmentLowerRelatedIds[j] = [
                  idForSegment(i),
                  idForSegment(j),
                ];
                perSegmentLowerSource[j] = "self";
                perSegmentLowerWitnessS[j] = sweptSegments[j]!.startS;
                perSegmentLowerWitnessPos[j] = sweptSegments[j]!.start.position;
              }
              continue;
            }
            const pairKey = `${i}:${j}`;
            if (seenRaw.has(pairKey)) continue;
            if (!charge(1))
              throw new RangeError("work budget exhausted on dedup");
            seenRaw.add(pairKey);
            if (!charge(1))
              throw new RangeError(
                "work budget exhausted on candidate insertion",
              );
            candidatePairs.push([i, j]);
          }
        }
      } else {
        for (let i = startA; i < endA; i++) {
          for (let j = startB; j < endB; j++) {
            if (!charge(1))
              throw new RangeError(
                "work budget exhausted on raw pair enumeration",
              );
            const segA = sweptSegments[i]!;
            const segB = sweptSegments[j]!;
            if (
              areSweptIntervalsWithinLocality(
                segA,
                segB,
                localityM,
                closed,
                snapshot.totalLength,
              )
            )
              continue;
            const aabbA = sweptAabbs[i]!;
            const aabbB = sweptAabbs[j]!;
            const gap = (axis: 0 | 1 | 2): number => {
              if (aabbA.max[axis]! < aabbB.min[axis]!)
                return aabbB.min[axis]! - aabbA.max[axis]!;
              if (aabbB.max[axis]! < aabbA.min[axis]!)
                return aabbA.min[axis]! - aabbB.max[axis]!;
              return 0;
            };
            const distLower = nextDown(Math.hypot(gap(0), gap(1), gap(2)));
            if (distLower > effectiveCap) continue;
            if (distLower >= maxSelfSeparationThreshold) {
              if (!charge(1))
                throw new RangeError(
                  "work budget exhausted on threshold-pass lower update",
                );
              if (distLower < perSegmentLower[i]!) {
                perSegmentLower[i] = distLower;
                perSegmentLowerRelatedIds[i] = [
                  idForSegment(i),
                  idForSegment(j),
                ];
                perSegmentLowerSource[i] = "self";
                perSegmentLowerWitnessS[i] = sweptSegments[i]!.startS;
                perSegmentLowerWitnessPos[i] = sweptSegments[i]!.start.position;
              }
              if (distLower < perSegmentLower[j]!) {
                perSegmentLower[j] = distLower;
                perSegmentLowerRelatedIds[j] = [
                  idForSegment(i),
                  idForSegment(j),
                ];
                perSegmentLowerSource[j] = "self";
                perSegmentLowerWitnessS[j] = sweptSegments[j]!.startS;
                perSegmentLowerWitnessPos[j] = sweptSegments[j]!.start.position;
              }
              continue;
            }
            const ai = Math.min(i, j);
            const bj = Math.max(i, j);
            const pairKey = `${ai}:${bj}`;
            if (seenRaw.has(pairKey)) continue;
            if (!charge(1))
              throw new RangeError("work budget exhausted on dedup");
            seenRaw.add(pairKey);
            if (!charge(1))
              throw new RangeError(
                "work budget exhausted on candidate insertion",
              );
            candidatePairs.push([ai, bj]);
          }
        }
      }
    }
  } catch (e) {
    hashBuilt = false;
    const msg = e instanceof Error ? e.message : String(e);
    const isBudget = msg.includes("budget") || msg.includes("work budget");
    if (isBudget) {
      emitBudgetFatal(undefined, undefined, undefined, hard, [idForSegment(0)]);
    } else {
      diagnostics.push({
        code: "CLEARANCE_UNCERTIFIED",
        severity: "fatal",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Spatial hash overflow/fatal: ${msg}`,
        relatedIds: [idForSegment(0)],
      });
    }
    for (let i = 0; i < count - 1; i++) {
      perSegmentLower[i] = CONSERVATIVE_LOWER_M;
      perSegmentLowerRelatedIds[i] = [idForSegment(i)];
      perSegmentLowerSource[i] = "terrain";
      perSegmentLowerWitnessS[i] = snapshot.distances[i]!;
      perSegmentLowerWitnessPos[i] = vec3(
        snapshot.positions[i * 3]!,
        snapshot.positions[i * 3 + 1]!,
        snapshot.positions[i * 3 + 2]!,
      );
    }
  }

  if (hashBuilt) {
    for (const [aIdx, bIdx] of candidatePairs) {
      const segA = sweptSegments[aIdx]!;
      const segB = sweptSegments[bIdx]!;
      const closedForPair = closed;
      const trackLen = snapshot.totalLength;
      if (
        areSweptIntervalsWithinLocality(
          segA,
          segB,
          localityM,
          closedForPair,
          trackLen ?? 0,
        )
      ) {
        continue;
      }
      if (remaining <= 0) {
        emitBudgetFatal(undefined, undefined, undefined, hard, [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ]);
        for (let i = 0; i < count - 1; i++) {
          perSegmentLower[i] = CONSERVATIVE_LOWER_M;
          perSegmentLowerRelatedIds[i] = [
            idForSegment(aIdx),
            idForSegment(bIdx),
          ];
          perSegmentLowerSource[i] = "self";
          perSegmentLowerWitnessS[i] = sweptSegments[aIdx]!.startS;
          perSegmentLowerWitnessPos[i] = sweptSegments[aIdx]!.start.position;
        }
        break;
      }
      if (!charge(1)) {
        emitBudgetFatal(undefined, undefined, undefined, hard, [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ]);
        for (let i = 0; i < count - 1; i++) {
          perSegmentLower[i] = CONSERVATIVE_LOWER_M;
          perSegmentLowerRelatedIds[i] = [
            idForSegment(aIdx),
            idForSegment(bIdx),
          ];
          perSegmentLowerSource[i] = "self";
          perSegmentLowerWitnessS[i] = sweptSegments[aIdx]!.startS;
          perSegmentLowerWitnessPos[i] = sweptSegments[aIdx]!.start.position;
        }
        break;
      }
      let res: ReturnType<typeof certifiedSweptDistance>;
      try {
        res = certifiedSweptDistance(segA, segB, {
          maxWork: remaining,
          resolutionM: CERTIFICATE_RESOLUTION_M,
          localityM,
          ...(closed
            ? { closed: true, trackLengthM: snapshot.totalLength }
            : {}),
          separationThresholds: selfSeparationThresholds,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        perSegmentLower[aIdx] = CONSERVATIVE_LOWER_M;
        perSegmentLower[bIdx] = CONSERVATIVE_LOWER_M;
        perSegmentLowerRelatedIds[aIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerRelatedIds[bIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerSource[aIdx] = "self";
        perSegmentLowerSource[bIdx] = "self";
        perSegmentLowerWitnessS[aIdx] = segA.startS;
        perSegmentLowerWitnessS[bIdx] = segB.startS;
        perSegmentLowerWitnessPos[aIdx] = segA.start.position;
        perSegmentLowerWitnessPos[bIdx] = segB.start.position;
        diagnostics.push({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Self clearance exception segments ${aIdx},${bIdx}: ${msg}`,
          relatedIds: [idForSegment(aIdx), idForSegment(bIdx)],
        });
        continue;
      }
      if (!charge(res.work)) {
        emitBudgetFatal(undefined, undefined, undefined, hard, [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ]);
        for (let i = 0; i < count - 1; i++) {
          perSegmentLower[i] = CONSERVATIVE_LOWER_M;
          perSegmentLowerRelatedIds[i] = [
            idForSegment(aIdx),
            idForSegment(bIdx),
          ];
          perSegmentLowerSource[i] = "self";
          perSegmentLowerWitnessS[i] = sweptSegments[aIdx]!.startS;
          perSegmentLowerWitnessPos[i] = sweptSegments[aIdx]!.start.position;
        }
        break;
      }
      if (!res.ok) {
        perSegmentLower[aIdx] = CONSERVATIVE_LOWER_M;
        perSegmentLower[bIdx] = CONSERVATIVE_LOWER_M;
        perSegmentLowerRelatedIds[aIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerRelatedIds[bIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerSource[aIdx] = "self";
        perSegmentLowerSource[bIdx] = "self";
        perSegmentLowerWitnessS[aIdx] = segA.startS;
        perSegmentLowerWitnessS[bIdx] = segB.startS;
        perSegmentLowerWitnessPos[aIdx] = segA.start.position;
        perSegmentLowerWitnessPos[bIdx] = segB.start.position;
        emitBudgetFatal(undefined, undefined, undefined, hard, [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ]);
        continue;
      }
      if (res.excluded) continue;
      const lower = res.lowerM;
      const upper = res.upperM;
      if (lower < perSegmentLower[aIdx]!) {
        perSegmentLower[aIdx] = lower;
        perSegmentLowerRelatedIds[aIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerSource[aIdx] = "self";
        perSegmentLowerWitnessS[aIdx] =
          segA.startS + (segA.endS - segA.startS) * res.witnessU;
        perSegmentLowerWitnessPos[aIdx] = res.pointA;
      }
      if (upper < perSegmentUpper[aIdx]!) {
        perSegmentUpper[aIdx] = upper;
        perSegmentWitnessS[aIdx] =
          segA.startS + (segA.endS - segA.startS) * res.witnessU;
        perSegmentWitnessPos[aIdx] = res.pointA;
        perSegmentRelatedIds[aIdx] = [idForSegment(aIdx), idForSegment(bIdx)];
        perSegmentSource[aIdx] = "self";
      }
      if (lower < perSegmentLower[bIdx]!) {
        perSegmentLower[bIdx] = lower;
        perSegmentLowerRelatedIds[bIdx] = [
          idForSegment(aIdx),
          idForSegment(bIdx),
        ];
        perSegmentLowerSource[bIdx] = "self";
        perSegmentLowerWitnessS[bIdx] =
          segB.startS + (segB.endS - segB.startS) * res.witnessV;
        perSegmentLowerWitnessPos[bIdx] = res.pointB;
      }
      if (upper < perSegmentUpper[bIdx]!) {
        perSegmentUpper[bIdx] = upper;
        perSegmentWitnessS[bIdx] =
          segB.startS + (segB.endS - segB.startS) * res.witnessV;
        perSegmentWitnessPos[bIdx] = res.pointB;
        perSegmentRelatedIds[bIdx] = [idForSegment(aIdx), idForSegment(bIdx)];
        perSegmentSource[bIdx] = "self";
      }
    }
  }

  const segments: ClearanceFieldSegment[] = [];
  let globalLowerM = Infinity;
  let globalUpperM = Infinity;
  let globalWitnessS = snapshot.distances[0]!;
  let globalWitnessPosition: Vec3 = vec3(
    snapshot.positions[0]!,
    snapshot.positions[1]!,
    snapshot.positions[2]!,
  );
  let globalRelatedIds: readonly string[] = [idForSegment(0)];
  let globalSource: "terrain" | "self" | "cap" = "terrain";
  let globalLowerRelatedIds: readonly string[] = [idForSegment(0)];
  let globalLowerSource: "terrain" | "self" | "cap" = "terrain";
  let globalLowerWitnessS = snapshot.distances[0]!;
  let globalLowerWitnessPosition: Vec3 = vec3(
    snapshot.positions[0]!,
    snapshot.positions[1]!,
    snapshot.positions[2]!,
  );

  for (let i = 0; i < count - 1; i++) {
    let lower = perSegmentLower[i]!;
    let upper = perSegmentUpper[i]!;
    if (!Number.isFinite(lower)) lower = CONSERVATIVE_LOWER_M;
    if (!Number.isFinite(upper)) upper = effectiveCap;
    const witnessS = perSegmentWitnessS[i]!;
    const witnessPos = perSegmentWitnessPos[i]!;
    const relatedIds = perSegmentRelatedIds[i] ?? [idForSegment(i)];
    const source = perSegmentSource[i] ?? "terrain";
    const separated = thresholdsSeparated(
      lower,
      upper,
      allThresholdsForSeparation,
    );
    const certified = separated || lower >= effectiveCap;
    segments.push({
      index: i,
      startS: snapshot.distances[i]!,
      endS: snapshot.distances[i + 1]!,
      lowerM: lower,
      upperM: upper,
      witnessS,
      witnessPosition: witnessPos,
      relatedIds: Object.freeze([...relatedIds]),
      work: perSegmentWork[i]!,
      certified,
      source,
    });
    if (lower < globalLowerM) {
      const lowerRelated = perSegmentLowerRelatedIds[i] ?? relatedIds;
      const lowerSrc = perSegmentLowerSource[i] ?? source;
      const lowerWS = perSegmentLowerWitnessS[i] ?? witnessS;
      const lowerWP = perSegmentLowerWitnessPos[i] ?? witnessPos;
      globalLowerM = lower;
      globalLowerRelatedIds = Object.freeze([...lowerRelated]);
      globalLowerSource = lowerSrc;
      globalLowerWitnessS = lowerWS;
      globalLowerWitnessPosition = lowerWP;
    }
    if (upper < globalUpperM) {
      globalUpperM = upper;
      globalWitnessS = witnessS;
      globalWitnessPosition = witnessPos;
      globalRelatedIds = Object.freeze([...relatedIds]);
      globalSource = source;
    }
  }
  if (!Number.isFinite(globalLowerM)) globalLowerM = CONSERVATIVE_LOWER_M;
  if (!Number.isFinite(globalUpperM)) globalUpperM = effectiveCap;
  if (!Number.isFinite(globalLowerWitnessS))
    globalLowerWitnessS = snapshot.distances[0]!;
  return {
    track,
    segments: Object.freeze(segments),
    globalLowerM,
    globalUpperM,
    globalWitnessS,
    globalWitnessPosition,
    globalRelatedIds: Object.freeze([...globalRelatedIds]),
    globalSource,
    globalLowerRelatedIds: Object.freeze([...globalLowerRelatedIds]),
    globalLowerSource,
    globalLowerWitnessS,
    globalLowerWitnessPosition,
    effectiveCap,
    diagnostics: Object.freeze(diagnostics),
    work: totalWork,
    closed,
  };
}

export function projectClearanceDiagnostics(
  field: ClearanceField,
  constraints: readonly ClearanceConstraintDescriptor[],
): readonly Diagnostic[] {
  if (!field || typeof field !== "object")
    throw new RangeError("field must be object");
  finite(field.globalLowerM, "globalLowerM");
  finite(field.globalUpperM, "globalUpperM");
  finite(field.effectiveCap, "effectiveCap");
  finite(field.globalWitnessS, "globalWitnessS");
  if (!Array.isArray(constraints))
    throw new RangeError("constraints must be array");
  for (const c of constraints) {
    if (typeof c.id !== "string" || c.id.trim().length === 0)
      throw new RangeError("constraint id must be non-empty string");
    if (typeof c.hard !== "boolean")
      throw new RangeError("constraint hard must be boolean");
    finite(c.threshold, "threshold");
    if (c.threshold < 0) throw new RangeError("threshold must be non-negative");
  }
  const defaultConstraint: ClearanceConstraintDescriptor = {
    id: "default-hard-0.5",
    hard: true,
    threshold: DEFAULT_HARD_CLEARANCE_M,
  };
  const all = [defaultConstraint, ...constraints];
  const diagnostics: Diagnostic[] = [];
  const isSelfSource = field.globalSource === "self";
  for (const c of all) {
    const limit = c.threshold;
    if (field.globalLowerM >= limit) continue;
    if (field.globalUpperM < limit) {
      const actual = field.globalUpperM;
      const code = isSelfSource ? "TRACK_CLEARANCE" : "TERRAIN_CLEARANCE";
      diagnostics.push({
        code,
        severity: c.hard ? "error" : "warning",
        provenance: c.hard ? "PROJECT_ENGINEERING_LIMIT" : "DESIGN_ASSUMPTION",
        message: `${code === "TERRAIN_CLEARANCE" ? "Terrain" : "Track"} clearance ${actual.toFixed(6)} < limit ${limit.toFixed(6)} at s=${field.globalWitnessS.toFixed(6)}`,
        location: {
          s: field.globalWitnessS,
          position: field.globalWitnessPosition,
        },
        actual,
        limit,
        margin: actual - limit,
        relatedIds: [
          ...field.globalRelatedIds,
          ...(c.id !== defaultConstraint.id ? [c.id] : []),
        ],
      });
    } else {
      const lowerIds = field.globalLowerRelatedIds;
      if (c.hard) {
        diagnostics.push({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "fatal",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: `Clearance uncertified straddling threshold ${limit.toFixed(6)} bracket [${field.globalLowerM.toFixed(6)}, ${field.globalUpperM.toFixed(6)}]`,
          relatedIds: [
            ...lowerIds,
            ...(c.id !== defaultConstraint.id ? [c.id] : []),
          ],
        });
      } else {
        diagnostics.push({
          code: "CLEARANCE_UNCERTIFIED",
          severity: "warning",
          provenance: "DESIGN_ASSUMPTION",
          message: `Clearance uncertified straddling threshold ${limit.toFixed(6)} bracket [${field.globalLowerM.toFixed(6)}, ${field.globalUpperM.toFixed(6)}]`,
          relatedIds: [
            ...lowerIds,
            ...(c.id !== defaultConstraint.id ? [c.id] : []),
          ],
        });
      }
    }
  }
  return Object.freeze(diagnostics);
}

export function mapClearanceToTimeline(
  field: ClearanceField,
  timelineHeadDistanceM: Float64Array,
  trainOffsets: readonly number[],
): Float64Array {
  if (!(timelineHeadDistanceM instanceof Float64Array))
    throw new RangeError("timelineHeadDistanceM must be Float64Array");
  if (!Array.isArray(trainOffsets) && !(trainOffsets instanceof Float64Array))
    throw new RangeError("trainOffsets must be array");
  for (const v of trainOffsets) {
    if (!Number.isFinite(v)) throw new RangeError("trainOffset must be finite");
    if (v < 0) throw new RangeError("trainOffset must be non-negative");
  }
  for (let i = 0; i < timelineHeadDistanceM.length; i++)
    if (!Number.isFinite(timelineHeadDistanceM[i]!))
      throw new RangeError("headDistance must be finite");
  const out = new Float64Array(timelineHeadDistanceM.length);
  const L = field.track.totalLength;
  if (!Number.isFinite(L) || L <= 0)
    throw new RangeError("track totalLength must be finite positive");
  const stationDistances = field.track.distances;
  const n = stationDistances.length;
  for (let t = 0; t < timelineHeadDistanceM.length; t++) {
    const head = timelineHeadDistanceM[t]!;
    let minClear = Infinity;
    for (const offset of trainOffsets) {
      let carS = head - offset;
      if (field.closed) carS = ((carS % L) + L) % L;
      else {
        if (carS < 0 || carS > L)
          throw new RangeError(
            `Car station ${carS} outside [0,${L}] for open track`,
          );
        if (Object.is(carS, -0)) carS = 0;
      }
      let segClear: number;
      if (!field.closed && carS === L)
        segClear = field.segments[field.segments.length - 1]!.lowerM;
      else if (field.closed && carS === 0) {
        const a = field.segments[0]!;
        const b = field.segments[field.segments.length - 1]!;
        segClear = Math.min(a.lowerM, b.lowerM);
      } else {
        let lo = 0;
        let hi = n - 1;
        let exactIdx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const d = stationDistances[mid]!;
          if (carS === d) {
            exactIdx = mid;
            break;
          } else if (carS < d) hi = mid - 1;
          else lo = mid + 1;
        }
        if (exactIdx !== -1) {
          if (exactIdx === 0) segClear = field.segments[0]!.lowerM;
          else if (exactIdx === n - 1)
            segClear = field.segments[field.segments.length - 1]!.lowerM;
          else
            segClear = Math.min(
              field.segments[exactIdx - 1]!.lowerM,
              field.segments[exactIdx]!.lowerM,
            );
        } else {
          const idx = hi;
          if (idx < 0 || idx >= field.segments.length)
            throw new RangeError(`station ${carS} outside track [0,${L}]`);
          segClear = field.segments[idx]!.lowerM;
        }
      }
      minClear = Math.min(minClear, segClear);
    }
    out[t] = Math.min(minClear, field.effectiveCap);
    if (!Number.isFinite(out[t]!))
      throw new RangeError("clearance timeline must be finite");
  }
  return out;
}
