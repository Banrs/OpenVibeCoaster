import * as THREE from "three";
import {
  sampleCompiledTrack,
  type CompiledTrackData,
} from "@openvibecoaster/core";

export interface HighlightMarker {
  group: THREE.Group;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export function normalizeHighlightDistance(
  data: CompiledTrackData,
  distance: number,
  closedTrack = false,
): number {
  const total = data.totalLength;
  if (total <= 1e-9) return 0;
  if (!Number.isFinite(distance)) return 0;
  if (closedTrack) {
    let wrapped = distance % total;
    if (wrapped < 0) wrapped += total;
    // Handle floating point edge where wrapped ~ total and exact endpoint consistently maps to 0
    if (wrapped >= total - 1e-9) wrapped = 0;
    if (wrapped < 0) wrapped = 0;
    if (wrapped > total) wrapped = total;
    return wrapped;
  }
  return Math.max(0, Math.min(total, distance));
}

export function createHighlightMarker(): HighlightMarker {
  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.Material | null = null;
  let mesh: THREE.Mesh | null = null;
  let group: THREE.Group | null = null;
  try {
    geometry = new THREE.SphereGeometry(0.42, 16, 12);
    material = new THREE.MeshStandardMaterial({
      color: 0xffff55,
      emissive: 0xffaa00,
      emissiveIntensity: 0.7,
      roughness: 0.35,
      metalness: 0.05,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.name = "highlightMarkerMesh";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.isHighlight = true;

    group = new THREE.Group();
    group.name = "highlightMarker";
    group.userData.isHighlight = true;
    group.add(mesh);
    group.visible = false;

    const result: HighlightMarker = {
      group,
      mesh,
      geometry,
      material,
    };
    geometry = null;
    material = null;
    mesh = null;
    group = null;
    return result;
  } catch (e) {
    if (mesh && mesh.parent) {
      try {
        mesh.parent.remove(mesh);
      } catch {
        // ignore
      }
    }
    if (geometry) {
      try {
        geometry.dispose();
      } catch {
        // ignore
      }
    }
    if (material) {
      try {
        material.dispose();
      } catch {
        // ignore
      }
    }
    if (group) {
      try {
        // group has no geometry itself
      } catch {
        // ignore
      }
    }
    throw e;
  }
}

export function updateHighlightMarker(
  marker: HighlightMarker,
  data: CompiledTrackData | null,
  distance: number | null,
  closedTrack = false,
): void {
  if (distance === null || data === null) {
    marker.group.visible = false;
    return;
  }
  if (!Number.isFinite(distance)) {
    marker.group.visible = false;
    return;
  }
  const total = data.totalLength;
  if (total <= 1e-9) {
    marker.group.visible = false;
    return;
  }
  const normalized = normalizeHighlightDistance(data, distance, closedTrack);
  const t = total === 0 ? 0 : normalized / total;
  // Use canonical sampling – no second spline
  const sample = sampleCompiledTrack(data, t);
  const upOffset = 0.6;
  const x = sample.position[0] + sample.normal[0] * upOffset;
  const y = sample.position[1] + sample.normal[1] * upOffset;
  const z = sample.position[2] + sample.normal[2] * upOffset;
  marker.group.position.set(x, y, z);
  // Align marker orientation to track normal for visual coherence (optional)
  marker.group.quaternion.set(
    sample.normal[0] * 0.1,
    sample.normal[1] * 0.1,
    sample.normal[2] * 0.1,
    1,
  );
  marker.group.visible = true;
}

export function disposeHighlightMarker(marker: HighlightMarker): void {
  try {
    marker.group.remove(marker.mesh);
  } catch {
    // ignore
  }
  try {
    marker.geometry.dispose();
  } catch {
    // ignore
  }
  try {
    marker.material.dispose();
  } catch {
    // ignore
  }
  // group itself has no disposable resources beyond children already handled
}
