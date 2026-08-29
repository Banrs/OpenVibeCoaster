import {
  createDesignIntentV1,
  type Aabb,
  type DesignIntentV1,
  type GateV1,
  type Vec3,
  type QuaternionV1,
} from "@openvibecoaster/core";
import { ELEMENT_KINDS, type ElementKind } from "@openvibecoaster/generator";

// Re-export for tests convenience
export type { ElementKind };

// Field-specific validation error
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface DirectedGateInput {
  // Spatial gate: exactly maps to GateV1.position + orientation
  readonly position: readonly [number, number, number];
  readonly orientation?: readonly [number, number, number, number];
}

export interface DirectedTargetInput {
  readonly id: string;
  readonly kind: string; // must be supported TargetV1 kind
  readonly value: number | readonly [number, number, number];
  readonly hard?: boolean; // default true for hardTargets, false for soft
}

export interface DirectedFootprintInput {
  // Polygon in XZ plane (meters), closed loop implied. Maps to Aabb footprint.
  readonly polygon: readonly (readonly [number, number])[];
  readonly maxHeightM: number;
  readonly minHeightM?: number;
}

export interface DirectedEditorInput {
  readonly seed: number;
  readonly gates: readonly DirectedGateInput[];
  readonly footprint: DirectedFootprintInput;
  readonly terrainProfileId: string;
  readonly requiredElements: readonly ElementKind[];
  readonly requiresStall?: boolean;
  readonly hardTargets: readonly DirectedTargetInput[];
  readonly softTargets: readonly DirectedTargetInput[];
  readonly pinnedElementIds?: readonly string[];
}

const UINT32_MAX = 0xffffffff;
const SUPPORTED_TARGET_KINDS = new Set([
  "end-x",
  "end-y",
  "end-z",
  "end-bank",
  "end-position",
  "end-tangent",
  "total-length",
]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const vec3Finite = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (component) => typeof component === "number" && Number.isFinite(component),
  );

const parseUint32Seed = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= UINT32_MAX
    ? parsed
    : null;
};

export { parseUint32Seed };

function addError(errors: FieldError[], field: string, message: string): void {
  errors.push(Object.freeze({ field, message }));
}

function shoelaceArea(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const [x1, z1] = points[i]!;
    const [x2, z2] = points[(i + 1) % n]!;
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

function orientation(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): number {
  const v = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

function onSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): boolean {
  return (
    Math.min(ax, cx) <= bx &&
    bx <= Math.max(ax, cx) &&
    Math.min(az, cz) <= bz &&
    bz <= Math.max(az, cz)
  );
}

function segmentsIntersect(
  p1: readonly [number, number],
  p2: readonly [number, number],
  q1: readonly [number, number],
  q2: readonly [number, number],
): boolean {
  const o1 = orientation(p1[0], p1[1], p2[0], p2[1], q1[0], q1[1]);
  const o2 = orientation(p1[0], p1[1], p2[0], p2[1], q2[0], q2[1]);
  const o3 = orientation(q1[0], q1[1], q2[0], q2[1], p1[0], p1[1]);
  const o4 = orientation(q1[0], q1[1], q2[0], q2[1], p2[0], p2[1]);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1[0], p1[1], q1[0], q1[1], p2[0], p2[1]))
    return true;
  if (o2 === 0 && onSegment(p1[0], p1[1], q2[0], q2[1], p2[0], p2[1]))
    return true;
  if (o3 === 0 && onSegment(q1[0], q1[1], p1[0], p1[1], q2[0], q2[1]))
    return true;
  if (o4 === 0 && onSegment(q1[0], q1[1], p2[0], p2[1], q2[0], q2[1]))
    return true;
  return false;
}

