import * as THREE from "three";
import {
  createDeterministicHeightfield,
  createTerrainGroup,
} from "./terrain.js";
import {
  resolveTerrainEnvironment,
  ROLLING_TERRAIN_PROFILE_ID,
  BLOCKING_TERRAIN_PROFILE_ID,
} from "../terrain/environment.js";

export interface RendererHandle {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer | null;
  dispose: () => void;
  resize: (width: number, height: number) => void;
  getDpr: () => number;
}

export interface CreateRendererOptions {
  onWebGLFailure?: (() => void) | undefined;
  dprCap?: number | undefined;
  enableShadows?: boolean | undefined;
  terrainSeed?: string | undefined;
  createRenderer?:
    ((canvas: HTMLCanvasElement) => THREE.WebGLRenderer) | undefined;
}

let _WebGLRendererForTest: typeof THREE.WebGLRenderer | null = null;
export function _setWebGLRendererForTest(
  ctor: typeof THREE.WebGLRenderer | null,
): void {
  _WebGLRendererForTest = ctor;
}

function buildScene(terrainSeed: string): THREE.Scene {
  const scene = new THREE.Scene();
  let terrainMesh: THREE.Mesh | null = null;
  let terrainGrid: THREE.GridHelper | null = null;
  let skyGeom: THREE.BufferGeometry | null = null;
  let skyMat: THREE.Material | null = null;
  let skyMesh: THREE.Mesh | null = null;
  try {
    scene.background = new THREE.Color(0x0a0f18);
    scene.fog = new THREE.Fog(0x0a0f18, 120, 420);

    const ambient = new THREE.HemisphereLight(0xcfe0ff, 0x1e2a22, 0.55);
    ambient.name = "hemisphere";
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff6e8, 1.35);
    sun.position.set(80, 120, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 420;
    sun.shadow.camera.left = -160;
    sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160;
    sun.shadow.camera.bottom = -160;
    sun.shadow.bias = -0.0006;
    sun.shadow.radius = 4;
    sun.name = "sun";
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9fb7ff, 0.28);
    fill.position.set(-60, 35, -40);
    fill.name = "fill";
    scene.add(fill);

    const env = (() => {
      // Prefer explicit profile IDs for deterministic terrain
      if (
        terrainSeed === ROLLING_TERRAIN_PROFILE_ID ||
        terrainSeed === BLOCKING_TERRAIN_PROFILE_ID
      ) {
        return resolveTerrainEnvironment(terrainSeed)!;
      }
      // "default-terrain" is the initial seed before any generation – map to rolling profile for footprint
      if (terrainSeed === "default-terrain") {
        return resolveTerrainEnvironment(ROLLING_TERRAIN_PROFILE_ID)!;
      }
      // For generic seeds, use legacy seeded generation – allows tests to spy on createDeterministicHeightfield
      return createDeterministicHeightfield(terrainSeed);
    })();
    const terrain = createTerrainGroup(env);
    terrainMesh = terrain.mesh;
    terrainGrid = terrain.grid;
    scene.add(terrainMesh);
    scene.add(terrainGrid);

    skyGeom = new THREE.SphereGeometry(800, 24, 16);
    skyMat = new THREE.MeshBasicMaterial({
      color: 0x161e2f,
      side: THREE.BackSide,
      fog: false,
    });
    skyMesh = new THREE.Mesh(skyGeom, skyMat);
    skyMesh.name = "sky";
    skyMesh.userData.isSky = true;
    scene.add(skyMesh);

    scene.userData.terrainEnv = env;

    // success – ownership transferred to scene, prevent double dispose in catch
    terrainMesh = null;
    terrainGrid = null;
    skyGeom = null;
    skyMat = null;
    skyMesh = null;

    return scene;
  } catch (e) {
    // Collect unique not-yet-attached resources to dispose exactly once;
    // attached resources will be disposed via disposeScene without double disposal.
    const geoms = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    if (skyMesh) {
      if (skyMesh.parent === null) {
        const g = skyMesh.geometry as unknown as
          THREE.BufferGeometry | undefined;
        if (g) geoms.add(g);
        const mat = (skyMesh as unknown as { material?: THREE.Material })
          .material;
        if (mat) {
          const arr = Array.isArray(mat) ? mat : [mat];
          for (const mm of arr) mats.add(mm);
        }
      }
    } else {
      if (skyGeom) geoms.add(skyGeom);
      if (skyMat) mats.add(skyMat);
    }
    if (terrainMesh && terrainMesh.parent === null) {
      const g = terrainMesh.geometry as unknown as
        THREE.BufferGeometry | undefined;
      if (g) geoms.add(g);
      const mat = (terrainMesh as unknown as { material?: THREE.Material })
        .material;
      if (mat) {
        const arr = Array.isArray(mat) ? mat : [mat];
        for (const mm of arr) mats.add(mm);
      }
    }
    if (terrainGrid && terrainGrid.parent === null) {
      const g = terrainGrid as unknown as {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (g.geometry) geoms.add(g.geometry);
      const m = g.material;
      if (m) {
        const arr = Array.isArray(m) ? m : [m];
        for (const mm of arr) mats.add(mm);
      }
    }
    for (const g of geoms) {
      try {
        g.dispose();
      } catch {
        // ignore
      }
    }
    for (const m of mats) {
      try {
        m.dispose();
      } catch {
        // ignore
      }
    }
    try {
      disposeScene(scene);
    } catch {
      // ignore
    }
    throw e;
  }
}

