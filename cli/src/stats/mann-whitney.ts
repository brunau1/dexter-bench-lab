export interface MannWhitneyResult {
  /** U statistic of sample B (the candidate). */
  u: number;
  /** Two-sided p-value. */
  p: number;
  method: 'exact' | 'asymptotic';
}

/** Largest sample size per side for which the exact distribution is used. */
export const EXACT_MAX_N = 20;

function rankWithTies(values: readonly number[]): { ranks: number[]; tieTerm: number } {
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const ranks = new Array<number>(values.length);
  let tieTerm = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  return { ranks, tieTerm };
}

/** Counts of each U value (0..n1·n2) over all arrangements, without ties. */
function exactUCounts(n1: number, n2: number): number[] {
  // counts[i][j][u]: arrangements of i items of sample 1 and j of sample 2 with statistic u.
  let previous: number[][] = Array.from({ length: n2 + 1 }, () => [1]);
  for (let i = 1; i <= n1; i++) {
    const current: number[][] = [[1]];
    for (let j = 1; j <= n2; j++) {
      // The largest item is from sample 1 (adds j to U) or from sample 2 (adds 0).
      const fromFirst = previous[j]!;
      const fromSecond = current[j - 1]!;
      const size = i * j + 1;
      const row = new Array<number>(size).fill(0);
      for (let u = 0; u < fromFirst.length; u++) row[u + j]! += fromFirst[u]!;
      for (let u = 0; u < fromSecond.length; u++) row[u]! += fromSecond[u]!;
      current.push(row);
    }
    previous = current;
  }
  return previous[n2]!;
}

/** Standard normal survival function, via the complementary error function (Numerical Recipes erfcc, |ε| < 1.2e-7). */
function normalSf(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const erfc =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return 0.5 * (x >= 0 ? erfc : 2 - erfc);
}

/**
 * BR-6: two-sided Mann-Whitney U test of B against A. Exact distribution when both samples have at
 * most EXACT_MAX_N values and there are no ties; otherwise the normal approximation with tie and
 * continuity corrections (the same choices as scipy.stats.mannwhitneyu).
 */
export function mannWhitneyU(a: readonly number[], b: readonly number[]): MannWhitneyResult {
  const n1 = b.length;
  const n2 = a.length;
  if (n1 === 0 || n2 === 0) throw new Error('Mann-Whitney U needs two non-empty samples');
  const { ranks, tieTerm } = rankWithTies([...b, ...a]);
  const rankSumB = ranks.slice(0, n1).reduce((sum, r) => sum + r, 0);
  const u = rankSumB - (n1 * (n1 + 1)) / 2;

  if (n1 <= EXACT_MAX_N && n2 <= EXACT_MAX_N && tieTerm === 0) {
    const counts = exactUCounts(n1, n2);
    const total = counts.reduce((sum, c) => sum + c, 0);
    const k = Math.round(u);
    const lower = counts.slice(0, k + 1).reduce((sum, c) => sum + c, 0) / total;
    const upper = counts.slice(k).reduce((sum, c) => sum + c, 0) / total;
    return { u, p: Math.min(1, 2 * Math.min(lower, upper)), method: 'exact' };
  }

  const n = n1 + n2;
  const mean = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return { u, p: 1, method: 'asymptotic' };
  const z = (Math.max(u, n1 * n2 - u) - mean - 0.5) / sigma;
  return { u, p: Math.min(1, 2 * normalSf(z)), method: 'asymptotic' };
}