function isAxisAlignedRectangle(
  points: readonly (readonly [number, number])[],
): boolean {
  if (points.length !== 4) return false;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (!(maxX > minX && maxZ > minZ)) return false;
  const corners: [number, number][] = [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
  const sort = (a: readonly [number, number], b: readonly [number, number]) =>
    a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
  const sortedPoints = [...points].sort(sort);
  const sortedCorners = [...corners].sort(sort);
  for (let i = 0; i < 4; i += 1) {
    if (
      sortedPoints[i]![0] !== sortedCorners[i]![0] ||
      sortedPoints[i]![1] !== sortedCorners[i]![1]
    )
      return false;
  }
  return true;
}

function validatePolygon(
  value: unknown,
  field: string,
  errors: FieldError[],
): readonly (readonly [number, number])[] | null {
  if (!Array.isArray(value)) {
    addError(errors, field, "expected polygon array");
    return null;
  }
  const polygon = value as unknown[];
  if (polygon.length < 3) {
    addError(errors, field, "polygon must have at least 3 vertices");
    return null;
  }
  if (polygon.length > 32) {
    addError(errors, field, "polygon must have at most 32 vertices");
    return null;
  }
  const result: [number, number][] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const point = polygon[i];
    const pointField = `${field}[${i}]`;
    if (!Array.isArray(point) || point.length !== 2) {
      addError(errors, pointField, "expected [x, z] pair");
      continue;
    }
    const [x, z] = point as unknown[];
    if (!finite(x))
      addError(errors, `${pointField}[0]`, "expected finite number");
    if (!finite(z))
      addError(errors, `${pointField}[1]`, "expected finite number");
    if (finite(x) && finite(z)) result.push([x, z] as [number, number]);
  }
  if (result.length !== polygon.length) return null;

  // Duplicate vertices
  for (let i = 0; i < result.length; i += 1) {
    for (let j = i + 1; j < result.length; j += 1) {
      if (result[i]![0] === result[j]![0] && result[i]![1] === result[j]![1]) {
        addError(
          errors,
          `${field}[${j}]`,
          `duplicate vertex ${j} duplicates ${i}`,
        );
      }
    }
  }

  // Zero-length edges (consecutive duplicates, including closing edge)
  for (let i = 0; i < result.length; i += 1) {
    const a = result[i]!;
    const b = result[(i + 1) % result.length]!;
    if (a[0] === b[0] && a[1] === b[1]) {
      addError(errors, `${field}[${i}]`, "zero-length edge");
    }
  }

  // Zero-area (true zero-area via shoelace)
  const area = shoelaceArea(result);
  if (Math.abs(area) < 1e-12) {
    addError(errors, field, "polygon must have non-zero area");
  }

  // Self-intersections (including bow-tie)
  const n = result.length;
  for (let i = 0; i < n; i += 1) {
    const p1 = result[i]!;
    const p2 = result[(i + 1) % n]!;
    for (let j = i + 1; j < n; j += 1) {
      const q1 = result[j]!;
      const q2 = result[(j + 1) % n]!;
      // Skip adjacent edges and shared vertices
      if (i === j || (i + 1) % n === j || i === (j + 1) % n) continue;
      // Skip if they share a vertex exactly (duplicate already reported, but avoid false positive)
      if (
        (p1[0] === q1[0] && p1[1] === q1[1]) ||
        (p1[0] === q2[0] && p1[1] === q2[1]) ||
        (p2[0] === q1[0] && p2[1] === q1[1]) ||
        (p2[0] === q2[0] && p2[1] === q2[1])
      )
        continue;
      if (segmentsIntersect(p1, p2, q1, q2)) {
        addError(errors, field, "polygon self-intersects");
        // Break after first detection to keep deterministic single error, but could continue
        i = n; // outer break
        break;
      }
    }
  }

  if (errors.some((e) => e.field.startsWith(field))) return null;

  // Preserve core contract: only axis-aligned rectangles are representable as AABB
  if (!isAxisAlignedRectangle(result)) {
    addError(
      errors,
      field,
      "unsupported non-rectangular polygon: core contract supports only axis-aligned rectangles via AABB; provide 4 corners of the bounding rectangle",
    );
    return null;
  }

  return result;
}

