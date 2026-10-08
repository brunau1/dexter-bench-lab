import type { MetricDef } from '../config/schema.js';
import type { MetricSample } from '../metrics/sample.js';

export interface SinkStats {
  completed: number;
  measured: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  timeouts: number;
  unmatched: number;
}

/** BR-19: sink catalogue entries of one repetition, attributed to the scenario. */
export function sinkSamples(stats: SinkStats, metrics: MetricDef[], scenario: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const metric of metrics.filter((m) => m.source === 'sink')) {
    const value = stats[metric.query as keyof SinkStats];
    if (typeof value !== 'number') continue;
    samples.push({ metric: metric.id, subject: scenario, key: '', value });
  }
  return samples;
}
