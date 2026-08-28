export type Seed = string | number | bigint;

const mix32 = (value: number): number => {
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
};

export const hashSeed = (seed: Seed, ...parts: Seed[]): number => {
  let hash = 0x811c9dc5;
  for (const value of [seed, ...parts]) {
    const text = typeof value === "string" ? value : value.toString();
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return mix32(hash);
};

const rotl = (value: number, shift: number): number =>
  (value << shift) | (value >>> (32 - shift));

export class Xoshiro128ss {
  private state: [number, number, number, number];
  private readonly rootSeed: number;

  public constructor(seed: Seed | readonly [number, number, number, number]) {
    if (
      typeof seed !== "string" &&
      typeof seed !== "number" &&
      typeof seed !== "bigint"
    ) {
      this.state = [seed[0] >>> 0, seed[1] >>> 0, seed[2] >>> 0, seed[3] >>> 0];
      this.rootSeed = hashSeed(
        seed[0] ?? 0,
        seed[1] ?? 0,
        seed[2] ?? 0,
        seed[3] ?? 0,
      );
    } else {
      this.rootSeed = hashSeed(seed);
      let x = this.rootSeed;
      const next = (): number => {
        x = (x + 0x9e3779b9) >>> 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
        z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
        return (z ^ (z >>> 15)) >>> 0;
      };
      this.state = [next(), next(), next(), next()];
    }
    if ((this.state[0] | this.state[1] | this.state[2] | this.state[3]) === 0)
      this.state[0] = 1;
  }

  public nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.state[1], 5), 7), 9) >>> 0;
    const t = (this.state[1] << 9) >>> 0;
    this.state[2] ^= this.state[0];
    this.state[3] ^= this.state[1];
    this.state[1] ^= this.state[2];
    this.state[0] ^= this.state[3];
    this.state[2] ^= t;
    this.state[3] = rotl(this.state[3], 11) >>> 0;
    return result;
  }

  public nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  public nextRange(min: number, max: number): number {
    if (!(max >= min))
      throw new RangeError("Random range must have max >= min");
    return min + (max - min) * this.nextFloat();
  }

  public fork(name: string): Xoshiro128ss {
    return new Xoshiro128ss(hashSeed(this.rootSeed, name));
  }
}
