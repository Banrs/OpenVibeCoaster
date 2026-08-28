import * as THREE from "three";
import type { CompiledTrackData } from "../shim/core.js";
import { buildTrackGeometries, type MetricId } from "./trackGeometry.js";
import { buildSupportColumns } from "./supports.js";
import {
  createTrainGroup,
  getCarTransforms,
  updateTrainTransforms,
  type TrainGroup,
} from "./train.js";
import { clampFovForSpeed, getCameraState, type CameraId } from "./cameras.js";
import type { RendererHandle } from "./renderer.js";

export interface MetricData {
  speed?: Float64Array;
  gForce?: Float64Array;
  energy?: Float64Array;
}

export interface AttachOptions {
  metric?: MetricId | undefined;
  metricData?: MetricData | undefined;
  selectedElementIndex?: number | undefined;
  seamIndices?: number[] | undefined;
  timeline?:
    | {
        distances: Float64Array;
        speeds: Float64Array;
      }
    | undefined;
}

export interface RendererController {
  attachTrack(
    data: CompiledTrackData,
    options?: AttachOptions | undefined,
  ): void;
  clearTrack(): void;
  hasTrack(): boolean;
  getTrackData(): CompiledTrackData | null;
  updatePlayback(distance: number, speed: number): void;
  getTrainFrontPosition(): readonly [number, number, number] | null;
  applyCamera(
    cameraId: CameraId,
    options?:
      | { reducedMotion?: boolean | undefined; deltaMs?: number | undefined }
      | undefined,
  ): void;
  setMetric(metric: MetricId, metricData?: MetricData | undefined): void;
  dispose(): void;
  getScene(): THREE.Scene;
}

let activeResizeHandler: (() => void) | null = null;
let activeRafId: number | null = null;

export function teardownRendererLifecycle(): void {
  if (activeResizeHandler) {
    try {
      window.removeEventListener(
        "resize",
        activeResizeHandler as EventListener,
      );
    } catch {
      // ignore
    }
    activeResizeHandler = null;
  }
  if (activeRafId !== null) {
    try {
      cancelAnimationFrame(activeRafId);
    } catch {
      // ignore
    }
    activeRafId = null;
  }
}