function validateGate(
  gate: unknown,
  index: number,
  errors: FieldError[],
): GateV1 | null {
  const field = `gates[${index}]`;
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    addError(errors, field, "expected object");
    return null;
  }
  const record = gate as Record<string, unknown>;
  const position = record.position;
  if (!vec3Finite(position)) {
    addError(errors, `${field}.position`, "expected finite [x, y, z]");
    // also check field-specific if array length wrong etc
    if (Array.isArray(position)) {
      for (let i = 0; i < 3; i += 1) {
        const component = (position as unknown[])[i];
        if (!finite(component))
          addError(errors, `${field}.position[${i}]`, "expected finite number");
      }
    }
    return null;
  }
  const pos = [...(position as unknown as number[])] as unknown as Vec3;
  // Ensure no NaN downstream: already finite
  let orientation: QuaternionV1 | undefined;
  if (record.orientation !== undefined) {
    const q = record.orientation;
    if (!Array.isArray(q) || q.length !== 4) {
      addError(
        errors,
        `${field}.orientation`,
        "expected finite quaternion [x, y, z, w]",
      );
      return null;
    }
    for (let i = 0; i < 4; i += 1) {
      if (!finite((q as unknown[])[i]))
        addError(
          errors,
          `${field}.orientation[${i}]`,
          "expected finite number",
        );
    }
    if (errors.some((e) => e.field.startsWith(`${field}.orientation`)))
      return null;
    const qArray = q as [number, number, number, number];
    const length = Math.hypot(qArray[0], qArray[1], qArray[2], qArray[3]);
    if (!(length > 1e-12)) {
      addError(errors, `${field}.orientation`, "quaternion must be non-zero");
      return null;
    }
    orientation = Object.freeze([
      qArray[0],
      qArray[1],
      qArray[2],
      qArray[3],
    ] as const);
  }
  const id = `gate-${String(index).padStart(3, "0")}`;
  const result: GateV1 = orientation
    ? Object.freeze({
        id,
        position: Object.freeze([...pos]) as Vec3,
        orientation,
      })
    : Object.freeze({ id, position: Object.freeze([...pos]) as Vec3 });
  return result;
}

function validateTargetInput(
  target: unknown,
  index: number,
  prefix: string,
  errors: FieldError[],
): {
  id: string;
  kind: string;
  targetValue: number | Vec3;
  hard: boolean;
} | null {
  const field = `${prefix}[${index}]`;
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    addError(errors, field, "expected object");
    return null;
  }
  const record = target as Record<string, unknown>;
  const id = record.id;
  const kind = record.kind;
  const value = record.value;
  if (typeof id !== "string" || id.trim().length === 0) {
    addError(errors, `${field}.id`, "expected non-empty string");
    return null;
  }
  if (typeof kind !== "string" || !SUPPORTED_TARGET_KINDS.has(kind)) {
    addError(
      errors,
      `${field}.kind`,
      `unsupported target kind ${String(kind)}`,
    );
    return null;
  }
  const hard = record.hard;
  const hardBoolean =
    hard === undefined ? prefix === "hardTargets" : Boolean(hard);
  if (hard !== undefined && typeof hard !== "boolean") {
    addError(errors, `${field}.hard`, "expected boolean");
    return null;
  }
  // Validate value finiteness field-specific
  if (kind === "end-position" || kind === "end-tangent") {
    if (!vec3Finite(value)) {
      addError(errors, `${field}.value`, "expected finite [x, y, z]");
      if (Array.isArray(value)) {
        for (let i = 0; i < 3; i += 1) {
          if (!finite((value as unknown[])[i]))
            addError(errors, `${field}.value[${i}]`, "expected finite number");
        }
      }
      return null;
    }
    return {
      id: id.trim(),
      kind,
      targetValue: [...(value as unknown as number[])] as unknown as Vec3,
      hard: hardBoolean,
    };
  }
  if (!finite(value)) {
    addError(errors, `${field}.value`, "expected finite number");
    return null;
  }
  return {
    id: id.trim(),
    kind,
    targetValue: value as number,
    hard: hardBoolean,
  };
}

/**
 * Validates directed editor input with field-specific errors.
 * Deep-copies mutable inputs; never produces NaN or schema-invalid intents.
 * Returns frozen errors array. Does not mutate caller's input.
 */
