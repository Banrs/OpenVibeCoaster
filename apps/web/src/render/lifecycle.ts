import * as THREE from "three";
import { createRendererHandle, type RendererHandle } from "./renderer.js";
import {
  createRendererController,
  type AttachOptions,
  type MetricData,
  type RendererController,
} from "./controller.js";
import type { CompiledTrackData } from "@openvibecoaster/core";
import type { MetricId } from "./trackGeometry.js";
import type { CameraId } from "../viewState.js";
import { RenderMetrics } from "./metrics.js";

export interface AttachmentSnapshot {
  data: CompiledTrackData;
  options: AttachOptions;
}

export interface AppLifecycleConfig {
  canvas: HTMLCanvasElement;
  getTerrainSeed?: () => string;
  getDprCap?: () => number;
  createRenderer?: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;
  onWebGLFailure?: () => void;
  createHandle?: typeof createRendererHandle;
  createController?: typeof createRendererController;
  getCameraId?: () => CameraId;
  getReducedMotion?: () => boolean;
  metrics?: RenderMetrics;
  onResize2D?: () => void;
  getWindow?: () => Window & typeof globalThis;
}

export interface AppLifecycle {
  init(): boolean;
  dispose(): void;
  reinitialize(): boolean;
  attachTrack(data: CompiledTrackData, options?: AttachOptions): void;
  clearTrack(): void;
  updatePlayback(distance: number, speed: number): void;
  setMetric(metric: MetricId, metricData?: MetricData): void;
  getController(): RendererController | null;
  getRendererHandle(): RendererHandle | null;
  getCamera(): THREE.PerspectiveCamera | null;
  getAttachment(): AttachmentSnapshot | null;
  getPendingAttachment(): AttachmentSnapshot | null;
  getRafId(): number | null;
  getResizeHandler(): (() => void) | null;
  hasTrack(): boolean;
  getMetricState(): { metric: MetricId; metricAvailable: boolean } | null;
}

function resolveWindow(
  getWindow?: () => Window & typeof globalThis,
): Window & typeof globalThis {
  if (getWindow) {
    try {
      return getWindow();
    } catch {
      // fall through
    }
  }
  const g = globalThis as unknown as { window?: Window & typeof globalThis };
  return (g.window ?? globalThis) as unknown as Window & typeof globalThis;
}

