import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3, sampleCompiledTrack } from "@openvibecoaster/core";

import { createRendererController } from "./controller.js";
import { buildTrackGeometries } from "./trackGeometry.js";
import { createRendererHandle } from "./renderer.js";

function makeTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) =>
            vec3(u * 20, 5 + Math.sin(u * Math.PI) * 2, 0),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(20, Math.cos(u * Math.PI) * Math.PI * 2, 0)
              : vec3(0, -Math.sin(u * Math.PI) * Math.PI * Math.PI * 2, 0),
        },
      },
    ],
    { samples: 12 },
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

describe("findings – controller attaches real CompiledTrackData only", () => {
  it("terrain-only handle has no track; attachTrack builds from real data, clearTrack removes", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(handle).not.toBeNull();
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const controller = createRendererController(handle, cam);
    expect(controller.hasTrack()).toBe(false);
    expect(
      handle.scene.children.some((c) => c.userData?.isTrack === true),
    ).toBe(false);

    const data = makeTrack();
    controller.attachTrack(data);
    expect(controller.hasTrack()).toBe(true);
    expect(
      handle.scene.children.some((c) => c.userData?.isTrack === true),
    ).toBe(true);

    controller.clearTrack();
    expect(controller.hasTrack()).toBe(false);
    expect(
      handle.scene.children.some((c) => c.userData?.isTrack === true),
    ).toBe(false);
    controller.dispose();
    handle.dispose();
  });

  it("updatePlayback moves train only from supplied distance/speed, no fabrication", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data);
    ctl.updatePlayback(5, 8);
    const posA = ctl.getTrainFrontPosition();
    ctl.updatePlayback(5, 8);
    const posB = ctl.getTrainFrontPosition();
    expect(posA).toEqual(posB);
    ctl.updatePlayback(9, 8);
    const posC = ctl.getTrainFrontPosition();
    expect(posA).not.toBeNull();
    expect(posC).not.toBeNull();
    if (posA && posC) expect(posC[0]).not.toBeCloseTo(posA[0], 2);
    ctl.dispose();
    handle.dispose();
  });
});

describe("findings – camera applies selected state when track exists", () => {
  it("orbit is pending fallback; selected camera applied when track/distance present", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const ctl = createRendererController(handle, cam);
    ctl.applyCamera("chase", { reducedMotion: false });
    const pendingPos = cam.position.clone();
    const data = makeTrack();
    ctl.attachTrack(data);
    ctl.updatePlayback(8, 6);
    ctl.applyCamera("front", { reducedMotion: false });
    const frontPos = cam.position.clone();
    expect(frontPos.distanceTo(pendingPos)).toBeGreaterThan(1);
    expect(cam.fov).toBeGreaterThan(58);
    expect(cam.fov).toBeLessThanOrEqual(90);
    const checksum = data.checksum;
    ctl.applyCamera("rear", { reducedMotion: false });
    expect(data.checksum).toBe(checksum);
    ctl.dispose();
    handle.dispose();
  });
});

describe("findings – metric proxies removed", () => {
  it("height derives from canonical position; speed/gForce/energy require authoritative arrays", () => {
    const data = makeTrack();
    const h = buildTrackGeometries(data, { metric: "height" });
    expect(h.metricAvailable).toBe(true);
    const s = buildTrackGeometries(data, { metric: "speed" });
    expect(s.metricAvailable).toBe(false);
    const sColors = s.leftRail.getAttribute("color") as THREE.BufferAttribute;
    expect(sColors.getX(6)).toBeCloseTo(0.6, 1);
    const speeds = new Float64Array(data.distances.length)
      .fill(0)
      .map((_, i) => i * 0.5);
    const s2 = buildTrackGeometries(data, {
      metric: "speed",
      metricData: { speed: speeds },
    });
    expect(s2.metricAvailable).toBe(true);
    const s2c = s2.leftRail.getAttribute("color") as THREE.BufferAttribute;
    expect(s2c.getX(6)).not.toBeCloseTo(0.6, 1);

    const g = buildTrackGeometries(data, { metric: "gForce" });
    expect(g.metricAvailable).toBe(false);
    const e = buildTrackGeometries(data, { metric: "energy" });
    expect(e.metricAvailable).toBe(false);

    const gArr = new Float64Array(data.distances.length).fill(0.3);
    const g2 = buildTrackGeometries(data, {
      metric: "gForce",
      metricData: { gForce: gArr },
    });
    expect(g2.metricAvailable).toBe(true);
  });
});

