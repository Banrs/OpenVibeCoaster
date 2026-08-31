export class TrackCompileError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "TrackCompileError";
    this.code = code;
  }
}
