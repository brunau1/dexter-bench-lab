import { describe as group, expect, it } from 'vitest';
import { bootstrapRatioCI } from '../src/stats/bootstrap.js';
import { describe, stability } from '../src/stats/describe.js';
import { mannWhitneyU } from '../src/stats/mann-whitney.js';
import { compareMetric, type ComparisonInput } from '../src/stats/verdict.js';

// Reference values computed independently with scipy 1.x / numpy (see methodology §5.6).
const WORKED_A = [212, 205, 219, 208, 214];
const WORKED_B = [171, 176, 168, 180, 173];
const THRESHOLDS = { stable: 0.05, acceptable: 0.1 };

/** Values with an exact coefficient of variation: mean 100, sample stdev = cv · 100. */
function sampleWithCv(cv: number): number[] {
  // values 100 − d, 100, 100 + d have sample stdev d; the tiny offset keeps exact boundaries on their side
  const d = cv * 100 * (1 - 1e-9);
  return [100 - d, 100, 100 + d];
}

group('describe and stability (BR-5)', () => {
  it('matches the worked example', () => {
    const a = describe(WORKED_A);
    expect(a.median).toBe(212);
    expect(a.mean).toBeCloseTo(211.6, 10);
    expect(a.cv).toBeCloseTo(0.025581037056189714, 12);
  });

  it.each([
    [0.0499, 'stable'],
    [0.05, 'stable'],
    [0.0501, 'acceptable'],
    [0.1, 'acceptable'],
    [0.1001, 'unstable'],
  ] as const)('CV %f is %s', (cv, expected) => {
    expect(stability(describe(sampleWithCv(cv)).cv, THRESHOLDS)).toBe(expected);
  });

  it('treats constant samples as stable and varying zero-mean samples as unstable', () => {
    expect(stability(describe([0, 0, 0]).cv, THRESHOLDS)).toBe('stable');
    expect(stability(describe([-1, 0, 1]).cv, THRESHOLDS)).toBe('unstable');
  });
});

group('bootstrap ratio CI (BR-6)', () => {
  it('reproduces the reference interval of the worked example', () => {
    const { ratio, ci } = bootstrapRatioCI(WORKED_A, WORKED_B);
    expect(ratio).toBeCloseTo(173 / 212, 12);
    // numpy reference with 200 000 resamples: [0.78505, 0.85854]
    expect(ci![0]).toBeCloseTo(0.78505, 2);
    expect(ci![1]).toBeCloseTo(0.85854, 2);
  });

  it('is deterministic for the same data and seed', () => {
    const a = [10.1, 10.4, 9.8, 10.0, 10.2, 9.7, 10.6, 9.9];
    const b = [10.3, 9.9, 10.5, 10.1, 10.0, 11.0, 9.6, 10.8];
    expect(bootstrapRatioCI(a, b)).toEqual(bootstrapRatioCI(a, b));
    expect(bootstrapRatioCI(a, b, { seed: 1 })).not.toEqual(bootstrapRatioCI(a, b, { seed: 2 }));
  });

  it('contains 1.0 for identical samples and excludes it for a 20% shift', () => {
    const a = [50, 52, 49, 51, 50.5];
    const same = bootstrapRatioCI(a, a);
    expect(same.ratio).toBe(1);
    expect(same.ci![0]).toBeLessThan(1);
    expect(same.ci![1]).toBeGreaterThan(1);
    const { ci } = bootstrapRatioCI(a, a.map((v) => v * 1.2));
    expect(ci![0]).toBeGreaterThan(1);
  });

  it('returns an undefined ratio when A is 0 and B is not', () => {
    expect(bootstrapRatioCI([0, 0, 0], [1, 2, 1])).toEqual({ ratio: null, ci: null });
    expect(bootstrapRatioCI([0, 0, 0], [0, 0, 0]).ratio).toBe(1);
  });
});

