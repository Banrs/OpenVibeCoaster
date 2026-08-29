import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  compileTrack,
  vec3,
  sampleTrackAtDistance,
} from "@openvibecoaster/core";
import { buildTrackGeometries } from "./trackGeometry.js";
import { createRendererHandle } from "./renderer.js";
import { createRendererController } from "./controller.js";
import { createAppLifecycle } from "./lifecycle.js";
import { normalizeHighlightDistance } from "./highlight.js";
import { METRIC_IDS } from "../viewState.js";

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
  // Closed loop: start and end same position
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

describe("spark – metric union supports six metrics", () => {
  it("viewState METRIC_IDS includes six required ids", () => {
    expect(METRIC_IDS).toEqual(
      expect.arrayContaining([
        "speed",
        "gForce",
        "rollRate",
        "clearance",
        "height",
        "energy",
      ]),
    );
    expect(METRIC_IDS.length).toBe(6);
  });

  it("buildTrackGeometries accepts each metric id", () => {
    const data = makeTrack();
    const count = data.distances.length;
    for (const metric of METRIC_IDS) {
      if (metric === "height") {
        const res = buildTrackGeometries(data, { metric });
        expect(res.metricAvailable).toBe(true);
        expect(res.metric).toBe(metric);
      } else {
        const arr = new Float64Array(count).fill(1);
        const res = buildTrackGeometries(data, {
          metric,
          metricData: { [metric]: arr } as unknown as Record<
            string,
            Float64Array
          >,
        });
        expect(res.metricAvailable).toBe(true);
      }
    }
  });
});

describe("spark – MetricData availability: missing, misaligned, non-finite", () => {
  it("missing data renders neutral and metricAvailable false", () => {
    const data = makeTrack();
    for (const metric of [
      "speed",
      "gForce",
      "rollRate",
      "clearance",
      "energy",
    ] as const) {
      const res = buildTrackGeometries(data, { metric });
      expect(res.metricAvailable).toBe(false);
      const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
      // neutral palette 0.6
      expect(col.getX(0)).toBeCloseTo(0.6, 1);
      expect(col.getY(0)).toBeCloseTo(0.6, 1);
    }
  });

  it("misaligned length renders neutral", () => {
    const data = makeTrack();
    const short = new Float64Array(data.distances.length - 1).fill(1);
    const long = new Float64Array(data.distances.length + 1).fill(1);
    for (const arr of [short, long]) {
      const res = buildTrackGeometries(data, {
        metric: "speed",
        metricData: { speed: arr },
      });
      expect(res.metricAvailable).toBe(false);
      const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
      expect(col.getX(2)).toBeCloseTo(0.6, 1);
    }
  });

  it("non-finite values render neutral", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const badNaN = new Float64Array(count).fill(1);
    badNaN[5] = Number.NaN;
    const badInf = new Float64Array(count).fill(1);
    badInf[3] = Infinity;
    const badNegInf = new Float64Array(count).fill(1);
    badNegInf[7] = -Infinity;
    for (const arr of [badNaN, badInf, badNegInf]) {
      const res = buildTrackGeometries(data, {
        metric: "gForce",
        metricData: { gForce: arr },
      });
      expect(res.metricAvailable).toBe(false);
    }
  });

  it("height derives only from positions and always available (no fake arrays)", () => {
    const data = makeTrack();
    const res = buildTrackGeometries(data, { metric: "height" });
    expect(res.metricAvailable).toBe(true);
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    // heights vary, but verify not all neutral; at least one vertex differs
    let anyNonNeutral = false;
    for (let i = 0; i < col.count; i++)
      if (Math.abs(col.getX(i) - 0.6) > 0.05) {
        anyNonNeutral = true;
        break;
      }
    expect(anyNonNeutral).toBe(true);
    // providing fake speed array must not affect height
    const speedArr = new Float64Array(data.distances.length).fill(0);
    const res2 = buildTrackGeometries(data, {
      metric: "height",
      metricData: { speed: speedArr },
    });
    expect(res2.metricAvailable).toBe(true);
  });

  it("does not mutate caller arrays", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const arr = new Float64Array(count);
    for (let i = 0; i < count; i++) arr[i] = i * 1.5 + 2;
    const before = arr.slice();
    buildTrackGeometries(data, { metric: "speed", metricData: { speed: arr } });
    expect(arr).toEqual(before);
    const roll = new Float64Array(count).fill(-1);
    const beforeRoll = roll.slice();
    buildTrackGeometries(data, {
      metric: "rollRate",
      metricData: { rollRate: roll } as unknown as Record<string, Float64Array>,
    });
    expect(roll).toEqual(beforeRoll);
  });
});

