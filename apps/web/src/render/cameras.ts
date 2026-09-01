import { sampleCompiledTrack } from "@openvibecoaster/core";
import type { CompiledTrackData, Vec3 } from "@openvibecoaster/core";
import type { RidePlaybackSnapshot } from "../ride/controller.js";

export type CameraId = "front" | "middle" | "rear" | "chase" | "orbit";

export const CAMERA_FALLBACK_DIAGNOSTIC =
  "camera:fallback:legacy-compact-timeline";

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
  snapshot?: RidePlaybackSnapshot | null | undefined;
}

export function getCarIndexForCamera(
  cameraId: CameraId,
  carCount: number,
): number | null {
  if (cameraId === "front") return carCount > 0 ? 0 : null;
  if (cameraId === "rear") return carCount > 0 ? carCount - 1 : null;
  if (cameraId === "middle")
    return carCount > 0 ? Math.floor((carCount - 1) / 2) : null;
  return null;
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

function resolveSeatPose(
  cameraId: CameraId,
  snapshot: RidePlaybackSnapshot | null | undefined,
): { pos: Vec3; tangent: Vec3; normal: Vec3; binormal: Vec3 } | null {
  if (!snapshot) return null;
  const selId =
    cameraId === "front"
      ? "front"
      : cameraId === "rear"
        ? "rear"
        : cameraId === "middle"
          ? "middle"
          : null;
  if (!selId) return null;
  const selections = snapshot.selections;
  const sel =
    selId === "front"
      ? selections.front
      : selId === "rear"
        ? selections.rear
        : selections.middle;
  if (!sel || !sel.position || !sel.tangent || !sel.normal || !sel.binormal)
    return null;
  return {
    pos: sel.position,
    tangent: sel.tangent,
    normal: sel.normal,
    binormal: sel.binormal,
  };
}

function resolveHeadPose(
  snapshot: RidePlaybackSnapshot | null | undefined,
  data: CompiledTrackData,
  fallbackDistance: number,
): { pos: Vec3; tangent: Vec3; normal: Vec3; binormal: Vec3 } {
  const front = resolveSeatPose("front", snapshot);
  if (front) return front;
  return samplePosition(data, fallbackDistance);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] as Vec3;
}
function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s] as Vec3;
}
function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ] as Vec3;
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
  const snapshot = options.snapshot;
  // Signed speed remains authoritative; validate finite
  const effectiveSpeed = Number.isFinite(speedMps) ? speedMps : 0;
  const fov = clampFovForSpeed(effectiveSpeed);
  let rawPos: Vec3;
  let rawTarget: Vec3;

  const hasAuthoritative =
    snapshot !== null &&
    snapshot !== undefined &&
    snapshot.selections.front.position !== undefined &&
    snapshot.selections.front.tangent !== undefined;

  switch (cameraId) {
    case "front":
    case "middle":
    case "rear": {
      const pose = resolveSeatPose(cameraId, snapshot);
      if (pose) {
        // small rider-eye offset about selected pose frame (not pitch-derived distance)
        const eyeOffset =
          cameraId === "front" ? 0.85 : cameraId === "middle" ? 0.9 : 0.95;
        const forwardBias =
          cameraId === "rear" ? -0.9 : cameraId === "front" ? 0.35 : 0;
        rawPos = add(
          add(pose.pos, scale(pose.normal, eyeOffset)),
          scale(pose.tangent, forwardBias),
        );
        rawTarget = add(pose.pos, scale(pose.tangent, 20));
        break;
      }
      {
        const s = samplePosition(data, distance);
        const eye =
          cameraId === "front" ? 0.85 : cameraId === "middle" ? 0.9 : 0.95;
        const bias =
          cameraId === "rear" ? -0.9 : cameraId === "front" ? 0.35 : 0;
        rawPos = add(add(s.pos, scale(s.normal, eye)), scale(s.tangent, bias));
        rawTarget = add(s.pos, scale(s.tangent, 20));
        break;
      }
    }
    case "chase": {
      const chaseDist = options.chaseDistance ?? 9;
      const chaseHeight = options.chaseHeight ?? 3.2;
      if (hasAuthoritative) {
        const head = resolveHeadPose(snapshot, data, distance);
        // Position behind and above head using authoritative head frame, no spacing reconstruction
        rawPos = add(
          add(head.pos, scale(head.normal, chaseHeight)),
          scale(head.tangent, -chaseDist * 0.55 - 2.5),
        );
        rawTarget = add(head.pos, scale(head.tangent, 6));
        break;
      }
      {
        const s0 = samplePosition(data, distance);
        const sBehind = samplePosition(data, Math.max(0, distance - chaseDist));
        rawPos = add(
          add(sBehind.pos, scale(sBehind.normal, chaseHeight)),
          scale(sBehind.tangent, -2.5),
        );
        rawTarget = add(s0.pos, scale(s0.tangent, 6));
        break;
      }
    }
    case "orbit":
    default: {
      if (hasAuthoritative) {
        const head = resolveHeadPose(snapshot, data, distance);
        const orbitRadius = 32;
        const angle = (distance * 0.03) % (Math.PI * 2);
        const orbitOffset: Vec3 = [
          Math.cos(angle) * orbitRadius,
          14,
          Math.sin(angle) * orbitRadius,
        ] as Vec3;
        rawPos = add(head.pos, orbitOffset);
        rawTarget = add(head.pos, scale(head.normal, 0.6));
        break;
      }
      {
        const s = samplePosition(data, distance);
        const orbitRadius = 32;
        const angle = (distance * 0.03) % (Math.PI * 2);
        const orbitOffset: Vec3 = [
          Math.cos(angle) * orbitRadius,
          14,
          Math.sin(angle) * orbitRadius,
        ] as Vec3;
        rawPos = add(s.pos, orbitOffset);
        rawTarget = add(s.pos, scale(s.normal, 0.6));
        break;
      }
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
