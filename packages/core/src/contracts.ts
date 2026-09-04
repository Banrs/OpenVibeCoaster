import type { Vec3 } from "./math";
import type { Aabb } from "./math";
import type { ParametricSpan } from "./spans";

export type DesignModeV1 = "insta" | "full-auto" | "directed";
export type DesignFamilyV1 = "steel-sitdown-lsm-v1";
export type QuaternionV1 = readonly [number, number, number, number];

export interface DesignElementV1 {
  readonly id: string;
  readonly kind?: string;
  readonly type?: string;
  readonly parameters?: Readonly<Record<string, number | string | boolean>>;
  readonly target?: string | number | Vec3;
  readonly pinned?: boolean;
}
export interface DesignCompatibilityV1 {
  readonly elements: readonly DesignElementV1[];
  readonly gates?: readonly GateV1[];
  readonly constraints?: readonly ConstraintV1[];
}
export interface GateV1 {
  readonly id: string;
  readonly position: Vec3;
  readonly orientation?: QuaternionV1;
  readonly at?: number;
  readonly kind?: string;
  readonly target?: string | number | Vec3;
  readonly pinned?: boolean;
}
export interface ConstraintV1 {
  readonly id: string;
  readonly kind: string;
  readonly value?: string | number | Vec3;
  readonly hard?: boolean;
  readonly target?: string | number | Vec3;
  readonly pinned?: boolean;
}
export interface TargetV1 {
  readonly id: string;
  readonly kind: string;
  readonly target: number | Vec3;
  readonly hard: boolean;
}
export interface HeightRangeV1 {
  readonly min: number;
  readonly max: number;
}
export interface DesignIntentV1 {
  readonly elements: readonly DesignElementV1[];
  readonly schemaVersion: 1;
  readonly generatorVersion: string;
  readonly seed: number;
  readonly mode: DesignModeV1;
  readonly family: DesignFamilyV1;
  readonly gates: readonly GateV1[];
  readonly targets: readonly TargetV1[];
  readonly constraints: readonly ConstraintV1[];
  readonly footprint?: readonly Vec3[];
  readonly heightRange?: HeightRangeV1;
  readonly terrainProfileId?: string;
  readonly pinnedElementIds: readonly string[];
}
export interface SolvedSpan {
  readonly id: string;
  readonly span: ParametricSpan<Vec3>;
  readonly bank?: ParametricSpan<number>;
  readonly zones?: readonly string[];
  readonly bounds?: Aabb;
  readonly kind?: string;
  readonly length?: number;
  readonly positionCoefficients?: readonly (readonly number[])[];
  readonly rollCoefficients?: readonly number[];
}
export interface SerializedSolvedSpanV1 {
  readonly id: string;
  readonly kind: string;
  readonly positionCoefficients: readonly (readonly number[])[];
  readonly rollCoefficients: readonly number[];
  readonly length: number;
}
export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly provenance?:
    | "SOURCE_VERIFIED"
    | "PROJECT_ENGINEERING_LIMIT"
    | "DESIGN_ASSUMPTION"
    | "UNKNOWN_UNCONFIGURED";
  readonly message: string;
  readonly elementId?: string;
  readonly suggestedRelaxation?: string;
  readonly location?: {
    readonly s: number;
    readonly position?: Vec3;
    readonly time?: number;
  };
  readonly actual?: number;
  readonly limit?: number;
  readonly margin?: number;
  readonly relatedIds?: readonly string[];
}
export interface EnvironmentRaycast {
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
}
/**
 * Environment signed-distance query for terrain clearance certification.
 *
 * Contract: `signedDistance` MUST return the finite exact Euclidean
 * signed distance to the environment surface (negative inside, positive
 * outside) and MUST be 1-Lipschitz (|d(p)-d(q)| ≤ |p-q|). Any
 * implementation that violates finiteness, exactness, or Lipschitz
 * invalidates the proof. Callers must treat exceptions/failures as
 * conservative unknown and MUST NOT fabricate `actual`, `margin`, or a
 * precise `location` from a failed query.
 */
export interface EnvironmentQuery {
  signedDistance(point: Vec3): number;
  sampleSolid?: (point: Vec3) => number;
  bounds?: () => Aabb;
  /**
   * Optional proof capability. Every point on the signed-distance zero surface
   * relevant to this query must have Y at or below the returned finite value.
   * Implementations that cannot guarantee this must omit the method.
   */
  certifiedSurfaceMaximumY?: () => number;
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): EnvironmentRaycast | undefined;
}
export interface WorkerRequest {
  readonly type: "compile" | "sample" | "cancel";
  readonly requestId: string;
  readonly design?: DesignIntentV1;
}
export interface WorkerResponse {
  readonly type: "compiled" | "diagnostics" | "error";
  readonly requestId: string;
  readonly data?: unknown;
  readonly diagnostics?: readonly Diagnostic[];
}
export type DesignIntent = DesignIntentV1;
export type Element = DesignElementV1;
export type Gate = GateV1;
export type Constraint = ConstraintV1;
export type Environment = EnvironmentQuery;
export type WorkerMessage = WorkerRequest | WorkerResponse;
