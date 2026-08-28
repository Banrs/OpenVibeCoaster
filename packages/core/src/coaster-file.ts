import { compileTrack } from "./track";
import { SeventhOrderHermiteSpan, QuinticScalarSpan } from "./spans";
import type { Aabb, Vec3 } from "./math";
import type {
  ConstraintV1,
  DesignElementV1,
  DesignCompatibilityV1,
  DesignIntentV1,
  GateV1,
  SerializedSolvedSpanV1,
  SolvedSpan,
} from "./contracts";
import type { CompiledTrackData, CompileTrackOptions } from "./track";

const encodeUtf8 = (text: string): Uint8Array => {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(bytes);
};

export interface CoasterFileV1 {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly intent: DesignIntentV1;
  /** Read-only legacy view; it is intentionally not serialized in v1 strict files. */
  readonly design: DesignCompatibilityV1;
  readonly solvedSpans: readonly SerializedSolvedSpanV1[];
  readonly seed: number;
  readonly generatorVersion: string;
  readonly profileVersion: string;
  readonly researchSnapshotIds: readonly string[];
  readonly compiledDataChecksum: string;
}
export interface CoasterFileCreateInput {
  readonly name: string;
  readonly intent?: DesignIntentV1;
  readonly design?: {
    readonly elements: readonly DesignElementV1[];
    readonly gates?: readonly GateV1[];
    readonly constraints?: readonly ConstraintV1[];
  };
  readonly solvedSpans?: readonly SerializedSolvedSpanV1[];
  readonly seed: number;
  readonly generatorVersion?: string;
  readonly profileVersion?: string;
  readonly researchSnapshotIds?: readonly string[];
  readonly compiledDataChecksum?: string;
}
export class CoasterFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CoasterFileError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (path: string, reason: string): never => {
  throw new CoasterFileError(`${path}: expected ${reason}`);
};
const finite = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(path, "finite number");
const string = (value: unknown, path: string): string =>
  typeof value === "string" ? value : fail(path, "string");
const boolean = (value: unknown, path: string): boolean =>
  typeof value === "boolean" ? value : fail(path, "boolean");
const uint32 = (value: unknown, path: string): number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 0xffffffff
    ? value
    : fail(path, "uint32 integer");
