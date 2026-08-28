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
): CoasterFileV1 =>
  Object.freeze({
    schemaVersion: 1 as const,
    name: input.name,
    seed: input.seed >>> 0,
    design: input.design,
  });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
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
  if (
    typeof value.name !== "string" ||
    typeof value.seed !== "number" ||
    !Number.isSafeInteger(value.seed) ||
    !isRecord(value.design) ||
    !Array.isArray(value.design.elements)
  )
    throw new CoasterFileError("Invalid coaster file v1 structure");
  return createCoasterFileV1({
    name: value.name,
    seed: value.seed,
    design: value.design as unknown as DesignIntentV1,
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