export function createAppLifecycle(config: AppLifecycleConfig): AppLifecycle {
  let rendererHandle: RendererHandle | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controller: RendererController | null = null;
  let rafId: number | null = null;
  let resizeHandler: (() => void) | null = null;
  let attachment: AttachmentSnapshot | null = null;
  let lastPlayback: { distance: number; speed: number } | null = null;
  // pending retry semantics: when no controller exists, attachTrack stores pending
  // and does NOT overwrite last-known-good attachment until a controller successfully builds it
  let pendingAttachment: AttachmentSnapshot | null = null;
  let pendingPlayback: { distance: number; speed: number } | null = null;
  let lastFrameMs = 0;

  const getWin = (): Window & typeof globalThis =>
    resolveWindow(config.getWindow);

  const clearGlobal = (): void => {
    const win = getWin();
    try {
      (win as unknown as Record<string, unknown>).__vibecoasterController =
        undefined;
    } catch {
      // ignore
    }
    try {
      (
        globalThis as unknown as Record<string, unknown>
      ).__vibecoasterController = undefined;
    } catch {
      // ignore
    }
  };

  const setGlobal = (ctrl: RendererController | null): void => {
    const win = getWin();
    try {
      (win as unknown as Record<string, unknown>).__vibecoasterController =
        ctrl ?? undefined;
    } catch {
      // ignore
    }
    try {
      (
        globalThis as unknown as Record<string, unknown>
      ).__vibecoasterController = ctrl ?? undefined;
    } catch {
      // ignore
    }
  };

  const teardownRafAndResize = (): void => {
    const win = getWin();
    if (rafId !== null) {
      try {
        const caf =
          (
            win as unknown as {
              cancelAnimationFrame?: typeof cancelAnimationFrame;
            }
          ).cancelAnimationFrame ??
          (
            globalThis as unknown as {
              cancelAnimationFrame?: typeof cancelAnimationFrame;
            }
          ).cancelAnimationFrame;
        caf?.call(win as unknown as never, rafId as unknown as number);
      } catch {
        // ignore
      }
      rafId = null;
    }
    if (resizeHandler) {
      try {
        win.removeEventListener(
          "resize",
          resizeHandler as unknown as EventListener,
        );
      } catch {
        // ignore
      }
      resizeHandler = null;
    }
  };

  const disposeHandles = (): void => {
    if (controller) {
      try {
        controller.dispose();
      } catch {
        // ignore
      }
      controller = null;
    }
    if (rendererHandle) {
      try {
        rendererHandle.dispose();
      } catch {
        // ignore
      }
      rendererHandle = null;
    }
    camera = null;
  };

  const createHandleAndController = (): boolean => {
    const handleFactory = config.createHandle ?? createRendererHandle;
    const ctrlFactory = config.createController ?? createRendererController;
    const dprCap = config.getDprCap?.() ?? 2;
    const terrainSeed = config.getTerrainSeed?.() ?? "default-terrain";
    let handle: RendererHandle | null = null;
    try {
      handle = handleFactory(config.canvas, {
        dprCap,
        terrainSeed,
        onWebGLFailure: config.onWebGLFailure,
        ...(config.createRenderer
          ? { createRenderer: config.createRenderer }
          : {}),
      });
    } catch {
      // factory threw – ensure no partial resources
      handle = null;
    }
    if (!handle) {
      // transactionally clean up any partial allocation (none yet) and clear globals
      disposeHandles();
      clearGlobal();
      return false;
    }
    // handle succeeded – now try to create camera + controller transactionally
    let localCamera: THREE.PerspectiveCamera | null = null;
    let localController: RendererController | null = null;
    try {
      localCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
      localCamera.position.set(0, 28, 52);
      localController = ctrlFactory(handle, localCamera);
      if (!localController) throw new Error("controller factory returned null");
    } catch {
      // any throw or null – dispose handle and clear references transactionally
      try {
        handle.dispose();
      } catch {
        // ignore
      }
      disposeHandles();
      clearGlobal();
      return false;
    }
    // commit
    rendererHandle = handle;
    camera = localCamera;
    controller = localController;
    setGlobal(controller);
    // reattach authoritative attachment – pending takes precedence, transactional
    const targetAttachment = pendingAttachment ?? attachment;
    const targetPlayback = pendingAttachment ? pendingPlayback : lastPlayback;
    if (targetAttachment) {
      try {
        controller.attachTrack(targetAttachment.data, targetAttachment.options);
        if (targetPlayback) {
          controller.updatePlayback(
            targetPlayback.distance,
            targetPlayback.speed,
          );
        }
      } catch {
        // reattachment failed – clean up new controller/handle/camera transactionally, keep pending/attachment for retry
        disposeHandles();
        clearGlobal();
        return false;
      }
      // success – if pending was used, promote it to last-known-good
      if (pendingAttachment) {
        attachment = pendingAttachment;
        lastPlayback = pendingPlayback;
        pendingAttachment = null;
        pendingPlayback = null;
      }
    }
    return true;
  };

  const registerLifecycle = (): void => {
    const win = getWin();
    const handler = (): void => {
      try {
        config.onResize2D?.();
      } catch {
        // ignore
      }
      if (rendererHandle && camera) {
        try {
          const rect = config.canvas.getBoundingClientRect();
          const w = Math.max(1, Math.round(rect.width));
          const h = Math.max(1, Math.round(rect.height));
          rendererHandle.resize(w, h);
          camera.aspect = w / Math.max(1, h);
          camera.updateProjectionMatrix();
        } catch {
          // ignore
        }
      }
    };
    resizeHandler = handler;
    try {
      win.addEventListener("resize", handler as unknown as EventListener);
    } catch {
      // ignore
    }
    try {
      handler();
    } catch {
      // ignore
    }

    const metrics = config.metrics;
    lastFrameMs = globalThis.performance.now();
    const tick = (): void => {
      if (!rendererHandle || !camera || !controller) {
        rafId = null;
        return;
      }
      const now = globalThis.performance.now();
      const deltaMs = now - lastFrameMs;
      lastFrameMs = now;
      metrics?.beginFrame();
      const camId = config.getCameraId?.() ?? ("orbit" as CameraId);
      const reduced = config.getReducedMotion?.() ?? false;
      try {
        controller.applyCamera(camId, { reducedMotion: reduced, deltaMs });
      } catch {
        // ignore
      }
      try {
        camera.updateProjectionMatrix();
        rendererHandle.renderer?.render(rendererHandle.scene, camera);
      } catch {
        // ignore
      }
      metrics?.endFrame();
      try {
        const info = (
          rendererHandle.renderer as unknown as {
            info?: { render?: { calls?: number; triangles?: number } };
          }
        )?.info;
        if (info?.render && metrics) {
          metrics.recordBuild(
            metrics.meshBuildTimeMs,
            info.render.calls ?? 0,
            info.render.triangles ?? 0,
          );
        }
      } catch {
        // ignore
      }
      const raf =
        (
          win as unknown as {
            requestAnimationFrame?: typeof requestAnimationFrame;
          }
        ).requestAnimationFrame ??
        (
          globalThis as unknown as {
            requestAnimationFrame?: typeof requestAnimationFrame;
          }
        ).requestAnimationFrame;
      if (raf) {
        try {
          rafId = raf.call(
            win as unknown as never,
            tick as unknown as FrameRequestCallback,
          ) as unknown as number;
        } catch {
          rafId = null;
        }
      }
    };
    const raf =
      (
        win as unknown as {
          requestAnimationFrame?: typeof requestAnimationFrame;
        }
      ).requestAnimationFrame ??
      (
        globalThis as unknown as {
          requestAnimationFrame?: typeof requestAnimationFrame;
        }
      ).requestAnimationFrame;
    if (raf) {
      try {
        rafId = raf.call(
          win as unknown as never,
          tick as unknown as FrameRequestCallback,
        ) as unknown as number;
      } catch {
        rafId = null;
      }
    }
  };

  const init = (): boolean => {
    teardownRafAndResize();
    disposeHandles();
    clearGlobal();
    const ok = createHandleAndController();
    if (!ok) {
      // preserve attachment for retry, but ensure no stale global and no listeners beyond teardown
      // do not register RAF/resize when failed – truthful pending/fallback
      return false;
    }
    registerLifecycle();
    return true;
  };

  const dispose = (): void => {
    teardownRafAndResize();
    disposeHandles();
    clearGlobal();
    attachment = null;
    lastPlayback = null;
    pendingAttachment = null;
    pendingPlayback = null;
  };

  const reinitialize = (): boolean => {
    // alias to init but preserves attachment – init already preserves
    return init();
  };

  const validateTimelineSnapshot = (
    timeline: { distances: Float64Array; speeds: Float64Array } | undefined,
  ): void => {
    if (!timeline) return;
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
  };

  const attachTrack = (
    data: CompiledTrackData,
    options: AttachOptions = {},
  ): void => {
    // two-phase: validate and apply through controller first, then commit snapshot
    const snapshot: AttachmentSnapshot = {
      data,
      options: { ...options },
    };
    // Determine next playback snapshot to commit only after success
    let nextPlayback: { distance: number; speed: number } | null = null;
    if (options.timeline && options.timeline.distances.length > 0) {
      nextPlayback = {
        distance: options.timeline.distances[0] ?? 0,
        speed: options.timeline.speeds[0] ?? 0,
      };
    } else if (lastPlayback !== null) {
      nextPlayback = { ...lastPlayback };
    } else {
      nextPlayback = { distance: 0, speed: 0 };
    }

    if (controller) {
      const prevAttachment = attachment
        ? { data: attachment.data, options: { ...attachment.options } }
        : null;
      const prevPlayback = lastPlayback ? { ...lastPlayback } : null;
      try {
        // validate timeline shape early to avoid partial clearTrack side effects
        validateTimelineSnapshot(options.timeline);
        controller.attachTrack(data, options);
        if (nextPlayback) {
          controller.updatePlayback(nextPlayback.distance, nextPlayback.speed);
        }
      } catch (e) {
        // attempt to restore previous last-known-good attachment when feasible
        if (prevAttachment) {
          try {
            controller.attachTrack(prevAttachment.data, prevAttachment.options);
            if (prevPlayback) {
              controller.updatePlayback(
                prevPlayback.distance,
                prevPlayback.speed,
              );
            }
          } catch {
            // restore failed – leave controller in truthfully cleared state
            // ensure controller has no track if restore also failed
            try {
              controller.clearTrack();
            } catch {
              // ignore
            }
          }
        } else {
          // no previous attachment – ensure controller cleared
          try {
            controller.clearTrack();
          } catch {
            // ignore
          }
        }
        throw e;
      }
      // success – commit snapshot and playback
      attachment = snapshot;
      lastPlayback = nextPlayback;
    } else {
      // No controller yet (pending lifecycle) – validate but do NOT overwrite last-known-good
      // Store as pending so prior snapshot is preserved until a controller successfully builds the replacement
      validateTimelineSnapshot(options.timeline);
      pendingAttachment = snapshot;
      pendingPlayback = nextPlayback;
    }
  };

  const clearTrackInternal = (): void => {
    attachment = null;
    lastPlayback = null;
    pendingAttachment = null;
    pendingPlayback = null;
    controller?.clearTrack();
  };

  const updatePlayback = (distance: number, speed: number): void => {
    if (controller) {
      lastPlayback = { distance, speed };
      controller.updatePlayback(distance, speed);
    } else {
      // no controller – update pending playback if pending exists, else lastPlayback for next pending
      if (pendingAttachment) {
        pendingPlayback = { distance, speed };
      } else {
        lastPlayback = { distance, speed };
      }
    }
  };

  const setMetric = (metric: MetricId, metricData?: MetricData): void => {
    const hasData = metricData !== undefined;
    // lifecycle snapshot update is two-phase with controller success
    const prevAttachment = attachment
      ? { data: attachment.data, options: { ...attachment.options } }
      : null;
    if (attachment) {
      const prevMetricData = attachment.options.metricData;
      const nextMetricData = hasData ? metricData : prevMetricData;
      const nextOptions: AttachOptions = {
        ...attachment.options,
        metric,
        ...(nextMetricData !== undefined ? { metricData: nextMetricData } : {}),
      };
      // store tentative next snapshot for commit after controller success
      // do not mutate attachment yet – wait for controller.setMetric success
      const tentativeAttachment: AttachmentSnapshot = {
        data: attachment.data,
        options: nextOptions,
      };
      if (!hasData && prevMetricData === undefined) {
        const { metricData: _omit2, ...rest2 } =
          nextOptions as unknown as Record<string, unknown>;
        tentativeAttachment.options = rest2 as AttachOptions;
      }
      try {
        controller?.setMetric(metric, metricData);
      } catch (e) {
        // restore previous attachment snapshot if controller failed
        if (prevAttachment) {
          attachment = prevAttachment;
        }
        throw e;
      }
      // success – commit tentative
      attachment = tentativeAttachment;
      // if metricData was omitted and previous was undefined, ensure omitted
      if (!hasData && prevMetricData === undefined) {
        const { metricData: _omit3, ...rest3 } =
          attachment.options as unknown as Record<string, unknown>;
        attachment.options = rest3 as AttachOptions;
      }
      // controller.setMetric already preserves playback
      return;
    }
    // no attachment – just delegate
    controller?.setMetric(metric, metricData);
  };

  return {
    init,
    dispose,
    reinitialize,
    attachTrack,
    clearTrack: clearTrackInternal,
    updatePlayback,
    setMetric,
    getController: () => controller,
    getRendererHandle: () => rendererHandle,
    getCamera: () => camera,
    getAttachment: () =>
      attachment
        ? { data: attachment.data, options: { ...attachment.options } }
        : null,
    getPendingAttachment: () =>
      pendingAttachment
        ? {
            data: pendingAttachment.data,
            options: { ...pendingAttachment.options },
          }
        : null,
    getRafId: () => rafId,
    getResizeHandler: () => resizeHandler,
    hasTrack: () => controller?.hasTrack() ?? false,
    getMetricState: () => controller?.getMetricState() ?? null,
  };
}
