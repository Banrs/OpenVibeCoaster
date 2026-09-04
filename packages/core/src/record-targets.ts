export interface RecordTargetProfile {
  readonly schemaVersion: 1;
  readonly profileId: "record-targets-v1";
  readonly provenance: "PROJECT_ENGINEERING_LIMIT";
  readonly totalLengthM: readonly [number, number];
  readonly maxHeightM: readonly [number, number];
  readonly maxSpeedKmh: readonly [number, number];
  readonly invertedTopHatM: readonly [number, number];
  readonly immelmannM: readonly [number, number];
  readonly verticalLoopM: readonly [number, number];
  readonly diveDrop: {
    readonly heightM: number;
    readonly toleranceM: number;
    readonly angleDeg: number;
    readonly toleranceDeg: number;
  };
  readonly force: {
    readonly verticalPeakG: readonly [number, number];
    readonly verticalMinG: number;
    readonly lateralMaxG: number;
    readonly longitudinalMaxG: number;
    readonly jerkMps3: number;
    readonly rollRateRadPerSec: number;
  };
  readonly holdSeconds: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${path}: expected object`);
  return value;
};

const exactKeys = (
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
): void => {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`${path}: expected exactly ${keys.join(", ")}`);
};

const exactNumber = (value: unknown, path: string, expected: number): void => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value !== expected
  )
    throw new Error(`${path}: expected ${expected}`);
};

const exactRange = (
  value: unknown,
  path: string,
  expected: readonly [number, number],
): void => {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`${path}: expected two finite numbers`);
  exactNumber(value[0], `${path}[0]`, expected[0]);
  exactNumber(value[1], `${path}[1]`, expected[1]);
};

export function validateRecordTargetsProfile(
  value: unknown,
): asserts value is RecordTargetProfile {
  const profile = requireRecord(value, "profile");
  exactKeys(profile, "profile", [
    "schemaVersion",
    "profileId",
    "provenance",
    "totalLengthM",
    "maxHeightM",
    "maxSpeedKmh",
    "invertedTopHatM",
    "immelmannM",
    "verticalLoopM",
    "diveDrop",
    "force",
    "holdSeconds",
  ]);
  if (profile.schemaVersion !== 1)
    throw new Error("profile.schemaVersion: expected 1");
  if (profile.profileId !== "record-targets-v1")
    throw new Error("profile.profileId: expected record-targets-v1");
  if (profile.provenance !== "PROJECT_ENGINEERING_LIMIT")
    throw new Error("profile.provenance: expected PROJECT_ENGINEERING_LIMIT");

  exactRange(profile.totalLengthM, "profile.totalLengthM", [5200, 5400]);
  exactRange(profile.maxHeightM, "profile.maxHeightM", [225, 235]);
  exactRange(profile.maxSpeedKmh, "profile.maxSpeedKmh", [285, 295]);
  exactRange(profile.invertedTopHatM, "profile.invertedTopHatM", [90, 92]);
  exactRange(profile.immelmannM, "profile.immelmannM", [80, 82]);
  exactRange(profile.verticalLoopM, "profile.verticalLoopM", [66, 68]);

  const diveDrop = requireRecord(profile.diveDrop, "profile.diveDrop");
  exactKeys(diveDrop, "profile.diveDrop", [
    "heightM",
    "toleranceM",
    "angleDeg",
    "toleranceDeg",
  ]);
  exactNumber(diveDrop.heightM, "profile.diveDrop.heightM", 210);
  exactNumber(diveDrop.toleranceM, "profile.diveDrop.toleranceM", 3);
  exactNumber(diveDrop.angleDeg, "profile.diveDrop.angleDeg", 110);
  exactNumber(diveDrop.toleranceDeg, "profile.diveDrop.toleranceDeg", 1.5);

  const force = requireRecord(profile.force, "profile.force");
  exactKeys(force, "profile.force", [
    "verticalPeakG",
    "verticalMinG",
    "lateralMaxG",
    "longitudinalMaxG",
    "jerkMps3",
    "rollRateRadPerSec",
  ]);
  exactRange(force.verticalPeakG, "profile.force.verticalPeakG", [4.8, 5]);
  exactNumber(force.verticalMinG, "profile.force.verticalMinG", -1.1);
  exactNumber(force.lateralMaxG, "profile.force.lateralMaxG", 1.5);
  exactNumber(force.longitudinalMaxG, "profile.force.longitudinalMaxG", 1.5);
  exactNumber(force.jerkMps3, "profile.force.jerkMps3", 15);
  exactNumber(force.rollRateRadPerSec, "profile.force.rollRateRadPerSec", 1.5);
  exactNumber(profile.holdSeconds, "profile.holdSeconds", 3);
}