export function validateDirectedInput(input: unknown): readonly FieldError[] {
  const errors: FieldError[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    addError(errors, "input", "expected object");
    return Object.freeze([...errors]);
  }
  const record = input as Record<string, unknown>;

  // seed
  const seed = record.seed;
  if (
    !Number.isInteger(seed) ||
    !finite(seed as number) ||
    (seed as number) < 0 ||
    (seed as number) > UINT32_MAX
  ) {
    addError(errors, "seed", "expected uint32 integer");
  }

  // gates
  const gates = record.gates;
  if (!Array.isArray(gates)) {
    addError(errors, "gates", "expected array");
  } else {
    if (gates.length > 3)
      addError(errors, "gates", "at most 3 gates are supported");
    for (let i = 0; i < Math.min(gates.length, 3); i += 1) {
      validateGate(gates[i], i, errors);
    }
    if (gates.length > 3) {
      for (let i = 3; i < gates.length; i += 1)
        addError(errors, `gates[${i}]`, "exceeds maximum gate count");
    }
  }

  // footprint
  const footprint = record.footprint;
  if (
    typeof footprint !== "object" ||
    footprint === null ||
    Array.isArray(footprint)
  ) {
    addError(errors, "footprint", "expected object");
  } else {
    const fp = footprint as Record<string, unknown>;
    if (fp.polygon !== undefined) {
      validatePolygon(fp.polygon, "footprint.polygon", errors);
    } else {
      addError(errors, "footprint.polygon", "expected polygon array");
    }
    const maxHeight = fp.maxHeightM;
    if (!finite(maxHeight) || (maxHeight as number) <= 0)
      addError(
        errors,
        "footprint.maxHeightM",
        "expected positive finite number",
      );
    if (fp.minHeightM !== undefined) {
      const minH = fp.minHeightM;
      if (!finite(minH))
        addError(errors, "footprint.minHeightM", "expected finite number");
      else if (finite(maxHeight) && (minH as number) > (maxHeight as number))
        addError(errors, "footprint.minHeightM", "min must not exceed max");
    }
  }

  // terrain
  const terrain = record.terrainProfileId ?? record.terrain;
  if (typeof terrain !== "string" || terrain.trim().length === 0) {
    addError(errors, "terrainProfileId", "expected non-empty string");
  }

  // requiredElements
  const requiredElements = record.requiredElements;
  if (!Array.isArray(requiredElements)) {
    addError(errors, "requiredElements", "expected array");
  } else {
    if (requiredElements.length === 0)
      addError(
        errors,
        "requiredElements",
        "select at least one required element",
      );
    for (let i = 0; i < requiredElements.length; i += 1) {
      const kind = requiredElements[i];
      if (
        typeof kind !== "string" ||
        !(ELEMENT_KINDS as readonly string[]).includes(kind)
      ) {
        addError(
          errors,
          `requiredElements[${i}]`,
          `unknown element kind ${String(kind)}`,
        );
      }
    }
  }
  if (
    record.requiresStall !== undefined &&
    typeof record.requiresStall !== "boolean"
  ) {
    addError(errors, "requiresStall", "expected boolean");
  }

  // hardTargets / softTargets
  for (const key of ["hardTargets", "softTargets"] as const) {
    const list = record[key];
    if (list !== undefined) {
      if (!Array.isArray(list)) addError(errors, key, "expected array");
      else {
        for (let i = 0; i < list.length; i += 1)
          validateTargetInput(list[i], i, key, errors);
        // check duplicate ids across both lists
      }
    }
  }
  // cross-check duplicate target ids
  const hard = Array.isArray(record.hardTargets)
    ? (record.hardTargets as unknown[])
    : [];
  const soft = Array.isArray(record.softTargets)
    ? (record.softTargets as unknown[])
    : [];
  const ids = new Set<string>();
  for (const list of [hard, soft]) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] as Record<string, unknown>;
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (id && ids.has(id))
        addError(errors, "targets", `duplicate target id ${id}`);
      if (id) ids.add(id);
    }
  }

  // pinnedElementIds – must validate against final stable IDs and preserve order, no silent drop
  if (record.pinnedElementIds !== undefined) {
    const pinned = record.pinnedElementIds;
    if (!Array.isArray(pinned))
      addError(errors, "pinnedElementIds", "expected array");
    else {
      for (let i = 0; i < pinned.length; i += 1) {
        if (
          typeof pinned[i] !== "string" ||
          (pinned[i] as string).trim().length === 0
        )
          addError(
            errors,
            `pinnedElementIds[${i}]`,
            "expected non-empty string",
          );
      }
      // Build expected stable IDs for validation (deterministic, bounded)
      if (Array.isArray(requiredElements)) {
        const expectedIds: string[] = [];
        for (let i = 0; i < requiredElements.length; i += 1) {
          const kind = requiredElements[i];
          if (
            typeof kind === "string" &&
            (ELEMENT_KINDS as readonly string[]).includes(kind)
          ) {
            expectedIds.push(`${String(kind)}-${String(i).padStart(3, "0")}`);
          }
        }
        const hasStall = (requiredElements as unknown as string[]).includes(
          "stall",
        );
        if (record.requiresStall === true && !hasStall) {
          expectedIds.push(
            `stall-${String(requiredElements.length).padStart(3, "0")}`,
          );
        }
        const expectedSet = new Set(expectedIds);
        const seenPinned = new Set<string>();
        for (let i = 0; i < pinned.length; i += 1) {
          const raw = pinned[i];
          if (typeof raw !== "string" || raw.trim().length === 0) continue;
          const id = raw.trim();
          if (!expectedSet.has(id)) {
            addError(
              errors,
              `pinnedElementIds[${i}]`,
              `unknown element ID ${id}`,
            );
          } else if (seenPinned.has(id)) {
            addError(
              errors,
              `pinnedElementIds[${i}]`,
              `duplicate pinned ID ${id}`,
            );
          }
          seenPinned.add(id);
        }
      }
    }
  }

  return Object.freeze([...errors]);
}

