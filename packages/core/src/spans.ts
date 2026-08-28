import { vec3 } from "./math";
import type { Vec3 } from "./math";

export type SpanValue = number | Vec3;
export interface ParametricSpan<T extends SpanValue = Vec3> {
  readonly position: (u: number) => T;
  readonly derivative: (u: number, order?: number) => T;
}

const components = (value: SpanValue): number[] =>
  typeof value === "number" ? [value] : [...value];
const fromComponents = <T extends SpanValue>(
  values: readonly number[],
  template: T,
): T => {
  if (typeof template === "number") return values[0] as T;
  return vec3(values[0], values[1], values[2]) as T;
};
const factorial = (n: number): number => (n === 0 ? 1 : n * factorial(n - 1));

export interface SeventhOrderHermiteSpec<T extends SpanValue> {
  readonly p0: T;
  readonly d10: T;
  readonly d20: T;
  readonly d30: T;
  readonly p1: T;
  readonly d11: T;
  readonly d21: T;
  readonly d31: T;
}

export class SeventhOrderHermiteSpan<
  T extends SpanValue = number,
> implements ParametricSpan<T> {
  private coefficientRows: readonly number[][];
  private template: T;
  private endpointConditions: readonly (readonly (readonly number[])[])[];

  public constructor(spec: SeventhOrderHermiteSpec<T>) {
    this.template = spec.p0;
    const start = [spec.p0, spec.d10, spec.d20, spec.d30].map(components);
    const end = [spec.p1, spec.d11, spec.d21, spec.d31].map(components);
    this.endpointConditions = [start, end];
    this.coefficientRows = start[0]!.map((_, component) => {
      const result = [
        start[0]![component]!,
        start[1]![component]!,
        start[2]![component]! / 2,
        start[3]![component]! / 6,
        0,
        0,
        0,
        0,
      ];
      const rhs = [
        end[0]![component]! - result[0]! - result[1]! - result[2]! - result[3]!,
        end[1]![component]! - result[1]! - 2 * result[2]! - 3 * result[3]!,
        end[2]![component]! - 2 * result[2]! - 6 * result[3]!,
        end[3]![component]! - 6 * result[3]!,
      ];
      const matrix = [
        [1, 1, 1, 1],
        [4, 5, 6, 7],
        [12, 20, 30, 42],
        [24, 60, 120, 210],
      ];
      for (let row = 0; row < 4; row += 1) {
        let pivot = row;
        for (let candidate = row + 1; candidate < 4; candidate += 1)
          if (
            Math.abs(matrix[candidate]![row]!) > Math.abs(matrix[pivot]![row]!)
          )
            pivot = candidate;
        [matrix[row], matrix[pivot]] = [matrix[pivot]!, matrix[row]!];
        [rhs[row], rhs[pivot]] = [rhs[pivot]!, rhs[row]!];
        const divisor = matrix[row]![row]!;
        for (let column = row; column < 4; column += 1)
          matrix[row]![column]! /= divisor;
        rhs[row]! /= divisor;
        for (let other = 0; other < 4; other += 1) {
          if (other === row) continue;
          const factor = matrix[other]![row]!;
          for (let column = row; column < 4; column += 1)
            matrix[other]![column]! -= factor * matrix[row]![column]!;
          rhs[other]! -= factor * rhs[row]!;
        }
      }
      result[4] = rhs[0]!;
      result[5] = rhs[1]!;
      result[6] = rhs[2]!;
      result[7] = rhs[3]!;
      return result;
    });
  }

  public static line<T extends SpanValue>(
    p0: T,
    p1: T,
  ): SeventhOrderHermiteSpan<T> {
    const start = components(p0);
    const delta = components(p1).map((value, index) => value - start[index]!);
    const deltaValue = fromComponents(delta, p0);
    const zero = typeof p0 === "number" ? 0 : vec3(0, 0, 0);
    return new SeventhOrderHermiteSpan({
      p0,
      d10: deltaValue,
      d20: zero as T,
      d30: zero as T,
      p1,
      d11: deltaValue,
      d21: zero as T,
      d31: zero as T,
    });
  }

  public static c3Join<T extends SpanValue>(
    left: ParametricSpan<T>,
    right: ParametricSpan<T>,
  ): SeventhOrderHermiteSpan<T> {
    return new SeventhOrderHermiteSpan({
      p0: left.position(0),
      d10: left.derivative(0, 1),
      d20: left.derivative(0, 2),
      d30: left.derivative(0, 3),
      p1: right.position(1),
      d11: right.derivative(1, 1),
      d21: right.derivative(1, 2),
      d31: right.derivative(1, 3),
    } as SeventhOrderHermiteSpec<T>);
  }

  public static fromCoefficients<T extends SpanValue = number>(
    coefficients: readonly (readonly number[])[],
  ): SeventhOrderHermiteSpan<T> {
    if (
      coefficients.length === 0 ||
      coefficients.some((row) => row.length !== 8)
    )
      throw new RangeError(
        "Seventh-order coefficients must contain eight values per component",
      );
    const template = (coefficients.length === 1 ? 0 : vec3(0, 0, 0)) as T;
    const evaluate = (
      row: readonly number[],
      order: number,
      u: number,
    ): number => {
      let value = 0;
      for (let power = order; power < row.length; power += 1) {
        let factor = 1;
        for (let index = 0; index < order; index += 1) factor *= power - index;
        value += row[power]! * factor * u ** (power - order);
      }
      return value;
    };
    const value = (u: number, order: number): T =>
      fromComponents(
        coefficients.map((row) => evaluate(row, order, u)),
        template,
      );
    const result = Object.create(
      SeventhOrderHermiteSpan.prototype,
    ) as SeventhOrderHermiteSpan<T>;
    result.template = template;
    result.coefficientRows = coefficients.map((row) => [...row]);
    result.endpointConditions = [
      [0, 1, 2, 3].map((order) => components(value(0, order))),
      [0, 1, 2, 3].map((order) => components(value(1, order))),
    ];
    return result;
  }

  public get coefficients(): readonly (readonly number[])[] {
    return this.coefficientRows.map((row) => [...row]);
  }

  public position(u: number): T {
    return this.evaluate(u, 0);
  }
  public derivative(u: number, order = 1): T {
    return this.evaluate(u, order);
  }
  public evaluate(u: number, order = 0): T {
    if (order < 0 || order > 7 || !Number.isInteger(order))
      throw new RangeError("Derivative order must be an integer from 0 to 7");
    if ((u === 0 || u === 1) && order <= 3) {
      const endpoint = u === 0 ? 0 : 1;
      const values = this.endpointConditions[endpoint]![order]!;
      return fromComponents(values, this.template);
    }
    const values = this.coefficientRows.map((coefficient) => {
      let result = 0;
      for (let power = order; power < coefficient.length; power += 1)
        result +=
          ((coefficient[power]! * factorial(power)) /
            factorial(power - order)) *
          u ** (power - order);
      return result;
    });
    return fromComponents(values, this.template);
  }
}

