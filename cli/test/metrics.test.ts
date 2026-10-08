import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadCatalog, kitPath } from '../src/config/load.js';
import type { Target, Versions } from '../src/config/schema.js';
import { aggregate } from '../src/metrics/aggregate.js';
import { planQueries } from '../src/metrics/catalog.js';
import { aggregateStats, parseSize, parseStatsLine, type StatsPoint } from '../src/metrics/docker-stats.js';
import { exportersFor, exporterServices, prometheusConfig } from '../src/metrics/observers.js';
import { collectPrometheus, PrometheusClient } from '../src/metrics/prometheus.js';

const WINDOW = { start: 100, end: 110 };
const catalog = loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'));

const versions: Versions = {
  schemaVersion: 1,
  images: { node: 'n', k6: 'k', prometheus: 'p', cadvisor: 'c', mongodbExporter: 'mongo-exp:1@sha256:x', redisExporter: 'redis-exp:1@sha256:y' },
};

const target: Target = {
  schemaVersion: 1,
  name: 'demo',
  compose: ['compose.yaml'],
  services: [{ name: 'api', cpus: 1, memory: 1 }],
  dependencies: [
    { name: 'db', type: 'mongodb', cpus: 1, memory: 1 },
    { name: 'cache', type: 'redis', cpus: 1, memory: 1, exporterTarget: 'redis://cache:6380' },
    { name: 'queue', type: 'custom', cpus: 1, memory: 1, exporter: { image: 'q-exp:2', port: 9400, metricsPath: '/m', command: ['--x'] } },
  ],
  simulators: [],
  seed: { service: 'seed' },
};

describe('aggregation over the measurement window (BR-2)', () => {
  // warm-up samples (t < 100) and cool-down samples (t > 110) must not count
  const samples: [number, number][] = [
    [95, 1000],
    [100, 10],
    [102, 20],
    [104, 30],
    [106, 40],
    [108, 50],
    [110, 60],
    [115, 9000],
  ];

  it.each([
    ['avg', 35],
    ['max', 60],
    ['value', 60],
    ['delta', 50],
    ['rate', 5],
  ] as const)('%s ignores samples outside the window', (aggregation, expected) => {
    expect(aggregate(samples, aggregation, WINDOW)).toBeCloseTo(expected, 10);
  });

  it('p95 interpolates like numpy', () => {
    expect(aggregate(samples, 'p95', WINDOW)).toBeCloseTo(57.5, 10);
  });

  it('skips non-finite samples and returns null for an empty window', () => {
    expect(aggregate([[101, Number.NaN], [102, 4]], 'avg', WINDOW)).toBe(4);
    expect(aggregate([[50, 1]], 'avg', WINDOW)).toBeNull();
    expect(aggregate([[101, 1]], 'rate', WINDOW)).toBeNull();
  });
});

describe('exporters per dependency type (BR-15)', () => {
  const exporters = exportersFor(target, versions);

  it('maps each dependency type to its exporter', () => {
    expect(exporters.map((e) => [e.name, e.image, e.port])).toEqual([
      ['db-exporter', 'mongo-exp:1@sha256:x', 9216],
      ['cache-exporter', 'redis-exp:1@sha256:y', 9121],
      ['queue-exporter', 'q-exp:2', 9400],
    ]);
    expect(exporters[0]!.command).toContain('--mongodb.uri=mongodb://db:27017');
    expect(exporters[0]!.command).toContain('--collector.diagnosticdata');
    expect(exporters[1]!.environment).toEqual({ REDIS_ADDR: 'redis://cache:6380' });
  });

  it('scrapes MongoDB every 2 s with a timeout the exporter can meet, everything else every 1 s', () => {
    const config = parse(prometheusConfig(exporters)) as { scrape_configs: { job_name: string; scrape_interval?: string; scrape_timeout?: string; metrics_path?: string }[] };
    const jobs = Object.fromEntries(config.scrape_configs.map((j) => [j.job_name, j]));
    expect(Object.keys(jobs)).toEqual(['cadvisor', 'db-exporter', 'cache-exporter', 'queue-exporter']);
    expect(jobs['db-exporter']).toMatchObject({ scrape_interval: '2s', scrape_timeout: '1500ms' });
    expect(jobs['cache-exporter']).toMatchObject({ scrape_interval: '1s', scrape_timeout: '1s' });
    expect(jobs['queue-exporter']!.metrics_path).toBe('/m');
  });

  it('puts every exporter on the bench network without ports', () => {
    const services = exporterServices(exporters) as Record<string, Record<string, unknown>>;
    for (const service of Object.values(services)) {
      expect(service.networks).toEqual(['bench']);
      expect(service).not.toHaveProperty('ports');
    }
  });
});

describe('query planning (BR-14)', () => {
  const planned = planQueries(catalog, {
    projects: ['run1-sut', 'run1-obs'],
    sutServices: ['api', 'db', 'cache'],
    dependencies: target.dependencies.map((d) => ({ name: d.name, type: d.type })),
  });

  it('selects every container of both projects for container metrics', () => {
    const cpu = planned.find((p) => p.metric.id === 'cpu_cores_avg')!;
    expect(cpu.query).toBe(
      'sum by (container_label_com_docker_compose_project, container_label_com_docker_compose_service) (container_cpu_usage_seconds_total{ container_label_com_docker_compose_project=~"run1-sut|run1-obs" })',
    );
    expect(cpu.subject).toBeUndefined();
  });

  it('plans one query per dependency of the matching type, scoped to its exporter job', () => {
    const mongo = planned.filter((p) => p.metric.id === 'mongo_connections');
    expect(mongo).toHaveLength(1);
    expect(mongo[0]!.subject).toBe('db');
    expect(mongo[0]!.query).toContain('job="db-exporter"');
    expect(planned.filter((p) => p.metric.id === 'redis_used_memory').map((p) => p.subject)).toEqual(['cache']);
  });

  it('leaves no placeholder unexpanded and skips non-Prometheus sources', () => {
    expect(planned.every((p) => !p.query.includes('{{'))).toBe(true);
    expect(planned.some((p) => p.metric.source !== 'prometheus')).toBe(false);
  });
});

