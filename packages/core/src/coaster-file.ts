import { compileTrack } from "./track";
import { SeventhOrderHermiteSpan, QuinticScalarSpan } from "./spans";
import type { Aabb, Vec3 } from "./math";
import type {
  ConstraintV1,
  DesignElementV1,
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
  string(element.id, `${path}.id`);
  if (element.kind === undefined && element.type === undefined)
    fail(`${path}.kind`, "string");
  if (element.kind !== undefined) string(element.kind, `${path}.kind`);
  if (element.type !== undefined) string(element.type, `${path}.type`);
  if (element.parameters !== undefined) {
    const parameters = record(element.parameters, `${path}.parameters`);
    for (const [key, parameter] of Object.entries(parameters))
      primitive(parameter, `${path}.parameters.${key}`);
  }
  if (element.target !== undefined)
    targetValue(element.target, `${path}.target`);
  if (element.pinned !== undefined) boolean(element.pinned, `${path}.pinned`);
};
const validateGate = (value: unknown, path: string): void => {
  const gate = record(value, path);
  exactKeys(gate, ["id", "position", "orientation"], path);
  string(gate.id, `${path}.id`);
  vector(gate.position, `${path}.position`);
  if (gate.orientation !== undefined)
    quaternion(gate.orientation, `${path}.orientation`);
};
const validateTarget = (value: unknown, path: string): void => {
  const target = record(value, path);
  exactKeys(target, ["id", "kind", "target", "hard"], path);
  string(target.id, `${path}.id`);
  string(target.kind, `${path}.kind`);
  targetValue(target.target, `${path}.target`);
  boolean(target.hard, `${path}.hard`);
};
const validateConstraint = (value: unknown, path: string): void => {
  const constraint = record(value, path);
  exactKeys(
    constraint,
    ["id", "kind", "value", "hard", "target", "pinned"],
    path,
  );
  string(constraint.id, `${path}.id`);
  string(constraint.kind, `${path}.kind`);
  if (constraint.value !== undefined)
    targetValue(constraint.value, `${path}.value`);
  if (constraint.hard !== undefined) boolean(constraint.hard, `${path}.hard`);
  if (constraint.target !== undefined)
    targetValue(constraint.target, `${path}.target`);
  if (constraint.pinned !== undefined)
    boolean(constraint.pinned, `${path}.pinned`);
};
const validateAabb = (value: unknown, path: string): Aabb => {
  const box = record(value, path);
  exactKeys(box, ["min", "max"], path);
  return {
    min: vector(box.min, `${path}.min`),
    max: vector(box.max, `${path}.max`),
  };
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
  elements.forEach((element, index) =>
    validateElement(element, `elements[${index}]`),
  );
  const gates = array(intent.gates, "gates");
  if (gates.length > 3) fail("gates", "at most 3 items");
  gates.forEach((gate, index) => validateGate(gate, `gates[${index}]`));
  array(intent.targets, "targets").forEach((target, index) =>
    validateTarget(target, `targets[${index}]`),
  );
  array(intent.constraints, "constraints").forEach((constraint, index) =>
    validateConstraint(constraint, `constraints[${index}]`),
  );
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
  const file: CoasterFileV1 = {
    schemaVersion: 1,
    name: input.name,
    intent,
    solvedSpans,
    seed: uint32(input.seed, "seed"),
    generatorVersion: input.generatorVersion ?? intent.generatorVersion,
    profileVersion: input.profileVersion ?? "profile-v1",
    researchSnapshotIds: [...(input.researchSnapshotIds ?? [])],
    compiledDataChecksum: input.compiledDataChecksum ?? "",
  };
  string(file.generatorVersion, "generatorVersion");
  string(file.profileVersion, "profileVersion");
  file.researchSnapshotIds.forEach((id, index) =>
    string(id, `researchSnapshotIds[${index}]`),
  );
  string(file.compiledDataChecksum, "compiledDataChecksum");
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
const canonicalFileValue = (file: CoasterFileV1): CoasterFileV1 => ({
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
  if (!Array.isArray(design.elements)) fail("design.elements", "array");
  const elements = design.elements as unknown[];
  for (const [index, value] of elements.entries()) {
    const element = record(value, `design.elements[${index}]`);
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
  array(file.solvedSpans, "solvedSpans").forEach((span, index) =>
    validateSerializedSpan(span, `solvedSpans[${index}]`),
  );
  uint32(file.seed, "seed");
  string(file.generatorVersion, "generatorVersion");
  string(file.profileVersion, "profileVersion");
  array(file.researchSnapshotIds, "researchSnapshotIds").forEach((id, index) =>
    string(id, `researchSnapshotIds[${index}]`),
  );
  string(file.compiledDataChecksum, "compiledDataChecksum");
}

export const deserializeCoasterFileV1 = (
  encoded: string | Uint8Array,
): CoasterFileV1 => {
  try {
    const text = typeof encoded === "string" ? encoded : decodeUtf8(encoded);
    const value = JSON.parse(text) as unknown;
    if (isRecord(value) && "design" in value && !("intent" in value)) {
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
  return {
    file: parsed,
    solvedSpans,
    track: compileTrack(solvedSpans, options),
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
