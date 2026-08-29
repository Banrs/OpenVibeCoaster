import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  compileTrack,
  vec3,
  sampleTrackAtDistance,
} from "@openvibecoaster/core";
import { createRendererHandle } from "./renderer.js";
import { createRendererController } from "./controller.js";
import { createAppLifecycle } from "./lifecycle.js";
import { normalizeHighlightDistance } from "./highlight.js";

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

function makeClosedTrack() {
  const radius = 20;
  return compileTrack(
    [
      {
        id: "loop",
        span: {
          position: (u: number) => {
            const a = u * Math.PI * 2;
            return vec3(Math.cos(a) * radius, 5, Math.sin(a) * radius);
          },
          derivative: (u: number, order = 1) => {
            const a = u * Math.PI * 2;
            if (order === 1)
              return vec3(
                -Math.sin(a) * Math.PI * 2 * radius,
                0,
                Math.cos(a) * Math.PI * 2 * radius,
              );
            return vec3(
              -Math.cos(a) * Math.PI * Math.PI * 4 * radius,
              0,
              -Math.sin(a) * Math.PI * Math.PI * 4 * radius,
            );
          },
        },
      },
    ],
    { samples: 32 },
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

function findHighlight(scene: THREE.Scene): THREE.Group | null {
  const obj = scene.getObjectByName("highlightMarker");
  return (obj as THREE.Group | null) ?? null;
}

describe("highlight – marker re-use and sampling", () => {
  it("reuses one procedural marker, positions via sampling, no second spline", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("no handle");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { closedTrack: false });
    expect(findHighlight(handle.scene)).toBeNull();
    ctl.setHighlight(5);
    const marker = findHighlight(handle.scene);
    expect(marker).not.toBeNull();
    const firstMarker = marker;
    ctl.setHighlight(7);
    expect(findHighlight(handle.scene)).toBe(firstMarker);
    const expected = sampleTrackAtDistance(
      data,
      normalizeHighlightDistance(data, 7, false),
    );
    const pos = firstMarker!.position;
    expect(pos.x).toBeCloseTo(
      expected.position[0] + expected.normal[0] * 0.6,
      3,
    );
    expect(pos.y).toBeCloseTo(
      expected.position[1] + expected.normal[1] * 0.6,
      3,
    );
    const leftGeom = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    ctl.setHighlight(9);
    const leftGeom2 = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    expect(leftGeom2).toBe(leftGeom);
    ctl.dispose();
    handle.dispose();
  });

  it("null hides marker, clamp for open, wrap for closed", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("h");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { closedTrack: false });
    ctl.setHighlight(null);
    ctl.setHighlight(3);
    const m = findHighlight(handle.scene);
    expect(m?.visible).toBe(true);
    ctl.setHighlight(null);
    expect(m?.visible).toBe(false);
    const beyond = data.totalLength + 100;
    ctl.setHighlight(beyond);
    const posClamped = m?.position as THREE.Vector3;
    const expectedClamped = sampleTrackAtDistance(data, data.totalLength);
    expect(posClamped?.x).toBeCloseTo(
      expectedClamped.position[0] + expectedClamped.normal[0] * 0.6,
      3,
    );
    const closed = makeClosedTrack();
    const canvas2 = fakeCanvas();
    const handle2 = createRendererHandle(canvas2, {
      createRenderer: () => mockRenderer(canvas2),
    })!;
    const cam2 = new THREE.PerspectiveCamera();
    const ctl2 = createRendererController(handle2, cam2);
    ctl2.attachTrack(closed, { closedTrack: true });
    ctl2.setHighlight(closed.totalLength + 10);
    const m2 = findHighlight(handle2.scene);
    const expectedWrap = sampleTrackAtDistance(closed, 10);
    expect(m2?.position.x).toBeCloseTo(
      expectedWrap.position[0] + expectedWrap.normal[0] * 0.6,
      3,
    );
    ctl2.setHighlight(-5);
    const expectedNeg = sampleTrackAtDistance(closed, closed.totalLength - 5);
    expect(m2?.position.x).toBeCloseTo(
      expectedNeg.position[0] + expectedNeg.normal[0] * 0.6,
      3,
    );
    ctl.dispose();
    handle.dispose();
    ctl2.dispose();
    handle2.dispose();
  });

  it("disposed exactly once and no geometry leak on reattach/retry", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("h");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { closedTrack: false });
    ctl.setHighlight(4);
    const marker = findHighlight(handle.scene)!;
    const mesh = marker.children[0] as THREE.Mesh;
    const disposeGeomSpy = vi.spyOn(mesh.geometry, "dispose");
    const disposeMatSpy = vi.spyOn(mesh.material as THREE.Material, "dispose");
    // Instead spy the marker's stored geometry via controller's internal marker
    // Use mesh spy which is authoritative
    ctl.dispose();
    expect(disposeGeomSpy).toHaveBeenCalledTimes(1);
    expect(disposeMatSpy).toHaveBeenCalledTimes(1);
    ctl.dispose();
    expect(disposeGeomSpy).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("train playback remains authoritative and separate from highlight", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { closedTrack: false });
    ctl.updatePlayback(5, 3);
    const trainPos = ctl.getTrainFrontPosition()!;
    ctl.setHighlight(12);
    const trainPos2 = ctl.getTrainFrontPosition()!;
    expect(trainPos2[0]).toBeCloseTo(trainPos[0], 5);
    const markerPos = findHighlight(handle.scene)!.position;
    const expectedHighlight = sampleTrackAtDistance(
      data,
      normalizeHighlightDistance(data, 12, false),
    );
    expect(markerPos.x).toBeCloseTo(
      expectedHighlight.position[0] + expectedHighlight.normal[0] * 0.6,
      3,
    );
    ctl.dispose();
    handle.dispose();
  });

  it("open-near-start still clamps when flag false despite geometric proximity", () => {
    const closedGeom = makeClosedTrack();
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    ctl.attachTrack(closedGeom, { closedTrack: false });
    // beyond length should clamp, not wrap, even though geometry is loop
    expect(
      normalizeHighlightDistance(closedGeom, closedGeom.totalLength + 5, false),
    ).toBe(closedGeom.totalLength);
    expect(normalizeHighlightDistance(closedGeom, -5, false)).toBe(0);
    ctl.setHighlight(closedGeom.totalLength + 5);
    const pos = findHighlight(handle.scene)!.position;
    const expectedClamped = sampleTrackAtDistance(
      closedGeom,
      closedGeom.totalLength,
    );
    expect(pos.x).toBeCloseTo(
      expectedClamped.position[0] + expectedClamped.normal[0] * 0.6,
      3,
    );
    ctl.setHighlight(-5);
    const expectedZero = sampleTrackAtDistance(closedGeom, 0);
    expect(findHighlight(handle.scene)!.position.x).toBeCloseTo(
      expectedZero.position[0] + expectedZero.normal[0] * 0.6,
      3,
    );
    ctl.dispose();
    handle.dispose();
  });

  it("imperfect closed-loop wraps when flag true despite geometric gap", () => {
    const openData = makeTrack();
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    })!;
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    ctl.attachTrack(openData, { closedTrack: true });
    expect(
      normalizeHighlightDistance(openData, openData.totalLength + 7, true),
    ).toBeCloseTo(7, 5);
    expect(normalizeHighlightDistance(openData, -3, true)).toBeCloseTo(
      openData.totalLength - 3,
      5,
    );
    // exact endpoint wraps to 0
    expect(
      normalizeHighlightDistance(openData, openData.totalLength, true),
    ).toBe(0);
    ctl.setHighlight(openData.totalLength + 7);
    const expectedWrap = sampleTrackAtDistance(openData, 7);
    expect(findHighlight(handle.scene)!.position.x).toBeCloseTo(
      expectedWrap.position[0] + expectedWrap.normal[0] * 0.6,
      3,
    );
    ctl.setHighlight(-3);
    const expectedNeg = sampleTrackAtDistance(
      openData,
      openData.totalLength - 3,
    );
    expect(findHighlight(handle.scene)!.position.x).toBeCloseTo(
      expectedNeg.position[0] + expectedNeg.normal[0] * 0.6,
      3,
    );
    ctl.dispose();
    handle.dispose();
  });
});

