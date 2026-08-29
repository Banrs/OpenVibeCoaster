import * as THREE from "three";
import type { CompiledTrackData } from "@openvibecoaster/core";
import { buildTrackGeometries } from "./trackGeometry.js";
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
import {
  createHighlightMarker,
  disposeHighlightMarker,
  updateHighlightMarker,
  type HighlightMarker,
} from "./highlight.js";
import type { MetricId, MetricData } from "./metricContract.js";

export type { MetricData } from "./metricContract.js";

let meshCreateSeq = 0;
function emitMeshCreateMeasure(startTime: number, endTime: number): void {
  const dur = endTime - startTime;
  const safe = Number.isFinite(dur) && dur >= 0 ? dur : 0;
  try {
    performance.measure("ovc:mesh-create", {
      start: startTime,
      duration: safe,
    });
    return;
  } catch {
    // ignore
  }
  try {
    performance.measure("ovc:mesh-create", {
      start: startTime,
      end: endTime,
    });
    return;
  } catch {
    // ignore
  }
  const s = `ovc:mesh-create:s:${meshCreateSeq++}:${Math.random().toString(36).slice(2)}`;
  const e = `ovc:mesh-create:e:${meshCreateSeq++}:${Math.random().toString(36).slice(2)}`;
  try {
    performance.mark(s);
    performance.mark(e);
    performance.measure("ovc:mesh-create", { start: s, end: e });
  } catch {
    // ignore
  } finally {
    try {
      performance.clearMarks(s);
    } catch {
      // ignore
    }
    try {
      performance.clearMarks(e);
    } catch {
      // ignore
    }
  }
}

export interface AttachOptions {
  metric?: MetricId | undefined;
  metricData?: MetricData | undefined;
  selectedElementIndex?: number | undefined;
  seamIndices?: number[] | undefined;
  seamInspectionEnabled?: boolean | undefined;
  closedTrack?: boolean | undefined;
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
  setSelectedElement(index: number | null): void;
  setSeamInspection(enabled: boolean, seamIndices?: number[] | undefined): void;
  updateSelection(options: {
    selectedElementIndex?: number | null | undefined;
    seamInspectionEnabled?: boolean | undefined;
    seamIndices?: number[] | undefined;
  }): void;
  setHighlight(distance: number | null): void;
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
  let seamInspectionEnabled: boolean | undefined;
  let closedTrackFlag = false;
  let trainGroup: TrainGroup | null = null;
  let supportMeshes: THREE.Mesh[] = [];
  let trackMeshes: THREE.Mesh[] = [];
  let playbackDistance = 0;
  let playbackSpeed = 0;
  let cameraPrevious: ReturnType<typeof getCameraState> | undefined;
  let lastMetricAvailable: boolean | null = null;
  let highlightMarker: HighlightMarker | null = null;
  let highlightDistance: number | null = null;
  let highlightDisposed = false;

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

  function ensureHighlightMarker(): HighlightMarker | null {
    if (highlightDisposed) return null;
    if (highlightMarker) return highlightMarker;
    try {
      const created = createHighlightMarker();
      handle.scene.add(created.group);
      highlightMarker = created;
      return created;
    } catch {
      return null;
    }
  }

  function refreshHighlight(): void {
    if (!highlightMarker) return;
    updateHighlightMarker(
      highlightMarker,
      trackData,
      highlightDistance,
      closedTrackFlag,
    );
  }

  function getCurrentAttachOptions(): AttachOptions {
    const opts: AttachOptions = {};
    opts.metric = currentMetric;
    if (currentMetricData !== undefined) opts.metricData = currentMetricData;
    if (selectedElementIndex !== undefined)
      opts.selectedElementIndex = selectedElementIndex;
    if (seamIndices !== undefined) opts.seamIndices = seamIndices;
    if (seamInspectionEnabled !== undefined)
      opts.seamInspectionEnabled = seamInspectionEnabled;
    if (closedTrackFlag) opts.closedTrack = true;
    return opts;
  }

