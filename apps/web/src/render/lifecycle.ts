import * as THREE from "three";
import { createRendererHandle, type RendererHandle } from "./renderer.js";
import {
  createRendererController,
  type AttachOptions,
  type MetricData,
  type RendererController,
} from "./controller.js";
import type { CompiledTrackData } from "@openvibecoaster/core";
import type { MetricId } from "./metricContract.js";
import type { CameraId } from "../viewState.js";
import { RenderMetrics } from "./metrics.js";
import { recordMeasure } from "./userTiming.js";

export interface AttachmentSnapshot {
  data: CompiledTrackData;
  options: AttachOptions;
}

export interface AppLifecycleConfig {
  canvas: HTMLCanvasElement;
  getTerrainSeed?: () => string;
  getTerrainProfileId?: () => string | undefined;
  terrainProfileId?: string | undefined;
  getDprCap?: () => number;
  createRenderer?: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;
  onWebGLFailure?: () => void;
  onSetupError?: (error: unknown) => void;
  onRuntimeError?: (error: unknown) => void;
  createHandle?: typeof createRendererHandle;
  createController?: typeof createRendererController;
  getCameraId?: () => CameraId;
  getReducedMotion?: () => boolean;
  metrics?: RenderMetrics;
  onResize2D?: () => void;
  getWindow?: () => Window & typeof globalThis;
  onFrame?: (deltaSeconds: number) => void;
}

