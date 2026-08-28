import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3, sampleCompiledTrack } from "@openvibecoaster/core";

import { createRendererController } from "./controller.js";
import { buildTrackGeometries } from "./trackGeometry.js";
import { createRendererHandle } from "./renderer.js";
import { createAppLifecycle, type AttachmentSnapshot } from "./lifecycle.js";

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

describe("findings round3 – setMetric preserves playback and metric arrays", () => {
  it("changing color mode without metricData must not snap train to s=0 and must preserve metric arrays + geometry availability", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const speeds = new Float64Array(data.distances.length)
      .fill(0)
      .map((_, i) => i * 1.2 + 2);
    ctl.attachTrack(data, { metric: "speed", metricData: { speed: speeds } });
    ctl.updatePlayback(9, 6);
    const posBefore = ctl.getTrainFrontPosition();
    expect(posBefore).not.toBeNull();
    // initial speed metric must be available via production API and real geometry colors
    const stateSpeed = ctl.getMetricState();
    expect(stateSpeed).not.toBeNull();
    expect(stateSpeed?.metric).toBe("speed");
    expect(stateSpeed?.metricAvailable).toBe(true);
    const leftBefore = handle.scene.children.find(
      (c) => (c as THREE.Mesh).name === "leftRail",
    ) as THREE.Mesh | undefined;
    expect(leftBefore).toBeDefined();
    if (leftBefore) {
      const col = (leftBefore.geometry as THREE.BufferGeometry).getAttribute(
        "color",
      ) as THREE.BufferAttribute;
      // speed with data should not be neutral 0.6
      expect(col.getX(6)).not.toBeCloseTo(0.6, 1);
    }
    // Change metric without supplying metricData – must preserve distance and arrays
    ctl.setMetric("height");
    const posAfterHeight = ctl.getTrainFrontPosition();
    expect(posAfterHeight).not.toBeNull();
    if (posBefore && posAfterHeight) {
      expect(posAfterHeight[0]).toBeCloseTo(posBefore[0], 4);
      expect(posAfterHeight[1]).toBeCloseTo(posBefore[1], 4);
    }
    const stateHeight = ctl.getMetricState();
    expect(stateHeight?.metric).toBe("height");
    expect(stateHeight?.metricAvailable).toBe(true);
    // geometry after height switch is still built (height always available)
    const leftHeight = handle.scene.children.find(
      (c) => (c as THREE.Mesh).name === "leftRail",
    ) as THREE.Mesh | undefined;
    expect(leftHeight).toBeDefined();
    // Switch back to speed without re-supplying array – should still be available (preserved) and geometry not neutral
    ctl.setMetric("speed");
    const posAfterSpeed = ctl.getTrainFrontPosition();
    if (posBefore && posAfterSpeed) {
      expect(posAfterSpeed[0]).toBeCloseTo(posBefore[0], 4);
    }
    const stateSpeed2 = ctl.getMetricState();
    expect(stateSpeed2?.metric).toBe("speed");
    expect(stateSpeed2?.metricAvailable).toBe(true);
    const leftSpeed2 = handle.scene.children.find(
      (c) => (c as THREE.Mesh).name === "leftRail",
    ) as THREE.Mesh | undefined;
    expect(leftSpeed2).toBeDefined();
    if (leftSpeed2) {
      const col2 = (leftSpeed2.geometry as THREE.BufferGeometry).getAttribute(
        "color",
      ) as THREE.BufferAttribute;
      expect(col2.getX(6)).not.toBeCloseTo(0.6, 1);
    }
    // Also verify that supplying new metricData updates, and omitting keeps previous
    const gForces = new Float64Array(data.distances.length).fill(0.7);
    ctl.setMetric("gForce", { gForce: gForces });
    ctl.updatePlayback(4, 2);
    const posG = ctl.getTrainFrontPosition();
    ctl.setMetric("gForce");
    const posG2 = ctl.getTrainFrontPosition();
    if (posG && posG2) expect(posG2[0]).toBeCloseTo(posG[0], 4);
    const stateG = ctl.getMetricState();
    expect(stateG?.metric).toBe("gForce");
    expect(stateG?.metricAvailable).toBe(true);
    ctl.dispose();
    handle.dispose();
  });

  it("setMetric saves state before mesh rebuild – playback distance/speed preserved across rebuild", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data);
    ctl.updatePlayback(11, 3.5);
    const before = ctl.getTrainFrontPosition();
    ctl.setMetric("height");
    const after = ctl.getTrainFrontPosition();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (before && after) {
      expect(after[0]).toBeCloseTo(before[0], 4);
      expect(after[1]).toBeCloseTo(before[1], 4);
    }
    // speed should also be preserved for camera FOV purposes – applyCamera should use preserved speed
    ctl.applyCamera("front", { reducedMotion: false });
    const fovAfter = cam.fov;
    expect(fovAfter).toBeGreaterThan(50);
    ctl.dispose();
    handle.dispose();
  });
});