export function createRendererController(
  handle: RendererHandle,
  camera: THREE.PerspectiveCamera,
): RendererController {
  // Ensure prior lifecycle is torn down before new controller owns it
  teardownRendererLifecycle();

  let trackData: CompiledTrackData | null = null;
  let currentMetric: MetricId = "height";
  let currentMetricData: MetricData | undefined;
  let selectedElementIndex: number | undefined;
  let seamIndices: number[] | undefined;
  let trainGroup: TrainGroup | null = null;
  let supportMeshes: THREE.Mesh[] = [];
  let trackMeshes: THREE.Mesh[] = [];
  let playbackDistance = 0;
  let playbackSpeed = 0;
  let cameraPrevious: ReturnType<typeof getCameraState> | undefined;

  const onResize = (): void => {
    const canvas = handle.renderer?.domElement as unknown as
      HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect?.width ?? 800));
    const h = Math.max(1, Math.round(rect?.height ?? 600));
    handle.resize(w, h);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };

  activeResizeHandler = onResize;
  try {
    (globalThis as unknown as Window).addEventListener(
      "resize",
      onResize as EventListener,
    );
  } catch {
    // ignore in non-browser test
  }
  onResize();

  const loop = (): void => {
    activeRafId = (globalThis as unknown as Window).requestAnimationFrame(loop);
  };
  try {
    activeRafId = (globalThis as unknown as Window).requestAnimationFrame(loop);
  } catch {
    activeRafId = null;
  }

  const attachTrack = (
    data: CompiledTrackData,
    options: AttachOptions = {},
  ): void => {
    clearTrack();
    trackData = data;
    currentMetric = options.metric ?? "height";
    currentMetricData = options.metricData;
    selectedElementIndex = options.selectedElementIndex;
    seamIndices = options.seamIndices;

    const built = buildTrackGeometries(data, {
      metric: currentMetric,
      ...(currentMetricData !== undefined
        ? { metricData: currentMetricData }
        : {}),
      ...(selectedElementIndex !== undefined ? { selectedElementIndex } : {}),
      ...(seamIndices !== undefined ? { seamIndices } : {}),
    });

    const env = handle.scene.userData.terrainEnv as unknown as
      { raycast?: unknown } | undefined;

    const leftMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.12,
    });
    const rightMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.12,
    });
    const spineMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.08,
    });
    const tiesMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.02,
    });

    const mk = (
      geom: THREE.BufferGeometry,
      mat: THREE.Material,
      name: string,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = name;
      mesh.userData.isTrack = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    const left = mk(built.leftRail, leftMat, "leftRail");
    const right = mk(built.rightRail, rightMat, "rightRail");
    const spine = mk(built.spine, spineMat, "spine");
    const ties = mk(built.ties, tiesMat, "ties");

    trackMeshes = [left, right, spine, ties];
    for (const m of trackMeshes) handle.scene.add(m);

    if (env && typeof (env as { raycast?: unknown }).raycast === "function") {
      const supports = buildSupportColumns(
        data,
        env as unknown as import("../shim/core.js").EnvironmentQuery,
        10,
      );
      supportMeshes = supports.meshes;
      for (const s of supportMeshes) handle.scene.add(s);
    }

    trainGroup = createTrainGroup();
    handle.scene.add(trainGroup.group);
    // initial placement
    updatePlayback(playbackDistance, playbackSpeed);
  };

  const clearTrack = (): void => {
    for (const m of trackMeshes) {
      handle.scene.remove(m);
      try {
        m.geometry.dispose();
      } catch {
        // ignore
      }
      const mat = m.material as THREE.Material | THREE.Material[];
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const mm of mats) {
        try {
          mm.dispose();
        } catch {
          // ignore
        }
      }
    }
    trackMeshes = [];
    for (const s of supportMeshes) {
      handle.scene.remove(s);
      try {
        s.geometry.dispose();
      } catch {
        // ignore
      }
      const mat = s.material as THREE.Material | THREE.Material[];
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const mm of mats) {
        try {
          mm.dispose();
        } catch {
          // ignore
        }
      }
    }
    supportMeshes = [];
    if (trainGroup) {
      handle.scene.remove(trainGroup.group);
      for (const car of trainGroup.cars) {
        for (const child of car.children) {
          const mesh = child as THREE.Mesh;
          try {
            mesh.geometry.dispose();
          } catch {
            // ignore
          }
          const mat = (mesh as unknown as { material?: THREE.Material })
            .material;
          if (mat) {
            try {
              mat.dispose();
            } catch {
              // ignore
            }
          }
        }
      }
      trainGroup = null;
    }
    trackData = null;
    playbackDistance = 0;
    playbackSpeed = 0;
  };

  const updatePlayback = (distance: number, speed: number): void => {
    playbackDistance = distance;
    playbackSpeed = speed;
    if (!trackData || !trainGroup) return;
    const transforms = getCarTransforms(trackData, distance);
    updateTrainTransforms(trainGroup, transforms);
  };

  const applyCamera = (
    cameraId: CameraId,
    options: { reducedMotion?: boolean; deltaMs?: number } = {},
  ): void => {
    const reduced = options.reducedMotion ?? false;
    const deltaMs = options.deltaMs ?? 16;
    if (trackData) {
      const state = getCameraState(
        cameraId,
        trackData,
        playbackDistance,
        playbackSpeed,
        {
          reducedMotion: reduced,
          previous: cameraPrevious,
          deltaMs,
        },
      );
      camera.position.set(
        state.position[0],
        state.position[1],
        state.position[2],
      );
      camera.lookAt(
        new THREE.Vector3(state.target[0], state.target[1], state.target[2]),
      );
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
      cameraPrevious = state;
      return;
    }
    // truthful pending fallback: orbit around terrain center
    const idleAngle = reduced
      ? 0
      : (performance.now() * 0.00007) % (Math.PI * 2);
    const radius = 62;
    const height = 28;
    const target = new THREE.Vector3(0, 0, 0);
    const rawPos = new THREE.Vector3(
      Math.cos(idleAngle) * radius,
      height,
      Math.sin(idleAngle) * radius,
    );
    const damp = reduced ? 0.02 : 0.08;
    if (cameraPrevious) {
      camera.position.lerp(rawPos, damp);
    } else {
      camera.position.copy(rawPos);
    }
    camera.lookAt(target);
    camera.fov = clampFovForSpeed(0);
    camera.updateProjectionMatrix();
    // keep previous for damping parity without fabricating track camera
    cameraPrevious = {
      position: [
        camera.position.x,
        camera.position.y,
        camera.position.z,
      ] as unknown as typeof cameraPrevious extends { position: infer P }
        ? P
        : never,
      target: [
        target.x,
        target.y,
        target.z,
      ] as unknown as typeof cameraPrevious extends { target: infer T }
        ? T
        : never,
      fov: camera.fov,
    };
  };

  const dispose = (): void => {
    clearTrack();
    teardownRendererLifecycle();
  };

  return {
    attachTrack,
    clearTrack,
    hasTrack: () => trackData !== null,
    getTrackData: () => trackData,
    updatePlayback,
    getTrainFrontPosition: () => {
      if (!trackData || !trainGroup) return null;
      const car0 = trainGroup.cars[0];
      if (!car0) return null;
      return [car0.position.x, car0.position.y, car0.position.z] as const;
    },
    applyCamera,
    setMetric: (metric: MetricId, metricData?: MetricData | undefined) => {
      currentMetric = metric;
      currentMetricData = metricData;
      if (trackData) {
        const data = trackData;
        clearTrack();
        attachTrack(data, {
          metric: currentMetric,
          ...(currentMetricData !== undefined
            ? { metricData: currentMetricData }
            : {}),
          ...(selectedElementIndex !== undefined
            ? { selectedElementIndex }
            : {}),
          ...(seamIndices !== undefined ? { seamIndices } : {}),
        });
        updatePlayback(playbackDistance, playbackSpeed);
      }
    },
    dispose,
    getScene: () => handle.scene,
  };
}
