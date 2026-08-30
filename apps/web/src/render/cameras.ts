import { sampleCompiledTrack } from "@openvibecoaster/core";
import type { CompiledTrackData, Vec3 } from "@openvibecoaster/core";

export type CameraId = "front" | "middle" | "rear" | "chase" | "orbit";

export const CAMERA_IDS: readonly CameraId[] = [
  "front",
  "middle",
  "rear",
  "chase",
  "orbit",
] as const;

export function selectCamera(
  requested: CameraId,
  fallback: CameraId,
): CameraId {
  if ((CAMERA_IDS as readonly string[]).includes(requested)) return requested;
  return fallback;
}

export function clampFovForSpeed(speedMps: number): number {
  // Physically coherent but restrained: higher speed slightly widens FOV, clamped 50-90
  const t = Math.max(0, Math.min(1, speedMps / 35));
  const fov = 58 + t * 18;
  return Math.max(50, Math.min(90, fov));
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface GetCameraOptions {
  reducedMotion?: boolean | undefined;
  previous?: CameraState | undefined;
  deltaMs?: number | undefined;
  chaseDistance?: number | undefined;
  chaseHeight?: number | undefined;
}

function samplePosition(
  data: CompiledTrackData,
  distance: number,
): { pos: Vec3; tangent: Vec3; normal: Vec3; binormal: Vec3 } {
  const t =
    data.totalLength === 0
      ? 0
      : Math.max(0, Math.min(1, distance / data.totalLength));
  const s = sampleCompiledTrack(data, t);
  return {
    pos: s.position,
    tangent: s.tangent,
    normal: s.normal,
    binormal: s.binormal,
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as unknown as Vec3;
}
function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s] as unknown as Vec3;
}
function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ] as unknown as Vec3;
}
function lerp(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

export function getCameraState(
  cameraId: CameraId,
  data: CompiledTrackData,
  distance: number,
  speedMps: number,
  options: GetCameraOptions = {},
): CameraState {
  const reduced = options.reducedMotion ?? false;
  const fov = clampFovForSpeed(speedMps);
  let rawPos: Vec3;
  let rawTarget: Vec3;

  switch (cameraId) {
    case "front": {
      const s = samplePosition(data, distance);
      rawPos = add(add(s.pos, scale(s.normal, 0.85)), scale(s.tangent, 0.35));
      rawTarget = add(s.pos, scale(s.tangent, 20));
      break;
    }
    case "middle": {
      // middle car offset: distance - 2.5* pitch approx mid-train
      const midDist = distance - 2.5 * 3.4;
      const s = samplePosition(data, midDist);
      rawPos = add(s.pos, scale(s.normal, 0.9));
      rawTarget = add(s.pos, scale(s.tangent, 20));
      break;
    }
    case "rear": {
      const rearDist = distance - 5 * 3.4;
      const s = samplePosition(data, rearDist);
      rawPos = add(add(s.pos, scale(s.normal, 0.95)), scale(s.tangent, -0.9));
      rawTarget = add(s.pos, scale(s.tangent, 20));
      break;
    }
    case "chase": {
      const chaseDist = options.chaseDistance ?? 9;
      const chaseHeight = options.chaseHeight ?? 3.2;
      const s0 = samplePosition(data, distance);
      const sBehind = samplePosition(data, Math.max(0, distance - chaseDist));
      // Position behind and above
      rawPos = add(
        add(sBehind.pos, scale(sBehind.normal, chaseHeight)),
        scale(sBehind.tangent, -2.5),
      );
      // Look at a point slightly ahead of front car
      rawTarget = add(s0.pos, scale(s0.tangent, 6));
      break;
    }
    case "orbit":
    default: {
      const s = samplePosition(data, distance);
      // Orbit: wider radius exposes substantially more track and reduces train dominance
      const orbitRadius = 32;
      const angle = (distance * 0.03) % (Math.PI * 2);
      const orbitOffset: Vec3 = [
        Math.cos(angle) * orbitRadius,
        14,
        Math.sin(angle) * orbitRadius,
      ] as unknown as Vec3;
      rawPos = add(s.pos, orbitOffset);
      rawTarget = add(s.pos, scale(s.normal, 0.6));
      break;
    }
  }

  // Visual-only damping: lerp from previous if provided and not reducedMotion
  if (options.previous && options.deltaMs !== undefined) {
    const deltaSec = options.deltaMs / 1000;
    // Damping factor: more lag for chase/orbit, reducedMotion uses very low lerp (almost frozen) or instant snap
    const baseTau =
      cameraId === "orbit" ? 0.6 : cameraId === "chase" ? 0.35 : 0.2;
    // Reduced motion: clamp or heavily dampen movement to avoid vestibular load
    const tau = reduced ? baseTau * 6 : baseTau;
    const t = reduced ? 0.04 : 1 - Math.exp(-deltaSec / tau);
    // In reduced motion chase, also cap max movement per frame
    const pos = lerpVec(options.previous.position, rawPos, t);
    const target = lerpVec(options.previous.target, rawTarget, t);
    const fovLerped = lerp(options.previous.fov, fov, reduced ? 0.02 : 0.12);
    return { position: pos, target, fov: fovLerped };
  }

  return { position: rawPos, target: rawTarget, fov };
}
