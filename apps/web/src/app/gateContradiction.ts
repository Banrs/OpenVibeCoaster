import type { Diagnostic } from "@openvibecoaster/core";
import {
  isPointInsidePolygon,
  signedDistanceXZ,
  vec3,
} from "@openvibecoaster/core";
import type { DirectedEditorInput } from "../directedInput.js";

function getPolygonAndHeight(
  footprint: DirectedEditorInput["footprint"],
): { polygon: ReturnType<typeof vec3>[]; minY: number; maxY: number } | null {
  const raw = footprint.polygon;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const polygon: ReturnType<typeof vec3>[] = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const x = (point as unknown[])[0] as number;
    const z = (point as unknown[])[1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    polygon.push(vec3(x, 0, z));
  }
  const minY = footprint.minHeightM ?? 0;
  const maxY = footprint.maxHeightM;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  if (polygon.length < 3) return null;
  return { polygon, minY, maxY };
}

export function detectGateContradictions(
  input: DirectedEditorInput,
): Diagnostic[] {
  const parsed = getPolygonAndHeight(input.footprint);
  if (!parsed) return [];
  const { polygon, minY, maxY } = parsed;
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < input.gates.length; i++) {
    const gate = input.gates[i]!;
    const pos = gate.position;
    const x = pos[0];
    const y = pos[1];
    const z = pos[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      continue;

    // Boundary-inclusive polygon classification — uses reviewed core with signed distance.
    const point = vec3(x, 0, z);
    const inside = isPointInsidePolygon(polygon, point);
    if (!inside) {
      const dist = signedDistanceXZ(polygon, point);
      const distance = Number.isFinite(dist) && dist > 0 ? dist : 0;
      // Stable evidence: signed distance positive outside, limit 0 at boundary, margin negative.
      const actual = distance > 0 ? distance : 0;
      const limit = 0;
      const margin = -Math.abs(actual - limit);
      diagnostics.push({
        code: "GATE_OUTSIDE_FOOTPRINT",
        severity: "error",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${i} XZ outside footprint polygon (distance ${actual.toFixed(3)} m)`,
        actual,
        limit,
        margin,
      });
    }
    if (y < minY || y > maxY) {
      const limit = y < minY ? minY : maxY;
      const actual = y;
      const margin = -Math.abs(actual - limit);
      diagnostics.push({
        code: "GATE_OUTSIDE_HEIGHT",
        severity: "error",
        provenance: "PROJECT_ENGINEERING_LIMIT",
        message: `Gate ${i} Y=${y} outside height range [${minY},${maxY}]`,
        actual,
        limit,
        margin,
      });
    }
  }
  return diagnostics;
}