describe('Prometheus collection', () => {
  it('aggregates each series in the window and names its subject and key', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      const matrix = [
        {
          metric: { container_label_com_docker_compose_service: 'api' },
          values: [[95, '0'], [100, '10'], [110, '30'], [115, '99']],
        },
        {
          metric: { container_label_com_docker_compose_service: 'k6' },
          values: [[100, '0'], [110, '5']],
        },
      ];
      return { status: 200, json: async () => ({ status: 'success', data: { resultType: 'matrix', result: matrix } }) };
    }) as unknown as typeof fetch;
    const client = new PrometheusClient('http://prometheus:9090', fakeFetch);
    const metric = catalog.find((m) => m.id === 'cpu_cores_avg')!;
    const { samples, raw } = await collectPrometheus(client, [{ metric, query: 'q' }], WINDOW);
    expect(samples).toEqual([
      { metric: 'cpu_cores_avg', subject: 'api', key: '', value: 2 },
      { metric: 'cpu_cores_avg', subject: 'k6', key: '', value: 0.5 },
    ]);
    expect(raw).toHaveLength(2);
    expect(new URL(calls[0]!).searchParams.get('step')).toBe('1');
  });

  it('starts range queries after their look-back so no point reads warm-up data (BR-2)', async () => {
    const starts: number[] = [];
    const fakeFetch = (async (url: string) => {
      starts.push(Number(new URL(url).searchParams.get('start')));
      const matrix = [{ metric: { container_label_com_docker_compose_service: 'api' }, values: [[102, '99'], [105, '1'], [110, '3']] }];
      return { status: 200, json: async () => ({ status: 'success', data: { resultType: 'matrix', result: matrix } }) };
    }) as unknown as typeof fetch;
    const p95 = catalog.find((m) => m.id === 'cpu_cores_p95')!;
    expect(p95.range).toBe(5000);
    const { samples } = await collectPrometheus(new PrometheusClient('http://p', fakeFetch), [{ metric: p95, query: 'q' }], WINDOW);
    expect(starts).toEqual([105]);
    // the point at t=102 (look-back into the warm-up) is not aggregated
    expect(samples[0]!.value).toBeCloseTo(2.9, 10);
  });

  it('reports a non-JSON Prometheus answer with its URL', async () => {
    const fakeFetch = (async () => ({ status: 502, json: async () => JSON.parse('<html>') })) as unknown as typeof fetch;
    await expect(new PrometheusClient('http://p', fakeFetch).queryRange('up', WINDOW)).rejects.toThrow('http://p/api/v1/query_range answered HTTP 502');
  });

  it('fails loudly on a Prometheus error', async () => {
    const fakeFetch = (async () => ({ status: 400, json: async () => ({ status: 'error', error: 'parse error' }) })) as unknown as typeof fetch;
    await expect(new PrometheusClient('http://p', fakeFetch).queryRange('bad{', WINDOW)).rejects.toThrow('parse error');
  });
});

describe('docker stats fallback (§8)', () => {
  it.each([
    ['0B', 0],
    ['1.5kB', 1500],
    ['2MiB', 2 * 1024 ** 2],
    ['1.25GiB', 1.25 * 1024 ** 3],
  ])('parses size %s', (input, bytes) => expect(parseSize(input)).toBe(bytes));

  it('parses a streamed line with ANSI codes and skips containers without data', () => {
    const line = '\u001b[2J\u001b[H{"ID":"abc","CPUPerc":"150.00%","MemUsage":"256MiB / 1GiB","MemPerc":"25.00%","NetIO":"1kB / 2kB","BlockIO":"0B / 4MB"}';
    expect(parseStatsLine(line, 101)).toEqual({
      id: 'abc',
      point: { t: 101, cpuCores: 1.5, memBytes: 256 * 1024 ** 2, memLimitRatio: 0.25, netRx: 1000, netTx: 2000, blkRead: 0, blkWrite: 4e6 },
    });
    expect(parseStatsLine('{"ID":"x","CPUPerc":"--","MemUsage":"--","MemPerc":"--","NetIO":"--","BlockIO":"--"}', 1)).toBeNull();
  });

  it('maps streamed points to catalogue ids per compose service', () => {
    const point = (t: number, cpu: number, rx: number): StatsPoint => ({ t, cpuCores: cpu, memBytes: 100, memLimitRatio: 0.1, netRx: rx, netTx: 0, blkRead: 0, blkWrite: 0 });
    const samples = aggregateStats(new Map([['abc', [point(100, 1, 0), point(110, 3, 1000)]], ['zzz', [point(100, 1, 0)]]]), new Map([['abc', 'api']]), WINDOW);
    const byMetric = Object.fromEntries(samples.map((s) => [s.metric, s]));
    expect(byMetric.cpu_cores_avg).toEqual({ metric: 'cpu_cores_avg', subject: 'api', key: '', value: 2 });
    expect(byMetric.net_rx_bps!.value).toBe(100);
    expect(samples.every((s) => s.subject === 'api')).toBe(true);
  });
});
