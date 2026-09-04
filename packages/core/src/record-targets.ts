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

const fail = (path: string, expected: string): never => {
  throw new Error(`${path}: expected ${expected}`);
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
    fail(path, `exactly ${keys.join(", ")}`);
};

const exactNumber = (value: unknown, path: string, expected: number): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value !== expected)
    fail(path, String(expected));
};

const exactRange = (
  value: unknown,
  path: string,
  expected: readonly [number, number],
): void => {
  if (!Array.isArray(value) || value.length !== 2)
    fail(path, "two finite numbers");
  exactNumber(value[0], `${path}[0]`, expected[0]);
  exactNumber(value[1], `${path}[1]`, expected[1]);
};

export function validateRecordTargetsProfile(
  value: unknown,
): asserts value is RecordTargetProfile {
  if (!isRecord(value)) fail("profile", "object");
  exactKeys(value, "profile", [
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
  if (value.schemaVersion !== 1) fail("profile.schemaVersion", "1");
  if (value.profileId !== "record-targets-v1")
    fail("profile.profileId", "record-targets-v1");
  if (value.provenance !== "PROJECT_ENGINEERING_LIMIT")
    fail("profile.provenance", "PROJECT_ENGINEERING_LIMIT");

  exactRange(value.totalLengthM, "profile.totalLengthM", [5200, 5400]);
  exactRange(value.maxHeightM, "profile.maxHeightM", [225, 235]);
  exactRange(value.maxSpeedKmh, "profile.maxSpeedKmh", [285, 295]);
  exactRange(value.invertedTopHatM, "profile.invertedTopHatM", [90, 92]);
  exactRange(value.immelmannM, "profile.immelmannM", [80, 82]);
  exactRange(value.verticalLoopM, "profile.verticalLoopM", [66, 68]);

  if (!isRecord(value.diveDrop)) fail("profile.diveDrop", "object");
  exactKeys(value.diveDrop, "profile.diveDrop", [
    "heightM",
    "toleranceM",
    "angleDeg",
    "toleranceDeg",
  ]);
  exactNumber(value.diveDrop.heightM, "profile.diveDrop.heightM", 210);
  exactNumber(value.diveDrop.toleranceM, "profile.diveDrop.toleranceM", 3);
  exactNumber(value.diveDrop.angleDeg, "profile.diveDrop.angleDeg", 110);
  exactNumber(value.diveDrop.toleranceDeg, "profile.diveDrop.toleranceDeg", 1.5);

  if (!isRecord(value.force)) fail("profile.force", "object");
  exactKeys(value.force, "profile.force", [
    "verticalPeakG",
    "verticalMinG",
    "lateralMaxG",
    "longitudinalMaxG",
    "jerkMps3",
    "rollRateRadPerSec",
  ]);
  exactRange(value.force.verticalPeakG, "profile.force.verticalPeakG", [4.8, 5]);
  exactNumber(value.force.verticalMinG, "profile.force.verticalMinG", -1.1);
  exactNumber(value.force.lateralMaxG, "profile.force.lateralMaxG", 1.5);
  exactNumber(
    value.force.longitudinalMaxG,
    "profile.force.longitudinalMaxG",
    1.5,
  );
  exactNumber(value.force.jerkMps3, "profile.force.jerkMps3", 15);
  exactNumber(value.force.rollRateRadPerSec, "profile.force.rollRateRadPerSec", 1.5);
  exactNumber(value.holdSeconds, "profile.holdSeconds", 3);
}