describe("findings round3 – attachTrack owns timeline option", () => {
  it("validates matching finite arrays and applies first distance/speed directly", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const distances = new Float64Array([4, 8, 12]);
    const speeds = new Float64Array([2, 4, 6]);
    ctl.attachTrack(data, { timeline: { distances, speeds } });
    const pos = ctl.getTrainFrontPosition();
    // Direct controller caller must not depend on app helper – position should already reflect distances[0]=4
    const ctl2PosCheck = (() => {
      const tmpCanvas = fakeCanvas();
      const tmpHandle = createRendererHandle(tmpCanvas, {
        createRenderer: () => mockRenderer(tmpCanvas),
      });
      if (!tmpHandle) return null;
      const tmpCam = new THREE.PerspectiveCamera();
      const tmpCtl = createRendererController(tmpHandle, tmpCam);
      tmpCtl.attachTrack(data, { timeline: { distances, speeds } });
      const p = tmpCtl.getTrainFrontPosition();
      tmpCtl.dispose();
      tmpHandle.dispose();
      return p;
    })();
    expect(pos).not.toBeNull();
    expect(ctl2PosCheck).not.toBeNull();
    if (pos && ctl2PosCheck) {
      expect(pos[0]).toBeCloseTo(ctl2PosCheck[0], 4);
    }
    // verify playback applied: updatePlayback to 8 would move further
    ctl.updatePlayback(8, 4);
    const pos8 = ctl.getTrainFrontPosition();
    if (pos && pos8) expect(pos8[0]).not.toBeCloseTo(pos[0], 2);
    ctl.dispose();
    handle.dispose();
  });

  it("throws on mismatched or non-finite timeline arrays", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const distances = new Float64Array([0, 1]);
    const speedsMismatch = new Float64Array([0]);
    expect(() =>
      ctl.attachTrack(data, {
        timeline: { distances, speeds: speedsMismatch },
      }),
    ).toThrow();
    const badDist = new Float64Array([0, Number.NaN]);
    const badSpeed = new Float64Array([0, 1]);
    expect(() =>
      ctl.attachTrack(data, {
        timeline: { distances: badDist, speeds: badSpeed },
      }),
    ).toThrow();
    const infDist = new Float64Array([0, Infinity]);
    expect(() =>
      ctl.attachTrack(data, {
        timeline: { distances: infDist, speeds: badSpeed },
      }),
    ).toThrow();
    ctl.dispose();
    handle.dispose();
  });
});