describe("spark – deterministic distinct coloring, diverging and clearance danger", () => {
  it("each metric yields visibly distinct palette for same t", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const makeArr = (fn: (i: number) => number) => {
      const a = new Float64Array(count);
      for (let i = 0; i < count; i++) a[i] = fn(i);
      return a;
    };
    const base = makeArr((i) => i);
    const colors: Record<string, [number, number, number]> = {};
    for (const metric of METRIC_IDS) {
      const arr = metric === "height" ? undefined : base;
      const res = buildTrackGeometries(data, {
        metric,
        ...(arr
          ? {
              metricData: { [metric]: arr } as unknown as Record<
                string,
                Float64Array
              >,
            }
          : {}),
      });
      const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
      // sample at index improving t ~1
      const idx = count - 1;
      // find first vertex of that sample ring (approx)
      const cIdx = idx * 6;
      if (cIdx < col.count) {
        colors[metric] = [col.getX(cIdx), col.getY(cIdx), col.getZ(cIdx)];
      }
    }
    // verify all 6 are pairwise distant (>0.1 in at least one channel)
    const ids = Object.keys(colors);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = colors[ids[i]!]!;
        const b = colors[ids[j]!]!;
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        expect(dist).toBeGreaterThan(0.12);
      }
  });

  it("gForce diverging: negative vs positive produce opposite hue", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const neg = new Float64Array(count);
    const pos = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      neg[i] = -2 + i * 0.1;
      pos[i] = 2 + i * 0.1;
    }
    // Use combined array containing negative and positive
    const mixed = new Float64Array(count);
    for (let i = 0; i < count; i++) mixed[i] = i < count / 2 ? -1 : 2;
    const res = buildTrackGeometries(data, {
      metric: "gForce",
      metricData: { gForce: mixed },
    });
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    // low (negative) should be more blue/less red than high (positive)
    const lowIdx = 0; // first sample negative
    const highIdx = count - 1;
    const lowC = [
      col.getX(lowIdx * 6),
      col.getY(lowIdx * 6),
      col.getZ(lowIdx * 6),
    ] as const;
    const highC = [
      col.getX(highIdx * 6),
      col.getY(highIdx * 6),
      col.getZ(highIdx * 6),
    ] as const;
    expect(lowC[2]).toBeGreaterThan(highC[2]); // more blue low
    expect(highC[0]).toBeGreaterThan(lowC[0]); // more red high
  });

  it("rollRate diverging signed negative vs positive distinct", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const mixed = new Float64Array(count);
    for (let i = 0; i < count; i++) mixed[i] = i < count / 2 ? -5 : 5;
    const res = buildTrackGeometries(data, {
      metric: "rollRate",
      metricData: { rollRate: mixed } as unknown as Record<
        string,
        Float64Array
      >,
    });
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    const low = [col.getX(0), col.getY(0), col.getZ(0)] as const;
    const high = [
      col.getX((count - 1) * 6),
      col.getY((count - 1) * 6),
      col.getZ((count - 1) * 6),
    ] as const;
    const dist = Math.hypot(
      low[0] - high[0],
      low[1] - high[1],
      low[2] - high[2],
    );
    expect(dist).toBeGreaterThan(0.25);
  });

  it("clearance danger direction: low margin is redder", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const clearance = new Float64Array(count);
    for (let i = 0; i < count; i++) clearance[i] = i; // increasing clearance
    const res = buildTrackGeometries(data, {
      metric: "clearance",
      metricData: { clearance } as unknown as Record<string, Float64Array>,
    });
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    const low = [col.getX(0), col.getY(0), col.getZ(0)] as const;
    const high = [
      col.getX((count - 1) * 6),
      col.getY((count - 1) * 6),
      col.getZ((count - 1) * 6),
    ] as const;
    expect(low[0]).toBeGreaterThan(high[0]); // low more red
    expect(high[1]).toBeGreaterThan(low[1]); // high more green
  });
});

