// @ts-nocheck
import * as THREE from "three";
import {
  createDeterministicHeightfield,
  createTerrainGroup,
} from "./terrain.js";

export interface RendererHandle {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer | null;
  dispose: () => void;
  resize: (width: number, height: number) => void;
  getDpr: () => number;
}

export interface CreateRendererOptions {
  onWebGLFailure?: () => void;
  dprCap?: number;
  enableShadows?: boolean;
  terrainSeed?: string;
  createRenderer?: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;
}

function supportsWebGL(canvas: HTMLCanvasElement): boolean {
  try {
    return Boolean(
      canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

function buildScene(terrainSeed: string): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f18);
  scene.fog = new THREE.Fog(0x0a0f18, 120, 420);

  // Restrained physically coherent lighting: ambient + directional sun with soft shadows
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

  // Fill light, very restrained
  const fill = new THREE.DirectionalLight(0x9fb7ff, 0.28);
  fill.position.set(-60, 35, -40);
  fill.name = "fill";
  scene.add(fill);

  // Deterministic terrain + grid + sky dome via environment treatment
  const env = createDeterministicHeightfield(terrainSeed);
  const { mesh, grid } = createTerrainGroup(env);
  scene.add(mesh);
  scene.add(grid);

  // Sky dome – simple large sphere with gradient via shaderless color
  const skyGeom = new THREE.SphereGeometry(800, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    color: 0x161e2f,
    side: THREE.BackSide,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeom, skyMat);
  sky.name = "sky";
  sky.userData.isSky = true;
  scene.add(sky);

  scene.userData.terrainEnv = env;

  return scene;
}

export function createRendererHandle(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): RendererHandle | null {
  const dprCap = options.dprCap ?? 2;
  const onFailure = options.onWebGLFailure;

  if (!supportsWebGL(canvas)) {
    onFailure?.();
    return null;
  }

  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = options.createRenderer
      ? options.createRenderer(canvas)
      : new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        });
  } catch {
    onFailure?.();
    return null;
  }

  if (!renderer) {
    onFailure?.();
    return null;
  }

  // Restrained PBR renderer config
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = options.enableShadows ?? true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

  const scene = buildScene(options.terrainSeed ?? "default-terrain");

  // Initial size: match canvas CSS size, but tests don't depend on real size
  const resize = (width: number, height: number): void => {
    renderer?.setSize(width, height, false);
    renderer?.setPixelRatio(getDprNow());
  };

  const dispose = (): void => {
    disposeScene(scene);
    renderer?.dispose();
    // Remove reference
    (renderer as unknown as { domElement?: unknown }) =
      undefined as unknown as never;
  };

  // Size to current rect if available
  try {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) resize(rect.width, rect.height);
  } catch {
    // ignore
  }

  return {
    scene,
    renderer,
    dispose,
    resize,
    getDpr: () => getDprNow(),
  };
}

export function disposeScene(scene: THREE.Scene): void {
  // Complete disposal: traverse, dispose geometries/materials/textures
  const toRemove = [...scene.children];
  for (const obj of toRemove) scene.remove(obj);

  // Walk all objects recursively
  const disposeObject = (root: THREE.Object3D): void => {
    for (const child of root.children) disposeObject(child);
    // @ts-expect-error material/geometry may exist
    const mesh = root as THREE.Mesh;
    if (mesh.geometry) {
      try {
        mesh.geometry.dispose();
      } catch {
        /* ignore */
      }
    }
    const mat = (
      mesh as unknown as { material?: THREE.Material | THREE.Material[] }
    ).material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        try {
          m.dispose();
        } catch {
          /* ignore */
        }
        // dispose textures
        for (const key of Object.keys(
          m as unknown as Record<string, unknown>,
        )) {
          const val = (m as unknown as Record<string, unknown>)[key];
          if (
            val &&
            typeof (val as { dispose?: () => void }).dispose === "function" &&
            (val as { isTexture?: boolean }).isTexture
          ) {
            try {
              (val as { dispose: () => void }).dispose();
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  };
  for (const obj of toRemove) disposeObject(obj);
  scene.clear();
}
