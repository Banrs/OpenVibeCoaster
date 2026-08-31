import type { Diagnostic, Vec3 } from "@openvibecoaster/core";
import {
  isPointInsidePolygon,
  signedDistanceXZ,
  vec3,
} from "@openvibecoaster/core";
import type { DirectedEditorInput } from "../directedInput.js";

function isXzTuple(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function getPolygonAndHeight(
  footprint: DirectedEditorInput["footprint"],
): { polygon: readonly Vec3[]; minY: number; maxY: number } | null {
  const raw = footprint.polygon;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const polygon: Vec3[] = [];
  for (const point of raw) {
    if (!isXzTuple(point)) return null;
    const [x, z] = point;
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