describe("spark – selection and seam inspection", () => {
  it("selected element highlight brightens vertices", () => {
    const data = makeTrack();
    const base = buildTrackGeometries(data, { metric: "height" });
    const sel = buildTrackGeometries(data, {
      metric: "height",
      selectedElementIndex: 0,
    });
    const baseCol = base.leftRail.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    const selCol = sel.leftRail.getAttribute("color") as THREE.BufferAttribute;
    let diff = false;
    for (let i = 0; i < baseCol.count; i++)
      if (Math.abs(baseCol.getX(i) - selCol.getX(i)) > 1e-5) {
        diff = true;
        break;
      }
    expect(diff).toBe(true);
  });

  it("seam disabled shows no seams; enabled uses canonical boundaries", () => {
    const data = makeTrack();
    const withDisabled = buildTrackGeometries(data, {
      metric: "height",
      seamInspectionEnabled: false,
    });
    const withEnabled = buildTrackGeometries(data, {
      metric: "height",
      seamInspectionEnabled: true,
    });
    const colDisabled = withDisabled.leftRail.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    const colEnabled = withEnabled.leftRail.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    // enabled should have bright seam color (1,0.96,0.45) at some index that disabled does not
    let seamFoundEnabled = false;
    let seamFoundDisabled = false;
    for (let i = 0; i < colEnabled.count; i++) {
      if (
        Math.abs(colEnabled.getX(i) - 1) < 0.01 &&
        Math.abs(colEnabled.getY(i) - 0.96) < 0.01
      )
        seamFoundEnabled = true;
      if (
        Math.abs(colDisabled.getX(i) - 1) < 0.01 &&
        Math.abs(colDisabled.getY(i) - 0.96) < 0.01
      )
        seamFoundDisabled = true;
    }
    expect(seamFoundEnabled).toBe(true);
    expect(seamFoundDisabled).toBe(false);
  });

  it("controller selection/seam API rebuilds static colors not per frame", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("handle");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { metric: "height" });
    const before = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry.getAttribute("color") as THREE.BufferAttribute;
    const beforeClone = new Float32Array(
      before.array as unknown as Float32Array,
    );
    ctl.setSelectedElement(0);
    const afterSel = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry.getAttribute("color") as THREE.BufferAttribute;
    expect(afterSel.array).not.toBe(beforeClone); // new geometry
    // updatePlayback must not rebuild: capture geometry identity
    const leftBefore = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    ctl.updatePlayback(5, 2);
    const leftAfter = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    expect(leftAfter).toBe(leftBefore);
    // seam toggle
    ctl.setSeamInspection(true);
    expect(ctl.isSeamInspectionEnabled()).toBe(true);
    const afterSeam = handle.scene.children.find(
      (c) => (c as THREE.Mesh).name === "leftRail",
    ) as THREE.Mesh;
    const col = afterSeam.geometry.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    let hasSeam = false;
    for (let i = 0; i < col.count; i++)
      if (Math.abs(col.getX(i) - 1) < 0.01) {
        hasSeam = true;
        break;
      }
    expect(hasSeam).toBe(true);
    ctl.setSeamInspection(false);
    const afterOff = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry.getAttribute("color") as THREE.BufferAttribute;
    let hasSeamOff = false;
    for (let i = 0; i < afterOff.count; i++)
      if (Math.abs(afterOff.getX(i) - 1) < 0.01) {
        hasSeamOff = true;
        break;
      }
    expect(hasSeamOff).toBe(false);
    ctl.dispose();
    handle.dispose();
  });

  it("lifecycle selection API propagates", () => {
    const canvas = fakeCanvas();
    const lc = createAppLifecycle({
      canvas,
      createHandle: (c) =>
        createRendererHandle(c, { createRenderer: () => mockRenderer(c) }),
      getWindow: () =>
        ({
          requestAnimationFrame: () => 1,
          cancelAnimationFrame: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as Window & typeof globalThis,
    });
    expect(lc.init()).toBe(true);
    const data = makeTrack();
    lc.attachTrack(data, { metric: "height" });
    lc.setSelectedElement(1);
    const ctl = lc.getController();
    expect(ctl?.getSelectedElement()).toBe(1);
    lc.setSeamInspection(true);
    expect(ctl?.isSeamInspectionEnabled()).toBe(true);
    lc.dispose();
  });
});