export interface AppLifecycle {
  init(): boolean;
  dispose(): void;
  reinitialize(): boolean;
  attachTrack(data: CompiledTrackData, options?: AttachOptions): void;
  clearTrack(): void;
  updatePlayback(distance: number, speed: number): void;
  setMetric(metric: MetricId, metricData?: MetricData): void;
  setHighlight(distance: number | null): void;
  updateSelection(options: {
    selectedElementIndex?: number | null | undefined;
    seamInspectionEnabled?: boolean | undefined;
    seamIndices?: number[] | undefined;
  }): void;
  setSelectedElement(index: number | null): void;
  setSeamInspection(enabled: boolean, seamIndices?: number[] | undefined): void;
  getController(): RendererController | null;
  getRendererHandle(): RendererHandle | null;
  getCamera(): THREE.PerspectiveCamera | null;
  getAttachment(): AttachmentSnapshot | null;
  getPendingAttachment(): AttachmentSnapshot | null;
  getRafId(): number | null;
  getResizeHandler(): (() => void) | null;
  hasTrack(): boolean;
  getMetricState(): { metric: MetricId; metricAvailable: boolean } | null;
  getSuccessfulRenderCount(): number;
  isRendererReady(): boolean;
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

function mergeSelectionIntoOptions(
  base: AttachOptions,
  updates: {
    selectedElementIndex?: number | null | undefined;
    seamInspectionEnabled?: boolean | undefined;
    seamIndices?: number[] | undefined;
  },
): AttachOptions {
  const next: AttachOptions = {};
  if (base.metric !== undefined) next.metric = base.metric;
  if (base.metricData !== undefined) next.metricData = base.metricData;
  if (base.closedTrack !== undefined) next.closedTrack = base.closedTrack;
  if (base.timeline !== undefined) next.timeline = base.timeline;
  if (updates.selectedElementIndex !== undefined) {
    if (updates.selectedElementIndex !== null)
      next.selectedElementIndex = updates.selectedElementIndex;
  } else if (base.selectedElementIndex !== undefined) {
    next.selectedElementIndex = base.selectedElementIndex;
  }
  if (updates.seamInspectionEnabled !== undefined)
    next.seamInspectionEnabled = updates.seamInspectionEnabled;
  else if (base.seamInspectionEnabled !== undefined)
    next.seamInspectionEnabled = base.seamInspectionEnabled;
  if (updates.seamIndices !== undefined) next.seamIndices = updates.seamIndices;
  else if (base.seamIndices !== undefined) next.seamIndices = base.seamIndices;
  return next;
}

function mergeMetricIntoOptions(
  base: AttachOptions,
  metric: MetricId,
  metricData: MetricData | undefined,
  hasData: boolean,
): AttachOptions {
  const next: AttachOptions = {};
  next.metric = metric;
  if (hasData) {
    if (metricData !== undefined) next.metricData = metricData;
    else if (base.metricData !== undefined) next.metricData = base.metricData;
  } else if (base.metricData !== undefined) {
    next.metricData = base.metricData;
  }
  if (base.selectedElementIndex !== undefined)
    next.selectedElementIndex = base.selectedElementIndex;
  if (base.seamIndices !== undefined) next.seamIndices = base.seamIndices;
  if (base.seamInspectionEnabled !== undefined)
    next.seamInspectionEnabled = base.seamInspectionEnabled;
  if (base.closedTrack !== undefined) next.closedTrack = base.closedTrack;
  if (base.timeline !== undefined) next.timeline = base.timeline;
  return next;
}

export function createAppLifecycle(config: AppLifecycleConfig): AppLifecycle {
  let rendererHandle: RendererHandle | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controller: RendererController | null = null;
  let rafId: number | null = null;
  let resizeHandler: (() => void) | null = null;
  let attachment: AttachmentSnapshot | null = null;
  let lastPlayback: { distance: number; speed: number } | null = null;
  let pendingAttachment: AttachmentSnapshot | null = null;
  let pendingPlayback: { distance: number; speed: number } | null = null;
  let pendingHighlight: number | null | undefined = undefined;
  let storedHighlight: number | null | undefined = undefined;
  let lastFrameMs = 0;
  let hasLastFrame = false;
  let successfulRenderCount = 0;

  const getWin = (): Window & typeof globalThis =>
    resolveWindow(config.getWindow);

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
    const terrainProfileId =
      config.getTerrainProfileId?.() ??
      config.terrainProfileId ??
      "rolling-highlands-v1";
    let handle: RendererHandle | null = null;
    try {
      handle = handleFactory(config.canvas, {
        dprCap,
        terrainSeed,
        terrainProfileId,
        onWebGLFailure: config.onWebGLFailure,
        ...(config.createRenderer
          ? { createRenderer: config.createRenderer }
          : {}),
      });
    } catch (e) {
      config.onSetupError?.(e);
      disposeHandles();
      return false;
    }
    if (!handle) {
      disposeHandles();
      return false;
    }
    let localCamera: THREE.PerspectiveCamera | null = null;
    let localController: RendererController | null = null;
    try {
      localCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
      localCamera.position.set(0, 28, 52);
      localController = ctrlFactory(handle, localCamera);
      if (!localController) throw new Error("controller factory returned null");
    } catch (e) {
      config.onSetupError?.(e);
      try {
        handle.dispose();
      } catch {
        // ignore
      }
      disposeHandles();
      return false;
    }
    rendererHandle = handle;
    camera = localCamera;
    controller = localController;
    const targetAttachment = pendingAttachment ?? attachment;
    const targetPlayback = pendingAttachment ? pendingPlayback : lastPlayback;
    const highlightToApply =
      pendingHighlight !== undefined ? pendingHighlight : storedHighlight;
    if (targetAttachment) {
      try {
        controller.attachTrack(targetAttachment.data, targetAttachment.options);
        if (targetPlayback) {
          controller.updatePlayback(
            targetPlayback.distance,
            targetPlayback.speed,
          );
        }
        if (highlightToApply !== undefined) {
          controller.setHighlight(highlightToApply);
        }
      } catch (e) {
        config.onSetupError?.(e);
        disposeHandles();
        return false;
      }
      if (pendingAttachment) {
        attachment = pendingAttachment;
        lastPlayback = pendingPlayback;
        pendingAttachment = null;
        pendingPlayback = null;
      }
      if (pendingHighlight !== undefined) {
        storedHighlight = pendingHighlight;
        pendingHighlight = undefined;
      }
    } else if (highlightToApply !== undefined && controller) {
      try {
        controller.setHighlight(highlightToApply);
        if (pendingHighlight !== undefined) {
          storedHighlight = pendingHighlight;
          pendingHighlight = undefined;
        }
      } catch {
        // ignore
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
    hasLastFrame = false;
    lastFrameMs = 0;
    const tick = (): void => {
      if (!rendererHandle || !camera || !controller) {
        rafId = null;
        return;
      }
      const frameStart = globalThis.performance.now();
      const now = frameStart;
      const deltaMs = hasLastFrame ? now - lastFrameMs : 0;
      hasLastFrame = true;
      lastFrameMs = now;
      metrics?.beginFrame();
      // onFrame seam – finite non-negative delta, before render, single RAF
      const rawDeltaSeconds = deltaMs / 1000;
      const deltaSeconds =
        Number.isFinite(rawDeltaSeconds) && rawDeltaSeconds >= 0
          ? rawDeltaSeconds
          : 0;
      if (config.onFrame) {
        try {
          config.onFrame(deltaSeconds);
        } catch (e) {
          config.onRuntimeError?.(e);
          metrics?.endFrame();
          teardownRafAndResize();
          return;
        }
      }
      const camId = config.getCameraId?.() ?? ("orbit" as CameraId);
      const reduced = config.getReducedMotion?.() ?? false;
      let runtimeError: unknown = null;
      try {
        controller.applyCamera(camId, { reducedMotion: reduced, deltaMs });
      } catch (e) {
        runtimeError = e;
      }
      if (runtimeError === null) {
        try {
          camera.updateProjectionMatrix();
          const r = rendererHandle.renderer;
          if (!r) throw new Error("renderer missing");
          r.render(rendererHandle.scene, camera);
        } catch (e) {
          runtimeError = e;
        }
      }
      if (runtimeError !== null) {
        config.onRuntimeError?.(runtimeError);
        metrics?.endFrame();
        teardownRafAndResize();
        return;
      }
      successfulRenderCount++;
      metrics?.endFrame();
      const frameEnd = globalThis.performance.now();
      recordMeasure("ovc:frame", frameStart, frameEnd);
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
    successfulRenderCount = 0;
    const ok = createHandleAndController();
    if (!ok) {
      return false;
    }
    registerLifecycle();
    return true;
  };

  const dispose = (): void => {
    teardownRafAndResize();
    disposeHandles();
    successfulRenderCount = 0;
    hasLastFrame = false;
    lastFrameMs = 0;
    attachment = null;
    lastPlayback = null;
    pendingAttachment = null;
    pendingPlayback = null;
    pendingHighlight = undefined;
    storedHighlight = undefined;
  };

  const reinitialize = (): boolean => {
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
    const snapshot: AttachmentSnapshot = {
      data,
      options: { ...options },
    };
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
        validateTimelineSnapshot(options.timeline);
        controller.attachTrack(data, options);
        if (nextPlayback) {
          controller.updatePlayback(nextPlayback.distance, nextPlayback.speed);
        }
      } catch (e) {
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
            try {
              controller.clearTrack();
            } catch {
              // ignore
            }
          }
        } else {
          try {
            controller.clearTrack();
          } catch {
            // ignore
          }
        }
        throw e;
      }
      attachment = snapshot;
      lastPlayback = nextPlayback;
    } else {
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
    pendingHighlight = undefined;
    storedHighlight = undefined;
    controller?.clearTrack();
    try {
      controller?.setHighlight(null);
    } catch {
      // ignore
    }
  };