  function buildNextOptions(patch: {
    metric?: MetricId | undefined;
    metricData?: MetricData | undefined;
    hasMetricData?: boolean | undefined;
    selectedElementIndex?: number | null | undefined;
    seamInspectionEnabled?: boolean | undefined;
    seamIndices?: number[] | undefined;
    closedTrack?: boolean | undefined;
  }): AttachOptions {
    const base = getCurrentAttachOptions();
    const next: AttachOptions = {};
    if (patch.metric !== undefined) next.metric = patch.metric;
    else if (base.metric !== undefined) next.metric = base.metric;
    if (patch.hasMetricData) {
      if (patch.metricData !== undefined) next.metricData = patch.metricData;
    } else if (base.metricData !== undefined) {
      next.metricData = base.metricData;
    }
    if (patch.selectedElementIndex !== undefined) {
      if (patch.selectedElementIndex !== null)
        next.selectedElementIndex = patch.selectedElementIndex;
    } else if (base.selectedElementIndex !== undefined) {
      next.selectedElementIndex = base.selectedElementIndex;
    }
    if (patch.seamInspectionEnabled !== undefined)
      next.seamInspectionEnabled = patch.seamInspectionEnabled;
    else if (base.seamInspectionEnabled !== undefined)
      next.seamInspectionEnabled = base.seamInspectionEnabled;
    if (patch.seamIndices !== undefined) next.seamIndices = patch.seamIndices;
    else if (base.seamIndices !== undefined)
      next.seamIndices = base.seamIndices;
    if (patch.closedTrack !== undefined) {
      if (patch.closedTrack) next.closedTrack = true;
    } else if (base.closedTrack) {
      next.closedTrack = true;
    }
    return next;
  }

  function rebuildWithOptions(nextOptions: AttachOptions): void {
    if (!trackData) {
      currentMetric = nextOptions.metric ?? "height";
      if (nextOptions.metricData !== undefined)
        currentMetricData = nextOptions.metricData;
      if (nextOptions.selectedElementIndex !== undefined)
        selectedElementIndex = nextOptions.selectedElementIndex;
      else if (!("selectedElementIndex" in nextOptions))
        selectedElementIndex = undefined;
      seamIndices = nextOptions.seamIndices;
      seamInspectionEnabled = nextOptions.seamInspectionEnabled;
      closedTrackFlag = nextOptions.closedTrack ?? false;
      return;
    }
    const data = trackData;
    const savedPlayback = { distance: playbackDistance, speed: playbackSpeed };
    const savedHighlight = highlightDistance;
    const prevOptions = getCurrentAttachOptions();
    const prevClosed = closedTrackFlag;
    const prevMarker = highlightMarker;
    if (prevMarker) {
      try {
        handle.scene.remove(prevMarker.group);
      } catch {
        // ignore
      }
    }
    clearTrackInternal(false);
    if (prevMarker && !highlightDisposed) {
      try {
        handle.scene.add(prevMarker.group);
      } catch {
        // ignore
      }
      highlightMarker = prevMarker;
    }
    try {
      attachTrack(data, nextOptions);
      updatePlayback(savedPlayback.distance, savedPlayback.speed);
      if (savedHighlight !== null) {
        highlightDistance = savedHighlight;
        ensureHighlightMarker();
        refreshHighlight();
      }
    } catch (e) {
      try {
        attachTrack(data, prevOptions);
        updatePlayback(savedPlayback.distance, savedPlayback.speed);
        if (savedHighlight !== null) {
          highlightDistance = savedHighlight;
          ensureHighlightMarker();
          refreshHighlight();
        }
        closedTrackFlag = prevClosed;
      } catch {
        try {
          clearTrackInternal(true);
        } catch {
          // ignore
        }
        highlightDistance = savedHighlight;
      }
      throw e;
    }
  }