export interface QuinticScalarSpec {
  readonly v0: number;
  readonly d10: number;
  readonly d20: number;
  readonly v1: number;
  readonly d11: number;
  readonly d21: number;
}
export class QuinticScalarSpan implements ParametricSpan<number> {
  private coefficientValues: readonly number[];
  private endpoints: readonly number[];
  public constructor(spec: QuinticScalarSpec) {
    const a0 = spec.v0;
    const a1 = spec.d10;
    const a2 = spec.d20 / 2;
    const b0 = spec.v1 - a0 - a1 - a2;
    const b1 = spec.d11 - a1 - 2 * a2;
    const b2 = spec.d21 - 2 * a2;
    const a5 = (b2 - 6 * b1 + 12 * b0) / 2;
    const a4 = b1 - 3 * b0 - 2 * a5;
    const a3 = b0 - a4 - a5;
    this.coefficientValues = [a0, a1, a2, a3, a4, a5];
    this.endpoints = [spec.v0, spec.d10, spec.d20, spec.v1, spec.d11, spec.d21];
  }
  public static fromCoefficients(
    coefficients: readonly number[],
  ): QuinticScalarSpan {
    if (coefficients.length !== 6)
      throw new RangeError("Quintic coefficients must contain six values");
    const result = Object.create(
      QuinticScalarSpan.prototype,
    ) as QuinticScalarSpan;
    result.coefficientValues = [...coefficients];
    const evaluate = (u: number, order: number): number => {
      let value = 0;
      for (let power = order; power < coefficients.length; power += 1) {
        let factor = 1;
        for (let index = 0; index < order; index += 1) factor *= power - index;
        value += coefficients[power]! * factor * u ** (power - order);
      }
      return value;
    };
    result.endpoints = [0, 1, 2]
      .map((order) => evaluate(0, order))
      .concat([0, 1, 2].map((order) => evaluate(1, order)));
    return result;
  }
  public get coefficients(): readonly number[] {
    return [...this.coefficientValues];
  }
  public value(u: number): number {
    return this.derivative(u, 0);
  }
  public position(u: number): number {
    return this.value(u);
  }
  public derivative(u: number, order = 1): number {
    if (order < 0 || order > 5 || !Number.isInteger(order))
      throw new RangeError("Derivative order must be an integer from 0 to 5");
    if ((u === 0 || u === 1) && order <= 2)
      return this.endpoints[(u === 0 ? 0 : 3) + order]!;
    let result = 0;
    for (let power = order; power < this.coefficientValues.length; power += 1)
      result +=
        ((this.coefficientValues[power]! * factorial(power)) /
          factorial(power - order)) *
        u ** (power - order);
    return result;
  }
}
