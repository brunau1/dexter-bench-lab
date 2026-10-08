import type { MetricDef } from '../config/schema.js';
import type { MetricSample } from '../metrics/sample.js';

interface K6Metric {
  type: 'trend' | 'counter' | 'rate' | 'gauge';
  values: Record<string, number>;
}

export interface K6Summary {
  metrics: Record<string, K6Metric>;
}

const MEASURE = 'scenario:measure';

/** Submetric key the helper registers for one use case: `metric{scenario:measure,usecase:x}`. */
function submetric(metric: string, usecase?: string): string {
  return usecase === undefined ? `${metric}{${MEASURE}}` : `${metric}{${MEASURE},usecase:${usecase}}`;
}

/**
 * Reads the k6 catalogue entries from a repetition's summary, per use case, measurement scenario
 * only (BR-2). `<metric>:<stat>` selects a summary value; for counters `rate` is recomputed over the
 * measurement window, because k6 divides by the whole test duration (warm-up included).
 */
export function k6Samples(summary: K6Summary, metrics: MetricDef[], usecases: string[], measureSeconds: number): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const metric of metrics.filter((m) => m.source === 'k6')) {
    const [name, stat] = metric.query.split(':') as [string, string];
    // dropped iterations are not tagged with a use case: they belong to the scenario
    const subjects = name === 'dropped_iterations' ? [undefined] : usecases;
    for (const usecase of subjects) {
      const entry = summary.metrics[submetric(name, usecase)];
      if (!entry) continue;
      const value = entry.type === 'counter' && stat === 'rate' ? (entry.values.count ?? 0) / measureSeconds : entry.values[stat];
      if (value === undefined || !Number.isFinite(value)) continue;
      samples.push({ metric: metric.id, subject: usecase ?? 'scenario', key: '', value });
    }
  }
  return samples;
}

/** BR-1: a repetition whose load generator dropped iterations did not apply the arrival rate. */
export function droppedIterations(summary: K6Summary): number {
  return summary.metrics[submetric('dropped_iterations')]?.values.count ?? 0;
}