  function clearTrackInternal(disposeHighlightIfEmpty: boolean): void {
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
    if (disposeHighlightIfEmpty) {
      if (highlightMarker) {
        updateHighlightMarker(highlightMarker, null, null, closedTrackFlag);
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
    const newSeamEnabled = options.seamInspectionEnabled;
    const newClosed = options.closedTrack ?? false;
    let newPlaybackDistance = playbackDistance;
    let newPlaybackSpeed = playbackSpeed;
    if (options.timeline && options.timeline.distances.length > 0) {
      newPlaybackDistance = options.timeline.distances[0] ?? 0;
      newPlaybackSpeed = options.timeline.speeds[0] ?? 0;
    }
    const ovcMeshStart = globalThis.performance.now();
    try {
      built = buildTrackGeometries(data, {
        metric: newMetric,
        ...(newMetricData !== undefined ? { metricData: newMetricData } : {}),
        ...(newSelected !== undefined
          ? { selectedElementIndex: newSelected }
          : {}),
        ...(newSeams !== undefined ? { seamIndices: newSeams } : {}),
        ...(newSeamEnabled !== undefined
          ? { seamInspectionEnabled: newSeamEnabled }
          : {}),
      });
      newMetricAvailable = built.metricAvailable;
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

      if (trainGroupLocal) {
        const transforms = getCarTransforms(data, newPlaybackDistance);
        updateTrainTransforms(trainGroupLocal, transforms);
      }

      trackData = data;
      currentMetric = newMetric;
      currentMetricData = newMetricData;
      selectedElementIndex = newSelected;
      seamIndices = newSeams;
      seamInspectionEnabled = newSeamEnabled;
      closedTrackFlag = newClosed;
      lastMetricAvailable = newMetricAvailable;
      trackMeshes = trackMeshesLocal;
      supportMeshes = supportMeshesLocal;
      trainGroup = trainGroupLocal;
      playbackDistance = newPlaybackDistance;
      playbackSpeed = newPlaybackSpeed;
      trackMeshesLocal = [];
      supportMeshesLocal = [];
      trainGroupLocal = null;
      if (highlightMarker && highlightDistance !== null) {
        refreshHighlight();
      } else if (highlightMarker) {
        updateHighlightMarker(
          highlightMarker,
          trackData,
          highlightDistance,
          closedTrackFlag,
        );
      }
      const ovcMeshEnd = globalThis.performance.now();
      emitMeshCreateMeasure(ovcMeshStart, ovcMeshEnd);
    } catch (e) {
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
    clearTrackInternal(true);
    if (highlightMarker) {
      updateHighlightMarker(highlightMarker, null, null, closedTrackFlag);
    }
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
    if (highlightMarker && !highlightDisposed) {
      try {
        handle.scene.remove(highlightMarker.group);
      } catch {
        // ignore
      }
      try {
        disposeHighlightMarker(highlightMarker);
      } catch {
        // ignore
      }
      highlightDisposed = true;
      highlightMarker = null;
      highlightDistance = null;
    }
  };

  const setHighlight = (distance: number | null): void => {
    if (distance !== null && !Number.isFinite(distance)) {
      highlightDistance = null;
      if (highlightMarker)
        updateHighlightMarker(
          highlightMarker,
          trackData,
          null,
          closedTrackFlag,
        );
      return;
    }
    highlightDistance = distance;
    if (distance === null) {
      if (highlightMarker)
        updateHighlightMarker(
          highlightMarker,
          trackData,
          null,
          closedTrackFlag,
        );
      return;
    }
    const marker = ensureHighlightMarker();
    if (!marker || !trackData) {
      if (marker) updateHighlightMarker(marker, null, null, closedTrackFlag);
      return;
    }
    updateHighlightMarker(marker, trackData, distance, closedTrackFlag);
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
      const hasData = metricData !== undefined;
      const next = buildNextOptions({
        metric,
        metricData,
        hasMetricData: hasData,
      });
      if (!trackData) {
        currentMetric = metric;
        if (hasData) currentMetricData = metricData;
        return;
      }
      rebuildWithOptions(next);
    },
    setSelectedElement: (index: number | null) => {
      const next = buildNextOptions({ selectedElementIndex: index });
      if (!trackData) {
        if (index === null) selectedElementIndex = undefined;
        else selectedElementIndex = index;
        return;
      }
      rebuildWithOptions(next);
    },
    setSeamInspection: (
      enabled: boolean,
      seamIndicesArg?: number[] | undefined,
    ) => {
      const next = buildNextOptions({
        seamInspectionEnabled: enabled,
        seamIndices: seamIndicesArg,
      });
      if (!trackData) {
        seamInspectionEnabled = enabled;
        if (seamIndicesArg !== undefined) seamIndices = seamIndicesArg;
        return;
      }
      rebuildWithOptions(next);
    },
    updateSelection: (opts: {
      selectedElementIndex?: number | null | undefined;
      seamInspectionEnabled?: boolean | undefined;
      seamIndices?: number[] | undefined;
    }) => {
      const next = buildNextOptions({
        selectedElementIndex: opts.selectedElementIndex,
        seamInspectionEnabled: opts.seamInspectionEnabled,
        seamIndices: opts.seamIndices,
      });
      if (!trackData) {
        if (opts.selectedElementIndex !== undefined) {
          if (opts.selectedElementIndex === null)
            selectedElementIndex = undefined;
          else selectedElementIndex = opts.selectedElementIndex;
        }
        if (opts.seamInspectionEnabled !== undefined)
          seamInspectionEnabled = opts.seamInspectionEnabled;
        if (opts.seamIndices !== undefined) seamIndices = opts.seamIndices;
        return;
      }
      rebuildWithOptions(next);
    },
    setHighlight,
    dispose,
    getScene: () => handle.scene,
    getMetricState: () => {
      if (!trackData || lastMetricAvailable === null) return null;
      return { metric: currentMetric, metricAvailable: lastMetricAvailable };
    },
  };
}
