import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitPath, loadCatalog } from '../src/config/load.js';
import { k6Env } from '../src/k6/env.js';
import { sinkSamples, type SinkStats } from '../src/k6/sink.js';
import { droppedIterations, k6Samples, type K6Summary } from '../src/k6/summary.js';

const catalog = loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'));
// Real k6 2.3.0 summary: use cases `ping` and `job`, 20 it/s, 3 s warm-up, 5 s measurement.
const summary = JSON.parse(readFileSync(new URL('./fixtures/k6-summary.json', import.meta.url), 'utf8')) as K6Summary;

describe('k6 environment (BR-1, BR-2)', () => {
  it('passes rate, timings and VU bounds to the helper', () => {
    const env = k6Env({
      profile: { timings: { warmup: 30_000, duration: 120_000, cooldown: 15_000 }, loadGenerator: { cpus: 2, memory: 1, preAllocatedVUs: 50, maxVUs: 400 } },
      usecases: ['deposit', 'withdraw'],
      rate: 25,
      summaryPath: '/results/k6.json',
    });
    expect(env).toEqual({
      BENCH_RATE: '25',
      BENCH_USECASES: 'deposit,withdraw',
      BENCH_WARMUP_MS: '30000',
      BENCH_DURATION_MS: '120000',
      BENCH_COOLDOWN_MS: '15000',
      BENCH_PRE_VUS: '50',
      BENCH_MAX_VUS: '400',
      BENCH_SUMMARY_PATH: '/results/k6.json',
    });
  });

  it('lets capacity steps override warm-up and duration', () => {
    const env = k6Env({
      profile: { timings: { warmup: 30_000, duration: 120_000, cooldown: 0 }, loadGenerator: { cpus: 1, memory: 1, preAllocatedVUs: 1, maxVUs: 1 } },
      usecases: ['x'],
      rate: 1,
      summaryPath: '/s',
      warmupMs: 5_000,
      durationMs: 60_000,
    });
    expect(env.BENCH_WARMUP_MS).toBe('5000');
    expect(env.BENCH_DURATION_MS).toBe('60000');
  });
});

describe('k6 summary', () => {
  const samples = k6Samples(summary, catalog, ['ping', 'job'], 5);
  const value = (metric: string, subject: string) => samples.find((s) => s.metric === metric && s.subject === subject)?.value;

  it('reads per-use-case values of the measurement scenario only', () => {
    expect(value('latency_p99', 'ping')).toBe(summary.metrics['http_req_duration{scenario:measure,usecase:ping}']!.values['p(99)']);
    expect(value('latency_p50', 'job')).toBe(summary.metrics['http_req_duration{scenario:measure,usecase:job}']!.values.med);
    expect(value('error_rate', 'job')).toBe(0);
  });

  it('recomputes the request rate over the measurement window, not the whole test', () => {
    // 100 requests in the 5 s measurement window; k6's own rate divides by ~8 s (warm-up included)
    expect(value('req_rate', 'ping')).toBe(20);
  });

  it('attributes dropped iterations to the scenario and reads them for validity (BR-1)', () => {
    expect(value('dropped_iterations', 'scenario')).toBe(0);
    expect(droppedIterations(summary)).toBe(0);
    const saturated: K6Summary = { metrics: { 'dropped_iterations{scenario:measure}': { type: 'counter', values: { count: 12, rate: 1 } } } };
    expect(droppedIterations(saturated)).toBe(12);
  });

  it('skips use cases absent from the summary', () => {
    expect(k6Samples(summary, catalog, ['unknown'], 5).filter((s) => s.subject === 'unknown')).toEqual([]);
  });
});

describe('sink stats mapping (BR-19)', () => {
  it('maps sink stats to catalogue ids, skipping percentiles without data', () => {
    const stats: SinkStats = { completed: 10, measured: 0, p50: null, p95: null, p99: null, timeouts: 3, unmatched: 1 };
    expect(sinkSamples(stats, catalog, 'jobs')).toEqual([
      { metric: 'callback_timeouts', subject: 'jobs', key: '', value: 3 },
      { metric: 'callback_unmatched', subject: 'jobs', key: '', value: 1 },
    ]);
  });
});

describe('callback sink server (BR-19)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.SINK_NO_LISTEN = '1';
    process.env.SINK_ID_PATH = 'data.id';
    ({ server } = (await import(pathToFileURL(kitPath('core', 'sink', 'server.js')).href)) as { server: Server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('matches callbacks by id path, measures only measurement-phase expectations, and counts the rest', async () => {
    expect((await post('/expect', { id: 'w1', measure: false })).status).toBe(204);
    expect((await post('/expect', { id: 'm1', measure: true })).status).toBe(204);
    expect((await post('/expect', { id: 'm2', measure: true })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post('/callback/deposit', { data: { id: 'w1' } }); // warm-up: matched, not measured
    await post('/callback/deposit', { data: { id: 'm1' } }); // measured
    await post('/callback', { data: { id: 'zzz' } }); // nothing expected it
    await post('/callback', { other: true }); // no id at the path

    const stats = (await (await fetch(`${base}/stats`)).json()) as SinkStats;
    expect(stats.completed).toBe(2);
    expect(stats.measured).toBe(1);
    expect(stats.p50).toBeGreaterThanOrEqual(15);
    expect(stats.unmatched).toBe(2);
    expect(stats.timeouts).toBe(1); // m2 never called back
  });

  it('rejects an expectation without id', async () => {
    expect((await post('/expect', { measure: true })).status).toBe(400);
  });
});
