import type {
  CoasterFileV1,
  CompiledTrackData,
  Diagnostic,
  EnvironmentQuery,
  DesignIntentV1,
  SolvedSpan,
  Vec3,
} from "@openvibecoaster/core";

export const ELEMENT_KINDS = [
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
] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];

export interface StationParameters {
  readonly length: number;
  readonly bank: number;
  readonly closed: boolean;
}
export interface LaunchParameters {
  readonly length: number;
  readonly targetSpeed: number;
  readonly bank: number;
}
export interface BrakeParameters {
  readonly length: number;
  readonly targetSpeed: number;
  readonly bank: number;
}
export interface TransitionParameters {
  readonly length: number;
  readonly rise: number;
  readonly pitch: number;
  readonly bank: number;
}
export interface TopHatParameters {
  readonly height: number;
  readonly width: number;
  readonly bank: number;
}
export interface AirtimeHillParameters {
  readonly length: number;
  readonly height: number;
  readonly targetForceG: number;
  readonly referenceSpeed: number;
  readonly bank: number;
}
export interface OverbankedTurnParameters {
  readonly radius: number;
  readonly angle: number;
  readonly bank: number;
}
export interface ZeroGRollParameters {
  readonly length: number;
  readonly roll: number;
}
export interface StallParameters {
  readonly length: number;
  readonly height: number;
  readonly bank: number;
}

export interface ElementParameterMap {
  readonly station: StationParameters;
  readonly launch: LaunchParameters;
  readonly boost: LaunchParameters;
  readonly brake: BrakeParameters;
  readonly transition: TransitionParameters;
  readonly topHat: TopHatParameters;
  readonly airtimeHill: AirtimeHillParameters;
  readonly overbankedTurn: OverbankedTurnParameters;
  readonly zeroGRoll: ZeroGRollParameters;
  readonly stall: StallParameters;
}

export type ElementParameters<K extends ElementKind = ElementKind> =
  ElementParameterMap[K];

export interface SemanticElement<K extends ElementKind = ElementKind> {
  readonly id: string;
  readonly type: K;
  readonly kind: K;
  readonly parameters: Readonly<ElementParameters<K>>;
}
export type AnySemanticElement = {
  [K in ElementKind]: SemanticElement<K>;
}[ElementKind];

export interface Pose {
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly bank: number;
}

export interface ElementBuildResult {
  readonly endPose: Pose;
  readonly solvedSpans: readonly SolvedSpan[];
}

export interface SeamTolerances {
  readonly positionM: number;
  readonly tangentRad: number;
  readonly curvaturePerM: number;
  readonly curvatureGradientPerM2: number;
  readonly bankRad: number;
  readonly bankDerivativeRadPerM: number;
  readonly specificForceJumpG: number;
  readonly sustainedForceDeviationG: number;
}

export interface HardTarget {
  readonly id: string;
  readonly kind:
    "end-x" | "end-y" | "end-z" | "end-bank" | "end-position" | "end-tangent";
  readonly target: number | Vec3;
  readonly hard?: boolean;
}

export interface SolveOptions {
  readonly startPose?: Pose;
  readonly endPose?: Pose;
  readonly closed?: boolean;
  readonly referenceSpeed?: number;
  readonly softForceTargetG?: number;
  readonly seamTolerances?: Partial<SeamTolerances>;
  readonly targets?: readonly HardTarget[];
  readonly maxIterations?: number;
}

export interface ResidualSet {
  readonly positionM: number;
  readonly tangentRad: number;
  readonly curvaturePerM: number;
  readonly curvatureGradientPerM2: number;
  readonly curvatureVectorJumpPerM: number;
  readonly bankRad: number;
  readonly bankDerivativeRadPerM: number;
  readonly specificForceJumpG: number;
  readonly sustainedForceDeviationG: number;
}

export interface SeamDiagnostics extends ResidualSet {
  readonly seamId: string;
  readonly hardResiduals: ResidualSet;
  readonly softResiduals: ResidualSet;
}

export interface SolveResult {
  readonly feasible: boolean;
  readonly solvedSpans: readonly SolvedSpan[];
  readonly diagnostics: readonly Diagnostic[];
  readonly seamDiagnostics: readonly SeamDiagnostics[];
  readonly relaxations: readonly string[];
  readonly startPose: Pose;
  readonly endPose: Pose;
  readonly lmIterations: number;
}

export interface CompileResult extends SolveResult {
  readonly track?: CompiledTrackData;
}

export interface GenerationOptions {
  readonly environment?: EnvironmentQuery;
  readonly samples?: number;
  readonly name?: string;
  readonly generatorVersion?: string;
  readonly profileVersion?: string;
  readonly researchSnapshotIds?: readonly string[];
  readonly trainEnvelopeRadius?: number;
  readonly trackClearance?: number;
}

export type StoredGenerationOptions = Omit<GenerationOptions, "environment">;

export interface GenerationResult {
  readonly feasible: boolean;
  readonly intent: DesignIntentV1;
  readonly elements: readonly AnySemanticElement[];
  readonly solvedSpans: readonly SolvedSpan[];
  readonly track: CompiledTrackData;
  readonly file: CoasterFileV1;
  readonly serializedFile: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly relaxations: readonly string[];
  readonly candidatesTested: number;
  /** Total LM iterations spent across every candidate and relaxation rerun. */
  readonly lmIterations: number;
  /** LM iterations for the candidate selected for the returned geometry. */
  readonly selectedLmIterations: number;
  /** One entry for every evaluated candidate, including rejected candidates. */
  readonly candidateLmIterations: readonly number[];
  readonly candidateLmWork: number;
  /** One entry for every relaxation rerun, including reruns that remain infeasible. */
  readonly relaxationLmIterations: readonly number[];
  readonly relaxationLmWork: number;
  readonly spanHashes: Readonly<Record<string, string>>;
  readonly spanBytes: Readonly<Record<string, string>>;
  readonly relaxationEvidence: readonly RelaxationEvidence[];
  readonly options: StoredGenerationOptions;
}

export interface RelaxationEvidence {
  readonly change: string;
  readonly rerun: true;
  readonly feasible: boolean;
  readonly lmIterations: number;
  readonly margins: Readonly<Record<string, number>>;
}

export interface ClearanceOptions {
  readonly trainEnvelopeRadius?: number;
  readonly samplesPerSpan?: number;
  readonly trackClearance?: number;
  readonly closed?: boolean;
  readonly maxDepth?: number;
  readonly maxWork?: number;
}

export interface LocalRegenerationOptions {
  readonly environment?: EnvironmentQuery;
  readonly pinnedElementIds?: readonly string[];
  readonly intent?: DesignIntentV1;
  readonly changes?: Readonly<
    Record<string, Partial<Record<string, number | string | boolean>>>
  >;
}

export interface LocalRegenerationResult {
  readonly feasible: boolean;
  readonly generation: GenerationResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly changedWindow: readonly [number, number];
  readonly untouchedSpanHashes: Readonly<Record<string, string>>;
  readonly untouchedSpanBytes: Readonly<Record<string, string>>;
}