const array = (value: unknown, path: string): unknown[] =>
  Array.isArray(value) ? value : fail(path, "array");
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${path}.${key}`, "no extra field");
};
const vector = (value: unknown, path: string): Vec3 => {
  const values = array(value, path);
  if (values.length !== 3) fail(path, "3-vector");
  return [
    finite(values[0], `${path}[0]`),
    finite(values[1], `${path}[1]`),
    finite(values[2], `${path}[2]`),
  ] as Vec3;
};
const quaternion = (
  value: unknown,
  path: string,
): readonly [number, number, number, number] => {
  const values = array(value, path);
  if (values.length !== 4) fail(path, "quaternion");
  return [
    finite(values[0], `${path}[0]`),
    finite(values[1], `${path}[1]`),
    finite(values[2], `${path}[2]`),
    finite(values[3], `${path}[3]`),
  ];
};
const targetValue = (value: unknown, path: string): number | Vec3 =>
  Array.isArray(value) ? vector(value, path) : finite(value, path);
const constraintValue = (
  value: unknown,
  path: string,
): string | number | Vec3 =>
  typeof value === "string" ? value : targetValue(value, path);
const primitive = (value: unknown, path: string): void => {
  if (typeof value === "number") finite(value, path);
  else if (typeof value !== "string" && typeof value !== "boolean")
    fail(path, "primitive value");
};
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) fail(path, "object");
  return value as Record<string, unknown>;
};

const validateElement = (value: unknown, path: string): void => {
  const element = record(value, path);
  exactKeys(
    element,
    ["id", "kind", "type", "parameters", "target", "pinned"],
    path,
  );
  const id = string(element.id, `${path}.id`);
  if (id.trim().length === 0) fail(`${path}.id`, "unique non-empty id");
  const supportedKinds = new Set([
    "station",
    "launch",
    "boost",
    "brake",
    "transition",
    "topHat",
    "airtimeHill",
    "overbankedTurn",
    "zeroGRoll",
    "stall",
  ]);
  const kind = string(element.kind, `${path}.kind`);
  const type = string(element.type, `${path}.type`);
  if (kind !== type) fail(`${path}.kind`, "kind and type must match");
  if (!supportedKinds.has(kind)) fail(`${path}.kind`, "supported element kind");
  if (element.parameters !== undefined) {
    const parameters = record(element.parameters, `${path}.parameters`);
    const parameterNames: Record<string, readonly string[]> = {
      station: ["length", "bank", "closed"],
      launch: ["length", "targetSpeed", "bank"],
      boost: ["length", "targetSpeed", "bank"],
      brake: ["length", "targetSpeed", "bank"],
      transition: ["length", "rise", "pitch", "bank"],
      topHat: ["height", "width", "bank"],
      airtimeHill: [
        "length",
        "height",
        "targetForceG",
        "referenceSpeed",
        "bank",
      ],
      overbankedTurn: ["radius", "angle", "bank"],
      zeroGRoll: ["length", "roll"],
      stall: ["length", "height", "bank"],
    };
    exactKeys(parameters, parameterNames[kind]!, `${path}.parameters`);
    const numericParameters = new Set([
      "length",
      "bank",
      "targetSpeed",
      "rise",
      "pitch",
      "height",
      "width",
      "targetForceG",
      "referenceSpeed",
      "radius",
      "angle",
      "roll",
    ]);
    for (const [key, parameter] of Object.entries(parameters)) {
      if (key === "closed") boolean(parameter, `${path}.parameters.${key}`);
      else if (numericParameters.has(key))
        finite(parameter, `${path}.parameters.${key}`);
      else primitive(parameter, `${path}.parameters.${key}`);
    }
  }
  if (element.target !== undefined)
    targetValue(element.target, `${path}.target`);
  if (element.pinned !== undefined) boolean(element.pinned, `${path}.pinned`);
};
const validateGate = (value: unknown, path: string): void => {
  const gate = record(value, path);
  exactKeys(gate, ["id", "position", "orientation"], path);
  if (string(gate.id, `${path}.id`).trim().length === 0)
    fail(`${path}.id`, "unique non-empty id");
  vector(gate.position, `${path}.position`);
  if (gate.orientation !== undefined)
    quaternion(gate.orientation, `${path}.orientation`);
};
const validateTarget = (value: unknown, path: string): void => {
  const target = record(value, path);
  exactKeys(target, ["id", "kind", "target", "hard"], path);
  if (string(target.id, `${path}.id`).trim().length === 0)
    fail(`${path}.id`, "unique non-empty id");
  const kind = string(target.kind, `${path}.kind`);
  if (
    ![
      "end-x",
      "end-y",
      "end-z",
      "end-bank",
      "end-position",
      "end-tangent",
      "total-length",
    ].includes(kind)
  )
    fail(`${path}.kind`, "supported target kind");
  if (["end-x", "end-y", "end-z", "end-bank", "total-length"].includes(kind))
    finite(target.target, `${path}.target`);
  else vector(target.target, `${path}.target`);
  boolean(target.hard, `${path}.hard`);
};
const validateConstraint = (value: unknown, path: string): void => {
  const constraint = record(value, path);
  exactKeys(
    constraint,
    ["id", "kind", "value", "hard", "target", "pinned"],
    path,
  );
  if (string(constraint.id, `${path}.id`).trim().length === 0)
    fail(`${path}.id`, "unique non-empty id");
  const kind = string(constraint.kind, `${path}.kind`);
  if (
    ![
      "required-element",
      "required-stall",
      "required-footprint",
      "required-height-range",
      "terrain-profile",
      "max-height",
      "min-height",
      "track-clearance",
    ].includes(kind)
  )
    fail(`${path}.kind`, "supported constraint kind");
  if (constraint.value !== undefined)
    constraintValue(constraint.value, `${path}.value`);
  if (constraint.hard !== undefined) boolean(constraint.hard, `${path}.hard`);
  if (constraint.target !== undefined) {
    if (["max-height", "min-height", "track-clearance"].includes(kind))
      finite(constraint.target, `${path}.target`);
    else constraintValue(constraint.target, `${path}.target`);
  }
  const requested = constraint.target ?? constraint.value;
  if (kind === "required-element" && typeof requested !== "string")
    fail(`${path}.target`, "element kind string");
  if (
    kind === "terrain-profile" &&
    requested !== undefined &&
    typeof requested !== "string"
  )
    fail(`${path}.target`, "terrain profile string");
  if (
    kind === "track-clearance" &&
    typeof requested === "number" &&
    requested < 0
  )
    fail(`${path}.target`, "non-negative finite number");
  if (constraint.pinned !== undefined)
    boolean(constraint.pinned, `${path}.pinned`);
};
const validateAabb = (value: unknown, path: string): Aabb => {
  const box = record(value, path);
  exactKeys(box, ["min", "max"], path);
  const min = vector(box.min, `${path}.min`);
  const max = vector(box.max, `${path}.max`);
  if (min.some((value, index) => value > max[index]!))
    fail(path, "ordered bounds");
  return { min, max };
};

export function validateDesignIntentV1(
  value: unknown,
): asserts value is DesignIntentV1 {
  const intent = record(value, "intent");
  exactKeys(
    intent,
    [
      "schemaVersion",
      "generatorVersion",
      "seed",
      "mode",
      "family",
      "elements",
      "gates",
      "targets",
      "constraints",
      "footprint",
      "heightRange",
      "terrainProfileId",
      "pinnedElementIds",
    ],
    "intent",
  );
  if (intent.schemaVersion !== 1) fail("schemaVersion", "1");
  string(intent.generatorVersion, "generatorVersion");
  uint32(intent.seed, "seed");
  if (
    intent.mode !== "insta" &&
    intent.mode !== "full-auto" &&
    intent.mode !== "directed"
  )
    fail("mode", "insta, full-auto, or directed");
  if (intent.family !== "steel-sitdown-lsm-v1")
    fail("family", "steel-sitdown-lsm-v1");
  const elements = array(intent.elements, "elements");
  const ids = new Set<string>();
  elements.forEach((element, index) =>
    validateElement(element, `elements[${index}]`),
  );
  for (const [index, element] of elements.entries()) {
    const id = (element as Record<string, unknown>).id as string;
    if (ids.has(id)) fail(`elements[${index}].id`, "unique non-empty id");
    ids.add(id);
  }
  const gates = array(intent.gates, "gates");
  if (gates.length > 3) fail("gates", "at most 3 items");
  const gateIds = new Set<string>();
  gates.forEach((gate, index) => {
    validateGate(gate, `gates[${index}]`);
    const id = (gate as Record<string, unknown>).id as string;
    if (gateIds.has(id)) fail(`gates[${index}].id`, "unique non-empty id");
    gateIds.add(id);
  });
  const targetIds = new Set<string>();
  array(intent.targets, "targets").forEach((target, index) => {
    validateTarget(target, `targets[${index}]`);
    const id = (target as Record<string, unknown>).id as string;
    if (targetIds.has(id)) fail(`targets[${index}].id`, "unique non-empty id");
    targetIds.add(id);
  });
  const constraintIds = new Set<string>();
  array(intent.constraints, "constraints").forEach((constraint, index) => {
    validateConstraint(constraint, `constraints[${index}]`);
    const id = (constraint as Record<string, unknown>).id as string;
    if (constraintIds.has(id))
      fail(`constraints[${index}].id`, "unique non-empty id");
    constraintIds.add(id);
  });
  const allIds = new Set<string>();
  for (const collection of [
    elements,
    gates,
    intent.targets as unknown[],
    intent.constraints as unknown[],
  ])
    for (const item of collection) {
      const id = (item as Record<string, unknown>).id as string;
      if (allIds.has(id))
        fail(
          "intent",
          "unique ids across elements, gates, targets, and constraints",
        );
      allIds.add(id);
    }
  if (intent.footprint !== undefined)
    validateAabb(intent.footprint, "footprint");
  if (intent.heightRange !== undefined) {
    const heightRange = record(intent.heightRange, "heightRange");
    exactKeys(heightRange, ["min", "max"], "heightRange");
    const min = finite(heightRange.min, "heightRange.min");
    const max = finite(heightRange.max, "heightRange.max");
    if (min > max) fail("heightRange", "ordered range");
  }
  if (intent.terrainProfileId !== undefined)
    string(intent.terrainProfileId, "terrainProfileId");
  const pinned = array(intent.pinnedElementIds, "pinnedElementIds");
  pinned.forEach((id, index) => string(id, `pinnedElementIds[${index}]`));
  if (elements.length > 0)
    for (const [index, id] of pinned.entries())
      if (!ids.has(id as string))
        fail(`pinnedElementIds[${index}]`, "known element id");
}

export const createDesignIntentV1 = (
  input: Omit<DesignIntentV1, "schemaVersion">,
): DesignIntentV1 => {
  const intent = { schemaVersion: 1 as const, ...input };
  validateDesignIntentV1(intent);
  return Object.freeze(intent);
};

const validateSerializedSpan = (value: unknown, path: string): void => {
  const span = record(value, path);
  exactKeys(
    span,
    ["id", "kind", "positionCoefficients", "rollCoefficients", "length"],
    path,
  );
  string(span.id, `${path}.id`);
  string(span.kind, `${path}.kind`);
  const position = array(
    span.positionCoefficients,
    `${path}.positionCoefficients`,
  );
  if (position.length !== 3)
    fail(`${path}.positionCoefficients`, "three coefficient rows");
  position.forEach((row, rowIndex) => {
    const coefficients = array(
      row,
      `${path}.positionCoefficients[${rowIndex}]`,
    );
    if (coefficients.length !== 8)
      fail(`${path}.positionCoefficients[${rowIndex}]`, "eight finite numbers");
    coefficients.forEach((coefficient, index) =>
      finite(
        coefficient,
        `${path}.positionCoefficients[${rowIndex}][${index}]`,
      ),
    );
  });
  const roll = array(span.rollCoefficients, `${path}.rollCoefficients`);
  if (roll.length !== 6) fail(`${path}.rollCoefficients`, "six finite numbers");
  roll.forEach((coefficient, index) =>
    finite(coefficient, `${path}.rollCoefficients[${index}]`),
  );
  const length = finite(span.length, `${path}.length`);
  if (!(length > 0)) fail(`${path}.length`, "positive number");
};

const legacyIntent = (
  seed: number,
  design: CoasterFileCreateInput["design"],
): DesignIntentV1 => ({
  schemaVersion: 1,
  generatorVersion: "legacy-v1",
  seed,
  mode: "directed",
  family: "steel-sitdown-lsm-v1",
  elements: [...(design?.elements ?? [])],
  gates: [],
  targets: [],
  constraints: [...(design?.constraints ?? [])],
  pinnedElementIds: [],
});

export const createCoasterFileV1 = (
  input: CoasterFileCreateInput,
): CoasterFileV1 => {
  if (typeof input.name !== "string")
    throw new CoasterFileError("name: expected string");
  const intent = input.intent ?? legacyIntent(input.seed, input.design);
  if (input.intent !== undefined) {
    if (input.solvedSpans === undefined) fail("solvedSpans", "array");
    if (input.generatorVersion === undefined)
      fail("generatorVersion", "string");
    if (input.profileVersion === undefined) fail("profileVersion", "string");
    if (input.researchSnapshotIds === undefined)
      fail("researchSnapshotIds", "array");
    if (input.compiledDataChecksum === undefined)
      fail("compiledDataChecksum", "string");
  }
  validateDesignIntentV1(intent);
  const solvedSpans = [...(input.solvedSpans ?? [])];
  solvedSpans.forEach((span, index) =>
    validateSerializedSpan(span, `solvedSpans[${index}]`),
  );
  if (!/^[0-9a-f]{8}$/i.test(input.compiledDataChecksum ?? "00000000"))
    fail("compiledDataChecksum", "eight hexadecimal characters");
  const fileWithoutDesign = {
    schemaVersion: 1,
    name: input.name,
    intent,
    solvedSpans,
    seed: uint32(input.seed, "seed"),
    generatorVersion: input.generatorVersion ?? intent.generatorVersion,
    profileVersion: input.profileVersion ?? "profile-v1",
    researchSnapshotIds: [...(input.researchSnapshotIds ?? [])],
    compiledDataChecksum: input.compiledDataChecksum ?? "00000000",
  };
  string(fileWithoutDesign.generatorVersion, "generatorVersion");
  string(fileWithoutDesign.profileVersion, "profileVersion");
  fileWithoutDesign.researchSnapshotIds.forEach((id, index) =>
    string(id, `researchSnapshotIds[${index}]`),
  );
  const design: DesignCompatibilityV1 = {
    elements: intent.elements,
    gates: intent.gates,
    constraints: intent.constraints,
  };
  const file = Object.defineProperty(fileWithoutDesign, "design", {
    value: design,
    enumerable: false,
  }) as unknown as CoasterFileV1;
  return Object.freeze(file);
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const canonicalJson = stableJson;
const canonicalFileValue = (
  file: CoasterFileV1,
): Omit<CoasterFileV1, "design"> => ({
  schemaVersion: 1,
  name: file.name,
  intent: file.intent,
  solvedSpans: file.solvedSpans,
  seed: file.seed,
  generatorVersion: file.generatorVersion,
  profileVersion: file.profileVersion,
  researchSnapshotIds: file.researchSnapshotIds,
  compiledDataChecksum: file.compiledDataChecksum,
});
export const serializeDesignIntentV1 = (intent: DesignIntentV1): string => {
  validateDesignIntentV1(intent);
  return stableJson(intent);
};
export const parseDesignIntentV1 = (
  encoded: string | Uint8Array,
): DesignIntentV1 => {
  const text = typeof encoded === "string" ? encoded : decodeUtf8(encoded);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CoasterFileError(
      `Invalid design intent JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  validateDesignIntentV1(value);
  return value;
};
export const serializeCoasterFileV1 = (file: CoasterFileV1): string => {
  validateCoasterFile(file);
  return stableJson(canonicalFileValue(file));
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  let text = "";
  const read = (index: number): number =>
    bytes[index] ??
    (() => {
      throw new CoasterFileError("Invalid UTF-8 encoding");
    })();
  for (let index = 0; index < bytes.length;) {
    const first = read(index++);
    if (first < 0x80) text += String.fromCodePoint(first);
    else if (first >= 0xc2 && first <= 0xdf) {
      const next = read(index++);
      if ((next & 0xc0) !== 0x80)
        throw new CoasterFileError("Invalid UTF-8 encoding");
      text += String.fromCodePoint(((first & 0x1f) << 6) | (next & 0x3f));
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = read(index++);
      const third = read(index++);
      if (
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (first === 0xe0 && second < 0xa0) ||
        (first === 0xed && second >= 0xa0)
      )
        throw new CoasterFileError("Invalid UTF-8 encoding");
      text += String.fromCodePoint(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = read(index++);
      const third = read(index++);
      const fourth = read(index++);
      if (
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80 ||
        (first === 0xf0 && second < 0x90) ||
        (first === 0xf4 && second >= 0x90)
      )
        throw new CoasterFileError("Invalid UTF-8 encoding");
      text += String.fromCodePoint(
        ((first & 7) << 18) |
          ((second & 0x3f) << 12) |
          ((third & 0x3f) << 6) |
          (fourth & 0x3f),
      );
    } else throw new CoasterFileError("Invalid UTF-8 encoding");
  }
  return text;
};
const validateLegacyDesign = (value: unknown): void => {
  const design = record(value, "design");
  exactKeys(
    design,
    ["elements", "gates", "constraints", "solvedSpans"],
    "design",
  );
  if (!Array.isArray(design.elements)) fail("design.elements", "array");
  const elements = design.elements as unknown[];
  for (const [index, value] of elements.entries()) {
    const element = record(value, `design.elements[${index}]`);
    exactKeys(
      element,
      ["id", "kind", "type", "parameters", "target", "pinned"],
      `design.elements[${index}]`,
    );
    string(element.id, `design.elements[${index}].id`);
    if (element.parameters !== undefined) {
      const parameters = record(
        element.parameters,
        `design.elements[${index}].parameters`,
      );
      for (const [key, parameter] of Object.entries(parameters))
        primitive(parameter, `design.elements[${index}].parameters.${key}`);
    }
    if (
      element.target !== undefined &&
      typeof element.target !== "string" &&
      !(typeof element.target === "number" && Number.isFinite(element.target))
    )
      fail(`design.elements[${index}].target`, "string or finite number");
  }
  if (design.gates !== undefined) {
    if (!Array.isArray(design.gates)) fail("design.gates", "array");
    for (const [index, value] of (design.gates as unknown[]).entries()) {
      const gate = record(value, `design.gates[${index}]`);
      exactKeys(
        gate,
        ["id", "at", "kind", "target", "pinned"],
        `design.gates[${index}]`,
      );
      string(gate.id, `design.gates[${index}].id`);
      finite(gate.at, `design.gates[${index}].at`);
      string(gate.kind, `design.gates[${index}].kind`);
      if (
        gate.target !== undefined &&
        typeof gate.target !== "string" &&
        !(typeof gate.target === "number" && Number.isFinite(gate.target))
      )
        fail(`design.gates[${index}].target`, "string or finite number");
      if (gate.pinned !== undefined)
        boolean(gate.pinned, `design.gates[${index}].pinned`);
    }
  }
  if (design.constraints !== undefined) {
    if (!Array.isArray(design.constraints)) fail("design.constraints", "array");
    for (const [index, value] of (design.constraints as unknown[]).entries()) {
      const constraint = record(value, `design.constraints[${index}]`);
      exactKeys(
        constraint,
        ["id", "kind", "value", "hard", "target", "pinned"],
        `design.constraints[${index}]`,
      );
      string(constraint.id, `design.constraints[${index}].id`);
      string(constraint.kind, `design.constraints[${index}].kind`);
      finite(constraint.value, `design.constraints[${index}].value`);
      if (constraint.hard !== undefined)
        boolean(constraint.hard, `design.constraints[${index}].hard`);
    }
  }
  if (design.solvedSpans !== undefined) {
    if (!Array.isArray(design.solvedSpans)) fail("design.solvedSpans", "array");
    for (const [index, value] of (design.solvedSpans as unknown[]).entries()) {
      const span = record(value, `design.solvedSpans[${index}]`);
      exactKeys(span, ["id", "coefficients"], `design.solvedSpans[${index}]`);
      string(span.id, `design.solvedSpans[${index}].id`);
      const coefficients = span.coefficients;
      const validate = (item: unknown, path: string): void => {
        if (Array.isArray(item))
          item.forEach((child, childIndex) =>
            validate(child, `${path}[${childIndex}]`),
          );
        else finite(item, path);
      };
      validate(coefficients, `design.solvedSpans[${index}].coefficients`);
    }
  }
};
function validateCoasterFile(value: unknown): asserts value is CoasterFileV1 {
  const file = record(value, "file");
  exactKeys(
    file,
    [
      "schemaVersion",
      "name",
      "intent",
      "solvedSpans",
      "seed",
      "generatorVersion",
      "profileVersion",
      "researchSnapshotIds",
      "compiledDataChecksum",
    ],
    "file",
  );
  if (file.schemaVersion !== 1)
    throw new CoasterFileError(
      `Unsupported coaster schema version: ${String(file.schemaVersion)}`,
    );
  string(file.name, "name");
  validateDesignIntentV1(file.intent);
  const solvedSpans = array(file.solvedSpans, "solvedSpans");
  solvedSpans.forEach((span, index) =>
    validateSerializedSpan(span, `solvedSpans[${index}]`),
  );
  const spanIds = new Set<string>();
  const intentKinds = new Map(
    file.intent.elements.map((element) => [
      element.id,
      element.kind ?? element.type,
    ]),
  );
  for (const [index, value] of solvedSpans.entries()) {
    const span = value as Record<string, unknown>;
    const id = span.id as string;
    if (spanIds.has(id)) fail(`solvedSpans[${index}].id`, "unique id");
    spanIds.add(id);
    if (intentKinds.size > 0 && intentKinds.get(id) !== span.kind)
      fail(`solvedSpans[${index}].kind`, "consistent with intent element");
  }
  if (intentKinds.size > 0 && solvedSpans.length !== intentKinds.size)
    fail("solvedSpans", "one coefficient span per intent element");
  if (file.seed !== file.intent.seed) fail("seed", "matching intent.seed");
  uint32(file.seed, "seed");
  string(file.generatorVersion, "generatorVersion");
  string(file.profileVersion, "profileVersion");
  array(file.researchSnapshotIds, "researchSnapshotIds").forEach((id, index) =>
    string(id, `researchSnapshotIds[${index}]`),
  );
  const checksum = string(file.compiledDataChecksum, "compiledDataChecksum");
  if (!/^[0-9a-f]{8}$/i.test(checksum))
    fail("compiledDataChecksum", "eight hexadecimal characters");
}

export const deserializeCoasterFileV1 = (
  encoded: string | Uint8Array,
): CoasterFileV1 => {
  try {
    const text = typeof encoded === "string" ? encoded : decodeUtf8(encoded);
    const value = JSON.parse(text) as unknown;
    if (isRecord(value) && "design" in value && !("intent" in value)) {
      exactKeys(value, ["schemaVersion", "name", "seed", "design"], "file");
      if (value.schemaVersion !== 1)
        throw new CoasterFileError(
          `Unsupported coaster schema version: ${String(value.schemaVersion)}`,
        );
      const seed = uint32(value.seed, "seed");
      validateLegacyDesign(value.design);
      return createCoasterFileV1({
        name: string(value.name, "name"),
        seed,
        design: value.design as NonNullable<CoasterFileCreateInput["design"]>,
      });
    }
    if (isRecord(value) && value.schemaVersion !== 1)
      throw new CoasterFileError(
        `Unsupported coaster schema version: ${String(value.schemaVersion)}`,
      );
    if (isRecord(value) && !("intent" in value)) uint32(value.seed, "seed");
    validateCoasterFile(value);
    return createCoasterFileV1(value as unknown as CoasterFileCreateInput);
  } catch (error) {
    if (error instanceof CoasterFileError) throw error;
    throw new CoasterFileError(
      `Invalid coaster file JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
};
export const parseCoasterFile = deserializeCoasterFileV1;

export const serializeSolvedSpanV1 = (
  span: SolvedSpan,
  kind = span.kind ?? "transition",
  length = span.length ?? 1,
): SerializedSolvedSpanV1 => {
  const positionCoefficients =
    span.positionCoefficients ??
    (span.span instanceof SeventhOrderHermiteSpan
      ? span.span.coefficients
      : undefined);
  const rollCoefficients =
    span.rollCoefficients ??
    (span.bank instanceof QuinticScalarSpan
      ? span.bank.coefficients
      : undefined);
  if (!positionCoefficients || !rollCoefficients)
    throw new CoasterFileError(
      `solvedSpans.${span.id}: coefficient-backed span required`,
    );
  return {
    id: span.id,
    kind,
    positionCoefficients: positionCoefficients.map((row) => [...row]),
    rollCoefficients: [...rollCoefficients],
    length,
  };
};
export const reconstructSolvedSpan = (
  span: SerializedSolvedSpanV1,
): SolvedSpan => ({
  id: span.id,
  kind: span.kind,
  length: span.length,
  zones: [span.kind],
  span: SeventhOrderHermiteSpan.fromCoefficients<Vec3>(
    span.positionCoefficients,
  ),
  bank: QuinticScalarSpan.fromCoefficients(span.rollCoefficients),
  positionCoefficients: span.positionCoefficients,
  rollCoefficients: span.rollCoefficients,
});
export interface LoadedCoasterFile {
  readonly file: CoasterFileV1;
  readonly solvedSpans: readonly SolvedSpan[];
  readonly track: CompiledTrackData;
}
export const compileCoasterFile = (
  file: CoasterFileV1 | string | Uint8Array,
  options: CompileTrackOptions = {},
): LoadedCoasterFile => {
  const parsed =
    typeof file === "string" || file instanceof Uint8Array
      ? deserializeCoasterFileV1(file)
      : file;
  validateCoasterFile(parsed);
  const solvedSpans = parsed.solvedSpans.map(reconstructSolvedSpan);
  if (solvedSpans.length === 0)
    throw new CoasterFileError("solvedSpans: expected at least one span");
  const canonicalTrack = compileTrack(solvedSpans, { samples: 32 });
  if (
    canonicalTrack.checksum.toLowerCase() !==
    parsed.compiledDataChecksum.toLowerCase()
  )
    throw new CoasterFileError(
      `compiledDataChecksum: checksum mismatch (expected ${parsed.compiledDataChecksum}, reconstructed ${canonicalTrack.checksum})`,
    );
  return {
    file: parsed,
    solvedSpans,
    track: compileTrack(
      solvedSpans,
      options.samples === undefined ? { samples: 32 } : options,
    ),
  };
};
export const loadCoasterFile = compileCoasterFile;

export const coasterFileChecksum = (file: CoasterFileV1): string => {
  let hash = 0x811c9dc5;
  for (const byte of encodeUtf8(serializeCoasterFileV1(file)))
    hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
export const checksumCoasterFileV1 = coasterFileChecksum;
