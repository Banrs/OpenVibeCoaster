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
  getRafId(): number | null;
  getResizeHandler(): (() => void) | null;
  hasTrack(): boolean;
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
    const handle = handleFactory(config.canvas, {
      dprCap,
      terrainSeed,
      onWebGLFailure: config.onWebGLFailure,
      ...(config.createRenderer
        ? { createRenderer: config.createRenderer }
        : {}),
    });
    if (!handle) {
      clearGlobal();
      return false;
    }
    rendererHandle = handle;
    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
    camera.position.set(0, 28, 52);
    controller = ctrlFactory(handle, camera);
    setGlobal(controller);
    // reattach preserved authoritative attachment if any
    if (attachment) {
      try {
        controller.attachTrack(attachment.data, attachment.options);
        if (lastPlayback) {
          controller.updatePlayback(lastPlayback.distance, lastPlayback.speed);
        }
      } catch {
        // truthfully downgrade – attachment stays for retry but controller has no track
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
  };

  const reinitialize = (): boolean => {
    // alias to init but preserves attachment – init already preserves
    return init();
  };

  const attachTrack = (
    data: CompiledTrackData,
    options: AttachOptions = {},
  ): void => {
    attachment = { data, options: { ...options } };
    if (options.timeline && options.timeline.distances.length > 0) {
      lastPlayback = {
        distance: options.timeline.distances[0] ?? 0,
        speed: options.timeline.speeds[0] ?? 0,
      };
    } else if (lastPlayback === null) {
      // initial playback at 0 if not previously set
      lastPlayback = { distance: 0, speed: 0 };
    }
    // if timeline not supplied but we have a lastPlayback from prior updatePlayback, keep it
    if (controller) {
      controller.attachTrack(data, options);
      if (lastPlayback) {
        controller.updatePlayback(lastPlayback.distance, lastPlayback.speed);
      }
    }
  };

  const clearTrackInternal = (): void => {
    attachment = null;
    lastPlayback = null;
    controller?.clearTrack();
  };

  const updatePlayback = (distance: number, speed: number): void => {
    lastPlayback = { distance, speed };
    controller?.updatePlayback(distance, speed);
  };

  const setMetric = (metric: MetricId, metricData?: MetricData): void => {
    const hasData = metricData !== undefined;
    if (attachment) {
      const prevMetricData = attachment.options.metricData;
      const nextMetricData = hasData ? metricData : prevMetricData;
      attachment.options = {
        ...attachment.options,
        metric,
        ...(nextMetricData !== undefined ? { metricData: nextMetricData } : {}),
      };
      // if hasData is false and prev was undefined, ensure metricData not present
      if (!hasData && prevMetricData === undefined) {
        const { metricData: _omit, ...rest } = attachment.options as Record<
          string,
          unknown
        >;
        attachment.options = rest as AttachOptions;
      }
    }
    // controller.setMetric already preserves playback and metric arrays when omitted
    controller?.setMetric(metric, metricData);
    // lastPlayback unchanged – setMetric preserves it via controller
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
    getRafId: () => rafId,
    getResizeHandler: () => resizeHandler,
    hasTrack: () => controller?.hasTrack() ?? false,
  };
}
