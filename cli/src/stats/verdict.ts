import { bootstrapRatioCI } from './bootstrap.js';
import { describe, stability, type Description, type Stability, type StabilityThresholds } from './describe.js';
import { mannWhitneyU } from './mann-whitney.js';

export type Direction = 'lower' | 'higher' | 'neutral';

export type Verdict = 'improved' | 'regressed' | 'changed-up' | 'changed-down' | 'no-significant-change' | 'inconclusive';

export interface Side {
  /** One value per valid repetition. */
  values: readonly number[];
  /** False when the run or variant is invalid (BR-1, BR-3, BR-12). */
  valid: boolean;
}

export interface ComparisonInput {
  a: Side;
  b: Side;
  direction: Direction;
  thresholds: StabilityThresholds;
  /** Noise floor of this metric for the host class (BR-8); undefined when uncalibrated. */
  noiseFloor?: number;
  alpha?: number;
}

export interface ComparisonResult {
  verdict: Verdict;
  reasons: string[];
  ratio: number | null;
  ci: [number, number] | null;
  p: number | null;
  noiseFloor: number;
  uncalibrated: boolean;
  a: (Description & { stability: Stability }) | null;
  b: (Description & { stability: Stability }) | null;
}

export const MIN_VALID_REPETITIONS = 3;

function summarize(side: Side, thresholds: StabilityThresholds) {
  if (side.values.length === 0) return null;
  const d = describe(side.values);
  return { ...d, stability: stability(d.cv, thresholds) };
}

/** BR-7: verdict for one metric; requires the interval, the test and the noise floor to agree. */
export function compareMetric(input: ComparisonInput): ComparisonResult {
  const alpha = input.alpha ?? 0.05;
  const uncalibrated = input.noiseFloor === undefined;
  const noiseFloor = input.noiseFloor ?? 0;
  const a = summarize(input.a, input.thresholds);
  const b = summarize(input.b, input.thresholds);
  const base = { ratio: null, ci: null, p: null, noiseFloor, uncalibrated, a, b };

  const reasons: string[] = [];
  if (!input.a.valid) reasons.push('A is invalid');
  if (!input.b.valid) reasons.push('B is invalid');
  if (input.a.values.length < MIN_VALID_REPETITIONS) reasons.push(`A has ${input.a.values.length} valid repetitions (< ${MIN_VALID_REPETITIONS})`);
  if (input.b.values.length < MIN_VALID_REPETITIONS) reasons.push(`B has ${input.b.values.length} valid repetitions (< ${MIN_VALID_REPETITIONS})`);
  if (a?.stability === 'unstable') reasons.push(`A is unstable (CV ${(a.cv * 100).toFixed(1)}%)`);
  if (b?.stability === 'unstable') reasons.push(`B is unstable (CV ${(b.cv * 100).toFixed(1)}%)`);
  if (reasons.length > 0) return { ...base, verdict: 'inconclusive', reasons };

  const { ratio, ci } = bootstrapRatioCI(input.a.values, input.b.values);
  const { p } = mannWhitneyU(input.a.values, input.b.values);
  if (ratio === null || ci === null) {
    return { ...base, p, verdict: 'inconclusive', reasons: ['ratio undefined: median of A is 0'] };
  }

  const excludesOne = ci[0] > 1 || ci[1] < 1;
  const significant = p < alpha;
  const aboveNoise = Math.abs(ratio - 1) > noiseFloor;
  const result = { ...base, ratio, ci, p };
  if (!(excludesOne && significant && aboveNoise)) {
    const why: string[] = [];
    if (!excludesOne) why.push('CI contains 1.0');
    if (!significant) why.push(`p = ${p.toPrecision(3)} ≥ ${alpha}`);
    if (!aboveNoise) why.push(`|ratio − 1| = ${Math.abs(ratio - 1).toFixed(3)} ≤ noise floor ${noiseFloor.toFixed(3)}`);
    return { ...result, verdict: 'no-significant-change', reasons: why };
  }

  const up = ratio > 1;
  const verdict: Verdict =
    input.direction === 'neutral'
      ? up
        ? 'changed-up'
        : 'changed-down'
      : (input.direction === 'lower') !== up
        ? 'improved'
        : 'regressed';
  return { ...result, verdict, reasons: [] };
}