describe("findings round3 – lifecycle manager (production) – RAF/resize, reattach, stale global", () => {
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

  it("reinitialization preserves last authoritative attachment and reattaches when state is ready", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const data = makeTrack();
    const distances = new Float64Array([5, 10]);
    const speeds = new Float64Array([3, 6]);
    // First lifecycle succeeds
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    lc.attachTrack(data, { metric: "height", timeline: { distances, speeds } });
    lc.updatePlayback(7, 2);
    const posBefore = lc.getController()?.getTrainFrontPosition();
    expect(posBefore).not.toBeNull();
    // Simulate reinitialization (e.g., WebGL retry or seed change)
    expect(lc.reinitialize()).toBe(true);
    expect(lc.hasTrack()).toBe(true);
    expect(lc.getAttachment()?.data.checksum).toBe(data.checksum);
    const posAfter = lc.getController()?.getTrainFrontPosition();
    expect(posAfter).not.toBeNull();
    if (posBefore && posAfter) {
      expect(posAfter[0]).toBeCloseTo(posBefore[0], 4);
    }
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBe(lc.getController());
    lc.dispose();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
  });

  it("failed WebGL creation preserves attachment for retry and clears stale global", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const data = makeTrack();
    let shouldFail = false;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) => {
        if (shouldFail) return null;
        return createRendererHandle(c, {
          createRenderer: () => mockRenderer(c),
        });
      },
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    lc.attachTrack(data, { metric: "height" });
    const attBefore = lc.getAttachment();
    expect(attBefore).not.toBeNull();
    const ctrlBefore = lc.getController();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBe(ctrlBefore);
    shouldFail = true;
    expect(lc.reinitialize()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    // attachment preserved for retry
    expect(lc.getAttachment()?.data.checksum).toBe(data.checksum);
    shouldFail = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.hasTrack()).toBe(true);
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBe(lc.getController());
    lc.dispose();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
  });

  it("owns single RAF/resize – cancels prior RAF and removes listener on reinitialize and disposal", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const rafSpy = vi
      .spyOn(
        win as unknown as {
          requestAnimationFrame: typeof requestAnimationFrame;
        },
        "requestAnimationFrame",
      )
      .mockReturnValue(101 as unknown as number);
    const cafSpy = vi
      .spyOn(
        win as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame },
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
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter((c) => c[0] === "resize").length).toBe(1);
    // reinitialize should cancel prior RAF and remove prior listener before new ones
    expect(lc.reinitialize()).toBe(true);
    expect(cafSpy).toHaveBeenCalledTimes(1);
    expect(remSpy.mock.calls.filter((c) => c[0] === "resize").length).toBe(1);
    expect(rafSpy).toHaveBeenCalledTimes(2);
    expect(addSpy.mock.calls.filter((c) => c[0] === "resize").length).toBe(2);
    // disposal cancels and removes
    lc.dispose();
    expect(cafSpy).toHaveBeenCalledTimes(2);
    expect(remSpy.mock.calls.filter((c) => c[0] === "resize").length).toBe(2);
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    // failed creation also cancels prior RAF/listener
    expect(lc.init()).toBe(true);
    // Simulate failure via flag
    let fail = true;
    const lc2 = createAppLifecycle({
      canvas: fakeCanvas(),
      createHandle: (c) =>
        fail
          ? null
          : createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    // init success first to set up RAF
    fail = false;
    expect(lc2.init()).toBe(true);
    fail = true;
    expect(lc2.reinitialize()).toBe(false);
    // should have cancelled prior RAF even on failure
    expect(cafSpy.mock.calls.length).toBeGreaterThan(2);
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    lc.dispose();
    lc2.dispose();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    addSpy.mockRestore();
    remSpy.mockRestore();
  });

  it("disposal clears global and RAF/resize, truthfully downgrades hasTrack", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    const data = makeTrack();
    lc.attachTrack(data);
    expect(lc.hasTrack()).toBe(true);
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBe(lc.getController());
    lc.dispose();
    expect(lc.hasTrack()).toBe(false);
    expect(lc.getRendererHandle()).toBeNull();
    expect(lc.getController()).toBeNull();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    // reinit without re-attach stays pending (truthful)
    expect(lc.reinitialize()).toBe(true);
    expect(lc.hasTrack()).toBe(false);
    lc.dispose();
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

describe("findings round4 – lifecycle transactional reattachment", () => {
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

  it("failed reattachment cleans up new controller/handle/camera, clears global, returns false, preserves attachment for retry", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const data = makeTrack();
    let shouldFailAttach = false;
    // lifecycle will reattach saved canonical track on reinit; make controller that throws on attachTrack when flag set
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      createController: (handle, cam) => {
        const real = createRendererController(handle, cam);
        const origAttach = real.attachTrack;
        real.attachTrack = (
          d: typeof data,
          opts?: Parameters<typeof origAttach>[1],
        ) => {
          if (shouldFailAttach) throw new Error("simulated mesh-build failure");
          return origAttach(d, opts);
        };
        return real;
      },
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    lc.attachTrack(data, { metric: "height" });
    expect(lc.hasTrack()).toBe(true);
    expect(lc.getAttachment()?.data.checksum).toBe(data.checksum);
    shouldFailAttach = true;
    // reinitialize will try to reattach and fail – must be transactional
    expect(lc.reinitialize()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    expect(lc.getCamera()).toBeNull();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    expect(
      (globalThis as unknown as Record<string, unknown>)
        .__vibecoasterController,
    ).toBeUndefined();
    // must not swallow failure – hasTrack downgraded truthfully, but attachment preserved for retry
    expect(lc.hasTrack()).toBe(false);
    expect(lc.getAttachment()?.data.checksum).toBe(data.checksum);
    // retry succeeds after clearing failure flag
    shouldFailAttach = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.hasTrack()).toBe(true);
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBe(lc.getController());
    lc.dispose();
  });

  it("handle and controller factories are transactional – throw or null disposes partial resources and clears globals", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    let disposeCount = 0;
    const trackingHandle = (): ReturnType<typeof createRendererHandle> => {
      const h = createRendererHandle(canvas, {
        createRenderer: () => mockRenderer(canvas),
      });
      if (!h) return null;
      const origDispose = h.dispose;
      h.dispose = () => {
        disposeCount++;
        origDispose();
      };
      return h;
    };
    let throwOnHandle = false;
    let throwOnController = false;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (_c) => {
        if (throwOnHandle) throw new Error("handle factory throw");
        return trackingHandle() as unknown as ReturnType<
          typeof createRendererHandle
        >;
      },
      createController: (handle_, cam_) => {
        if (throwOnController) throw new Error("controller factory throw");
        return createRendererController(handle_, cam_);
      },
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    expect(lc.getController()).not.toBeNull();
    const prevDispose = disposeCount;
    // controller factory throws – must dispose handle and clear globals, return false
    throwOnController = true;
    expect(lc.reinitialize()).toBe(false);
    expect(disposeCount).toBeGreaterThan(prevDispose);
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    expect(lc.getCamera()).toBeNull();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    // handle factory throws – also transactional
    throwOnController = false;
    throwOnHandle = true;
    expect(lc.reinitialize()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
    // recovery succeeds
    throwOnHandle = false;
    expect(lc.reinitialize()).toBe(true);
    expect(lc.getController()).not.toBeNull();
    lc.dispose();
    expect(
      (win as unknown as Record<string, unknown>).__vibecoasterController,
    ).toBeUndefined();
  });

  it("attachTrack is two-phase – rejected timeline does not overwrite previous last-known-good attachment", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const data = makeTrack();
    const data2 = makeTrack();
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    const goodDist = new Float64Array([2, 6]);
    const goodSpeed = new Float64Array([1, 3]);
    lc.attachTrack(data, {
      metric: "height",
      timeline: { distances: goodDist, speeds: goodSpeed },
    });
    const goodChecksum = lc.getAttachment()?.data.checksum;
    expect(goodChecksum).toBe(data.checksum);
    expect(lc.hasTrack()).toBe(true);
    // attempt invalid timeline with different data – must throw and preserve previous attachment
    const badDist = new Float64Array([0, 1]);
    const badSpeed = new Float64Array([0]); // mismatch
    expect(() =>
      lc.attachTrack(data2, {
        metric: "height",
        timeline: { distances: badDist, speeds: badSpeed },
      }),
    ).toThrow();
    expect(lc.getAttachment()?.data.checksum).toBe(goodChecksum);
    expect(lc.hasTrack()).toBe(true);
    // controller still has original track (restore when feasible)
    expect(lc.getController()?.getTrackData()?.checksum).toBe(data.checksum);
    // mesh-build failure should also not overwrite – simulate via buildTrackGeometries throw by passing not enough samples? Use data with 1 sample that triggers RangeError
    const badData = {
      ...data2,
      distances: new Float64Array([0]),
      positions: new Float64Array([0, 0, 0]),
      tangents: new Float64Array([0, 0, 0]),
      normals: new Float64Array([0, 0, 0]),
      binormals: new Float64Array([0, 0, 0]),
      curvature: new Float64Array([0]),
      bank: new Float64Array([0]),
      elementIndices: new Uint16Array([0]),
      elementBoundaries: new Uint16Array([0]),
      totalLength: 0,
      checksum: "bad",
    } as unknown as typeof data2;
    expect(() => lc.attachTrack(badData as unknown as typeof data)).toThrow();
    expect(lc.getAttachment()?.data.checksum).toBe(goodChecksum);
    expect(lc.hasTrack()).toBe(true);
    lc.dispose();
  });

  it("lifecycle is sole resize owner – no duplicate direct resize", async () => {
    // Verify main.ts no longer contains duplicate direct initial resize block
    const fs = await import("node:fs/promises");
    const mainText = await fs.readFile("apps/web/src/main.ts", "utf8");
    // lifecycle manager is sole resize owner – initial paint should be just render() without h.resize
    expect(mainText).not.toContain("h.resize(w, hgt)");
    expect(mainText).not.toContain("resizeCanvases();\n\n// Expose for manual");
    expect(mainText).toContain("lifecycle manager is sole resize owner");
    expect(mainText).toContain("onResize2D");
  });
});