export function createRendererHandle(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): RendererHandle | null {
  const dprCap = options.dprCap ?? 2;
  const onFailure = options.onWebGLFailure;

  let renderer: THREE.WebGLRenderer | null = null;

  if (options.createRenderer !== undefined) {
    renderer = options.createRenderer(canvas);
    if (!renderer) {
      onFailure?.();
      return null;
    }
  } else {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        antialias: true,
        alpha: false,
      }) as unknown as WebGL2RenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) {
      onFailure?.();
      return null;
    }
    {
      const Ctor = _WebGLRendererForTest ?? THREE.WebGLRenderer;
      renderer = new Ctor({
        canvas,
        context: gl as unknown as WebGLRenderingContext,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    }
    if (!renderer) {
      onFailure?.();
      return null;
    }
  }

  // transactional setup after renderer allocation – any throw disposes renderer + scene
  let scene: THREE.Scene | null = null;
  try {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const enableShadows = options.enableShadows ?? true;
    renderer.shadowMap.enabled = enableShadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const getDprNow = (): number => {
      const maybeWin = globalThis as unknown as {
        devicePixelRatio?: number;
        window?: { devicePixelRatio?: number };
      };
      const raw =
        maybeWin.window?.devicePixelRatio ?? maybeWin.devicePixelRatio ?? 1;
      return Math.min(raw, dprCap);
    };
    const dpr = getDprNow();
    renderer.setPixelRatio(dpr);

    scene = buildScene(options.terrainSeed ?? "default-terrain");

    const localScene = scene;
    const localRenderer = renderer;
    const resize = (width: number, height: number): void => {
      localRenderer?.setSize(width, height, false);
      localRenderer?.setPixelRatio(getDprNow());
    };

    const dispose = (): void => {
      disposeScene(localScene);
      try {
        localRenderer?.dispose();
      } catch {
        // ignore
      }
    };

    try {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) resize(rect.width, rect.height);
    } catch {
      // ignore
    }

    return {
      scene: localScene,
      renderer: localRenderer,
      dispose,
      resize,
      getDpr: () => getDprNow(),
    };
  } catch (e) {
    if (scene) {
      try {
        disposeScene(scene);
      } catch {
        // ignore
      }
    }
    try {
      renderer.dispose();
    } catch {
      // ignore
    }
    throw e;
  }
}

export function disposeScene(scene: THREE.Scene): void {
  const toRemove = [...scene.children];
  for (const obj of toRemove) scene.remove(obj);

  const seenGeoms = new Set<THREE.BufferGeometry>();
  const seenMats = new Set<THREE.Material>();
  const disposeObject = (root: THREE.Object3D): void => {
    for (const child of root.children) disposeObject(child);
    const mesh = root as unknown as {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    const geom = mesh.geometry as unknown as THREE.BufferGeometry | undefined;
    if (geom && !seenGeoms.has(geom)) {
      seenGeoms.add(geom);
      try {
        geom.dispose();
      } catch {
        // ignore
      }
    }
    const mat = mesh.material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        if (seenMats.has(m)) continue;
        seenMats.add(m);
        try {
          m.dispose();
        } catch {
          // ignore
        }
        for (const key of Object.keys(
          m as unknown as Record<string, unknown>,
        )) {
          const val = (m as unknown as Record<string, unknown>)[key];
          if (
            val !== null &&
            val !== undefined &&
            typeof (val as { dispose?: () => void }).dispose === "function" &&
            (val as { isTexture?: boolean }).isTexture === true
          ) {
            try {
              (val as { dispose: () => void }).dispose();
            } catch {
              // ignore
            }
          }
        }
      }
    }
  };
  for (const obj of toRemove) disposeObject(obj);
  scene.clear();
}
