import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { createRendererHandle } from "./renderer.js";
import { createRendererController } from "./controller.js";
import { createAppLifecycle } from "./lifecycle.js";

function makeTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) =>
            vec3(u * 30, 5 + Math.sin(u * Math.PI) * 3, 0),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(30, Math.cos(u * Math.PI) * Math.PI * 3, 0)
              : vec3(0, -Math.sin(u * Math.PI) * Math.PI * Math.PI * 3, 0),
        },
      },
      {
        id: "b",
        span: {
          position: (u: number) => vec3(30 + u * 20, 5, u * 16),
          derivative: (_u: number, order = 1) =>
            order === 1 ? vec3(20, 0, 16) : vec3(0, 0, 0),
        },
      },
    ],
    { samples: 24 },
  );
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    getContext: () =>
      ({}) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    getBoundingClientRect: () =>
      ({ width: 800, height: 600 }) as unknown as DOMRect,
  } as unknown as HTMLCanvasElement;
}
function mockRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  return {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0 },
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    capabilities: {},
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: "",
    info: { render: { calls: 0, triangles: 0 } },
  } as unknown as THREE.WebGLRenderer;
}
function polyfillWindow(): Window & typeof globalThis {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.requestAnimationFrame)
    g.requestAnimationFrame = (() =>
      1) as unknown as typeof requestAnimationFrame;
  if (!g.cancelAnimationFrame)
    g.cancelAnimationFrame =
      (() => {}) as unknown as typeof cancelAnimationFrame;
  if (!g.addEventListener)
    g.addEventListener = (() => {}) as unknown as typeof addEventListener;
  if (!g.removeEventListener)
    g.removeEventListener = (() => {}) as unknown as typeof removeEventListener;
  if (!g.window) g.window = g;
  if (!g.performance)
    g.performance = {
      now: () => Date.now(),
      mark: () => {},
      measure: () => {},
      clearMarks: () => {},
      clearMeasures: () => {},
      getEntriesByName: () => [],
      getEntriesByType: () => [],
    } as unknown as Performance;
  const win = (g.window ?? g) as unknown as Window & typeof globalThis;
  (win as unknown as Record<string, unknown>).requestAnimationFrame =
    g.requestAnimationFrame as unknown as typeof requestAnimationFrame;
  (win as unknown as Record<string, unknown>).cancelAnimationFrame =
    g.cancelAnimationFrame as unknown as typeof cancelAnimationFrame;
  return win as Window & typeof globalThis;
}

