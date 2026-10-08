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

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export class PrometheusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: Clock = realClock,
  ) {}

  /** Range query with a 1 s step over the window (unix seconds). */
  async queryRange(query: string, window: Window): Promise<MatrixResult[]> {
    const params = new URLSearchParams({ query, start: String(window.start), end: String(window.end), step: '1' });
    const url = `${this.baseUrl}/api/v1/query_range`;
    const response = await this.fetchImpl(`${url}?${params}`);
    let body: { status: string; error?: string; data?: { resultType: string; result: MatrixResult[] } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new Error(`Prometheus ${url} answered HTTP ${response.status} with a non-JSON body: ${query}`);
    }
    if (body.status !== 'success' || !body.data) throw new Error(`Prometheus query failed (${body.error ?? response.status}): ${query}`);
    return body.data.result;
  }

  /** Waits until Prometheus answers and has scraped every expected job at least once. */
  async waitReady(jobs: string[], timeoutMs: number): Promise<void> {
    const deadline = this.clock.now() + timeoutMs;
    let missing = jobs;
    while (this.clock.now() < deadline) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/v1/query?${new URLSearchParams({ query: 'up == 1' })}`);
        const body = (await response.json()) as { data?: { result: { metric: { job?: string } }[] } };
        const up = new Set((body.data?.result ?? []).map((r) => r.metric.job));
        missing = jobs.filter((job) => !up.has(job));
        if (missing.length === 0) return;
      } catch {
        // not reachable yet
      }
      await this.clock.sleep(1000);
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
    // BR-2: a range selector looks back `range`; points before window.start + range would mix in warm-up data
    const effective = metric.range ? { start: window.start + metric.range / 1000, end: window.end } : window;
    if (effective.start >= effective.end) throw new Error(`measurement window shorter than the range of ${metric.id}`);
    const result = await client.queryRange(query, effective);
    for (const series of result) {
      const values: Samples = series.values.map(([t, v]) => [t, Number(v)]);
      raw.push({ query, metric: metric.id, labels: series.metric, values });
      const value = aggregate(values, metric.aggregation, effective);
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
