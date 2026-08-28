import type { Aabb, Vec3 } from "./math";
import type { ParametricSpan } from "./spans";

export interface DesignElementV1 {
  readonly id: string;
  readonly type?: string;
  readonly parameters?: Readonly<Record<string, number | string | boolean>>;
}
export interface GateV1 {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
}
export interface ConstraintV1 {
  readonly id: string;
  readonly kind: string;
  readonly value: number;
  readonly hard?: boolean;
}
export interface DesignIntentV1 {
  readonly elements: readonly DesignElementV1[];
  readonly gates?: readonly GateV1[];
  readonly constraints?: readonly ConstraintV1[];
}
export interface SolvedSpan {
  readonly id: string;
  readonly span: ParametricSpan<Vec3>;
  readonly bank?: ParametricSpan<number>;
  readonly zones?: readonly string[];
  readonly bounds?: Aabb;
}
export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly elementId?: string;
  readonly suggestedRelaxation?: string;
}
export interface EnvironmentRaycast {
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
}
export interface EnvironmentQuery {
  signedDistance(point: Vec3): number;
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