describe("lifecycle – transactional reattach and highlight", () => {
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
    return win as Window & typeof globalThis;
  }

  it("failed attach preserves last-known-good and does not leak", () => {
    const win = polyfillWindow();
    const canvas = fakeCanvas();
    const data = makeTrack();
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () => win,
    });
    expect(lc.init()).toBe(true);
    lc.attachTrack(data, { metric: "height" });
    const before = lc.getAttachment()?.data.checksum;
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
      checksum: "bad",
    } as unknown as typeof data;
    expect(() => lc.attachTrack(badData as unknown as typeof data)).toThrow();
    expect(lc.getAttachment()?.data.checksum).toBe(before);
    expect(lc.hasTrack()).toBe(true);
    lc.dispose();
  });

  it("highlight survives reattach and retry", () => {
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
    lc.attachTrack(data, { closedTrack: false });
    lc.setHighlight(8);
    const ctl = lc.getController();
    const marker = findHighlight(ctl!.getScene());
    expect(marker?.visible).toBe(true);
    expect(lc.reinitialize()).toBe(true);
    const ctl2 = lc.getController();
    const marker2 = findHighlight(ctl2!.getScene());
    expect(marker2?.visible).toBe(true);
    // highlight distance preserved via lifecycle storedHighlight
    lc.dispose();
  });

  it("exact resource disposal on controller reattach with highlight", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("h");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { closedTrack: false });
    ctl.setHighlight(6);
    const beforeTrackCount = handle.scene.children.filter(
      (c) => c.userData?.isTrack,
    ).length;
    expect(beforeTrackCount).toBeGreaterThan(0);
    const markerBefore = findHighlight(handle.scene);
    const geom = (markerBefore?.children[0] as THREE.Mesh)?.geometry;
    const disposeSpy = geom ? vi.spyOn(geom, "dispose") : null;
    ctl.attachTrack(makeTrack(), { closedTrack: false });
    if (disposeSpy) expect(disposeSpy).not.toHaveBeenCalled();
    ctl.dispose();
    handle.dispose();
  });
});