  const updatePlayback = (distance: number, speed: number): void => {
    if (controller) {
      lastPlayback = { distance, speed };
      controller.updatePlayback(distance, speed);
    } else {
      if (pendingAttachment) {
        pendingPlayback = { distance, speed };
      } else {
        lastPlayback = { distance, speed };
      }
    }
  };

  const setMetric = (metric: MetricId, metricData?: MetricData): void => {
    const hasData = metricData !== undefined;
    if (attachment) {
      const prevAttachment = {
        data: attachment.data,
        options: { ...attachment.options },
      };
      const prevPlayback = lastPlayback ? { ...lastPlayback } : null;
      const nextOptions = mergeMetricIntoOptions(
        attachment.options,
        metric,
        metricData,
        hasData,
      );
      const tentative: AttachmentSnapshot = {
        data: attachment.data,
        options: nextOptions,
      };
      try {
        controller?.setMetric(metric, metricData);
      } catch (e) {
        if (controller?.hasTrack()) {
          attachment = prevAttachment;
          lastPlayback = prevPlayback;
        } else if (controller) {
          attachment = null;
          lastPlayback = null;
        } else {
          attachment = prevAttachment;
          lastPlayback = prevPlayback;
        }
        throw e;
      }
      attachment = tentative;
      return;
    }
    if (pendingAttachment) {
      pendingAttachment = {
        data: pendingAttachment.data,
        options: mergeMetricIntoOptions(
          pendingAttachment.options,
          metric,
          metricData,
          hasData,
        ),
      };
      return;
    }
    controller?.setMetric(metric, metricData);
  };

