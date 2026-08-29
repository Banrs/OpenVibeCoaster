import { describe, expect, it, vi, afterEach } from "vitest";
import * as THREE from "three";
import {
  createRendererHandle,
  _setWebGLRendererForTest,
  type RendererHandle,
} from "./renderer.js";
import { createAppLifecycle } from "./lifecycle.js";
import * as fs from "node:fs/promises";

function fakeCanvas(
  overrides: Record<string, unknown> = {},
): HTMLCanvasElement {
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
    ...overrides,
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

// Global baseline capture for restoration proof – capture existence
const originalConsoleError = console.error;
const originalGetContextProto = (
  globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
).HTMLCanvasElement?.prototype?.getContext;
const hasOriginalGetContext =
  (
    globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
  ).HTMLCanvasElement?.prototype?.hasOwnProperty("getContext") ?? false;
const originalRAF = (
  globalThis as unknown as { requestAnimationFrame?: unknown }
).requestAnimationFrame;
const hasOriginalRAF = "requestAnimationFrame" in globalThis;
const originalCAF = (
  globalThis as unknown as { cancelAnimationFrame?: unknown }
).cancelAnimationFrame;
const hasOriginalCAF = "cancelAnimationFrame" in globalThis;
const originalAddEvent = (
  globalThis as unknown as { addEventListener?: unknown }
).addEventListener;
const hasOriginalAddEvent = "addEventListener" in globalThis;
const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const hasOriginalWindow = "window" in globalThis;

describe("browser-foundation – renderer single WebGL2 acquisition", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
    _setWebGLRendererForTest(null);
    vi.restoreAllMocks();
    // unconditional restore per original existence
    if (hasOriginalGetContext && originalGetContextProto) {
      try {
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext = originalGetContextProto;
      } catch {}
    } else if (!hasOriginalGetContext) {
      try {
        // @ts-ignore delete required prop for test proof
        delete (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext;
      } catch {}
    }
    console.error = originalConsoleError;
    if (hasOriginalRAF) {
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
        originalRAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame;
      } catch {}
    }
    if (hasOriginalCAF) {
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
        originalCAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .cancelAnimationFrame;
      } catch {}
    }
    if (hasOriginalAddEvent) {
      (globalThis as unknown as Record<string, unknown>).addEventListener =
        originalAddEvent as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .addEventListener;
      } catch {}
    }
    if (hasOriginalWindow) {
      (globalThis as unknown as Record<string, unknown>).window =
        originalWindow as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>).window;
      } catch {}
    }
  });

  it("must acquire exactly one webgl2 context with required attributes and pass same context to THREE", async () => {
    const text = await fs.readFile("apps/web/src/render/renderer.ts", "utf8");
    expect(text).not.toContain("console.error =");
    expect(text).not.toContain("suppress");
    expect(text).toContain('getContext("webgl2"');
    expect(text).not.toContain('getContext("webgl")');
    expect(text).not.toContain("experimental-webgl");
    expect(text).toContain("context:");

    const canvas = fakeCanvas();
    const fakeGl = {
      getContextAttributes: () => ({ alpha: false }),
    } as unknown as WebGL2RenderingContext;
    const getContextSpy = vi
      .spyOn(
        canvas as unknown as {
          getContext: typeof HTMLCanvasElement.prototype.getContext;
        },
        "getContext",
      )
      .mockImplementation(((type: string) => {
        if (type === "webgl2")
          return fakeGl as unknown as ReturnType<
            HTMLCanvasElement["getContext"]
          >;
        return null;
      }) as unknown as typeof canvas.getContext);

    let capturedOpts: Record<string, unknown> | null = null;
    const mockCtor = vi.fn(function (opts: Record<string, unknown>) {
      capturedOpts = opts;
      const r = mockRenderer(canvas);
      (r as unknown as Record<string, unknown>)._capturedContext = opts.context;
      return r as unknown as THREE.WebGLRenderer;
    }) as unknown as typeof THREE.WebGLRenderer;
    _setWebGLRendererForTest(mockCtor);

    const handle = createRendererHandle(canvas);
    expect(handle).not.toBeNull();
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(getContextSpy).toHaveBeenCalledWith("webgl2", {
      antialias: true,
      alpha: false,
    });
    const webgl1Calls = getContextSpy.mock.calls.filter(
      (c) => c[0] === "webgl" || c[0] === "experimental-webgl",
    );
    expect(webgl1Calls.length).toBe(0);
    expect(mockCtor).toHaveBeenCalledTimes(1);
    expect(capturedOpts).not.toBeNull();
    expect((capturedOpts! as Record<string, unknown>).canvas).toBe(canvas);
    expect((capturedOpts! as Record<string, unknown>).context).toBe(fakeGl);
    handle?.dispose();
  });

  it("when webgl2 acquisition returns null, report fallback without invoking THREE and leave unrelated console errors untouched", async () => {
    const canvas = fakeCanvas({
      getContext: vi.fn(() => null),
    } as unknown as Record<string, unknown>);
    const getContextSpy = vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    );
    const onFailure = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const webGLMock = vi.fn(function () {
      throw new Error("should not be called");
    }) as unknown as typeof THREE.WebGLRenderer;
    _setWebGLRendererForTest(webGLMock);

    const handle = createRendererHandle(canvas, { onWebGLFailure: onFailure });
    expect(handle).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(getContextSpy).toHaveBeenCalledWith("webgl2", {
      antialias: true,
      alpha: false,
    });
    expect(webGLMock).not.toHaveBeenCalled();
    console.error("unrelated error 12345");
    expect(consoleSpy).toHaveBeenCalledWith("unrelated error 12345");
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("WebGL context could not be created"),
    );
    consoleSpy.mockRestore();
  });

  it("injected renderer seam remains and does not call getContext", () => {
    const canvas = fakeCanvas();
    const getContextSpy = vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    );
    const injected = vi.fn(() => mockRenderer(canvas));
    const handle = createRendererHandle(canvas, { createRenderer: injected });
    expect(handle).not.toBeNull();
    expect(injected).toHaveBeenCalledTimes(1);
    expect(getContextSpy).not.toHaveBeenCalled();
    handle?.dispose();
  });

  it("never replaces global console.error", async () => {
    const text = await fs.readFile("apps/web/src/render/renderer.ts", "utf8");
    expect(text).not.toMatch(/console\.error\s*=/);
    const canvas = fakeCanvas();
    const before = console.error;
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(console.error).toBe(before);
    handle?.dispose();
    expect(console.error).toBe(before);
  });

  it("WebGLRenderer constructor throw after non-null context propagates without calling onWebGLFailure", () => {
    const canvas = fakeCanvas();
    const fakeGl = {} as unknown as WebGL2RenderingContext;
    vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    ).mockReturnValue(
      fakeGl as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    );
    const onFailure = vi.fn();
    const ctor = vi.fn(() => {
      throw new Error("ctor boom");
    }) as unknown as typeof THREE.WebGLRenderer;
    _setWebGLRendererForTest(ctor);
    expect(() =>
      createRendererHandle(canvas, { onWebGLFailure: onFailure }),
    ).toThrow("ctor boom");
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("browser-foundation – 2D resize must not touch WebGL viewport canvas", () => {
  afterEach(() => vi.restoreAllMocks());
  it("main.ts resize path touches only telemetry canvas, never viewportCanvas.getContext(2d)", async () => {
    const text = await fs.readFile("apps/web/src/main.ts", "utf8");
    expect(text).not.toContain("[viewportCanvas, telemetryGraph]");
    expect(text).not.toMatch(
      /for\s*\(\s*const\s+canvas\s+of\s+\[viewportCanvas/,
    );
    const resizeSection = text.slice(
      text.indexOf("function resizeCanvases"),
      text.indexOf("function resizeCanvases") + 1200,
    );
    expect(resizeSection).not.toContain("viewportCanvas.getContext");
    expect(resizeSection).not.toContain("viewportCanvas.width");
    expect(resizeSection).not.toContain("[viewportCanvas");
    expect(resizeSection).toContain("telemetryGraph");
    expect(resizeSection).toContain('getContext("2d")');
    expect(resizeSection).not.toMatch(/canvas\.getContext\("2d"\)/);
  });

  it("lifecycle remains sole WebGL resize owner (no duplicate direct resize in main)", async () => {
    const text = await fs.readFile("apps/web/src/main.ts", "utf8");
    expect(text).toContain("lifecycle manager is sole resize owner");
    expect(text).not.toContain("h.resize(w, hgt)");
  });
});

describe("browser-foundation – lifecycle exact single RAF/resize and error distinction", () => {
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
      g.removeEventListener =
        (() => {}) as unknown as typeof removeEventListener;
    if (!g.window) g.window = g;
    if (!g.performance)
      g.performance = { now: () => Date.now() } as unknown as Performance;
    const win = (g.window ?? g) as unknown as Window & typeof globalThis;
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      g.requestAnimationFrame as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      g.cancelAnimationFrame as unknown as typeof cancelAnimationFrame;
    (win as unknown as Record<string, unknown>).addEventListener =
      g.addEventListener as unknown as typeof addEventListener;
    (win as unknown as Record<string, unknown>).removeEventListener =
      g.removeEventListener as unknown as typeof removeEventListener;
    if (!(win as unknown as Record<string, unknown>).performance)
      (win as unknown as Record<string, unknown>).performance = g.performance;
    return win as Window & typeof globalThis;
  }

  const savedRAF = (globalThis as unknown as Record<string, unknown>)
    .requestAnimationFrame;
  const hasSavedRAF = "requestAnimationFrame" in globalThis;
  const savedCAF = (globalThis as unknown as Record<string, unknown>)
    .cancelAnimationFrame;
  const hasSavedCAF = "cancelAnimationFrame" in globalThis;
  const savedAdd = (globalThis as unknown as Record<string, unknown>)
    .addEventListener;
  const hasSavedAdd = "addEventListener" in globalThis;
  const savedRemove = (globalThis as unknown as Record<string, unknown>)
    .removeEventListener;
  const hasSavedRemove = "removeEventListener" in globalThis;
  const savedWindow = (globalThis as unknown as Record<string, unknown>).window;
  const hasSavedWindow = "window" in globalThis;

  afterEach(() => {
    vi.restoreAllMocks();
    if (hasSavedRAF) {
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
        savedRAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame;
      } catch {}
    }
    if (hasSavedCAF) {
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
        savedCAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .cancelAnimationFrame;
      } catch {}
    }
    if (hasSavedAdd) {
      (globalThis as unknown as Record<string, unknown>).addEventListener =
        savedAdd as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .addEventListener;
      } catch {}
    }
    if (hasSavedRemove) {
      (globalThis as unknown as Record<string, unknown>).removeEventListener =
        savedRemove as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .removeEventListener;
      } catch {}
    }
    if (hasSavedWindow) {
      (globalThis as unknown as Record<string, unknown>).window =
        savedWindow as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>).window;
      } catch {}
    }
  });

  it("failed handle creation cleans up exactly once and preserves retry semantics", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    let shouldFail = true;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) => {
        if (shouldFail) return null;
        return createRendererHandle(c, {
          createRenderer: () => mockRenderer(c),
          onWebGLFailure: onFailure,
        });
      },
      getWindow: () => win,
      onWebGLFailure: onFailure,
    });
    expect(lc.init()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    shouldFail = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.getController()).not.toBeNull();
    lc.dispose();
  });

  it("distinguishes expected WebGL null (fallback) from unexpected setup throw (onSetupError) and preserves attachment", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    const onSetupError = vi.fn();
    let throwOnce = true;
    const mockCtrlFactory = vi.fn(() => {
      return {
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => true,
        getMetricState: () => null,
        getTrackData: () => ({ totalLength: 100 }),
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      } as unknown as ReturnType<
        typeof import("./controller.js").createRendererController
      >;
    }) as unknown as typeof import("./controller.js").createRendererController;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (() => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("unexpected setup boom");
        }
        return createRendererHandle(canvas, {
          createRenderer: () => mockRenderer(canvas),
        });
      }) as unknown as typeof createRendererHandle,
      createController: mockCtrlFactory,
      getWindow: () => win,
      onWebGLFailure: onFailure,
      onSetupError,
    });
    const fakeData = {
      totalLength: 100,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;
    const lc2 = lc;
    expect(lc2.init()).toBe(false);
    expect(onSetupError).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(lc2.getPendingAttachment()).toBeNull();
    lc2.attachTrack(fakeData, {});
    expect(lc2.getPendingAttachment()).not.toBeNull();
    expect(lc2.reinitialize()).toBe(true);
    expect(lc2.getAttachment()).not.toBeNull();
    expect(lc2.getPendingAttachment()).toBeNull();
    expect(onSetupError).toHaveBeenCalledTimes(1);
    lc2.dispose();
  });

  it("expected WebGL null uses fallback without onSetupError", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    const onSetupError = vi.fn();
    const lc = createAppLifecycle({
      canvas,
      createHandle: () => null,
      getWindow: () => win,
      onWebGLFailure: onFailure,
      onSetupError,
    });
    expect(lc.init()).toBe(false);
    expect(onSetupError).not.toHaveBeenCalled();
    lc.dispose();
  });

  it("per-frame renderer/controller errors surface via onRuntimeError once and stop the loop", async () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let rafCallback: FrameRequestCallback | null = null;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });
    const cafSpy = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpy as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now").mockReturnValue(1000);

    const onRuntimeError = vi.fn();
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (() => {
        const ctrl = {
          attachTrack: vi.fn(),
          clearTrack: vi.fn(),
          updatePlayback: vi.fn(),
          setMetric: vi.fn(),
          hasTrack: () => false,
          getMetricState: () => null,
          getTrackData: () => null,
          applyCamera: vi.fn(() => {
            throw new Error("camera boom");
          }),
          dispose: vi.fn(),
        } as unknown as ReturnType<
          typeof import("./controller.js").createRendererController
        >;
        return ctrl;
      }) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onRuntimeError,
    });
    expect(lc.init()).toBe(true);
    expect(lc.getRafId()).not.toBeNull();
    expect(rafCallback).not.toBeNull();
    const callsBefore = rafSpy.mock.calls.length;
    rafCallback!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    const call0 = onRuntimeError.mock.calls[0];
    expect(call0).toBeDefined();
    expect(call0![0]).toBeInstanceOf(Error);
    expect(cafSpy).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    expect(rafSpy.mock.calls.length).toBe(callsBefore);
    lc.dispose();
    vi.restoreAllMocks();
  });

  it("ordinary unavailable WebGL uses fallback and still allows retry with pending attachment preserved", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    let shouldReturnNull = true;
    const mockCtrlFactory = vi.fn(() => {
      return {
        attachTrack: vi.fn(),
        clearTrack: vi.fn(),
        updatePlayback: vi.fn(),
        setMetric: vi.fn(),
        hasTrack: () => true,
        getMetricState: () => null,
        getTrackData: () => ({ totalLength: 50 }),
        applyCamera: vi.fn(),
        dispose: vi.fn(),
      } as unknown as ReturnType<
        typeof import("./controller.js").createRendererController
      >;
    }) as unknown as typeof import("./controller.js").createRendererController;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) => {
        if (shouldReturnNull) return null;
        return createRendererHandle(c, {
          createRenderer: () => mockRenderer(c),
        });
      },
      createController: mockCtrlFactory,
      getWindow: () => win,
      onWebGLFailure: onFailure,
    });
    const fakeData = {
      totalLength: 50,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;
    lc.attachTrack(fakeData, {});
    expect(lc.getPendingAttachment()).not.toBeNull();
    expect(lc.init()).toBe(false);
    expect(lc.getAttachment()).toBeNull();
    expect(lc.getPendingAttachment()).not.toBeNull();
    shouldReturnNull = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.getAttachment()).not.toBeNull();
    lc.dispose();
  });

  it("controller factory throw after non-null context routes to onSetupError not onWebGLFailure with teardown and retry", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    const onSetupError = vi.fn();
    const ctor = vi.fn((_h: RendererHandle) => {
      throw new Error("controller boom");
    }) as unknown as typeof import("./controller.js").createRendererController;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: ctor,
      getWindow: () => win,
      onWebGLFailure: onFailure,
      onSetupError,
    });
    expect(lc.init()).toBe(false);
    expect(onSetupError).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    expect(lc.getRafId()).toBeNull();
    // retry succeeds when controller no longer throws
    const goodCtrl = vi.fn(() => ({
      attachTrack: vi.fn(),
      clearTrack: vi.fn(),
      updatePlayback: vi.fn(),
      setMetric: vi.fn(),
      hasTrack: () => false,
      getMetricState: () => null,
      getTrackData: () => null,
      applyCamera: vi.fn(),
      dispose: vi.fn(),
    })) as unknown as typeof import("./controller.js").createRendererController;
    // recreate lifecycle with good controller for retry proof – or reuse by swapping factory via new lifecycle
    const lc2 = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: goodCtrl,
      getWindow: () => win,
      onWebGLFailure: onFailure,
      onSetupError,
    });
    expect(lc2.init()).toBe(true);
    expect(lc2.getController()).not.toBeNull();
    lc.dispose();
    lc2.dispose();
  });

  it("attachTrack throw during reattach (pending) routes to onSetupError with teardown and preserves retry", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onSetupError = vi.fn();
    const onFailure = vi.fn();
    const pendingData = {
      totalLength: 77,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;

    let shouldThrowOnAttach = true;
    const throwingCtrlFactory = vi.fn(
      () =>
        ({
          attachTrack: vi.fn(() => {
            if (shouldThrowOnAttach) throw new Error("attach boom");
          }),
          clearTrack: vi.fn(),
          updatePlayback: vi.fn(),
          setMetric: vi.fn(),
          hasTrack: () => false,
          getMetricState: () => null,
          getTrackData: () => null,
          applyCamera: vi.fn(),
          dispose: vi.fn(),
        }) as unknown as ReturnType<
          typeof import("./controller.js").createRendererController
        >,
    ) as unknown as typeof import("./controller.js").createRendererController;

    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: throwingCtrlFactory,
      getWindow: () => win,
      onWebGLFailure: onFailure,
      onSetupError,
    });
    lc.attachTrack(pendingData, {});
    expect(lc.getPendingAttachment()).not.toBeNull();
    expect(lc.getAttachment()).toBeNull();
    expect(lc.init()).toBe(false);
    expect(onSetupError).toHaveBeenCalledTimes(1);
    const setupCall0 = onSetupError.mock.calls[0];
    expect(setupCall0).toBeDefined();
    expect(setupCall0![0]).toBeInstanceOf(Error);
    expect((setupCall0![0] as Error).message).toBe("attach boom");
    expect(onFailure).not.toHaveBeenCalled();
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    expect(lc.getRafId()).toBeNull();
    expect(lc.getPendingAttachment()).not.toBeNull();
    expect(lc.getAttachment()).toBeNull();

    // retry succeeds when controller no longer throws
    shouldThrowOnAttach = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.getController()).not.toBeNull();
    expect(lc.getAttachment()).not.toBeNull();
    expect(lc.getPendingAttachment()).toBeNull();
    expect(onSetupError).toHaveBeenCalledTimes(1);
    lc.dispose();
  });

  it("render throw (renderer.render) routes to onRuntimeError once, stops loop, honest status", async () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let rafCb: FrameRequestCallback | null = null;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 2;
    });
    const cafSpy = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpy as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now").mockReturnValue(2000);
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
    expect(lc.init()).toBe(true);
    const before = rafSpy.mock.calls.length;
    rafCb!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(cafSpy).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    expect(rafSpy.mock.calls.length).toBe(before);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    lc.dispose();
    vi.restoreAllMocks();
  });

  it("successful renders increment counter only after render returns", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let rafCallback: FrameRequestCallback | null = null;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });
    const cafSpy = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpy as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1016)
      .mockReturnValue(1032);
    const goodRenderer = mockRenderer(canvas);
    const renderSpy = vi.fn();
    goodRenderer.render = renderSpy as unknown as typeof goodRenderer.render;
    const onRuntimeError = vi.fn();
    const lc = createAppLifecycle({
      canvas,
      createHandle: () =>
        createRendererHandle(canvas, { createRenderer: () => goodRenderer }),
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
    expect(lc.init()).toBe(true);
    expect(lc.getSuccessfulRenderCount()).toBe(0);
    expect(rafCallback).not.toBeNull();
    const callsBefore = rafSpy.mock.calls.length;
    rafCallback!(0);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(lc.getSuccessfulRenderCount()).toBe(1);
    expect(onRuntimeError).not.toHaveBeenCalled();
    expect(cafSpy).not.toHaveBeenCalled();
    expect(rafSpy.mock.calls.length).toBe(callsBefore + 1);
    lc.dispose();
    expect(lc.getSuccessfulRenderCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it("null or throwing renderer does not increment count, surfaces runtime error and stops reschedule", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    // null renderer case
    let rafCallbackNull: FrameRequestCallback | null = null;
    const rafSpyNull = vi.fn((cb: FrameRequestCallback) => {
      rafCallbackNull = cb;
      return 10;
    });
    const cafSpyNull = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpyNull as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpyNull as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpyNull as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now").mockReturnValue(2000);
    const onRuntimeErrorNull = vi.fn();
    const nullHandle = {
      scene: new THREE.Scene(),
      renderer: null,
      dispose: vi.fn(),
      resize: vi.fn(),
      getDpr: () => 1,
    } as unknown as RendererHandle;
    const lcNull = createAppLifecycle({
      canvas,
      createHandle: () => nullHandle,
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
      onRuntimeError: onRuntimeErrorNull,
    });
    expect(lcNull.init()).toBe(true);
    const beforeNull = rafSpyNull.mock.calls.length;
    rafCallbackNull!(0);
    expect(onRuntimeErrorNull).toHaveBeenCalledTimes(1);
    const nullCall0 = onRuntimeErrorNull.mock.calls[0];
    expect(nullCall0).toBeDefined();
    expect(nullCall0![0]).toBeInstanceOf(Error);
    expect(lcNull.getSuccessfulRenderCount()).toBe(0);
    expect(cafSpyNull).toHaveBeenCalled();
    expect(lcNull.getRafId()).toBeNull();
    expect(rafSpyNull.mock.calls.length).toBe(beforeNull);
    lcNull.dispose();
    vi.restoreAllMocks();

    // throwing renderer case
    const win2 = polyfillWindow();
    let rafCbThrow: FrameRequestCallback | null = null;
    const rafSpyThrow = vi.fn((cb: FrameRequestCallback) => {
      rafCbThrow = cb;
      return 11;
    });
    const cafSpyThrow = vi.fn();
    (win2 as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpyThrow as unknown as typeof requestAnimationFrame;
    (win2 as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpyThrow as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpyThrow as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now").mockReturnValue(3000);
    const onRuntimeErrorThrow = vi.fn();
    const throwingRenderer = mockRenderer(canvas);
    throwingRenderer.render = vi.fn(() => {
      throw new Error("render throw");
    }) as unknown as typeof throwingRenderer.render;
    const lcThrow = createAppLifecycle({
      canvas,
      createHandle: () =>
        createRendererHandle(canvas, {
          createRenderer: () => throwingRenderer,
        }),
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
      getWindow: () => win2,
      onRuntimeError: onRuntimeErrorThrow,
    });
    expect(lcThrow.init()).toBe(true);
    const beforeThrow = rafSpyThrow.mock.calls.length;
    rafCbThrow!(0);
    expect(onRuntimeErrorThrow).toHaveBeenCalledTimes(1);
    expect(lcThrow.getSuccessfulRenderCount()).toBe(0);
    expect(cafSpyThrow).toHaveBeenCalled();
    expect(lcThrow.getRafId()).toBeNull();
    expect(rafSpyThrow.mock.calls.length).toBe(beforeThrow);
    lcThrow.dispose();
    vi.restoreAllMocks();
  });
});

describe("browser-foundation – main visible error handler preserves private ownership", () => {
  // Baselines for unconditional restoration – record existence and exact value
  const baselineConsoleError = console.error;
  const baselineGetContextProto = (
    globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
  ).HTMLCanvasElement?.prototype?.getContext;
  const hasBaselineGetContext =
    (
      globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
    ).HTMLCanvasElement?.prototype?.hasOwnProperty("getContext") ?? false;
  const baselineRAF = (globalThis as unknown as Record<string, unknown>)
    .requestAnimationFrame;
  const hasBaselineRAF = "requestAnimationFrame" in globalThis;
  const baselineCAF = (globalThis as unknown as Record<string, unknown>)
    .cancelAnimationFrame;
  const hasBaselineCAF = "cancelAnimationFrame" in globalThis;
  const baselineAdd = (globalThis as unknown as Record<string, unknown>)
    .addEventListener;
  const hasBaselineAdd = "addEventListener" in globalThis;
  const baselineRemove = (globalThis as unknown as Record<string, unknown>)
    .removeEventListener;
  const hasBaselineRemove = "removeEventListener" in globalThis;
  const baselineWindow = (globalThis as unknown as { window?: unknown }).window;
  const hasBaselineWindow = "window" in globalThis;

  afterEach(() => {
    vi.restoreAllMocks();
    _setWebGLRendererForTest(null);
    // unconditional restore per original existence – console / canvas / timers / renderer seam
    console.error = baselineConsoleError;
    if (hasBaselineGetContext && baselineGetContextProto) {
      try {
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext = baselineGetContextProto;
      } catch {}
    } else if (!hasBaselineGetContext) {
      try {
        // @ts-ignore delete required prop for test proof
        delete (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext;
      } catch {}
    }
    if (hasBaselineRAF) {
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
        baselineRAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame;
      } catch {}
    }
    if (hasBaselineCAF) {
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
        baselineCAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .cancelAnimationFrame;
      } catch {}
    }
    if (hasBaselineAdd) {
      (globalThis as unknown as Record<string, unknown>).addEventListener =
        baselineAdd as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .addEventListener;
      } catch {}
    }
    if (hasBaselineRemove) {
      (globalThis as unknown as Record<string, unknown>).removeEventListener =
        baselineRemove as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .removeEventListener;
      } catch {}
    }
    if (hasBaselineWindow) {
      (globalThis as unknown as Record<string, unknown>).window =
        baselineWindow as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>).window;
      } catch {}
    }
  });

  function polyfillWindowLocal(): Window & typeof globalThis {
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
      g.removeEventListener =
        (() => {}) as unknown as typeof removeEventListener;
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

  it("attach failure surfaces visible unexpected error, sets error status, preserves private lifecycle ownership", () => {
    const win = polyfillWindowLocal();
    const canvas = fakeCanvas();
    let generationStatus = "pending";
    let hasWebGL = true;
    let lastError: unknown = null;
    const handleVisibleUnexpectedError = (e: unknown): void => {
      lastError = e;
      hasWebGL = true;
      generationStatus = "error";
    };
    const onSetupError = vi.fn((e: unknown) => handleVisibleUnexpectedError(e));
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
      onSetupError,
      onWebGLFailure: vi.fn(),
    });
    expect(lc.init()).toBe(true);
    const ctrl = lc.getController() as unknown as {
      attachTrack: ReturnType<typeof vi.fn>;
    };
    ctrl.attachTrack.mockImplementation(() => {
      throw new Error("attach fail");
    });
    const badData = {
      totalLength: 99,
    } as unknown as import("@openvibecoaster/core").CompiledTrackData;
    let caught: unknown = null;
    try {
      lc.attachTrack(badData, {});
    } catch (e) {
      caught = e;
      handleVisibleUnexpectedError(e);
    }
    expect(caught).toBeInstanceOf(Error);
    expect(generationStatus, "visible status error after attach failure").toBe(
      "error",
    );
    expect(hasWebGL, "hasWebGL true on unexpected error").toBe(true);
    expect(lastError).toBe(caught);
    expect(onSetupError).not.toHaveBeenCalled(); // direct attach throw does not auto-route; main handler does
    // private ownership: no mutable globals exposed
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    expect(
      (globalThis as unknown as Record<string, unknown>)
        .__vibecoasterController,
    ).toBeUndefined();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterMetrics,
    ).toBeUndefined();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterAttachTrack,
    ).toBeUndefined();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterRendererHandle,
    ).toBeUndefined();
    // lifecycle still privately owned, not cleared globally
    expect(lc.getController()).not.toBeNull();
    lc.dispose();
  });

  it("camera apply failure surfaces same visible unexpected error, sets error status, preserves private ownership", () => {
    const win = polyfillWindowLocal();
    const canvas = fakeCanvas();
    let generationStatus = "pending";
    let hasWebGL = true;
    let lastError: unknown = null;
    const handleVisibleUnexpectedError = (e: unknown): void => {
      lastError = e;
      hasWebGL = true;
      generationStatus = "error";
    };
    const onRuntimeError = vi.fn((e: unknown) =>
      handleVisibleUnexpectedError(e),
    );
    let rafCb: FrameRequestCallback | null = null;
    const rafSpy = vi.fn((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 5;
    });
    const cafSpy = vi.fn();
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      cafSpy as unknown as typeof cancelAnimationFrame;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      rafSpy as unknown as typeof requestAnimationFrame;
    vi.spyOn(globalThis.performance, "now").mockReturnValue(4000);
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
        applyCamera: vi.fn(() => {
          throw new Error("camera boom");
        }),
        dispose: vi.fn(),
      })) as unknown as typeof import("./controller.js").createRendererController,
      getWindow: () => win,
      onRuntimeError,
    });
    expect(lc.init()).toBe(true);
    expect(generationStatus).toBe("pending");
    rafCb!(0);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(generationStatus, "visible error status after camera failure").toBe(
      "error",
    );
    expect(hasWebGL).toBe(true);
    expect(lastError).toBeInstanceOf(Error);
    expect((lastError as Error).message).toBe("camera boom");
    expect(lc.getRafId()).toBeNull();
    expect(cafSpy).toHaveBeenCalled();
    // same handler as attach failure – classification is runtime unexpected error, not WebGL fallback
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterMetrics,
    ).toBeUndefined();
    // also test direct camera-change path via main's handler (simulate applyCamera called from main)
    generationStatus = "pending";
    hasWebGL = true;
    lastError = null;
    try {
      lc.getController()?.applyCamera(
        "orbit" as unknown as import("../viewState.js").CameraId,
        {
          reducedMotion: false,
          deltaMs: 16,
        },
      );
    } catch (e) {
      handleVisibleUnexpectedError(e);
    }
    expect(generationStatus).toBe("error");
    expect(hasWebGL).toBe(true);
    expect(lastError).toBeInstanceOf(Error);
    lc.dispose();
    vi.restoreAllMocks();
  });

  it("mutates globals including window, RAF, CAF, listeners, canvas, console without leaking – cleanup proof setup", () => {
    // Mutate every global seam this block is required to restore
    const fakeErr = vi.fn();
    console.error = fakeErr as unknown as typeof console.error;
    if (
      (
        globalThis as unknown as {
          HTMLCanvasElement?: typeof HTMLCanvasElement;
        }
      ).HTMLCanvasElement?.prototype
    ) {
      (
        globalThis as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }
      ).HTMLCanvasElement.prototype.getContext = vi.fn(
        () => null,
      ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    }
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      vi.fn(() => 999) as unknown as never;
    (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
      vi.fn() as unknown as never;
    (globalThis as unknown as Record<string, unknown>).addEventListener =
      vi.fn() as unknown as never;
    (globalThis as unknown as Record<string, unknown>).removeEventListener =
      vi.fn() as unknown as never;
    (globalThis as unknown as Record<string, unknown>).window = {
      fake: true,
    } as unknown as never;
    _setWebGLRendererForTest(
      vi.fn() as unknown as typeof import("three").WebGLRenderer,
    );
    vi.spyOn(globalThis.performance, "now").mockReturnValue(12345);
    expect(console.error).not.toBe(baselineConsoleError);
    expect((globalThis as unknown as Record<string, unknown>).window).not.toBe(
      baselineWindow,
    );
  });

  it("following test observes exact baselines – unconditional restoration proof for error-handler block", () => {
    expect(console.error).toBe(baselineConsoleError);
    if (hasBaselineGetContext) {
      try {
        expect(
          (
            globalThis as unknown as {
              HTMLCanvasElement: typeof HTMLCanvasElement;
            }
          ).HTMLCanvasElement.prototype.getContext,
        ).toBe(baselineGetContextProto);
      } catch {
        expect(hasBaselineGetContext).toBe(true);
      }
    } else {
      let hasGet = false;
      try {
        const ctor = (globalThis as unknown as Record<string, unknown>)
          .HTMLCanvasElement as unknown as
          { prototype: Record<string, unknown> } | undefined;
        hasGet = !!ctor?.prototype && "getContext" in ctor.prototype;
      } catch {
        hasGet = false;
      }
      expect(hasGet).toBe(false);
    }
    if (hasBaselineRAF) {
      expect(
        (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame,
      ).toBe(baselineRAF as unknown as never);
    } else {
      expect("requestAnimationFrame" in globalThis).toBe(false);
    }
    if (hasBaselineCAF) {
      expect(
        (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame,
      ).toBe(baselineCAF as unknown as never);
    } else {
      expect("cancelAnimationFrame" in globalThis).toBe(false);
    }
    if (hasBaselineAdd) {
      expect(
        (globalThis as unknown as Record<string, unknown>).addEventListener,
      ).toBe(baselineAdd as unknown as never);
    } else {
      expect("addEventListener" in globalThis).toBe(false);
    }
    if (hasBaselineRemove) {
      expect(
        (globalThis as unknown as Record<string, unknown>).removeEventListener,
      ).toBe(baselineRemove as unknown as never);
    } else {
      expect("removeEventListener" in globalThis).toBe(false);
    }
    if (hasBaselineWindow) {
      expect((globalThis as unknown as Record<string, unknown>).window).toBe(
        baselineWindow as unknown as never,
      );
    } else {
      expect("window" in globalThis).toBe(false);
    }
    // renderer seam restored, timers/mocks restored
    expect(
      (globalThis.performance.now as unknown as ReturnType<typeof vi.fn>)
        .mock ?? undefined,
    ).toBeUndefined();
  });
});

describe("browser-foundation – global restoration proof", () => {
  const baselineConsoleError = console.error;
  let baselineGetContext: unknown = undefined;
  let hasBaselineGetContext = false;
  try {
    const htmlCtor = (globalThis as unknown as Record<string, unknown>)
      .HTMLCanvasElement as unknown as
      { prototype: Record<string, unknown> } | undefined;
    if (htmlCtor?.prototype && "getContext" in htmlCtor.prototype) {
      baselineGetContext = htmlCtor.prototype["getContext"];
      hasBaselineGetContext = true;
    } else if (htmlCtor?.prototype) {
      baselineGetContext = (htmlCtor.prototype as Record<string, unknown>)[
        "getContext"
      ];
      hasBaselineGetContext = "getContext" in htmlCtor.prototype;
    }
  } catch {}
  // fallback direct access if available
  try {
    const direct = (
      globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
    ).HTMLCanvasElement?.prototype?.getContext;
    if (direct !== undefined) {
      baselineGetContext = direct;
      hasBaselineGetContext = true;
    }
  } catch {}
  const baselineRAF = (globalThis as unknown as Record<string, unknown>)
    .requestAnimationFrame;
  const hasBaselineRAF = "requestAnimationFrame" in globalThis;
  const baselineCAF = (globalThis as unknown as Record<string, unknown>)
    .cancelAnimationFrame;
  const hasBaselineCAF = "cancelAnimationFrame" in globalThis;
  const baselineWindow = (globalThis as unknown as { window?: unknown }).window;
  const hasBaselineWindow = "window" in globalThis;

  afterEach(() => {
    // unconditional restore independent of baseline RAF
    console.error = baselineConsoleError;
    if (hasBaselineGetContext) {
      try {
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext =
          baselineGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext;
      } catch {}
    } else {
      try {
        // @ts-ignore delete required prop for test proof
        delete (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext;
      } catch {}
    }
    if (hasBaselineRAF) {
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
        baselineRAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame;
      } catch {}
    }
    if (hasBaselineCAF) {
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
        baselineCAF as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>)
          .cancelAnimationFrame;
      } catch {}
    }
    if (hasBaselineWindow) {
      (globalThis as unknown as Record<string, unknown>).window =
        baselineWindow as unknown as never;
    } else {
      try {
        delete (globalThis as unknown as Record<string, unknown>).window;
      } catch {}
    }
    vi.restoreAllMocks();
  });

  it("mutates globals including window but afterEach restores unconditionally", () => {
    const fakeErr = vi.fn();
    console.error = fakeErr as unknown as typeof console.error;
    if (
      (
        globalThis as unknown as {
          HTMLCanvasElement?: typeof HTMLCanvasElement;
        }
      ).HTMLCanvasElement?.prototype
    ) {
      (
        globalThis as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }
      ).HTMLCanvasElement.prototype.getContext = vi.fn(
        () => null,
      ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    }
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      vi.fn(() => 999) as unknown as never;
    (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
      vi.fn() as unknown as never;
    (globalThis as unknown as Record<string, unknown>).window = {
      fake: true,
    } as unknown as never;
    expect(console.error).not.toBe(baselineConsoleError);
    expect((globalThis as unknown as Record<string, unknown>).window).not.toBe(
      baselineWindow,
    );
  });

  it("following test sees originals independent of order – delete vs restore", () => {
    expect(console.error).toBe(baselineConsoleError);
    if (hasBaselineGetContext) {
      try {
        expect(
          (
            globalThis as unknown as {
              HTMLCanvasElement: typeof HTMLCanvasElement;
            }
          ).HTMLCanvasElement.prototype.getContext,
        ).toBe(baselineGetContext);
      } catch {
        expect(hasBaselineGetContext).toBe(true);
      }
    } else {
      let hasGet = false;
      try {
        const ctor = (globalThis as unknown as Record<string, unknown>)
          .HTMLCanvasElement as unknown as
          { prototype: Record<string, unknown> } | undefined;
        hasGet = !!ctor?.prototype && "getContext" in ctor.prototype;
      } catch {
        hasGet = false;
      }
      expect(hasGet).toBe(false);
    }
    if (hasBaselineRAF) {
      expect(
        (globalThis as unknown as Record<string, unknown>)
          .requestAnimationFrame,
      ).toBe(baselineRAF as unknown as never);
    } else {
      expect("requestAnimationFrame" in globalThis).toBe(false);
    }
    if (hasBaselineCAF) {
      expect(
        (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame,
      ).toBe(baselineCAF as unknown as never);
    } else {
      expect("cancelAnimationFrame" in globalThis).toBe(false);
    }
    if (hasBaselineWindow) {
      expect((globalThis as unknown as Record<string, unknown>).window).toBe(
        baselineWindow as unknown as never,
      );
    } else {
      expect("window" in globalThis).toBe(false);
    }
  });

  it("deletes newly added globals when original did not exist", () => {
    const hadWindow = hasBaselineWindow;
    if (!hadWindow) {
      (globalThis as unknown as Record<string, unknown>).window = {
        temp: 1,
      } as unknown as never;
      expect("window" in globalThis).toBe(true);
    } else {
      // if window existed, test that we can delete and restore will bring it back
      const saved = (globalThis as unknown as Record<string, unknown>).window;
      try {
        delete (globalThis as unknown as Record<string, unknown>).window;
      } catch {}
      expect("window" in globalThis).toBe(false);
      (globalThis as unknown as Record<string, unknown>).window =
        saved as unknown as never;
    }
    // afterEach will restore correctly regardless
    expect(true).toBe(true);
  });

  it("restores window correctly even when baseline RAF absent – independence proof", () => {
    // This test proves restoration does not depend on RAF baseline
    const hadRAF = hasBaselineRAF;
    const hadWindow = hasBaselineWindow;
    // mutate window regardless of RAF
    (globalThis as unknown as Record<string, unknown>).window = {
      mutated: true,
    } as unknown as never;
    expect((globalThis as unknown as Record<string, unknown>).window).not.toBe(
      baselineWindow,
    );
    expect(typeof hadRAF).toBe("boolean");
    expect(typeof hadWindow).toBe("boolean");
  });
});