describe("perf – ovc:mesh-create User Timing", () => {
  beforeEach(() => {
    performance.clearMeasures();
    try {
      performance.clearMarks();
    } catch {}
  });
  afterEach(() => {
    vi.restoreAllMocks();
    performance.clearMeasures();
    try {
      performance.clearMarks();
    } catch {}
  });

  it("successful attach emits exactly one ovc:mesh-create with finite nonnegative duration", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const measureSpy = vi.spyOn(performance, "measure");
    ctl.attachTrack(data, { metric: "height" });
    const calls = measureSpy.mock.calls.filter(
      (c) => c[0] === "ovc:mesh-create",
    );
    expect(calls.length).toBe(1);
    const entry = performance.getEntriesByName("ovc:mesh-create")[0] as
      PerformanceMeasure | undefined;
    expect(entry).toBeDefined();
    expect(Number.isFinite(entry!.duration)).toBe(true);
    expect(entry!.duration).toBeGreaterThanOrEqual(0);
    // no leaked marks
    const marks = performance.getEntriesByType("mark") as PerformanceMark[];
    const leaked = marks.filter((m) => m.name.startsWith("ovc:mesh-create"));
    expect(leaked.length).toBe(0);
    ctl.dispose();
    handle.dispose();
  });

  it("failed attach emits zero ovc:mesh-create and does not leak marks", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const badData = {
      distances: new Float64Array([0]),
      positions: new Float64Array([0, 0, 0]),
      tangents: new Float64Array([0, 0, 0]),
      normals: new Float64Array([0, 0, 0]),
      binormals: new Float64Array([0, 0, 0]),
      curvature: new Float64Array([0]),
      curvatureVector: new Float64Array([0, 0, 0]),
      bank: new Float64Array([0]),
      bankDerivative: new Float64Array([0]),
      zoneMasks: new Uint32Array([0]),
      zoneNames: [],
      elementIndices: new Uint32Array([0]),
      elementBoundaries: new Uint32Array([0]),
      parameters: new Float64Array([0]),
      totalLength: 0,
      checksum: "bad",
    } as unknown as ReturnType<typeof makeTrack>;
    const measureSpy = vi.spyOn(performance, "measure");
    performance.clearMeasures();
    expect(() => ctl.attachTrack(badData)).toThrow();
    const calls = measureSpy.mock.calls.filter(
      (c) => c[0] === "ovc:mesh-create",
    );
    expect(calls.length).toBe(0);
    expect(performance.getEntriesByName("ovc:mesh-create").length).toBe(0);
    const marks = performance.getEntriesByType("mark") as PerformanceMark[];
    const leaked = marks.filter((m) => m.name.startsWith("ovc:mesh-create"));
    expect(leaked.length).toBe(0);
    ctl.dispose();
    handle.dispose();
  });

  it("reattach after success emits second measure; failed preserve last good", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    performance.clearMeasures();
    ctl.attachTrack(data, { metric: "height" });
    expect(performance.getEntriesByName("ovc:mesh-create").length).toBe(1);
    ctl.setMetric("height");
    expect(performance.getEntriesByName("ovc:mesh-create").length).toBe(2);
    // failing reattach should not add
    const badData = {
      ...data,
      distances: new Float64Array([0]),
      positions: new Float64Array([0, 0, 0]),
      tangents: new Float64Array([0, 0, 0]),
      normals: new Float64Array([0, 0, 0]),
      binormals: new Float64Array([0, 0, 0]),
      curvature: new Float64Array([0]),
      curvatureVector: new Float64Array([0, 0, 0]),
      bank: new Float64Array([0]),
      bankDerivative: new Float64Array([0]),
      zoneMasks: new Uint32Array([0]),
      zoneNames: [],
      elementIndices: new Uint32Array([0]),
      elementBoundaries: new Uint32Array([0]),
      parameters: new Float64Array([0]),
      totalLength: 0,
      checksum: "bad2",
    } as unknown as typeof data;
    expect(() => ctl.attachTrack(badData)).toThrow();
    expect(performance.getEntriesByName("ovc:mesh-create").length).toBe(2);
    ctl.dispose();
    handle.dispose();
  });

  it("does not mutate caller seamIndices array", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const seam = [0, 1, 2];
    const before = [...seam];
    performance.clearMeasures();
    ctl.attachTrack(data, { metric: "height", seamIndices: seam });
    expect(seam).toEqual(before);
    ctl.setSeamInspection(true, seam);
    expect(seam).toEqual(before);
    ctl.dispose();
    handle.dispose();
  });

  it("collision-safe: two rapid attaches produce two distinct measures with finite durations", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    performance.clearMeasures();
    ctl.attachTrack(data, { metric: "height" });
    ctl.attachTrack(data, { metric: "height" });
    const entries = performance.getEntriesByName(
      "ovc:mesh-create",
    ) as PerformanceMeasure[];
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(Number.isFinite(e.duration)).toBe(true);
      expect(e.duration).toBeGreaterThanOrEqual(0);
    }
    const marks = performance.getEntriesByType("mark") as PerformanceMark[];
    expect(marks.filter((m) => m.name.includes("ovc:mesh-create")).length).toBe(
      0,
    );
    ctl.dispose();
    handle.dispose();
  });
});

