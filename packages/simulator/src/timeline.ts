export interface RideTimelineInput {
  readonly sampleRateHz: number;
  readonly timeSeconds: Float64Array;
  readonly headDistanceM: Float64Array;
  readonly speedMps: Float64Array;
  readonly longitudinalG?: Float64Array;
  readonly lateralG?: Float64Array;
  readonly verticalG?: Float64Array;
  readonly jerkMps3?: Float64Array;
  readonly carCount?: number;
  readonly carPositionsXYZ?: Float64Array;
  readonly carTangentsXYZ?: Float64Array;
  readonly carNormalsXYZ?: Float64Array;
  readonly carBinormalsXYZ?: Float64Array;
}

export interface RideTimelineTransfer {
  readonly sampleRateHz: number;
  readonly carCount: number;
  readonly length: number;
  readonly buffers: readonly ArrayBuffer[];
}

const clone = (values: Float64Array | undefined): Float64Array =>
  values ? new Float64Array(values) : new Float64Array();

export class RideTimeline {
  readonly #sampleRateHz: number;
  readonly #carCount: number;
  readonly #timeSeconds: Float64Array;
  readonly #headDistanceM: Float64Array;
  readonly #speedMps: Float64Array;
  readonly #longitudinalG: Float64Array;
  readonly #lateralG: Float64Array;
  readonly #verticalG: Float64Array;
  readonly #jerkMps3: Float64Array;
  readonly #carPositionsXYZ: Float64Array;
  readonly #carTangentsXYZ: Float64Array;
  readonly #carNormalsXYZ: Float64Array;
  readonly #carBinormalsXYZ: Float64Array;

  public constructor(input: RideTimelineInput) {
    if (!Number.isFinite(input.sampleRateHz) || input.sampleRateHz <= 0)
      throw new RangeError("RideTimeline sample rate must be positive");
    const length = input.timeSeconds.length;
    for (const values of [input.headDistanceM, input.speedMps])
      if (values.length !== length)
        throw new RangeError(
          "RideTimeline scalar arrays must have equal lengths",
        );
    for (const values of [input.longitudinalG, input.lateralG, input.verticalG])
      if (values && values.length !== 0 && values.length !== length)
        throw new RangeError(
          "RideTimeline metric arrays must match time length",
        );
    this.#sampleRateHz = input.sampleRateHz;
    this.#carCount = input.carCount ?? 0;
    this.#timeSeconds = new Float64Array(input.timeSeconds);
    this.#headDistanceM = new Float64Array(input.headDistanceM);
    this.#speedMps = new Float64Array(input.speedMps);
    this.#longitudinalG = clone(input.longitudinalG);
    this.#lateralG = clone(input.lateralG);
    this.#verticalG = clone(input.verticalG);
    this.#jerkMps3 = clone(input.jerkMps3);
    this.#carPositionsXYZ = clone(input.carPositionsXYZ);
    this.#carTangentsXYZ = clone(input.carTangentsXYZ);
    this.#carNormalsXYZ = clone(input.carNormalsXYZ);
    this.#carBinormalsXYZ = clone(input.carBinormalsXYZ);
    Object.freeze(this);
  }

  public get sampleRateHz(): number {
    return this.#sampleRateHz;
  }
  public get carCount(): number {
    return this.#carCount;
  }
  public get length(): number {
    return this.#timeSeconds.length;
  }
  public get timeSeconds(): Float64Array {
    return new Float64Array(this.#timeSeconds);
  }
  public get headDistanceM(): Float64Array {
    return new Float64Array(this.#headDistanceM);
  }
  public get speedMps(): Float64Array {
    return new Float64Array(this.#speedMps);
  }
  public get longitudinalG(): Float64Array {
    return new Float64Array(this.#longitudinalG);
  }
  public get lateralG(): Float64Array {
    return new Float64Array(this.#lateralG);
  }
  public get verticalG(): Float64Array {
    return new Float64Array(this.#verticalG);
  }
  public get jerkMps3(): Float64Array {
    return new Float64Array(this.#jerkMps3);
  }
  public get carPositionsXYZ(): Float64Array {
    return new Float64Array(this.#carPositionsXYZ);
  }
  public get carTangentsXYZ(): Float64Array {
    return new Float64Array(this.#carTangentsXYZ);
  }
  public get carNormalsXYZ(): Float64Array {
    return new Float64Array(this.#carNormalsXYZ);
  }
  public get carBinormalsXYZ(): Float64Array {
    return new Float64Array(this.#carBinormalsXYZ);
  }

  public toTransferable(): RideTimelineTransfer {
    return {
      sampleRateHz: this.#sampleRateHz,
      carCount: this.#carCount,
      length: this.length,
      buffers: [
        this.#timeSeconds.slice().buffer,
        this.#headDistanceM.slice().buffer,
        this.#speedMps.slice().buffer,
        this.#longitudinalG.slice().buffer,
        this.#lateralG.slice().buffer,
        this.#verticalG.slice().buffer,
        this.#jerkMps3.slice().buffer,
        this.#carPositionsXYZ.slice().buffer,
        this.#carTangentsXYZ.slice().buffer,
        this.#carNormalsXYZ.slice().buffer,
        this.#carBinormalsXYZ.slice().buffer,
      ],
    };
  }

  public static fromTransferable(transfer: RideTimelineTransfer): RideTimeline {
    if (transfer.buffers.length < 11)
      throw new RangeError(
        "RideTimeline transfer is missing typed-array buffers",
      );
    const values = transfer.buffers.map((buffer) => new Float64Array(buffer));
    return new RideTimeline({
      sampleRateHz: transfer.sampleRateHz,
      carCount: transfer.carCount,
      timeSeconds: values[0]!,
      headDistanceM: values[1]!,
      speedMps: values[2]!,
      longitudinalG: values[3]!,
      lateralG: values[4]!,
      verticalG: values[5]!,
      jerkMps3: values[6]!,
      carPositionsXYZ: values[7]!,
      carTangentsXYZ: values[8]!,
      carNormalsXYZ: values[9]!,
      carBinormalsXYZ: values[10]!,
    });
  }

  public transferables(): readonly ArrayBuffer[] {
    return this.toTransferable().buffers;
  }

  public toJSON(): Record<string, unknown> {
    return {
      sampleRateHz: this.#sampleRateHz,
      carCount: this.#carCount,
      timeSeconds: Array.from(this.#timeSeconds),
      headDistanceM: Array.from(this.#headDistanceM),
      speedMps: Array.from(this.#speedMps),
      longitudinalG: Array.from(this.#longitudinalG),
      lateralG: Array.from(this.#lateralG),
      verticalG: Array.from(this.#verticalG),
      jerkMps3: Array.from(this.#jerkMps3),
      carPositionsXYZ: Array.from(this.#carPositionsXYZ),
      carTangentsXYZ: Array.from(this.#carTangentsXYZ),
      carNormalsXYZ: Array.from(this.#carNormalsXYZ),
      carBinormalsXYZ: Array.from(this.#carBinormalsXYZ),
    };
  }
}
