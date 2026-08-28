import * as THREE from "three";
import type { CompiledTrackData } from "@openvibecoaster/core";
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
import type { EnvironmentQuery } from "@openvibecoaster/core";
import { collectFromGroups, disposeSets } from "./dispose.js";

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
  getMetricState(): { metric: MetricId; metricAvailable: boolean } | null;
}

export function createRendererController(
  handle: RendererHandle,
  camera: THREE.PerspectiveCamera,
): RendererController {
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
  let lastMetricAvailable: boolean | null = null;

  function validateTimeline(timeline: {
    distances: Float64Array;
    speeds: Float64Array;
  }): void {
    if (
      !(timeline.distances instanceof Float64Array) ||
      !(timeline.speeds instanceof Float64Array)
    ) {
      throw new TypeError("timeline distances/speeds must be Float64Array");
    }
    if (timeline.distances.length !== timeline.speeds.length) {
      throw new RangeError("timeline distances/speeds length mismatch");
    }
    for (let i = 0; i < timeline.distances.length; i++) {
      const d = timeline.distances[i];
      const s = timeline.speeds[i];
      if (
        d === undefined ||
        s === undefined ||
        !Number.isFinite(d) ||
        !Number.isFinite(s)
      ) {
        throw new RangeError("timeline distances/speeds must be finite");
      }
    }
  }

  const attachTrack = (
    data: CompiledTrackData,
    options: AttachOptions = {},
  ): void => {
    if (options.timeline !== undefined) {
      validateTimeline(options.timeline);
    }
    clearTrack();
    // transactional construction – allocate locally first, commit only after every throwing operation (including updatePlayback) succeeds
    let built: ReturnType<typeof buildTrackGeometries> | null = null;
    let leftGeom: THREE.BufferGeometry | null = null;
    let rightGeom: THREE.BufferGeometry | null = null;
    let spineGeom: THREE.BufferGeometry | null = null;
    let tiesGeom: THREE.BufferGeometry | null = null;
    let leftMat: THREE.Material | null = null;
    let rightMat: THREE.Material | null = null;
    let spineMat: THREE.Material | null = null;
    let tiesMat: THREE.Material | null = null;
    let trackMeshesLocal: THREE.Mesh[] = [];
    let supportMeshesLocal: THREE.Mesh[] = [];
    let trainGroupLocal: TrainGroup | null = null;
    let newMetricAvailable: boolean | null = null;
    const newMetric: MetricId = options.metric ?? "height";
    const newMetricData = options.metricData;
    const newSelected = options.selectedElementIndex;
    const newSeams = options.seamIndices;
    // compute playback targets but do not commit until success
    let newPlaybackDistance = playbackDistance;
    let newPlaybackSpeed = playbackSpeed;
    if (options.timeline && options.timeline.distances.length > 0) {
      newPlaybackDistance = options.timeline.distances[0] ?? 0;
      newPlaybackSpeed = options.timeline.speeds[0] ?? 0;
    }
    try {
      built = buildTrackGeometries(data, {
        metric: newMetric,
        ...(newMetricData !== undefined ? { metricData: newMetricData } : {}),
        ...(newSelected !== undefined
          ? { selectedElementIndex: newSelected }
          : {}),
        ...(newSeams !== undefined ? { seamIndices: newSeams } : {}),
      });
      newMetricAvailable = built.metricAvailable;
      // extract geometries for exact-once ownership tracking
      leftGeom = built.leftRail;
      rightGeom = built.rightRail;
      spineGeom = built.spine;
      tiesGeom = built.ties;
      built = null;

      const env = handle.scene.userData.terrainEnv as unknown as
        { raycast?: unknown } | undefined;

      leftMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.52,
        metalness: 0.12,
      });
      rightMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.52,
        metalness: 0.12,
      });
      spineMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.08,
      });
      tiesMat = new THREE.MeshStandardMaterial({
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

      // create and add track meshes one-by-one, transferring ownership exactly once
      if (!leftGeom || !rightGeom || !spineGeom || !tiesGeom) {
        throw new Error("missing track geometry");
      }
      const left = mk(leftGeom, leftMat, "leftRail");
      leftGeom = null;
      leftMat = null;
      trackMeshesLocal.push(left);
      handle.scene.add(left);

      const right = mk(rightGeom, rightMat, "rightRail");
      rightGeom = null;
      rightMat = null;
      trackMeshesLocal.push(right);
      handle.scene.add(right);

      const spine = mk(spineGeom, spineMat, "spine");
      spineGeom = null;
      spineMat = null;
      trackMeshesLocal.push(spine);
      handle.scene.add(spine);

      const ties = mk(tiesGeom, tiesMat, "ties");
      tiesGeom = null;
      tiesMat = null;
      trackMeshesLocal.push(ties);
      handle.scene.add(ties);

      if (env && typeof (env as { raycast?: unknown }).raycast === "function") {
        const supports = buildSupportColumns(
          data,
          env as unknown as EnvironmentQuery,
          10,
        );
        supportMeshesLocal = supports.meshes;
        for (const s of supportMeshesLocal) handle.scene.add(s);
      }

      trainGroupLocal = createTrainGroup();
      handle.scene.add(trainGroupLocal.group);

      // post-build playback must not have nulled local ownership yet – apply via locals
      if (trainGroupLocal) {
        const transforms = getCarTransforms(data, newPlaybackDistance);
        updateTrainTransforms(trainGroupLocal, transforms);
      }

      // commit only after every throwing operation succeeded
      trackData = data;
      currentMetric = newMetric;
      currentMetricData = newMetricData;
      selectedElementIndex = newSelected;
      seamIndices = newSeams;
      lastMetricAvailable = newMetricAvailable;
      trackMeshes = trackMeshesLocal;
      supportMeshes = supportMeshesLocal;
      trainGroup = trainGroupLocal;
      playbackDistance = newPlaybackDistance;
      playbackSpeed = newPlaybackSpeed;
      // prevent double-dispose in catch
      trackMeshesLocal = [];
      supportMeshesLocal = [];
      trainGroupLocal = null;
    } catch (e) {
      // dispose remaining geometries not yet transferred to meshes (exact once)
      for (const g of [leftGeom, rightGeom, spineGeom, tiesGeom]) {
        if (g) {
          try {
            g.dispose();
          } catch {
            // ignore
          }
        }
      }
      if (built) {
        try {
          built.leftRail.dispose();
        } catch {
          // ignore
        }
        try {
          built.rightRail.dispose();
        } catch {
          // ignore
        }
        try {
          built.spine.dispose();
        } catch {
          // ignore
        }
        try {
          built.ties.dispose();
        } catch {
          // ignore
        }
      }
      for (const mat of [leftMat, rightMat, spineMat, tiesMat]) {
        if (mat) {
          try {
            mat.dispose();
          } catch {
            // ignore
          }
        }
      }
      for (const m of trackMeshesLocal) {
        try {
          handle.scene.remove(m);
        } catch {
          // ignore
        }
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
      for (const s of supportMeshesLocal) {
        try {
          handle.scene.remove(s);
        } catch {
          // ignore
        }
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
      if (trainGroupLocal) {
        try {
          handle.scene.remove(trainGroupLocal.group);
        } catch {
          // ignore
        }
        const geoms = new Set<THREE.BufferGeometry>();
        const mats = new Set<THREE.Material>();
        collectFromGroups(trainGroupLocal.cars, geoms, mats);
        disposeSets(geoms, mats);
      }
      // reset authoritative state truthfully – no usable track
      trackData = null;
      trackMeshes = [];
      supportMeshes = [];
      trainGroup = null;
      lastMetricAvailable = null;
      playbackDistance = 0;
      playbackSpeed = 0;
      throw e;
    }
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
      const geoms = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      collectFromGroups(trainGroup.cars, geoms, mats);
      disposeSets(geoms, mats);
      trainGroup = null;
    }
    trackData = null;
    playbackDistance = 0;
    playbackSpeed = 0;
    lastMetricAvailable = null;
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
      const hasMetricDataArg = metricData !== undefined;
      const metricDataToUse = hasMetricDataArg ? metricData : currentMetricData;
      currentMetric = metric;
      if (hasMetricDataArg) {
        currentMetricData = metricData;
      }
      if (trackData) {
        const savedDistance = playbackDistance;
        const savedSpeed = playbackSpeed;
        const data = trackData;
        const savedSelected = selectedElementIndex;
        const savedSeams = seamIndices;
        clearTrack();
        attachTrack(data, {
          metric: currentMetric,
          ...(metricDataToUse !== undefined
            ? { metricData: metricDataToUse }
            : {}),
          ...(savedSelected !== undefined
            ? { selectedElementIndex: savedSelected }
            : {}),
          ...(savedSeams !== undefined ? { seamIndices: savedSeams } : {}),
        });
        updatePlayback(savedDistance, savedSpeed);
      }
    },
    dispose,
    getScene: () => handle.scene,
    getMetricState: () => {
      if (!trackData || lastMetricAvailable === null) return null;
      return { metric: currentMetric, metricAvailable: lastMetricAvailable };
    },
  };
}
