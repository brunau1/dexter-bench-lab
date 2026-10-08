import { quantile } from '../stats/describe.js';
import type { MetricDef } from '../config/schema.js';

/** [unix seconds, value] samples of one series. */
export type Samples = [number, number][];

/**
 * Reduces the samples of one series inside the measurement window to one value per repetition
 * (BR-2, §4). Non-finite samples (e.g. a ratio with a zero denominator) are ignored.
 * Returns null when the window has no usable samples.
 */
export function aggregate(samples: Samples, aggregation: MetricDef['aggregation'], window: { start: number; end: number }): number | null {
  const inside = samples.filter(([t, v]) => t >= window.start && t <= window.end && Number.isFinite(v));
  if (inside.length === 0) return null;
  const values = inside.map(([, v]) => v);
  switch (aggregation) {
    case 'avg':
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    case 'max':
      return Math.max(...values);
    case 'p95':
      return quantile([...values].sort((x, y) => x - y), 0.95);
    case 'value':
      return values[values.length - 1]!;
    case 'delta':
      return values[values.length - 1]! - values[0]!;
    case 'rate': {
      if (inside.length < 2) return null;
      const [t0, v0] = inside[0]!;
      const [t1, v1] = inside[inside.length - 1]!;
      return t1 > t0 ? (v1 - v0) / (t1 - t0) : null;
    }
  }
}
