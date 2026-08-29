import { describe, expect, it, vi, afterEach } from "vitest";
import * as THREE from "three";
import { createRendererHandle, _setWebGLRendererForTest } from "./renderer.js";
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

// Global baseline capture for restoration proof
const originalConsoleError = console.error;
const originalGetContextProto = (
  globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
).HTMLCanvasElement?.prototype?.getContext;
const originalRAF = (
  globalThis as unknown as { requestAnimationFrame?: unknown }
).requestAnimationFrame;
const originalCAF = (
  globalThis as unknown as { cancelAnimationFrame?: unknown }
).cancelAnimationFrame;
const originalAddEvent = (
  globalThis as unknown as { addEventListener?: unknown }
).addEventListener;

describe("browser-foundation – renderer single WebGL2 acquisition", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
    _setWebGLRendererForTest(null);
    vi.restoreAllMocks();
    if (originalGetContextProto) {
      try {
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext = originalGetContextProto;
      } catch {}
    }
    console.error = originalConsoleError;
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      originalRAF as unknown as never;
    (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
      originalCAF as unknown as never;
    (globalThis as unknown as Record<string, unknown>).addEventListener =
      originalAddEvent as unknown as never;
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
  const savedCAF = (globalThis as unknown as Record<string, unknown>)
    .cancelAnimationFrame;
  const savedAdd = (globalThis as unknown as Record<string, unknown>)
    .addEventListener;
  const savedRemove = (globalThis as unknown as Record<string, unknown>)
    .removeEventListener;

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      savedRAF as unknown as never;
    (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
      savedCAF as unknown as never;
    (globalThis as unknown as Record<string, unknown>).addEventListener =
      savedAdd as unknown as never;
    (globalThis as unknown as Record<string, unknown>).removeEventListener =
      savedRemove as unknown as never;
    if (savedRAF)
      (globalThis as unknown as Record<string, unknown>).window = globalThis;
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
    // onWebGLFailure not called by lifecycle, but handleFactory returning null is expected fallback – lifecycle dispose without calling onSetupError
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
    expect(onRuntimeError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(cafSpy).toHaveBeenCalled();
    expect(lc.getRafId()).toBeNull();
    // loop stopped – no new RAF scheduled after error
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
});

describe("browser-foundation – global restoration proof", () => {
  const baselineConsoleError = console.error;
  const baselineGetContext = (
    globalThis as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }
  ).HTMLCanvasElement?.prototype?.getContext;
  const baselineRAF = (globalThis as unknown as Record<string, unknown>)
    .requestAnimationFrame;
  const baselineCAF = (globalThis as unknown as Record<string, unknown>)
    .cancelAnimationFrame;

  afterEach(() => {
    console.error = baselineConsoleError;
    if (baselineGetContext) {
      try {
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext = baselineGetContext;
      } catch {}
    }
    (globalThis as unknown as Record<string, unknown>).requestAnimationFrame =
      baselineRAF as unknown as never;
    (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame =
      baselineCAF as unknown as never;
    vi.restoreAllMocks();
  });

  it("mutates globals but afterEach restores", () => {
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
    // prove mutated
    expect(console.error).not.toBe(baselineConsoleError);
  });

  it("following test sees originals", () => {
    expect(console.error).toBe(baselineConsoleError);
    if (baselineGetContext) {
      expect(
        (
          globalThis as unknown as {
            HTMLCanvasElement: typeof HTMLCanvasElement;
          }
        ).HTMLCanvasElement.prototype.getContext,
      ).toBe(baselineGetContext);
    }
    expect(
      (globalThis as unknown as Record<string, unknown>).requestAnimationFrame,
    ).toBe(baselineRAF as unknown as never);
    expect(
      (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame,
    ).toBe(baselineCAF as unknown as never);
  });
});
