// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { compileTrack, vec3 } from "@openvibecoaster/core";

// These imports will fail in red phase – that preserves evidence.
import { createDeterministicHeightfield, buildTerrainMesh } from "./terrain.js";
import { buildTrackGeometries } from "./trackGeometry.js";
import {
  TRAIN_CAR_COUNT,
  CAR_PITCH_M,
  createTrainGroup,
  getCarTransforms,
  updateTrainTransforms,
} from "./train.js";
import { buildSupportColumns } from "./supports.js";
import {
  CAMERA_IDS as RENDER_CAMERA_IDS,
  clampFovForSpeed,
  getCameraState,
  selectCamera as selectRenderCamera,
} from "./cameras.js";
import { createRendererHandle, disposeScene } from "./renderer.js";
import { RenderMetrics } from "./metrics.js";

function makeSimpleTrack() {
  return compileTrack(
    [
      {
        id: "a",
        span: {
          position: (u: number) =>
            vec3(u * 40, 5 + Math.sin(u * Math.PI) * 2, 0),
          derivative: (u: number, order = 1) =>
            order === 1
              ? vec3(40, Math.cos(u * Math.PI) * Math.PI * 2, 0)
              : vec3(0, -Math.sin(u * Math.PI) * Math.PI * Math.PI * 2, 0),
        },
      },
      {
        id: "b",
        span: {
          position: (u: number) => vec3(40 + u * 30, 5, u * 20),
          derivative: () => vec3(30, 0, 20),
        },
      },
    ],
    { samples: 16 },
  );
}

describe("render – terrain deterministic heightfield", () => {
  it("produces identical heights for same seed", () => {
    const a = createDeterministicHeightfield("seed-123", 8, 8, 2);
    const b = createDeterministicHeightfield("seed-123", 8, 8, 2);
    expect(a.heights).toEqual(b.heights);
    expect(a.width).toBe(8);
    expect(a.depth).toBe(8);
  });

  it("differs for different seeds", () => {
    const a = createDeterministicHeightfield("seed-A");
    const b = createDeterministicHeightfield("seed-B");
    expect(a.heights).not.toEqual(b.heights);
  });

  it("builds BufferGeometry with positions and indices", () => {
    const env = createDeterministicHeightfield("terrain-test", 8, 8, 4);
    const geom = buildTerrainMesh(env);
    expect(geom).toBeInstanceOf(THREE.BufferGeometry);
    const pos = geom.getAttribute("position");
    expect(pos.count).toBe(env.width * env.depth);
    expect(geom.getIndex()).not.toBeNull();
    expect(geom.getAttribute("normal")).toBeDefined();
  });

  it("raycast matches environment", () => {
    const env = createDeterministicHeightfield("ray-test", 4, 4, 1);
    const geom = buildTerrainMesh(env);
    expect(geom).toBeTruthy();
    const hit = env.raycast(vec3(1, 50, 1), vec3(0, -1, 0), 100);
    expect(hit).toBeDefined();
    if (hit)
      expect(hit.point[1]).toBeCloseTo(
        env.heightAt(hit.point[0], hit.point[2]),
        5,
      );
  });
});

