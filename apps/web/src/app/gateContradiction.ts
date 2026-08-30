import type { Diagnostic } from "@openvibecoaster/core";
import type { DirectedEditorInput } from "../directedInput.js";

function getFootprintBounds(footprint: DirectedEditorInput["footprint"]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
} | null {
  const polygon = footprint.polygon;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let hasFinite = false;
  for (const point of polygon) {
    const x = point[0];
    const z = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    hasFinite = true;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (
    !hasFinite ||
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxZ)
  ) {
    return null;
  }
  const minY = footprint.minHeightM ?? 0;
  const maxY = footprint.maxHeightM;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

export function detectGateContradictions(
  input: DirectedEditorInput,
): Diagnostic[] {
  const bounds = getFootprintBounds(input.footprint);
  if (!bounds) return [];
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < input.gates.length; i++) {
    const gate = input.gates[i]!;
    const pos = gate.position;
    const x = pos[0];
    const y = pos[1];
    const z = pos[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      continue;

    if (x < bounds.minX || x > bounds.maxX) {
      const limit = x < bounds.minX ? bounds.minX : bounds.maxX;
      const actual = x;
      const margin = -Math.abs(actual - limit);
      diagnostics.push({
        code: "GATE_OUTSIDE_FOOTPRINT",
        severity: "error",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${i} X=${x} outside footprint X [${bounds.minX},${bounds.maxX}]`,
        actual,
        limit,
        margin,
      });
    }
    if (z < bounds.minZ || z > bounds.maxZ) {
      const limit = z < bounds.minZ ? bounds.minZ : bounds.maxZ;
      const actual = z;
      const margin = -Math.abs(actual - limit);
      diagnostics.push({
        code: "GATE_OUTSIDE_FOOTPRINT",
        severity: "error",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${i} Z=${z} outside footprint Z [${bounds.minZ},${bounds.maxZ}]`,
        actual,
        limit,
        margin,
      });
    }
    if (y < bounds.minY || y > bounds.maxY) {
      const limit = y < bounds.minY ? bounds.minY : bounds.maxY;
      const actual = y;
      const margin = -Math.abs(actual - limit);
      diagnostics.push({
        code: "GATE_OUTSIDE_HEIGHT",
        severity: "error",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${i} Y=${y} outside height range [${bounds.minY},${bounds.maxY}]`,
        actual,
        limit,
        margin,
      });
    }
  }
  return diagnostics;
}