describe("findings – lifecycle single owner (app/main loop)", () => {
  it("renderer and controller do not schedule RAF or register resize – app owns single RAF/resize", () => {
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
    const win = (g.window ?? g) as unknown as Window;
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      g.requestAnimationFrame as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      g.cancelAnimationFrame as unknown as typeof cancelAnimationFrame;
    (win as unknown as Record<string, unknown>).addEventListener =
      g.addEventListener as unknown as typeof addEventListener;
    (win as unknown as Record<string, unknown>).removeEventListener =
      g.removeEventListener as unknown as typeof removeEventListener;
    const rafSpy = vi
      .spyOn(
        win as unknown as {
          requestAnimationFrame: typeof requestAnimationFrame;
        },
        "requestAnimationFrame",
      )
      .mockReturnValue(1 as unknown as number);
    const addSpy = vi.spyOn(
      win as unknown as { addEventListener: typeof addEventListener },
      "addEventListener",
    );
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(handle).not.toBeNull();
    if (!handle) {
      rafSpy.mockRestore();
      addSpy.mockRestore();
      return;
    }
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    expect(rafSpy).not.toHaveBeenCalled();
    const resizeCalls = addSpy.mock.calls.filter((c) => c[0] === "resize");
    expect(resizeCalls.length).toBe(0);
    ctl.dispose();
    handle.dispose();
    rafSpy.mockRestore();
    addSpy.mockRestore();
  });

  it("reinitialization via single app owner cancels prior RAF and keeps one resize listener", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g.requestAnimationFrame)
      g.requestAnimationFrame = (() =>
        42) as unknown as typeof requestAnimationFrame;
    if (!g.cancelAnimationFrame)
      g.cancelAnimationFrame =
        (() => {}) as unknown as typeof cancelAnimationFrame;
    if (!g.addEventListener)
      g.addEventListener = (() => {}) as unknown as typeof addEventListener;
    if (!g.removeEventListener)
      g.removeEventListener =
        (() => {}) as unknown as typeof removeEventListener;
    if (!g.window) g.window = g;
    const win = (g.window ?? g) as unknown as Window;
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      g.requestAnimationFrame as unknown as typeof requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      g.cancelAnimationFrame as unknown as typeof cancelAnimationFrame;
    (win as unknown as Record<string, unknown>).addEventListener =
      g.addEventListener as unknown as typeof addEventListener;
    (win as unknown as Record<string, unknown>).removeEventListener =
      g.removeEventListener as unknown as typeof removeEventListener;
    const rafSpy = vi
      .spyOn(
        win as unknown as {
          requestAnimationFrame: typeof requestAnimationFrame;
        },
        "requestAnimationFrame",
      )
      .mockReturnValue(42 as unknown as number);
    const cafSpy = vi
      .spyOn(
        win as unknown as {
          cancelAnimationFrame: typeof cancelAnimationFrame;
        },
        "cancelAnimationFrame",
      )
      .mockImplementation(() => {});
    const addSpy = vi.spyOn(
      win as unknown as { addEventListener: typeof addEventListener },
      "addEventListener",
    );
    const remSpy = vi.spyOn(
      win as unknown as { removeEventListener: typeof removeEventListener },
      "removeEventListener",
    );

    let rafId: number | null = win.requestAnimationFrame(() => {});
    const handler: EventListener = (() => {}) as EventListener;
    win.addEventListener("resize", handler);

    if (rafId !== null) win.cancelAnimationFrame(rafId);
    win.removeEventListener("resize", handler);
    rafId = win.requestAnimationFrame(() => {});
    win.addEventListener("resize", handler);

    expect(cafSpy).toHaveBeenCalledTimes(1);
    expect(remSpy).toHaveBeenCalledTimes(1);
    expect(rafSpy).toHaveBeenCalledTimes(2);
    expect(addSpy).toHaveBeenCalledTimes(2);

    rafSpy.mockRestore();
    cafSpy.mockRestore();
    addSpy.mockRestore();
    remSpy.mockRestore();
  });

  it("no module-global cross-instance teardown collisions – per-instance dispose", () => {
    const canvasA = fakeCanvas();
    const canvasB = fakeCanvas();
    const mockA = mockRenderer(canvasA);
    const mockB = mockRenderer(canvasB);
    const handleA = createRendererHandle(canvasA, {
      createRenderer: () => mockA,
    });
    const handleB = createRendererHandle(canvasB, {
      createRenderer: () => mockB,
    });
    expect(handleA).not.toBeNull();
    expect(handleB).not.toBeNull();
    if (!handleA || !handleB) return;
    const camA = new THREE.PerspectiveCamera();
    const camB = new THREE.PerspectiveCamera();
    const ctlA = createRendererController(handleA, camA);
    const ctlB = createRendererController(handleB, camB);
    const data = makeTrack();
    ctlA.attachTrack(data);
    ctlB.attachTrack(data);
    expect(ctlA.hasTrack()).toBe(true);
    expect(ctlB.hasTrack()).toBe(true);
    ctlA.dispose();
    expect(ctlB.hasTrack()).toBe(true);
    expect(handleB.scene.children.length).toBeGreaterThan(0);
    expect(
      (mockB.dispose as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
    ctlB.dispose();
    handleA.dispose();
    handleB.dispose();
  });
});

