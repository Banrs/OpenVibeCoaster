import type { DesignIntentV1 } from "./contracts";

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
  readonly seed: number;
  readonly design: DesignIntentV1;
}
export class CoasterFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CoasterFileError";
  }
}
export const createCoasterFileV1 = (
  input: Omit<CoasterFileV1, "schemaVersion">,
): CoasterFileV1 => {
  if (typeof input.name !== "string")
    throw new CoasterFileError("name: expected string");
  validateUint32(input.seed, "seed");
  validateDesign(input.design);
  return Object.freeze({
    schemaVersion: 1 as const,
    name: input.name,
    seed: input.seed,
    design: input.design,
  });
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const fail = (path: string, reason: string): never => {
  throw new CoasterFileError(`${path}: expected ${reason}`);
};
const validateString = (value: unknown, path: string): string =>
  typeof value === "string" ? value : fail(path, "string");
const validateNumber = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(path, "finite number");
const validateBoolean = (value: unknown, path: string): boolean =>
  typeof value === "boolean" ? value : fail(path, "boolean");
const validateUint32 = (value: unknown, path: string): number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 0xffffffff
    ? value
    : fail(path, "uint32 integer");
const validatePrimitive = (value: unknown, path: string): void => {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    fail(path, "primitive value");
  if (typeof value === "number" && !Number.isFinite(value))
    fail(path, "primitive value");
};
const validateTarget = (value: unknown, path: string): void => {
  if (typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  fail(path, "string or finite number");
};
const validateOptionalNestedFields = (
  value: Record<string, unknown>,
  path: string,
): void => {
  if ("target" in value) validateTarget(value.target, `${path}.target`);
  if ("pinned" in value) validateBoolean(value.pinned, `${path}.pinned`);
};
const validateParameters = (value: unknown, path: string): void => {
  if (!isRecord(value)) fail(path, "object");
  const parameters = value as Record<string, unknown>;
  for (const [key, parameter] of Object.entries(parameters))
    validatePrimitive(parameter, `${path}.${key}`);
};
const validateCoefficients = (value: unknown, path: string): void => {
  if (!Array.isArray(value)) fail(path, "array of finite numbers");
  const coefficients = value as unknown[];
  for (let index = 0; index < coefficients.length; index += 1) {
    const coefficient = coefficients[index];
    if (Array.isArray(coefficient))
      validateCoefficients(coefficient, `${path}[${index}]`);
    else validateNumber(coefficient, `${path}[${index}]`);
  }
};
const validateElement = (value: unknown, path: string): void => {
  if (!isRecord(value)) fail(path, "object");
  const element = value as Record<string, unknown>;
  validateString(element.id, `${path}.id`);
  if ("type" in element) validateString(element.type, `${path}.type`);
  if ("parameters" in element)
    validateParameters(element.parameters, `${path}.parameters`);
  validateOptionalNestedFields(element, path);
  if ("coefficients" in element)
    validateCoefficients(element.coefficients, `${path}.coefficients`);
};
const validateGate = (value: unknown, path: string): void => {
  if (!isRecord(value)) fail(path, "object");
  const gate = value as Record<string, unknown>;
  validateString(gate.id, `${path}.id`);
  validateNumber(gate.at, `${path}.at`);
  validateString(gate.kind, `${path}.kind`);
  validateOptionalNestedFields(gate, path);
};
const validateConstraint = (value: unknown, path: string): void => {
  if (!isRecord(value)) fail(path, "object");
  const constraint = value as Record<string, unknown>;
  validateString(constraint.id, `${path}.id`);
  validateString(constraint.kind, `${path}.kind`);
  validateNumber(constraint.value, `${path}.value`);
  if ("hard" in constraint) validateBoolean(constraint.hard, `${path}.hard`);
  validateOptionalNestedFields(constraint, path);
};
const validateDesign: (value: unknown) => asserts value is DesignIntentV1 = (
  value,
): asserts value is DesignIntentV1 => {
  if (!isRecord(value)) fail("design", "object");
  const design = value as Record<string, unknown>;
  if (!Array.isArray(design.elements)) fail("design.elements", "array");
  const elements = design.elements as unknown[];
  for (let index = 0; index < elements.length; index += 1)
    validateElement(elements[index], `design.elements[${index}]`);
  if ("gates" in design) {
    if (!Array.isArray(design.gates)) fail("design.gates", "array");
    const gates = design.gates as unknown[];
    for (let index = 0; index < gates.length; index += 1)
      validateGate(gates[index], `design.gates[${index}]`);
  }
  if ("constraints" in design) {
    if (!Array.isArray(design.constraints)) fail("design.constraints", "array");
    const constraints = design.constraints as unknown[];
    for (let index = 0; index < constraints.length; index += 1)
      validateConstraint(constraints[index], `design.constraints[${index}]`);
  }
  if ("solvedSpans" in design) {
    if (!Array.isArray(design.solvedSpans)) fail("design.solvedSpans", "array");
    const solvedSpans = design.solvedSpans as unknown[];
    for (let index = 0; index < solvedSpans.length; index += 1) {
      const path = `design.solvedSpans[${index}]`;
      const span = solvedSpans[index];
      if (!isRecord(span)) fail(path, "object");
      const solvedSpan = span as Record<string, unknown>;
      validateString(solvedSpan.id, `${path}.id`);
      validateCoefficients(solvedSpan.coefficients, `${path}.coefficients`);
    }
  }
};
const decodeUtf8 = (bytes: Uint8Array): string => {
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    if (first < 0x80) text += String.fromCodePoint(first);
    else if (first < 0xe0)
      text += String.fromCodePoint(
        ((first & 0x1f) << 6) | (bytes[index++] & 0x3f),
      );
    else if (first < 0xf0)
      text += String.fromCodePoint(
        ((first & 0x0f) << 12) |
          ((bytes[index++] & 0x3f) << 6) |
          (bytes[index++] & 0x3f),
      );
    else
      text += String.fromCodePoint(
        ((first & 0x07) << 18) |
          ((bytes[index++] & 0x3f) << 12) |
          ((bytes[index++] & 0x3f) << 6) |
          (bytes[index++] & 0x3f),
      );
  }
  return text;
};
const validate = (value: unknown): CoasterFileV1 => {
  if (!isRecord(value))
    throw new CoasterFileError("Coaster file must be a JSON object");
  if (value.schemaVersion !== 1)
    throw new CoasterFileError(
      `Unsupported coaster schema version: ${String(value.schemaVersion)}`,
    );
  const file = value as Record<string, unknown>;
  const name = validateString(file.name, "name");
  const seed = validateUint32(file.seed, "seed");
  const design = file.design;
  validateDesign(design);
  return createCoasterFileV1({
    name,
    seed,
    design,
  });
};
export const serializeCoasterFileV1 = (file: CoasterFileV1): string =>
  JSON.stringify({
    schemaVersion: 1,
    name: file.name,
    seed: file.seed,
    design: file.design,
  });
export const deserializeCoasterFileV1 = (
  encoded: string | Uint8Array,
): CoasterFileV1 => {
  try {
    const text = typeof encoded === "string" ? encoded : decodeUtf8(encoded);
    return validate(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof CoasterFileError) throw error;
    throw new CoasterFileError(
      `Invalid coaster file JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
};
export const parseCoasterFile = deserializeCoasterFileV1;
export const coasterFileChecksum = (file: CoasterFileV1): string => {
  let hash = 0x811c9dc5;
  for (const byte of encodeUtf8(serializeCoasterFileV1(file)))
    hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
};
export const checksumCoasterFileV1 = coasterFileChecksum;