  const setHighlight = (distance: number | null): void => {
    if (distance !== null && !Number.isFinite(distance)) {
      distance = null;
    }
    storedHighlight = distance;
    if (controller) {
      controller.setHighlight(distance);
      pendingHighlight = undefined;
    } else {
      pendingHighlight = distance;
    }
  };

  const updateSelection = (options: {
    selectedElementIndex?: number | null | undefined;
    seamInspectionEnabled?: boolean | undefined;
    seamIndices?: number[] | undefined;
  }): void => {
    if (controller && attachment) {
      const prevAttachment = {
        data: attachment.data,
        options: { ...attachment.options },
      };
      const prevPlayback = lastPlayback ? { ...lastPlayback } : null;
      const nextOptions = mergeSelectionIntoOptions(
        attachment.options,
        options,
      );
      const tentative: AttachmentSnapshot = {
        data: attachment.data,
        options: nextOptions,
      };
      try {
        controller.updateSelection(options);
      } catch (e) {
        if (controller?.hasTrack()) {
          attachment = prevAttachment;
          lastPlayback = prevPlayback;
        } else {
          attachment = null;
          lastPlayback = null;
        }
        throw e;
      }
      attachment = tentative;
      return;
    }
    if (attachment) {
      attachment = {
        data: attachment.data,
        options: mergeSelectionIntoOptions(attachment.options, options),
      };
      return;
    }
    if (pendingAttachment) {
      pendingAttachment = {
        data: pendingAttachment.data,
        options: mergeSelectionIntoOptions(pendingAttachment.options, options),
      };
      return;
    }
    controller?.updateSelection(options);
  };

  const setSelectedElement = (index: number | null): void => {
    updateSelection({ selectedElementIndex: index });
  };

  const setSeamInspection = (
    enabled: boolean,
    seamIndicesArg?: number[] | undefined,
  ): void => {
    updateSelection({
      seamInspectionEnabled: enabled,
      ...(seamIndicesArg !== undefined ? { seamIndices: seamIndicesArg } : {}),
    });
  };

  return {
    init,
    dispose,
    reinitialize,
    attachTrack,
    clearTrack: clearTrackInternal,
    updatePlayback,
    setMetric,
    setHighlight,
    updateSelection,
    setSelectedElement,
    setSeamInspection,
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
    getSuccessfulRenderCount: () => successfulRenderCount,
    isRendererReady: () => rendererHandle !== null && controller !== null,
  };
}