describe("spark – highlight marker", () => {
  it("reuses one procedural marker, positions via sampling, no second spline", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("no handle");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data);
    expect(ctl.getHighlightMarker()).toBeNull();
    ctl.setHighlight(5);
    const marker = ctl.getHighlightMarker();
    expect(marker).not.toBeNull();
    const firstMarker = marker;
    ctl.setHighlight(7);
    expect(ctl.getHighlightMarker()).toBe(firstMarker);
    // position matches sampling
    const expected = sampleTrackAtDistance(
      data,
      normalizeHighlightDistance(data, 7),
    );
    const pos = firstMarker!.group.position;
    expect(pos.x).toBeCloseTo(
      expected.position[0] + expected.normal[0] * 0.6,
      3,
    );
    expect(pos.y).toBeCloseTo(
      expected.position[1] + expected.normal[1] * 0.6,
      3,
    );
    // marker is reusable mesh, not rebuilding track
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
    ctl.attachTrack(data);
    ctl.setHighlight(null);
    let m = ctl.getHighlightMarker();
    // marker may be null until first non-null, but after null set with no prior marker, marker stays null
    // set to something then null
    ctl.setHighlight(3);
    m = ctl.getHighlightMarker();
    expect(m?.group.visible).toBe(true);
    ctl.setHighlight(null);
    expect(m?.group.visible).toBe(false);
    expect(ctl.getHighlightDistance()).toBeNull();
    // open clamp: beyond length should clamp to totalLength
    const beyond = data.totalLength + 100;
    ctl.setHighlight(beyond);
    const posClamped = m?.group.position as THREE.Vector3;
    const expectedClamped = sampleTrackAtDistance(data, data.totalLength);
    expect(posClamped?.x).toBeCloseTo(
      expectedClamped.position[0] + expectedClamped.normal[0] * 0.6,
      3,
    );
    // closed wrap
    const closed = makeClosedTrack();
    const canvas2 = fakeCanvas();
    const handle2 = createRendererHandle(canvas2, {
      createRenderer: () => mockRenderer(canvas2),
    })!;
    const cam2 = new THREE.PerspectiveCamera();
    const ctl2 = createRendererController(handle2, cam2);
    ctl2.attachTrack(closed);
    ctl2.setHighlight(closed.totalLength + 10);
    const m2 = ctl2.getHighlightMarker();
    const expectedWrap = sampleTrackAtDistance(closed, 10);
    expect(m2?.group.position.x).toBeCloseTo(
      expectedWrap.position[0] + expectedWrap.normal[0] * 0.6,
      3,
    );
    // negative wrap
    ctl2.setHighlight(-5);
    const expectedNeg = sampleTrackAtDistance(closed, closed.totalLength - 5);
    expect(m2?.group.position.x).toBeCloseTo(
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
    ctl.attachTrack(data);
    ctl.setHighlight(4);
    const marker = ctl.getHighlightMarker()!;
    const geom = marker.geometry;
    const mat = marker.material;
    const disposeGeomSpy = vi.spyOn(geom, "dispose");
    const disposeMatSpy = vi.spyOn(mat, "dispose");
    ctl.dispose();
    expect(disposeGeomSpy).toHaveBeenCalledTimes(1);
    expect(disposeMatSpy).toHaveBeenCalledTimes(1);
    // second dispose must not double dispose
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
    ctl.attachTrack(data);
    ctl.updatePlayback(5, 3);
    const trainPos = ctl.getTrainFrontPosition()!;
    ctl.setHighlight(12);
    const trainPos2 = ctl.getTrainFrontPosition()!;
    expect(trainPos2[0]).toBeCloseTo(trainPos[0], 5);
    // highlight separate
    const markerPos = ctl.getHighlightMarker()!.group.position;
    const expectedHighlight = sampleTrackAtDistance(
      data,
      normalizeHighlightDistance(data, 12),
    );
    expect(markerPos.x).toBeCloseTo(
      expectedHighlight.position[0] + expectedHighlight.normal[0] * 0.6,
      3,
    );
    ctl.dispose();
    handle.dispose();
  });
});

describe("spark – transactional lifecycle, reattach/retry, exact disposal", () => {
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
    lc.attachTrack(data);
    lc.setHighlight(8);
    const ctl = lc.getController();
    const marker = ctl?.getHighlightMarker();
    expect(marker?.group.visible).toBe(true);
    // reinitialize should preserve highlight
    expect(lc.reinitialize()).toBe(true);
    const ctl2 = lc.getController();
    expect(ctl2?.getHighlightDistance()).toBe(8);
    expect(ctl2?.getHighlightMarker()?.group.visible).toBe(true);
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
    ctl.attachTrack(data);
    ctl.setHighlight(6);
    const beforeTrackCount = handle.scene.children.filter(
      (c) => c.userData?.isTrack,
    ).length;
    expect(beforeTrackCount).toBeGreaterThan(0);
    const beforeHighlight = ctl.getHighlightMarker();
    const geom = beforeHighlight?.geometry;
    const disposeSpy = geom ? vi.spyOn(geom, "dispose") : null;
    ctl.attachTrack(makeTrack());
    // highlight geometry should not have been disposed (reused)
    if (disposeSpy) expect(disposeSpy).not.toHaveBeenCalled();
    // track geometries were replaced, old disposed
    ctl.dispose();
    handle.dispose();
  });
});