/**
 * Maps validated directed input into a frozen DesignIntentV1.
 * Returns field-specific errors if invalid; never returns schema-invalid intent or NaN.
 * Deep-copies typed data only when ownership requires it; freezes own graph.
 */
export function createDirectedDesignIntent(input: DirectedEditorInput): {
  readonly intent: DesignIntentV1 | null;
  readonly errors: readonly FieldError[];
} {
  // Deep-copy input to avoid caller mutation
  const copy: DirectedEditorInput = {
    seed: input.seed,
    gates: input.gates.map((g) => ({
      position: [...g.position] as [number, number, number],
      ...(g.orientation
        ? {
            orientation: [...g.orientation] as [number, number, number, number],
          }
        : {}),
    })),
    footprint: {
      polygon: input.footprint.polygon.map((p) => [...p] as [number, number]),
      maxHeightM: input.footprint.maxHeightM,
      ...(input.footprint.minHeightM !== undefined
        ? { minHeightM: input.footprint.minHeightM }
        : {}),
    },
    terrainProfileId: String(
      input.terrainProfileId ??
        (input as unknown as Record<string, unknown>).terrain ??
        "",
    ),
    requiredElements: [...input.requiredElements],
    ...(input.requiresStall !== undefined
      ? { requiresStall: Boolean(input.requiresStall) }
      : {}),
    hardTargets: input.hardTargets.map((t) => ({
      id: t.id,
      kind: t.kind,
      value: Array.isArray(t.value)
        ? ([...t.value] as [number, number, number])
        : t.value,
      ...(t.hard !== undefined ? { hard: t.hard } : {}),
    })),
    softTargets: input.softTargets.map((t) => ({
      id: t.id,
      kind: t.kind,
      value: Array.isArray(t.value)
        ? ([...t.value] as [number, number, number])
        : t.value,
      ...(t.hard !== undefined ? { hard: t.hard } : {}),
    })),
    ...(input.pinnedElementIds
      ? { pinnedElementIds: [...input.pinnedElementIds] }
      : {}),
  };

  const errors = validateDirectedInput(copy);
  if (errors.length > 0) return { intent: null, errors };

  // Build footprint Aabb from polygon XZ + height
  const polygon = copy.footprint.polygon;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const minY = copy.footprint.minHeightM ?? 0;
  const maxY = copy.footprint.maxHeightM;
  const footprint: Aabb = Object.freeze({
    min: Object.freeze([minX, minY, minZ] as Vec3),
    max: Object.freeze([maxX, maxY, maxZ] as Vec3),
  });

  // Build gates with stable ids
  const gates: GateV1[] = copy.gates.map((gate, index) => {
    const id = `gate-${String(index).padStart(3, "0")}`;
    const position = Object.freeze([...gate.position] as unknown as Vec3);
    if (gate.orientation) {
      const orientation = Object.freeze([
        ...gate.orientation,
      ] as unknown as QuaternionV1);
      return Object.freeze({ id, position, orientation }) as GateV1;
    }
    return Object.freeze({ id, position }) as GateV1;
  });

  // Build required elements with stable semantic IDs
  const elements = copy.requiredElements.map((kind, index) => {
    const id = `${kind}-${String(index).padStart(3, "0")}`;
    return Object.freeze({
      id,
      kind,
      type: kind,
    }) as unknown as DesignIntentV1["elements"][number];
  });
  // Optionally add stall if required but not already included
  let finalElements: readonly DesignIntentV1["elements"][number][] =
    elements as unknown as readonly DesignIntentV1["elements"][number][];
  if (
    copy.requiresStall &&
    !copy.requiredElements.includes("stall" as ElementKind)
  ) {
    const stallIndex = copy.requiredElements.length;
    const stallId = `stall-${String(stallIndex).padStart(3, "0")}`;
    finalElements = Object.freeze([
      ...(elements as unknown as DesignIntentV1["elements"]),
      Object.freeze({ id: stallId, kind: "stall", type: "stall" }),
    ]) as unknown as readonly DesignIntentV1["elements"][number][];
  } else {
    finalElements = Object.freeze([
      ...(elements as unknown as DesignIntentV1["elements"]),
    ]) as unknown as readonly DesignIntentV1["elements"][number][];
  }

  // Build targets (hard first, then soft). Ensure field-specific finite already validated.
  const allTargets = [
    ...copy.hardTargets.map((t) => ({ ...t, hard: true })),
    ...copy.softTargets.map((t) => ({ ...t, hard: false })),
  ];
  const targets = Object.freeze(
    allTargets.map((t) =>
      Object.freeze({
        id: t.id,
        kind: t.kind,
        target: Array.isArray(t.value)
          ? Object.freeze([
              ...(t.value as unknown as number[]),
            ] as unknown as Vec3)
          : t.value,
        hard: t.hard,
      }),
    ),
  );

  // Build constraints for footprint/terrain/stall semantics
  const constraintList: import("@openvibecoaster/core").ConstraintV1[] = [];
  // Required-element constraints for each required element kind (hard)
  for (const kind of copy.requiredElements) {
    constraintList.push(
      Object.freeze({
        id: `required-${kind}`,
        kind: "required-element",
        target: kind,
        hard: true,
      }),
    );
  }
  if (
    copy.requiresStall &&
    !copy.requiredElements.includes("stall" as ElementKind)
  ) {
    constraintList.push(
      Object.freeze({
        id: "required-stall",
        kind: "required-stall",
        target: "stall",
        hard: true,
      }),
    );
  }
  constraintList.push(
    Object.freeze({
      id: "footprint-required",
      kind: "required-footprint",
      hard: true,
    }),
  );
  // Terrain profile constraint
  constraintList.push(
    Object.freeze({
      id: "terrain-profile",
      kind: "terrain-profile",
      target: copy.terrainProfileId,
      hard: true,
    }),
  );
  // Height range constraint from footprint heights
  if (
    copy.footprint.minHeightM !== undefined ||
    copy.footprint.maxHeightM !== undefined
  ) {
    // Intent heightRange will be used; constraint not needed but we keep footprint hard.
  }
  const frozenConstraints = Object.freeze([...constraintList]);

  const heightRange = Object.freeze({ min: minY, max: maxY });

  // Pinned IDs validated field-specifically above – preserve order exactly, no silent drop
  const pinnedElementIds = copy.pinnedElementIds
    ? Object.freeze(copy.pinnedElementIds.map((id) => id.trim()))
    : Object.freeze([] as string[]);

  const rawIntent: Omit<DesignIntentV1, "schemaVersion"> = {
    generatorVersion: "directed-v1",
    seed: copy.seed,
    mode: "directed",
    family: "steel-sitdown-lsm-v1",
    elements: finalElements,
    gates: Object.freeze([...gates]),
    targets: targets as unknown as DesignIntentV1["targets"],
    constraints: frozenConstraints,
    footprint,
    heightRange,
    terrainProfileId: copy.terrainProfileId,
    pinnedElementIds,
  };

  // This will throw if we accidentally produced schema-invalid intent – we map to field error instead.
  try {
    const intent = createDesignIntentV1(rawIntent);
    // Deep-freeze already handled; return frozen intent
    return { intent: Object.freeze(intent), errors: Object.freeze([]) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      intent: null,
      errors: Object.freeze([{ field: "intent", message }]),
    };
  }
}
