export interface Description {
  n: number;
  median: number;
  mean: number;
  /** Sample standard deviation (n − 1). */
  stdev: number;
  /** stdev / |mean|; 0 when every value is equal, Infinity when the mean is 0 but values vary. */
  cv: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty sample');
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function describe(values: readonly number[]): Description {
  const n = values.length;
  if (n === 0) throw new Error('cannot describe an empty sample');
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = n > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const cv = stdev === 0 ? 0 : mean === 0 ? Number.POSITIVE_INFINITY : stdev / Math.abs(mean);
  return { n, median: median(values), mean, stdev, cv };
}

export type Stability = 'stable' | 'acceptable' | 'unstable';

export interface StabilityThresholds {
  stable: number;
  acceptable: number;
}

/** BR-5: classifies the run-to-run spread of one metric. */
export function stability(cv: number, thresholds: StabilityThresholds): Stability {
  if (cv <= thresholds.stable) return 'stable';
  if (cv <= thresholds.acceptable) return 'acceptable';
  return 'unstable';
}

/** Linear-interpolation quantile (the default of numpy.percentile), q in [0, 1]. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error('quantile of an empty sample');
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  const high = sorted[upper]!;
  if (lower === upper || low === high) return low;
  return low + (high - low) * (position - lower);
}
