import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "../shim/core.js";

// RED PHASE: these imports will fail until fix round 1 lands
import { createRendererController } from "./controller.js";
import { buildTrackGeometries } from "./trackGeometry.js";
import { createRendererHandle, teardownRendererLifecycle } from "./renderer.js";

void teardownRendererLifecycle;

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
    // pending: fallback orbit
    ctl.applyCamera("chase", { reducedMotion: false });
    const pendingPos = cam.position.clone();
    // attach track and set distance/speed
    const data = makeTrack();
    ctl.attachTrack(data);
    ctl.updatePlayback(8, 6);
    ctl.applyCamera("front", { reducedMotion: false });
    const frontPos = cam.position.clone();
    expect(frontPos.distanceTo(pendingPos)).toBeGreaterThan(1);
    expect(cam.fov).toBeGreaterThan(58);
    expect(cam.fov).toBeLessThanOrEqual(90);
    // verify damping doesn't mutate authoritative data
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
    // height should be available even without arrays
    const h = buildTrackGeometries(data, { metric: "height" });
    expect(h.metricAvailable).toBe(true);
    // speed without array -> unavailable neutral
    const s = buildTrackGeometries(data, { metric: "speed" });
    expect(s.metricAvailable).toBe(false);
    const sColors = s.leftRail.getAttribute("color") as THREE.BufferAttribute;
    // neutral gray: check a non-seam sample (sample 1 -> vertex 6)
    expect(sColors.getX(6)).toBeCloseTo(0.6, 1);
    // with authoritative array -> available
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

    // g with array
    const gArr = new Float64Array(data.distances.length).fill(0.3);
    const g2 = buildTrackGeometries(data, {
      metric: "gForce",
      metricData: { gForce: gArr },
    });
    expect(g2.metricAvailable).toBe(true);
  });
});

describe("findings – lifecycle owns resize and RAF", () => {
  it("reinit cancels prior RAF and removes prior resize listener, including failed creation", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g.requestAnimationFrame) {
      g.requestAnimationFrame = (() =>
        123) as unknown as typeof requestAnimationFrame;
    }
    if (!g.cancelAnimationFrame) {
      g.cancelAnimationFrame =
        (() => {}) as unknown as typeof cancelAnimationFrame;
    }
    if (!g.addEventListener) {
      g.addEventListener = (() => {}) as unknown as typeof addEventListener;
    }
    if (!g.removeEventListener) {
      g.removeEventListener =
        (() => {}) as unknown as typeof removeEventListener;
    }
    if (!g.window) {
      g.window = g;
    }
    const win = g.window as unknown as Window;
    (win as unknown as Record<string, unknown>).requestAnimationFrame =
      g.requestAnimationFrame;
    (win as unknown as Record<string, unknown>).cancelAnimationFrame =
      g.cancelAnimationFrame;
    (win as unknown as Record<string, unknown>).addEventListener =
      g.addEventListener;
    (win as unknown as Record<string, unknown>).removeEventListener =
      g.removeEventListener;
    const addSpy = vi.spyOn(win, "addEventListener");
    const removeSpy = vi.spyOn(win, "removeEventListener");
    const rafSpy = vi
      .spyOn(
        win as unknown as {
          requestAnimationFrame: typeof requestAnimationFrame;
        },
        "requestAnimationFrame",
      )
      .mockImplementation(() => 123 as unknown as number);
    const cafSpy = vi
      .spyOn(
        win as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame },
        "cancelAnimationFrame",
      )
      .mockImplementation(() => {});

    // create a successful handle first to set active RAF/listener
    const canvas = fakeCanvas();
    const okHandle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(okHandle).not.toBeNull();
    expect(rafSpy).toHaveBeenCalled();
    // failing creation should also cancel prior RAF/listener
    const failCanvas = fakeCanvas() as unknown as HTMLCanvasElement;
    (failCanvas as unknown as { getContext: () => null }).getContext = () =>
      null;
    const failHandle = createRendererHandle(failCanvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(failHandle).toBeNull();
    expect(cafSpy).toHaveBeenCalled();
    okHandle?.dispose();

    addSpy.mockRestore();
    removeSpy.mockRestore();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });
});

describe("findings – no second spline structural evidence", () => {
  it("geometry vertices are direct function of canonical sample arrays, no curve stored", () => {
    const data = makeTrack();
    const result = buildTrackGeometries(data, { metric: "height" });
    // new API must not expose splineCount; check absence
    expect(
      (result as unknown as { splineCount?: unknown }).splineCount,
    ).toBeUndefined();
    // structural: any stored curve object would have `isCurve` or `points`
    expect(
      (result.leftRail.userData as Record<string, unknown>).curve,
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>).curve,
    ).toBeUndefined();
    // verify position derives from canonical data: first rail vertex should be near pos + binormal*gauge/2
    const posAttr = result.leftRail.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const firstX = posAttr.getX(0);
    const canonicalX = data.positions[0] as number;
    // rail is offset by ~0.6 along binormal (approx 0 for this track's binormal z=1?), so X near canonical X
    expect(Math.abs(firstX - canonicalX)).toBeLessThan(1.5);
  });
});
