export type Unit<Name extends string> = number & { readonly __unit: Name };

const unit = <Name extends string>(value: number): Unit<Name> => {
  if (!Number.isFinite(value)) throw new RangeError("SI values must be finite");
  return value as Unit<Name>;
};

export type Metres = Unit<"metres">;
export type Meters = Metres;
export type Seconds = Unit<"seconds">;
export type MetresPerSecond = Unit<"metres-per-second">;
export type MetersPerSecond = MetresPerSecond;
export type Radians = Unit<"radians">;
export type Metre = Metres;
export type Meter = Meters;
export type Second = Seconds;
export type Radian = Radians;

export const metres = (value: number): Metres => unit<"metres">(value);
export const meters = metres;
export const seconds = (value: number): Seconds => unit<"seconds">(value);
export const metresPerSecond = (value: number): MetresPerSecond =>
  unit<"metres-per-second">(value);
export const metersPerSecond = metresPerSecond;
export const radians = (value: number): Radians => unit<"radians">(value);
