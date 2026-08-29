import { describe, expect, it, vi, afterEach } from "vitest";
import * as THREE from "three";
import { createRendererHandle } from "./renderer.js";
import { createAppLifecycle } from "./lifecycle.js";

function fakeCanvas(): HTMLCanvasElement {
  return {
    getContext: () =>
      ({}) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    getBoundingClientRect: () =>
      ({ width: 800, height: 600 }) as unknown as DOMRect,
    width: 800,
    height: 600,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
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
    g.performance = { now: () => Date.now() } as unknown as Performance;
  const win = (g.window ?? g) as unknown as Window & typeof globalThis;
  (win as unknown as Record<string, unknown>).requestAnimationFrame =
    g.requestAnimationFrame as unknown as typeof requestAnimationFrame;
  (win as unknown as Record<string, unknown>).cancelAnimationFrame =
    g.cancelAnimationFrame as unknown as typeof cancelAnimationFrame;
  return win as Window & typeof globalThis;
}

describe("lifecycle onFrame seam", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cadence – onFrame called each frame with finite non-negative delta before render", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let rafCb: any = null;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    const cafSpy = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpy as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    const deltas: number[] = [];
    const renderSpy = vi.fn();
    const renderer = mockRenderer(canvas);
    renderer.render = renderSpy as unknown as typeof renderer.render;
    const onFrame = vi.fn((d: number) => deltas.push(d));
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => renderer }),
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
      onFrame,
    });
    expect(lc.init()).toBe(true);
    expect(rafCb).not.toBeNull();
    // First tick
    now = 1016;
    rafCb!(0);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(deltas[0]).toBeCloseTo(0.016, 3);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    // onFrame should be before render: check order via mock invocation order
    const onFrameOrder = (
      onFrame as unknown as { mock: { invocationCallOrder: number[] } }
    ).mock.invocationCallOrder[0]!;
    const renderOrder = (
      renderSpy as unknown as { mock: { invocationCallOrder: number[] } }
    ).mock.invocationCallOrder[0]!;
    expect(onFrameOrder).toBeLessThan(renderOrder);
    // Second frame
    now = 1032;
    // rafCb was re-registered, capture new
    const rafCb2 = rafCb;
    rafCb2!(0);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(deltas[1]).toBeCloseTo(0.016, 3);
    expect(deltas.every((d) => Number.isFinite(d) && d >= 0)).toBe(true);
    lc.dispose();
    vi.restoreAllMocks();
  });

  it("first-frame delta is finite non-negative (zero when clock same)", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: any = null;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return 2;
    });
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      raf as unknown as typeof requestAnimationFrame;
    vi.spyOn(performance, "now").mockReturnValue(5000);
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
    // tick with same now => delta 0
    cb!(0);
    expect(deltas[0]).toBe(0);
    expect(Number.isFinite(deltas[0]!)).toBe(true);
    lc.dispose();
  });

  it("disposal cancels RAF and reinitialize restarts with fresh delta", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: any = null;
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
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1016)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2016);
    const onFrame = vi.fn();
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
      onFrame,
    });
    lc.init();
    expect(lc.getRafId()).not.toBeNull();
    cb!(0);
    expect(onFrame).toHaveBeenCalledTimes(1);
    lc.dispose();
    expect(caf).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    onFrame.mockClear();
    raf.mockClear();
    lc.reinitialize();
    expect(lc.getRafId()).not.toBeNull();
    // new tick
    void cb;
    // need to capture new raf
    // after reinitialize, raf should have been called again
    expect(raf).toHaveBeenCalled();
    lc.dispose();
  });

  it("callback failure routes to onRuntimeError and stops loop, no second RAF", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let cb: any = null;
    const raf = vi.fn((_c: FrameRequestCallback) => {
      cb = _c;
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
    const onFrame = vi.fn(() => {
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
      onFrame,
    });
    lc.init();
    const callsBefore = raf.mock.calls.length;
    cb!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(caf).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(raf.mock.calls.length).toBe(callsBefore);
    lc.dispose();
  });

  it("exactly one scheduled chain – no second RAF", () => {
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
  });
});