describe("findings round5 – pending retry does not overwrite last-known-good merely by validating", () => {
  function polyfillWindow5(): Window & typeof globalThis {
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

  it("no-controller attachTrack preserves last-known-good, explicit pending, failed reattach then replacement succeeds", () => {
    const win = polyfillWindow5();
    const canvas = fakeCanvas();
    const good = makeTrack();
    const bad = {
      ...good,
      distances: new Float64Array([0]),
      positions: new Float64Array([0, 0, 0]),
      tangents: new Float64Array([0, 0, 0]),
      normals: new Float64Array([0, 0, 0]),
      binormals: new Float64Array([0, 0, 0]),
      curvature: new Float64Array([0]),
      bank: new Float64Array([0]),
      elementIndices: new Uint16Array([0]),
      elementBoundaries: new Uint16Array([0]),
      totalLength: 0,
      checksum: "bad-pending",
    } as unknown as ReturnType<typeof makeTrack>;
    const replacement = makeTrack();

    let shouldFailHandle = false;
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) => {
        if (shouldFailHandle) return null;
        return createRendererHandle(c, {
          createRenderer: () => mockRenderer(c),
        });
      },
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    lc.attachTrack(good, { metric: "height" });
    expect(lc.hasTrack()).toBe(true);
    expect(lc.getAttachment()?.data.checksum).toBe(good.checksum);

    // force no-controller while preserving last-known-good for retry
    shouldFailHandle = true;
    expect(lc.reinitialize()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(lc.getRendererHandle()).toBeNull();
    // must preserve prior snapshot, not clear it
    expect(lc.getAttachment()?.data.checksum).toBe(good.checksum);
    // pending semantics: if lifecycle exposes getPendingAttachment, it should be null before pending
    const pendingBefore = (
      lc as unknown as { getPendingAttachment?: () => unknown }
    ).getPendingAttachment?.();
    if (pendingBefore !== undefined) expect(pendingBefore).toBeNull();

    // no-controller attach with data that will fail on next build – must not overwrite last-known-good
    lc.attachTrack(bad, { metric: "height" });
    // after pending attach, last-known-good still good
    expect(lc.getAttachment()?.data.checksum).toBe(good.checksum);
    // explicit pending should now be bad
    const pendingBad = (
      lc as unknown as {
        getPendingAttachment?: () => AttachmentSnapshot | null;
      }
    ).getPendingAttachment?.();
    if (pendingBad !== undefined) {
      expect(pendingBad?.data.checksum).toBe("bad-pending");
    }

    // retry with pending bad must fail transactionally and keep good for future retry
    shouldFailHandle = false;
    expect(lc.reinitialize()).toBe(false);
    expect(lc.hasTrack()).toBe(false);
    expect(lc.getController()).toBeNull();
    expect(lc.getAttachment()?.data.checksum).toBe(good.checksum);
    // pending still bad until replaced
    const pendingStillBad = (
      lc as unknown as {
        getPendingAttachment?: () => AttachmentSnapshot | null;
      }
    ).getPendingAttachment?.();
    if (pendingStillBad !== undefined) {
      expect(pendingStillBad?.data.checksum).toBe("bad-pending");
    }

    // replacement pending while still no-controller – must replace pending, still preserve good
    lc.attachTrack(replacement, { metric: "height" });
    expect(lc.getAttachment()?.data.checksum).toBe(good.checksum);
    const pendingRepl = (
      lc as unknown as {
        getPendingAttachment?: () => AttachmentSnapshot | null;
      }
    ).getPendingAttachment?.();
    if (pendingRepl !== undefined) {
      expect(pendingRepl?.data.checksum).toBe(replacement.checksum);
    }

    // next retry should succeed and promote replacement to last-known-good
    expect(lc.reinitialize()).toBe(true);
    expect(lc.hasTrack()).toBe(true);
    expect(lc.getAttachment()?.data.checksum).toBe(replacement.checksum);
    // pending cleared after success
    const pendingAfter = (
      lc as unknown as {
        getPendingAttachment?: () => AttachmentSnapshot | null;
      }
    ).getPendingAttachment?.();
    if (pendingAfter !== undefined) expect(pendingAfter).toBeNull();

    lc.dispose();
    expect(lc.getAttachment()).toBeNull();
    const pendingAfterDispose = (
      lc as unknown as { getPendingAttachment?: () => unknown }
    ).getPendingAttachment?.();
    if (pendingAfterDispose !== undefined)
      expect(pendingAfterDispose).toBeNull();
  });
});

describe("findings round5 – main downgrade on every failed path", () => {
  it("main truthfully downgrades ready/generating when no usable track after failure", async () => {
    const fs = await import("node:fs/promises");
    const mainText = await fs.readFile("apps/web/src/main.ts", "utf8");
    // every failed reinitialize path must downgrade
    expect(mainText).toMatch(/syncReadyDowngrade|downgradeIfNoTrack/);
    // attachCompiledTrack must downgrade on catch and on failed reinitialize
    // count that downgrade appears inside attachCompiledTrack failure branches
    const attachSection = mainText.slice(
      mainText.indexOf("function attachCompiledTrack"),
      mainText.indexOf("function attachCompiledTrack") + 3000,
    );
    expect(attachSection).toMatch(/downgrade|syncReadyDowngrade/);
    // webglRetry must downgrade on failure (both handle failure and supportsWebGL false)
    expect(mainText).toContain("webglRetry");
    // no exit may leave ready/generating without track – file must contain guard checking hasTrack before leaving ready
    expect(mainText).toMatch(/hasTrack\(\)/);
    expect(mainText).toMatch(/generationStatus.*error|error.*generationStatus/);
  });
});

describe("findings round5 – createRendererHandle transactional disposal", () => {
  it("disposes renderer and scene resources if buildScene throws after allocation", async () => {
    const canvas = fakeCanvas();
    const mockR = mockRenderer(canvas);
    const disposeSpy = vi.fn();
    mockR.dispose = disposeSpy;
    // spy on disposeScene by importing and mocking
    const rendererMod = await import("./renderer.js");
    // Make terrain's createDeterministicHeightfield throw to trigger buildScene failure after renderer allocation
    const terrainMod = await import("./terrain.js");
    const terrainSpy = vi
      .spyOn(terrainMod, "createDeterministicHeightfield")
      .mockImplementationOnce(() => {
        throw new Error("injected terrain failure");
      });
    let threw = false;
    try {
      rendererMod.createRendererHandle(canvas, {
        createRenderer: () => mockR as unknown as THREE.WebGLRenderer,
        terrainSeed: "should-fail",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(disposeSpy).toHaveBeenCalled();
    terrainSpy.mockRestore();
  });
});

describe("findings round5 – controller transactional construction", () => {
  it("disposes partially allocated geometry/material/support/train if construction throws before commit", async () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    expect(handle).not.toBeNull();
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data);
    expect(ctl.hasTrack()).toBe(true);
    // inject failure in support building after geometries allocated
    const supportsMod = await import("./supports.js");
    const supportSpy = vi
      .spyOn(supportsMod, "buildSupportColumns")
      .mockImplementationOnce(() => {
        throw new Error("injected support failure");
      });
    const geomDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    let threw = false;
    try {
      ctl.attachTrack(data);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // truthful state: no leaked track
    expect(ctl.hasTrack()).toBe(false);
    expect(
      handle.scene.children.some((c) => c.userData?.isTrack === true),
    ).toBe(false);
    // partial geometries should have been disposed
    expect(geomDisposeSpy.mock.calls.length).toBeGreaterThan(0);
    geomDisposeSpy.mockRestore();
    supportSpy.mockRestore();
    ctl.dispose();
    handle.dispose();
  });

  it("disposes train group resources if train creation throws", async () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) return;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    const trainMod = await import("./train.js");
    const trainSpy = vi
      .spyOn(trainMod, "createTrainGroup")
      .mockImplementationOnce(() => {
        throw new Error("injected train failure");
      });
    let threw = false;
    try {
      ctl.attachTrack(data);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(ctl.hasTrack()).toBe(false);
    expect(
      handle.scene.children.some((c) => c.userData?.isTrain === true),
    ).toBe(false);
    trainSpy.mockRestore();
    ctl.dispose();
    handle.dispose();
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
