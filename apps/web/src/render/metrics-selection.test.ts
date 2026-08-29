import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "@openvibecoaster/core";
import { buildTrackGeometries } from "./trackGeometry.js";
import { createRendererHandle } from "./renderer.js";
import { createRendererController } from "./controller.js";
import { createAppLifecycle } from "./lifecycle.js";
import { METRIC_IDS } from "./metricContract.js";

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

describe("metrics – metric union supports six metrics", () => {
  it("METRIC_IDS includes six required ids", () => {
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

describe("metrics – MetricData availability: missing, misaligned, non-finite", () => {
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
      expect(col.getX(0)).toBeCloseTo(0.6, 1);
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

  it("height derives only from positions and always available", () => {
    const data = makeTrack();
    const res = buildTrackGeometries(data, { metric: "height" });
    expect(res.metricAvailable).toBe(true);
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    let anyNonNeutral = false;
    for (let i = 0; i < col.count; i++)
      if (Math.abs(col.getX(i) - 0.6) > 0.05) {
        anyNonNeutral = true;
        break;
      }
    expect(anyNonNeutral).toBe(true);
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
  });
});

describe("metrics – deterministic distinct coloring", () => {
  it("each metric yields visibly distinct palette for same t", () => {
    const data = makeTrack();
    const count = data.distances.length;
    const base = new Float64Array(count);
    for (let i = 0; i < count; i++) base[i] = i;
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
      const idx = count - 1;
      const cIdx = idx * 6;
      if (cIdx < col.count) {
        colors[metric] = [col.getX(cIdx), col.getY(cIdx), col.getZ(cIdx)];
      }
    }
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
    const mixed = new Float64Array(count);
    for (let i = 0; i < count; i++) mixed[i] = i < count / 2 ? -1 : 2;
    const res = buildTrackGeometries(data, {
      metric: "gForce",
      metricData: { gForce: mixed },
    });
    const col = res.leftRail.getAttribute("color") as THREE.BufferAttribute;
    const lowIdx = 0;
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
    expect(lowC[2]).toBeGreaterThan(highC[2]);
    expect(highC[0]).toBeGreaterThan(lowC[0]);
  });

  it("rollRate diverging signed distinct", () => {
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
    for (let i = 0; i < count; i++) clearance[i] = i;
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
    expect(low[0]).toBeGreaterThan(high[0]);
    expect(high[1]).toBeGreaterThan(low[1]);
  });
});

describe("selection – seam inspection", () => {
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

  it("controller selection/seam rebuilds static colors not per frame", () => {
    const canvas = fakeCanvas();
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer(canvas),
    });
    if (!handle) throw new Error("handle");
    const cam = new THREE.PerspectiveCamera();
    const ctl = createRendererController(handle, cam);
    const data = makeTrack();
    ctl.attachTrack(data, { metric: "height" });
    const leftBefore = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    ctl.setSelectedElement(0);
    const leftAfterSel = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    expect(leftAfterSel).not.toBe(leftBefore);
    const leftBeforePlayback = leftAfterSel;
    ctl.updatePlayback(5, 2);
    const leftAfterPlayback = (
      handle.scene.children.find(
        (c) => (c as THREE.Mesh).name === "leftRail",
      ) as THREE.Mesh
    ).geometry;
    expect(leftAfterPlayback).toBe(leftBeforePlayback);
    ctl.setSeamInspection(true);
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

  it("lifecycle selection API propagates via attachment", () => {
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
    expect(lc.getAttachment()?.options.selectedElementIndex).toBe(1);
    lc.setSeamInspection(true);
    expect(lc.getAttachment()?.options.seamInspectionEnabled).toBe(true);
    lc.setSelectedElement(null);
    expect(lc.getAttachment()?.options.selectedElementIndex).toBeUndefined();
    lc.dispose();
  });

  it("updateSelection null clears selection without leaking key", () => {
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
    lc.attachTrack(data, { selectedElementIndex: 0 });
    expect(lc.getAttachment()?.options.selectedElementIndex).toBe(0);
    lc.updateSelection({ selectedElementIndex: null });
    expect("selectedElementIndex" in (lc.getAttachment()?.options ?? {})).toBe(
      false,
    );
    lc.dispose();
  });
});
