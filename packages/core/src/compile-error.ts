export type TrackCompileErrorCode =
  | "UNBOUNDED_SPAN"
  | "SAMPLE_BUDGET_EXCEEDED"
  | "INTEGRATION_FAILED"
  | "INVERSION_FAILED"
  | "SPEED_CERTIFICATION_FAILED"
  | "CHORD_CERTIFICATION_FAILED";

export interface TrackCompileErrorEvidence {
  readonly elementId?: string;
  readonly stage?: string;
  readonly uInterval?: readonly [number, number];
  readonly sInterval?: readonly [number, number];
  readonly actual?: number;
  readonly limit?: number;
  readonly depth?: number;
  readonly samples?: number;
  readonly limitSamples?: number;
  readonly totalLength?: number;
  readonly work?: number;
}

export class TrackCompileError extends Error {
  public readonly code: TrackCompileErrorCode;
  public readonly evidence: TrackCompileErrorEvidence;
  public constructor(
    code: TrackCompileErrorCode,
    message: string,
    evidence: TrackCompileErrorEvidence = {},
  ) {
    super(message);
    this.name = "TrackCompileError";
    this.code = code;
    this.evidence = Object.freeze({ ...evidence });
  }
}