group('Mann-Whitney U (BR-6)', () => {
  it.each([
    ['worked example 5v5', WORKED_A, WORKED_B, 0, 0.007936507936507936],
    ['overlap 3v3', [10, 12, 14], [11, 13, 15], 6, 0.7],
    ['shift 8v8', [1, 2, 3, 4, 5, 6, 7, 8], [5.5, 6.5, 7.5, 8.5, 9, 10, 11, 12], 58, 0.004662004662004662],
    ['unequal 4v6', [3.1, 4.2, 5.0, 2.2], [6.1, 7.3, 1.5, 8.8, 9.0, 4.4], 19, 0.17142857142857143],
  ])('exact: %s', (_label, a, b, u, p) => {
    const result = mannWhitneyU(a, b);
    expect(result.method).toBe('exact');
    expect(result.u).toBe(u);
    expect(result.p).toBeCloseTo(p, 12);
  });

  it('uses the tie-corrected normal approximation when values tie', () => {
    const result = mannWhitneyU([1, 2, 2, 3, 3, 3, 4], [2, 3, 4, 4, 5, 5, 6]);
    expect(result.method).toBe('asymptotic');
    expect(result.u).toBe(40.5);
    expect(result.p).toBeCloseTo(0.043051432728945134, 6);
  });

  it('uses the normal approximation above 20 values per side', () => {
    const a = [110.205, 87.222, 102.09, 97.161, 97.737, 98.922, 89.9, 98.84, 95.674, 116.615, 101.129, 98.237, 98.594, 96.66, 94.724, 98.046, 102.41, 98.807, 104.789, 99.001, 100.121, 107.729, 102.726, 97.474, 99.086];
    const b = [112.703, 119.675, 108.652, 108.782, 115.012, 105.568, 108.541, 114.413, 112.902, 110.458, 113.351, 95.859, 115.107, 105.202, 101.657, 111.382, 113.503, 107.776, 104.618, 110.131, 109.736, 117.028];
    const result = mannWhitneyU(a, b);
    expect(result.method).toBe('asymptotic');
    expect(result.u).toBe(491);
    expect(result.p / 4.338392235739676e-6).toBeCloseTo(1, 4);
  });
});

group('verdict (BR-7, BR-8)', () => {
  const input = (overrides: Partial<ComparisonInput> = {}): ComparisonInput => ({
    a: { values: WORKED_A, valid: true },
    b: { values: WORKED_B, valid: true },
    direction: 'lower',
    thresholds: THRESHOLDS,
    noiseFloor: 0.04,
    ...overrides,
  });
  const flat = [100, 101, 99, 100.5, 99.5];

  it.each([
    ['lower is better, B lower', {}, 'improved'],
    ['higher is better, B lower', { direction: 'higher' as const }, 'regressed'],
    ['lower is better, B higher', { a: { values: WORKED_B, valid: true }, b: { values: WORKED_A, valid: true } }, 'regressed'],
    ['neutral, B lower', { direction: 'neutral' as const }, 'changed-down'],
    ['neutral, B higher', { direction: 'neutral' as const, a: { values: WORKED_B, valid: true }, b: { values: WORKED_A, valid: true } }, 'changed-up'],
    ['effect inside the noise floor', { noiseFloor: 0.25 }, 'no-significant-change'],
    ['same distribution', { a: { values: flat, valid: true }, b: { values: flat, valid: true } }, 'no-significant-change'],
    ['A unstable', { a: { values: [100, 150, 60, 130, 70], valid: true } }, 'inconclusive'],
    ['B has 2 repetitions', { b: { values: [171, 176], valid: true } }, 'inconclusive'],
    ['B invalid', { b: { values: WORKED_B, valid: false } }, 'inconclusive'],
  ] as const)('%s → %s', (_label, overrides, expected) => {
    expect(compareMetric(input(overrides)).verdict).toBe(expected);
  });

  it('reports the worked example as an 18.4% improvement with its interval', () => {
    const result = compareMetric(input());
    expect(result.ratio).toBeCloseTo(0.816, 3);
    expect(result.p).toBeCloseTo(0.0079, 4);
    expect(result.uncalibrated).toBe(false);
  });

  it('labels comparisons without a noise floor as uncalibrated but still decides', () => {
    const result = compareMetric(input({ noiseFloor: undefined }));
    expect(result.uncalibrated).toBe(true);
    expect(result.noiseFloor).toBe(0);
    expect(result.verdict).toBe('improved');
  });

  it('explains why a difference is not significant', () => {
    const result = compareMetric(input({ noiseFloor: 0.25 }));
    expect(result.reasons.join(' ')).toContain('noise floor 0.250');
  });
});