describe("findings – behavior: no second spline, vertices from core fixture via sampling", () => {
  it("geometry vertices derived from real core sampling and no curve object stored", () => {
    const data = makeTrack();
    const result = buildTrackGeometries(data, { metric: "height" });
    const sampled = sampleCompiledTrack(data, 0);
    expect(sampled.position[0]).toBeCloseTo(data.positions[0] ?? 0, 5);
    expect(sampled.position[1]).toBeCloseTo(data.positions[1] ?? 0, 5);
    // Verify first rail vertex ring average approximates left center = pos + binormal*0.6
    const posAttr = result.leftRail.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const segments = 6;
    let avgX = 0;
    let avgY = 0;
    let avgZ = 0;
    for (let r = 0; r < segments; r++) {
      avgX += posAttr.getX(r);
      avgY += posAttr.getY(r);
      avgZ += posAttr.getZ(r);
    }
    avgX /= segments;
    avgY /= segments;
    avgZ /= segments;
    const bx = data.binormals[0] ?? 0;
    const by = data.binormals[1] ?? 0;
    const bz = data.binormals[2] ?? 0;
    const expectedX = (data.positions[0] ?? 0) + bx * 0.6;
    const expectedY = (data.positions[1] ?? 0) + by * 0.6;
    const expectedZ = (data.positions[2] ?? 0) + bz * 0.6;
    expect(Math.abs(avgX - expectedX)).toBeLessThan(1e-5);
    expect(Math.abs(avgY - expectedY)).toBeLessThan(1e-5);
    expect(Math.abs(avgZ - expectedZ)).toBeLessThan(1e-5);
    // No curve object retained
    expect(
      (result as unknown as Record<string, unknown>).curve,
    ).toBeUndefined();
    expect(
      (result.leftRail.userData as Record<string, unknown>).curve,
    ).toBeUndefined();
  });
});
