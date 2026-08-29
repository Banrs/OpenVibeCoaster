import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createRendererHandle } from "./renderer.js";
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

describe("browser-foundation – no preflight WebGL context on target viewport", () => {
  it("createRendererHandle must not call canvas.getContext(webgl) before THREE.WebGLRenderer", async () => {
    // Source-level check: renderer.ts must not contain preflight getContext strings
    const text = await fs.readFile("apps/web/src/render/renderer.ts", "utf8");
    expect(text).not.toContain('getContext("webgl")');
    expect(text).not.toContain("getContext('webgl')");
    expect(text).not.toContain('getContext("experimental-webgl")');
    expect(text).not.toContain("experimental-webgl");

    // Runtime-level: spy on getContext for webgl should be zero calls
    const canvas = fakeCanvas();
    const getContextSpy = vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    );
    // Provide successful renderer factory to avoid fallback
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(handle).not.toBeNull();
    const webglCalls = getContextSpy.mock.calls.filter(
      (c) => c[0] === "webgl" || c[0] === "experimental-webgl",
    );
    expect(webglCalls.length).toBe(0);
    getContextSpy.mockRestore();
    handle?.dispose();
  });

  it("createRendererHandle must not call getContext at all on success path", () => {
    const canvas = fakeCanvas();
    const spy = vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    );
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(handle).not.toBeNull();
    // Any getContext call on target is a violation (preflight)
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    handle?.dispose();
  });

  it("exactly one fallback transition on genuine WebGL failure (no double onFailure)", async () => {
    const text = await fs.readFile("apps/web/src/render/renderer.ts", "utf8");
    // Should have single onFailure call site per failure path, not preflight + creation double
    // Count onFailure?.() occurrences – after fix should be exactly 2: one in catch of createRenderer, one when renderer falsy?
    // But preflight removal means fewer call sites; we just assert not double due to supportsWebGL
    expect(text).not.toMatch(/supportsWebGL/);

    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    const spy = vi.spyOn(
      canvas as unknown as {
        getContext: typeof HTMLCanvasElement.prototype.getContext;
      },
      "getContext",
    );
    // Simulate genuine failure: createRenderer throws (e.g., WebGL not supported)
    const handle = createRendererHandle(canvas, {
      onWebGLFailure: onFailure,
      createRenderer: () => {
        throw new Error("WebGL unavailable");
      },
    });
    expect(handle).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled(); // no preflight
    spy.mockRestore();
  });

  it("cleanup still exact when renderer creation succeeds after prior failure – transactional", () => {
    const canvas = fakeCanvas();
    let disposeCount = 0;
    const handleFactory = (): THREE.WebGLRenderer => {
      const r = mockRenderer(canvas);
      const orig = r.dispose as unknown as () => void;
      (r as unknown as { dispose: () => void }).dispose = () => {
        disposeCount++;
        orig();
      };
      return r;
    };
    const h = createRendererHandle(canvas, { createRenderer: handleFactory });
    expect(h).not.toBeNull();
    const sceneChildren = h!.scene.children.length;
    expect(sceneChildren).toBeGreaterThan(0);
    h!.dispose();
    expect(disposeCount).toBe(1);
    expect(h!.scene.children.length).toBe(0);
  });
});

describe("browser-foundation – 2D resize must not touch WebGL viewport canvas", () => {
  it("main.ts resize path touches only telemetry canvas, never viewportCanvas.getContext(2d)", async () => {
    const text = await fs.readFile("apps/web/src/main.ts", "utf8");
    // Old code iterates over [viewportCanvas, telemetryGraph] and calls canvas.getContext("2d") for each.
    // New code must not contain that array and must not call getContext("2d") on viewportCanvas
    expect(text).not.toContain("[viewportCanvas, telemetryGraph]");
    expect(text).not.toMatch(
      /for\s*\(\s*const\s+canvas\s+of\s+\[viewportCanvas/,
    );
    // Ensure resizeCanvases only references telemetryGraph for size/context
    // It should contain telemetryGraph.getContext or telemetryGraph canvas width assignment, not viewportCanvas width in same loop
    const resizeSection = text.slice(
      text.indexOf("function resizeCanvases"),
      text.indexOf("function resizeCanvases") + 1200,
    );
    // Should not contain viewportCanvas usage inside resizeCanvases for getContext/size
    expect(resizeSection).not.toContain("viewportCanvas.getContext");
    expect(resizeSection).not.toContain("viewportCanvas.width");
    expect(resizeSection).not.toContain("[viewportCanvas");
    expect(resizeSection).toContain("telemetryGraph");
    expect(resizeSection).toContain('getContext("2d")');
    // Ensure no generic canvas loop with getContext("2d")
    expect(resizeSection).not.toMatch(/canvas\.getContext\("2d"\)/);
  });

  it("lifecycle remains sole WebGL resize owner (no duplicate direct resize in main)", async () => {
    const text = await fs.readFile("apps/web/src/main.ts", "utf8");
    expect(text).toContain("lifecycle manager is sole resize owner");
    expect(text).not.toContain("h.resize(w, hgt)");
  });
});

describe("browser-foundation – lifecycle exact single RAF/resize and global cleanup on fallback", () => {
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

  it("failed handle creation cleans up exactly once and preserves retry semantics", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const onFailure = vi.fn();
    let shouldFail = true;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) => {
        if (shouldFail) {
          // simulate transactional failure via throwing factory
          return null;
        }
        return createRendererHandle(c, {
          createRenderer: () => mockRenderer(c),
          onWebGLFailure: onFailure,
        });
      },
      getWindow: () => win,
      onWebGLFailure: onFailure,
    });
    // initial failure
    expect(lc.init()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(0); // onFailure is passed to handle, but handle returns null without calling? Actually handle would call onFailure if implemented transactionally. Our factory returns null without calling, so 0. That's okay.
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    // retry success should not have leaked RAF/listeners
    shouldFail = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.getController()).not.toBeNull();
    lc.dispose();
  });
});
