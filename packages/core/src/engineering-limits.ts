export interface EngineeringLimitsProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly provenance: "PROJECT_ENGINEERING_LIMIT";
  readonly description?: string;
  readonly verticalG: { readonly minimum: number; readonly maximum: number };
  readonly maximumAbsoluteLateralG: number;
  readonly maximumAbsoluteLongitudinalG: number;
  readonly maximumJerkMps3: number;
  readonly maximumRollRateRadPerSecond: number;
  readonly clearanceMarginM: number;
  readonly seams: {
    readonly positionM: number;
    readonly tangentRad: number;
    readonly curvaturePerM: number;
    readonly curvatureGradientPerM2: number;
    readonly bankRad: number;
    readonly bankDerivativeRadPerM: number;
    readonly specificForceJumpG: number;
    readonly sustainedForceDeviationG: number;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (path: string, reason: string): never => {
  throw new Error(`${path}: expected ${reason}`);
};
const finite = (v: unknown, path: string): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(path, "finite number");
const nonNegative = (v: unknown, path: string): number => {
  const n = finite(v, path);
  if (n < 0) fail(path, "non-negative finite number");
  return n;
};

export function validateEngineeringLimitsProfile(
  value: unknown,
): asserts value is EngineeringLimitsProfile {
  if (!isRecord(value)) fail("profile", "object");
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 1) fail("profile.schemaVersion", "1");
  if (typeof p.profileId !== "string" || p.profileId.trim() === "")
    fail("profile.profileId", "non-empty string");
  if (p.provenance !== "PROJECT_ENGINEERING_LIMIT")
    fail("profile.provenance", "PROJECT_ENGINEERING_LIMIT");
  if (p.description !== undefined && typeof p.description !== "string")
    fail("profile.description", "string");
  if (!isRecord(p.verticalG)) fail("profile.verticalG", "object");
  const vg = p.verticalG as Record<string, unknown>;
  const vgMin = finite(vg.minimum, "profile.verticalG.minimum");
  const vgMax = finite(vg.maximum, "profile.verticalG.maximum");
  if (vgMin > vgMax) fail("profile.verticalG", "minimum <= maximum");
  if (Object.keys(vg).some((k) => k !== "minimum" && k !== "maximum"))
    fail("profile.verticalG", "no extra field");
  nonNegative(p.maximumAbsoluteLateralG, "profile.maximumAbsoluteLateralG");
  nonNegative(
    p.maximumAbsoluteLongitudinalG,
    "profile.maximumAbsoluteLongitudinalG",
  );
  nonNegative(p.maximumJerkMps3, "profile.maximumJerkMps3");
  nonNegative(
    p.maximumRollRateRadPerSecond,
    "profile.maximumRollRateRadPerSecond",
  );
  nonNegative(p.clearanceMarginM, "profile.clearanceMarginM");
  if (!isRecord(p.seams)) fail("profile.seams", "object");
  const seams = p.seams as Record<string, unknown>;
  const seamKeys = [
    "positionM",
    "tangentRad",
    "curvaturePerM",
    "curvatureGradientPerM2",
    "bankRad",
    "bankDerivativeRadPerM",
    "specificForceJumpG",
    "sustainedForceDeviationG",
  ] as const;
  for (const k of seamKeys) nonNegative(seams[k], `profile.seams.${k}`);
  if (Object.keys(seams).length !== seamKeys.length)
    fail("profile.seams", "exact 8 seam fields");
  const allowed = new Set([
    "schemaVersion",
    "profileId",
    "provenance",
    "description",
    "verticalG",
    "maximumAbsoluteLateralG",
    "maximumAbsoluteLongitudinalG",
    "maximumJerkMps3",
    "maximumRollRateRadPerSecond",
    "clearanceMarginM",
    "seams",
  ]);
  for (const k of Object.keys(p))
    if (!allowed.has(k)) fail(`profile.${k}`, "no extra field");
}

export function parseEngineeringLimitsProfile(
  value: unknown,
): EngineeringLimitsProfile {
  validateEngineeringLimitsProfile(value);
  return value as EngineeringLimitsProfile;
}