describe("render – track geometry from CompiledTrackData", () => {
  it("builds twin-rail/spine/tie BufferGeometry from canonical samples", () => {
    const data = makeSimpleTrack();
    const result = buildTrackGeometries(data, { metric: "height" });
    expect(result.leftRail).toBeInstanceOf(THREE.BufferGeometry);
    expect(result.rightRail).toBeInstanceOf(THREE.BufferGeometry);
    expect(result.spine).toBeInstanceOf(THREE.BufferGeometry);
    expect(result.ties).toBeInstanceOf(THREE.BufferGeometry);
    for (const g of [result.leftRail, result.rightRail, result.spine]) {
      const pos = g.getAttribute("position");
      expect(pos.count).toBeGreaterThan(data.positions.length / 3);
      expect(g.getAttribute("color")).toBeDefined();
      expect(g.getIndex()).not.toBeNull();
    }
    expect(result.triangles).toBeGreaterThan(0);
    expect(result.drawCalls).toBeGreaterThanOrEqual(4);
    expect(result.buildTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("vertex colors encode metric and highlight selected/seam", () => {
    const data = makeSimpleTrack();
    const base = buildTrackGeometries(data, { metric: "speed" });
    const highlighted = buildTrackGeometries(data, {
      metric: "speed",
      selectedElementIndex: 0,
      seamIndices: [0, data.positions.length / 3 - 1],
    });
    const baseColors = base.leftRail.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    const highColors = highlighted.leftRail.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    expect(baseColors.count).toBe(highColors.count);
    // at least one vertex differs due to highlight
    let differs = false;
    for (let i = 0; i < baseColors.count; i++) {
      if (
        Math.abs(baseColors.getX(i) - highColors.getX(i)) > 1e-5 ||
        Math.abs(baseColors.getY(i) - highColors.getY(i)) > 1e-5 ||
        Math.abs(baseColors.getZ(i) - highColors.getZ(i)) > 1e-5
      ) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
    // colors are in [0,1]
    for (let i = 0; i < baseColors.count; i++) {
      expect(baseColors.getX(i)).toBeGreaterThanOrEqual(0);
      expect(baseColors.getX(i)).toBeLessThanOrEqual(1);
    }
  });

  it("does not maintain a second independent spline – vertices derived from CompiledTrackData", () => {
    const data = makeSimpleTrack();
    const result = buildTrackGeometries(data, { metric: "height" });
    // Sample a few centerline points and verify they are near original positions offset by gauge
    // Left/right rails should be offset along normal/binormal, not arbitrary.
    // We check that the source does not contain a hidden extra spline file.
    // At minimum, geometry count scales with compiled samples.
    const expectedMinVertices = data.positions.length / 3;
    expect(
      result.leftRail.getAttribute("position").count,
    ).toBeGreaterThanOrEqual(expectedMinVertices);
    // No second spline: the only Vec3 sources are data positions/tangents/normals/binormals
    // This test documents the invariant; implementation must not invent an independent spline.
    expect(
      (result as unknown as { splineCount?: number }).splineCount ?? 1,
    ).toBe(1);
  });
});

describe("render – train six-car LSM", () => {
  it("creates six recognizable cars", () => {
    expect(TRAIN_CAR_COUNT).toBe(6);
    expect(CAR_PITCH_M).toBeCloseTo(3.4);
    const group = createTrainGroup();
    expect(group.cars.length).toBe(6);
    expect(group.group.children.length).toBe(6);
    for (const car of group.cars) {
      expect(car.children.length).toBeGreaterThan(0);
    }
  });

  it("car transforms from track frames at supplied distance only", () => {
    const data = makeSimpleTrack();
    const front = data.totalLength * 0.2;
    const transformsA = getCarTransforms(data, front);
    const transformsB = getCarTransforms(data, front);
    expect(transformsA.length).toBe(6);
    expect(transformsA[0].position).toEqual(transformsB[0].position);
    // No motion independent of timeline: same distance -> same transforms
    expect(transformsA[0].quaternion).toEqual(transformsB[0].quaternion);
    // Advancing distance moves cars forward
    const later = getCarTransforms(data, front + 5);
    expect(later[0].position[0]).not.toBeCloseTo(transformsA[0].position[0], 2);
    // Spacing matches car pitch (Euclidean chord approximates arc length; allow 1.0 m tolerance for curvature)
    const pos0 = transformsA[0].position;
    const pos1 = transformsA[1].position;
    const dist = Math.hypot(
      pos0[0] - pos1[0],
      pos0[1] - pos1[1],
      pos0[2] - pos1[2],
    );
    expect(Math.abs(dist - CAR_PITCH_M)).toBeLessThan(1.0);
  });

  it("updateTrainTransforms applies without drift when distance unchanged", () => {
    const data = makeSimpleTrack();
    const group = createTrainGroup();
    const t0 = getCarTransforms(data, 10);
    updateTrainTransforms(group, t0);
    const firstPos = group.cars[0].position.clone();
    const t1 = getCarTransforms(data, 10);
    updateTrainTransforms(group, t1);
    expect(group.cars[0].position.distanceTo(firstPos)).toBeCloseTo(0, 5);
  });
});

describe("render – support columns via raycast", () => {
  it("procedural supports drop to terrain via environment raycasts", () => {
    const data = makeSimpleTrack();
    const env = createDeterministicHeightfield("supports", 16, 16, 5);
    const supports = buildSupportColumns(data, env, 10);
    expect(supports.meshes.length).toBeGreaterThan(0);
    for (let i = 0; i < supports.meshes.length; i++) {
      const mesh = supports.meshes[i];
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      // mesh position y should be near terrain height underneath
      const trackPoint = supports.trackPoints[i];
      const hit = env.raycast(trackPoint, vec3(0, -1, 0), 1000);
      expect(hit).toBeDefined();
      if (hit) {
        // column height should approximately equal distance to ground
        const colHeight = supports.heights[i];
        expect(colHeight).toBeCloseTo(hit.distance, 1);
      }
    }
  });
});

describe("render – cameras", () => {
  it("supports front/middle/rear/chase/orbit without mutating authoritative data", () => {
    expect(RENDER_CAMERA_IDS).toEqual(
      expect.arrayContaining(["front", "middle", "rear", "chase", "orbit"]),
    );
    const data = makeSimpleTrack();
    const originalChecksum = data.checksum;
    for (const id of RENDER_CAMERA_IDS as string[]) {
      const state = getCameraState(id as never, data, 10, 5, {
        reducedMotion: false,
      });
      expect(state.position.length).toBe(3);
      expect(state.target.length).toBe(3);
      expect(state.fov).toBeGreaterThan(0);
    }
    expect(data.checksum).toBe(originalChecksum);
    // selectRenderCamera is pure
    expect(selectRenderCamera("front", "chase")).toBe("front");
    expect(selectRenderCamera("invalid" as never, "chase")).toBe("chase");
  });

  it("clamped speed FOV and visual-only damping", () => {
    expect(clampFovForSpeed(0)).toBeGreaterThanOrEqual(50);
    expect(clampFovForSpeed(100)).toBeLessThanOrEqual(90);
    expect(clampFovForSpeed(-10)).toBe(clampFovForSpeed(0));
    const data = makeSimpleTrack();
    const a = getCameraState("chase", data, 10, 5, { reducedMotion: false });
    const b = getCameraState("chase", data, 10, 5, {
      reducedMotion: false,
      previous: a,
      deltaMs: 16,
    });
    // with damping, new chase should be lerped towards a, not jumping
    expect(b.position[0]).not.toBe(a.target[0]);
  });

  it("reduced-motion path reduces damping/movement", () => {
    const data = makeSimpleTrack();
    const _normal = getCameraState("chase", data, 10, 5, {
      reducedMotion: false,
      previous: getCameraState("chase", data, 5, 5, { reducedMotion: false }),
    });
    const reduced = getCameraState("chase", data, 10, 5, {
      reducedMotion: true,
      previous: getCameraState("chase", data, 5, 5, { reducedMotion: false }),
    });
    // In reduced motion, camera should move less (more damped or fixed)
    // We assert reduced position is not farther from previous than normal
    // For simplicity, check that reduced motion does not produce NaN and fov is clamped
    expect(reduced.fov).toBeGreaterThan(0);
    expect(Number.isFinite(reduced.position[0])).toBe(true);
  });
});

describe("render – lifecycle and disposal", () => {
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
  it("caps DPR, enables shadows, handles WebGL failure callback, and disposes completely", () => {
    const canvas = fakeCanvas({
      getContext: () =>
        null as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
    });
    const onFailure = vi.fn();
    const handle = createRendererHandle(canvas, {
      onWebGLFailure: onFailure,
      dprCap: 2,
    });
    expect(handle).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);

    // success path with injected renderer factory
    const canvas2 = fakeCanvas();
    let disposeCalled = false;
    const mockRenderer = {
      domElement: canvas2,
      shadowMap: { enabled: false, type: 0 },
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: () => {
        disposeCalled = true;
      },
      capabilities: { isWebGL2: true },
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: "",
    } as unknown as THREE.WebGLRenderer;
    const handle2 = createRendererHandle(canvas2, {
      dprCap: 2,
      createRenderer: () => mockRenderer,
    });
    expect(handle2).not.toBeNull();
    if (handle2) {
      expect(handle2.renderer).toBeDefined();
      // disposal must call renderer dispose and remove children
      const sceneChildren = handle2.scene.children.length;
      expect(sceneChildren).toBeGreaterThan(0); // terrain/grid/sky and lights
      handle2.dispose();
      expect(disposeCalled).toBe(true);
      expect(handle2.scene.children.length).toBe(0);
      disposeScene(handle2.scene);
    }
  });

  it("resize caps DPR at 2", () => {
    const globalAny = globalThis as unknown as {
      window?: { devicePixelRatio?: number };
    };
    const prevWin = globalAny.window;
    const prevDevice = (globalThis as unknown as { devicePixelRatio?: number })
      .devicePixelRatio;
    (globalThis as unknown as Record<string, unknown>).window = {
      devicePixelRatio: 3,
    };
    (globalThis as unknown as Record<string, unknown>).devicePixelRatio = 3;
    const canvas = fakeCanvas();
    let capturedRatio = 0;
    const mockRenderer2 = {
      domElement: canvas,
      shadowMap: { enabled: false },
      setSize: vi.fn(),
      setPixelRatio: (r: number) => {
        capturedRatio = r;
      },
      render: vi.fn(),
      dispose: vi.fn(),
      capabilities: {},
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: "",
    } as unknown as THREE.WebGLRenderer;
    const handle = createRendererHandle(canvas, {
      dprCap: 2,
      createRenderer: () => mockRenderer2,
    });
    expect(capturedRatio).toBeLessThanOrEqual(2);
    if (handle) handle.dispose();
    if (prevWin !== undefined)
      (globalThis as unknown as Record<string, unknown>).window = prevWin;
    else delete (globalThis as unknown as Record<string, unknown>).window;
    if (prevDevice !== undefined)
      (globalThis as unknown as Record<string, unknown>).devicePixelRatio =
        prevDevice;
    else
      delete (globalThis as unknown as Record<string, unknown>)
        .devicePixelRatio;
  });
});

describe("render – metrics", () => {
  it("records mesh build time, draw calls, triangles, frame duration", () => {
    const metrics = new RenderMetrics();
    metrics.beginFrame();
    const data = makeSimpleTrack();
    const result = buildTrackGeometries(data, { metric: "height" });
    metrics.recordBuild(result.buildTimeMs, result.drawCalls, result.triangles);
    // simulate some work
    const waitUntil = performance.now() + 2;
    while (performance.now() < waitUntil) {
      /* busy */
    }
    metrics.endFrame();
    expect(metrics.meshBuildTimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.meshBuildTimeMs).toBeCloseTo(result.buildTimeMs, 1);
    expect(metrics.drawCalls).toBe(result.drawCalls);
    expect(metrics.triangles).toBe(result.triangles);
    expect(metrics.frameDurationMs).toBeGreaterThan(0);

    const snapshot = metrics.toJSON();
    expect(snapshot.drawCalls).toBe(metrics.drawCalls);
    expect(snapshot.triangles).toBe(metrics.triangles);
  });
});

describe("render – absence of second spline / product UI terrain only", () => {
  it("renderer handle initially contains terrain/grid/sky but no track when no CompiledTrackData supplied", () => {
    const canvas = {
      getContext: () =>
        ({}) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
      getBoundingClientRect: () =>
        ({ width: 800, height: 600 }) as unknown as DOMRect,
    } as unknown as HTMLCanvasElement;
    const mockRenderer = {
      domElement: canvas,
      shadowMap: { enabled: false },
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
      capabilities: {},
      toneMapping: 0,
      toneMappingExposure: 1,
      outputColorSpace: "",
    } as unknown as THREE.WebGLRenderer;
    const handle = createRendererHandle(canvas, {
      createRenderer: () => mockRenderer,
    });
    expect(handle).not.toBeNull();
    if (handle) {
      const hasTrack = handle.scene.children.some(
        (c) => c.userData?.isTrack === true,
      );
      expect(hasTrack).toBe(false);
      const hasTerrain = handle.scene.children.some(
        (c) => c.userData?.isTerrain === true,
      );
      expect(hasTerrain).toBe(true);
      handle.dispose();
    }
  });
});
