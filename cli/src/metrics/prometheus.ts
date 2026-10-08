import { aggregate, type Samples } from './aggregate.js';
import { SERVICE_LABEL, type PlannedQuery } from './catalog.js';
import type { MetricSample } from './sample.js';

interface MatrixResult {
  metric: Record<string, string>;
  values: [number, string][];
}

export interface RawSeries {
  query: string;
  metric: string;
  labels: Record<string, string>;
  values: Samples;
}

export interface Window {
  start: number;
  end: number;
}

export class PrometheusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Range query with a 1 s step over the window (unix seconds). */
  async queryRange(query: string, window: Window): Promise<MatrixResult[]> {
    const params = new URLSearchParams({ query, start: String(window.start), end: String(window.end), step: '1' });
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/query_range?${params}`);
    const body = (await response.json()) as { status: string; error?: string; data?: { resultType: string; result: MatrixResult[] } };
    if (body.status !== 'success' || !body.data) throw new Error(`Prometheus query failed (${body.error ?? response.status}): ${query}`);
    return body.data.result;
  }

  /** Waits until Prometheus answers and has scraped every expected job at least once. */
  async waitReady(jobs: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let missing = jobs;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/v1/query?${new URLSearchParams({ query: 'up == 1' })}`);
        const body = (await response.json()) as { data?: { result: { metric: { job?: string } }[] } };
        const up = new Set((body.data?.result ?? []).map((r) => r.metric.job));
        missing = jobs.filter((job) => !up.has(job));
        if (missing.length === 0) return;
      } catch {
        // not reachable yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Prometheus targets not up after ${timeoutMs / 1000}s: ${missing.join(', ')}`);
  }
}

/** Runs every planned query over the window and aggregates each series (BR-2, BR-14). */
export async function collectPrometheus(
  client: PrometheusClient,
  planned: PlannedQuery[],
  window: Window,
): Promise<{ samples: MetricSample[]; raw: RawSeries[] }> {
  const samples: MetricSample[] = [];
  const raw: RawSeries[] = [];
  for (const { metric, query, subject } of planned) {
    const result = await client.queryRange(query, window);
    for (const series of result) {
      const values: Samples = series.values.map(([t, v]) => [t, Number(v)]);
      raw.push({ query, metric: metric.id, labels: series.metric, values });
      const value = aggregate(values, metric.aggregation, window);
      if (value === null) continue;
      samples.push({
        metric: metric.id,
        subject: subject ?? series.metric[SERVICE_LABEL] ?? 'unknown',
        key: metric.by ? (series.metric[metric.by] ?? '') : '',
        value,
      });
    }
  }
  return { samples, raw };
}
