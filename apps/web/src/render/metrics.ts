export interface MetricsSnapshot {
  readonly meshBuildTimeMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly frameDurationMs: number;
}

export class RenderMetrics {
  public meshBuildTimeMs = 0;
  public drawCalls = 0;
  public triangles = 0;
  public frameDurationMs = 0;
  private frameStart = 0;

  public beginFrame(): void {
    this.frameStart = performance.now();
  }

  public endFrame(): void {
    if (this.frameStart !== 0) {
      this.frameDurationMs = performance.now() - this.frameStart;
    }
  }

  public recordBuild(
    buildTimeMs: number,
    drawCalls: number,
    triangles: number,
  ): void {
    this.meshBuildTimeMs = buildTimeMs;
    this.drawCalls = drawCalls;
    this.triangles = triangles;
  }

  public toJSON(): MetricsSnapshot {
    return {
      meshBuildTimeMs: this.meshBuildTimeMs,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      frameDurationMs: this.frameDurationMs,
    };
  }
}