describe("perf – ovc:frame User Timing", () => {
  beforeEach(() => {
    performance.clearMeasures();
    try {
      performance.clearMarks();
    } catch {}
  });
  afterEach(() => {
    vi.restoreAllMocks();
    performance.clearMeasures();
    try {
      performance.clearMarks();
    } catch {}
  });

  it("frame measures on real successful ticks with finite nonnegative duration, same boundary as render", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let rafCb: FrameRequestCallback | null = null;
    const raf = vi.fn((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onFrame: vi.fn(),
    });
    lc.init();
    expect(rafCb).not.toBeNull();
    const measureSpy = vi.spyOn(performance, "measure");
    now = 1016;
    rafCb!(0);
    const frameCalls = measureSpy.mock.calls.filter(
      (c) => c[0] === "ovc:frame",
    );
    expect(frameCalls.length).toBe(1);
    const entries = performance.getEntriesByName(
      "ovc:frame",
    ) as PerformanceMeasure[];
    expect(entries.length).toBe(1);
    expect(Number.isFinite(entries[0]!.duration)).toBe(true);
    expect(entries[0]!.duration).toBeGreaterThanOrEqual(0);
    // second tick
    now = 1032;
    rafCb!(0);
    const entries2 = performance.getEntriesByName(
      "ovc:frame",
    ) as PerformanceMeasure[];
    expect(entries2.length).toBe(2);
    expect(entries2[1]!.duration).toBeGreaterThanOrEqual(0);
    const marksLeaked = (
      performance.getEntriesByType("mark") as PerformanceMark[]
    ).filter((m) => m.name.startsWith("ovc:frame"));
    expect(marksLeaked.length).toBe(0);
    lc.dispose();
  });

  it("safe when performance.now starts at zero: first delta 0 then real measure", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: FrameRequestCallback | null = null;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return 2;
    });
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(16)
      .mockReturnValueOnce(32);
    const deltas: number[] = [];
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onFrame: (d) => deltas.push(d),
    });
    lc.init();
    performance.clearMeasures();
    cb!(0);
    expect(deltas[0]).toBe(0);
    const e1 = performance.getEntriesByName(
      "ovc:frame",
    ) as PerformanceMeasure[];
    expect(e1.length).toBe(1);
    expect(Number.isFinite(e1[0]!.duration)).toBe(true);
    expect(e1[0]!.duration).toBeGreaterThanOrEqual(0);
    cb!(0);
    expect(deltas[1]).toBeCloseTo(0.016, 3);
    const e2 = performance.getEntriesByName(
      "ovc:frame",
    ) as PerformanceMeasure[];
    expect(e2.length).toBe(2);
    lc.dispose();
  });

  it("exactly one RAF chain – frame measures do not add extra RAF", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const raf = vi.fn((_cb: FrameRequestCallback) => 5 as unknown as number);
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onFrame: vi.fn(),
    });
    lc.init();
    expect(raf).toHaveBeenCalledTimes(1);
    lc.dispose();
    expect(lc.getRafId()).toBeNull();
    // measures should be 0 before any tick
    expect(performance.getEntriesByName("ovc:frame").length).toBe(0);
  });

  it("reset/dispose/reinitialize: measures reset and restart correctly", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: FrameRequestCallback | null = null;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return 3;
    });
    const caf = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      caf as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onFrame: vi.fn(),
    });
    lc.init();
    cb!(0);
    expect(performance.getEntriesByName("ovc:frame").length).toBe(1);
    lc.dispose();
    expect(lc.getRafId()).toBeNull();
    // after dispose, clear measures like fresh
    performance.clearMeasures();
    expect(performance.getEntriesByName("ovc:frame").length).toBe(0);
    raf.mockClear();
    lc.reinitialize();
    expect(raf).toHaveBeenCalledTimes(1);
    cb!(0);
    expect(performance.getEntriesByName("ovc:frame").length).toBe(1);
    lc.dispose();
  });

  it("callback failure does not emit successful frame measure and stops loop", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: FrameRequestCallback | null = null;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return 4;
    });
    const caf = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      caf as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    vi.spyOn(performance, "now").mockReturnValue(3000);
    const onRuntimeError = vi.fn();
    const faulty = vi.fn(() => {
      throw new Error("onFrame boom");
    });
    const renderSpy = vi.fn();
    const renderer = mockRenderer(canvas);
    renderer.render = renderSpy as unknown as typeof renderer.render;
    const lc = createAppLifecycle({
      canvas,
      createHandle: () =>
        createRendererHandle(canvas, { createRenderer: () => renderer }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onRuntimeError,
      onFrame: faulty,
    });
    lc.init();
    const before = raf.mock.calls.length;
    performance.clearMeasures();
    cb!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(caf).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(performance.getEntriesByName("ovc:frame").length).toBe(0);
    expect(raf.mock.calls.length).toBe(before);
    lc.dispose();
  });

  it("render failure keeps stop/error semantics and does not emit successful frame measure", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: FrameRequestCallback | null = null;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return 6;
    });
    const caf = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      caf as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    vi.spyOn(performance, "now").mockReturnValue(5000);
    const onRuntimeError = vi.fn();
    const faultyRenderer = mockRenderer(canvas);
    faultyRenderer.render = vi.fn(() => {
      throw new Error("render boom");
    }) as unknown as typeof faultyRenderer.render;
    const lc = createAppLifecycle({
      canvas,
      createHandle: () =>
        createRendererHandle(canvas, { createRenderer: () => faultyRenderer }),
      createController: (() => ({
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => false,
        getMetricState: () => null,
        getTrackData: () => null,
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onRuntimeError,
    });
    lc.init();
    performance.clearMeasures();
    cb!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(performance.getEntriesByName("ovc:frame").length).toBe(0);
    expect(caf).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    lc.dispose();
  });
});
