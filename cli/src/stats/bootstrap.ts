import { median, quantile } from './describe.js';
import { SeededRandom } from './random.js';

export interface RatioEstimate {
  /** median(B) / median(A); null when A's median is 0 and B's is not (undefined ratio). */
  ratio: number | null;
  /** 95% percentile-bootstrap interval of the ratio; null when the ratio is undefined. */
  ci: [number, number] | null;
}

export interface BootstrapOptions {
  resamples?: number;
  confidence?: number;
  seed?: number;
}

const DEFAULTS = { resamples: 10_000, confidence: 0.95, seed: 0x5eed } as const;

function ratioOf(b: number, a: number): number | null {
  if (a === 0) return b === 0 ? 1 : null;
  return b / a;
}

function resampleMedian(values: readonly number[], rng: SeededRandom, buffer: number[]): number {
  for (let i = 0; i < values.length; i++) buffer[i] = values[rng.nextInt(values.length)]!;
  return median(buffer);
}

/**
 * BR-6: ratio of medians B / A with a percentile-bootstrap confidence interval.
 * Each side is resampled independently with replacement; the generator is seeded so the
 * same data always yields the same interval.
 */
export function bootstrapRatioCI(a: readonly number[], b: readonly number[], options: BootstrapOptions = {}): RatioEstimate {
  const { resamples, confidence, seed } = { ...DEFAULTS, ...options };
  const ratio = ratioOf(median(b), median(a));
  if (ratio === null) return { ratio: null, ci: null };

  const rng = new SeededRandom(seed);
  const bufferA = new Array<number>(a.length);
  const bufferB = new Array<number>(b.length);
  const ratios: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const r = ratioOf(resampleMedian(b, rng, bufferB), resampleMedian(a, rng, bufferA));
    ratios.push(r ?? Number.POSITIVE_INFINITY);
  }
  ratios.sort((x, y) => x - y);
  const tail = (1 - confidence) / 2;
  return { ratio, ci: [quantile(ratios, tail), quantile(ratios, 1 - tail)] };
}
