import * as THREE from "three";

export function addMeshDisposables(
  source: {
    geometry?: THREE.BufferGeometry | undefined;
    material?: THREE.Material | THREE.Material[] | undefined;
  },
  geoms: Set<THREE.BufferGeometry>,
  mats: Set<THREE.Material>,
): void {
  if (source.geometry) geoms.add(source.geometry);
  const mat = source.material;
  if (mat) {
    const arr = Array.isArray(mat) ? mat : [mat];
    for (const mm of arr) mats.add(mm);
  }
}

export function collectFromGroups(
  groups: THREE.Group[],
  geoms: Set<THREE.BufferGeometry>,
  mats: Set<THREE.Material>,
): void {
  for (const group of groups) {
    for (const child of group.children) {
      const mesh = child as unknown as {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      addMeshDisposables(mesh, geoms, mats);
    }
  }
}

export function disposeSets(
  geoms: Set<THREE.BufferGeometry>,
  mats: Set<THREE.Material>,
): void {
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
}

export function disposeGroups(groups: THREE.Group[]): void {
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  collectFromGroups(groups, geoms, mats);
  disposeSets(geoms, mats);
}
