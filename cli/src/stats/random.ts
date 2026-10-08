/**
 * Seeded xoshiro128** generator. Reports must be reproducible byte for byte (BR-6, BR-18),
 * so statistics never use Math.random().
 */
export class SeededRandom {
  private readonly state: Uint32Array;

  constructor(seed: number) {
    // splitmix32 expands the seed into the 128-bit state.
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.state = new Uint32Array([next(), next(), next(), next()]);
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number {
    const s = this.state;
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return result;
  }

  /** Uniform integer in [0, bound). Rejection sampling avoids modulo bias. */
  nextInt(bound: number): number {
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
    let value: number;
    do value = this.nextUint32();
    while (value >= limit);
    return value % bound;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
