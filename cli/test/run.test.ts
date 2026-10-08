import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { CommandResult, DockerRunner } from '../src/docker/runner.js';
import type { CpuPlan } from '../src/host/classify.js';
import type { BenchService } from '../src/host/demand.js';
import type { HostFiles } from '../src/host/probe.js';
import type { MetricSample } from '../src/metrics/sample.js';
import { observerOverride, sutOverride, validateTargetCompose } from '../src/run/compose.js';
import { derivedSamples } from '../src/run/derived.js';
import { executeRun, meetsSlo, parseFingerprint, type RunDeps } from '../src/run/execute.js';
import { readManifest, type Manifest } from '../src/run/manifest.js';
import { buildPlan, capacityRates, measurementWindow, stepDir } from '../src/run/plan.js';
import type { RunSummary } from '../src/run/summary.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('plan (BR-16, BR-2, BR-17)', () => {
  const profile = {
    scenarios: [{ name: 'crud', script: 'c.js', usecases: ['c'], callbacks: false }],
    scales: { small: { crud: 5 } },
    repetitions: 4,
    variants: [
      { name: 'a', env: {} },
      { name: 'b', env: {} },
    ],
  };

  it('alternates variant order in each repetition (ABBA)', () => {
    expect(buildPlan(profile).map((s) => `${s.rep}${s.variant}`)).toEqual(['1a', '1b', '2b', '2a', '3a', '3b', '4b', '4a']);
  });

  it('expands every scenario × scale with its rate', () => {
    const plan = buildPlan({ ...profile, repetitions: 3, variants: [{ name: 'base', env: {} }], scales: { s: { crud: 5 }, m: { crud: 50 } } });
    expect(plan.map((s) => `${s.scale}:${s.rate}:${s.rep}`)).toEqual(['s:5:1', 's:5:2', 's:5:3', 'm:50:1', 'm:50:2', 'm:50:3']);
  });

  it('derives the measurement window from the measure scenario start', () => {
    expect(measurementWindow(1_700_000_030_000, 120_000)).toEqual({ start: 1_700_000_030, end: 1_700_000_150 });
  });

  it('steps capacity geometrically up to the maximum', () => {
    expect(capacityRates({ scenario: 'x', start: 10, factor: 2, max: 100, warmup: 1, stepDuration: 1 })).toEqual([10, 20, 40, 80]);
    expect(capacityRates({ scenario: 'x', start: 10, factor: 1.5, max: 35, warmup: 1, stepDuration: 1 })).toEqual([10, 15, 22.5, 33.75]);
  });

  it('names repetition directories stably', () => {
    expect(stepDir({ scenario: 'crud', scale: 'small', variant: 'base', rep: 3 })).toBe('raw/crud/small/base/rep-03');
  });
});

describe('compose overrides (BR-9, BR-13, BR-15)', () => {
  const services: BenchService[] = [
    { name: 'api', group: 'sut', cpus: 1, memory: 512, kit: false },
    { name: 'db', group: 'sut', cpus: 1, memory: 1024, kit: false },
    { name: 'bank', group: 'external', cpus: 0.5, memory: 256, kit: false },
    { name: 'k6', group: 'external', cpus: 2, memory: 1024, kit: true },
    { name: 'sink', group: 'external', cpus: 0.5, memory: 256, kit: true },
    { name: 'prometheus', group: 'observers', cpus: 0.5, memory: 512, kit: true },
    { name: 'cadvisor', group: 'observers', cpus: 0.5, memory: 256, kit: true },
    { name: 'db-exporter', group: 'observers', cpus: 0.25, memory: 128, kit: true },
  ];
  const cpus: CpuPlan = { reserved: [0, 8], groups: { sut: [1, 9], external: [2, 10, 3, 11], observers: [4, 12] } };

  it('pins every target service and kit container to its group and puts them on the internal run network', () => {
    const sut = parse(
      sutOverride({ services, cpus, network: 'run-net', k6Image: 'k6@sha', sinkImage: 'sink:1', sinkIdPath: 'data.id', kitK6Dir: '/r/kit/k6', scriptsDir: '/t', runDir: '/r', user: '1000:1000' }),
    ) as { services: Record<string, Record<string, unknown>>; networks: Record<string, unknown> };
    expect(sut.networks).toEqual({ default: { name: 'run-net', external: true } });
    expect(sut.services.api).toEqual({ cpus: 1, mem_limit: 512, memswap_limit: 512, cpuset: '1,9' });
    expect(sut.services.bank!.cpuset).toBe('2,10,3,11');
    expect(sut.services.k6).toMatchObject({ image: 'k6@sha', profiles: ['bench-k6'], user: '1000:1000', cpuset: '2,10,3,11' });
    expect(sut.services.sink).toMatchObject({ environment: { SINK_ID_PATH: 'data.id', SINK_PORT: '9000' } });
    expect(Object.values(sut.services).some((s) => 'ports' in s)).toBe(false);
    expect(sut.services).not.toHaveProperty('prometheus');
  });

  it('omits cpusets when the host cannot isolate the groups, keeping the limits', () => {
    const sut = parse(sutOverride({ services, cpus: null, network: 'n', k6Image: 'k', sinkImage: null, kitK6Dir: '/k', scriptsDir: '/s', runDir: '/r', user: '1:1' })) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(sut.services.api).toEqual({ cpus: 1, mem_limit: 512, memswap_limit: 512 });
    expect(sut.services).not.toHaveProperty('sink');
  });

  it('pins observers and adds exporters only for the declared dependencies', () => {
    const obs = parse(
      observerOverride({
        services,
        cpus,
        exporters: [{ name: 'db-exporter', dependency: 'db', image: 'exp', port: 9216, metricsPath: '/metrics', command: ['--x'], environment: {}, scrapeInterval: '2s', scrapeTimeout: '1500ms' }],
      }),
    ) as { services: Record<string, Record<string, unknown>> };
    expect(Object.keys(obs.services).sort()).toEqual(['cadvisor', 'db-exporter', 'prometheus']);
    expect(obs.services['db-exporter']).toMatchObject({ image: 'exp', command: ['--x'], cpuset: '4,12', networks: ['bench'] });
    expect(obs.services.prometheus!.cpuset).toBe('4,12');
  });

  it('rejects target compose files that would break isolation or egress rules', () => {
    const problems = validateTargetCompose({
      services: {
        api: { ports: [{ target: 3000, published: '3000' }] },
        db: { network_mode: 'host' },
        cache: { networks: { default: null, outside: null } },
        worker: { deploy: { resources: { limits: { cpus: '2' } } } },
        bank: { cpus: 1 },
        ok: { networks: { default: null } },
      },
    });
    expect(problems).toEqual([
      'api: publishes ports (BR-13)',
      'db: sets network_mode "host" (BR-13)',
      'cache: joins networks outside; use the default network only (BR-13)',
      'worker: sets deploy.resources; limits come from target.yaml (BR-9)',
      'bank: sets cpus/cpuset/mem_limit; limits come from target.yaml (BR-9)',
    ]);
  });
});

describe('seed fingerprint and capacity SLO', () => {
  it('reads the last fingerprint the seed printed (BR-3)', () => {
    expect(parseFingerprint(`seeding…\nBENCH_DATASET_SHA256=${HASH_A}\nBENCH_DATASET_SHA256=${HASH_B}\n`)).toBe(HASH_B);
    expect(() => parseFingerprint('done')).toThrow('BENCH_DATASET_SHA256');
  });

  const sample = (metric: string, value: number, subject = 'x'): MetricSample => ({ metric, subject, key: '', value });

  it.each([
    [[sample('latency_p99', 250), sample('error_rate', 0)], true],
    [[sample('latency_p99', 250), sample('latency_p99', 320, 'y')], false],
    [[sample('error_rate', 0.01)], false],
    [[sample('e2e_p99', 900)], false],
    [[sample('callback_timeouts', 2)], false],
  ] as const)('evaluates SLOs on the worst use case (%#)', (samples, ok) => {
    expect(meetsSlo([...samples], { latency_p99_ms: 300, error_rate: 0.001, e2e_p99_ms: 800 }).ok).toBe(ok);
  });
});

describe('derived efficiency metrics (§4.5)', () => {
  it('computes cost proxies from SUT CPU, requests and latency', () => {
    const samples = [
      { metric: 'cpu_cores_avg', subject: 'api', key: '', value: 0.5 },
      { metric: 'cpu_cores_avg', subject: 'db', key: '', value: 0.25 },
      { metric: 'cpu_cores_avg', subject: 'k6', key: '', value: 3 }, // load generator: not SUT
    ];
    const summary = {
      metrics: {
        'http_reqs{scenario:measure,usecase:a}': { type: 'counter' as const, values: { count: 600 } },
        'http_req_duration{scenario:measure,usecase:a}': { type: 'trend' as const, values: { avg: 50 } },
      },
    };
    const derived = Object.fromEntries(
      derivedSamples({ samples, sutServices: ['api', 'db'], sutMemoryPeak: 1e9, summary, usecases: ['a'], measureSeconds: 60 }).map((s) => [s.metric, s.value]),
    );
    // 0.75 cores × 60 s = 45 CPU-s for 600 requests → 75 CPU-s per 1 000
    expect(derived.cpu_seconds_per_1k_req).toBeCloseTo(75, 10);
    expect(derived.req_per_core).toBeCloseTo(10 / 0.75, 10);
    expect(derived.inflight_littles_law).toBeCloseTo(10 * 0.05, 10);
    expect(derived.sut_memory_peak).toBe(1e9);
  });
});

// ---------------------------------------------------------------------------------------------
// Executor lifecycle against a fake Docker, Prometheus and sink.

function hostFiles(): HostFiles {
  const files: Record<string, string> = {
    '/sys/devices/system/cpu/online': '0-7',
    '/proc/cpuinfo': 'model name\t: Test CPU\n',
    '/proc/meminfo': 'MemTotal:       16000000 kB\nSwapTotal:      0 kB\nSwapFree:       0 kB\n',
    '/proc/loadavg': '0.1 0.1 0.1 1/1 1',
    '/proc/sys/kernel/osrelease': '6.8.0\n',
    '/sys/fs/cgroup/cgroup.controllers': 'cpu',
  };
  for (let cpu = 0; cpu < 8; cpu++) files[`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`] = `${cpu % 4},${(cpu % 4) + 4}`;
  return { read: (path) => files[path] ?? null };
}

interface FakeOptions {
  missingImage?: string;
  seedHashes?: string[];
  dropped?: number[];
  /** p99 latency reported by k6 per call, for capacity tests. */
  p99?: number[];
}

class FakeDocker implements DockerRunner {
  readonly calls: string[][] = [];
  private seedCall = 0;
  private k6Call = 0;

  constructor(
    private readonly clock: { t: number },
    private readonly options: FakeOptions,
  ) {}

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'info') return ok(JSON.stringify({ ServerVersion: '29.4.3', DockerRootDir: '/var/lib/docker', OperatingSystem: 'Test', Architecture: 'x86_64' }));
    if (args[0] === 'compose' && args[1] === 'version') return ok('5.1.3');
    if (args[0] === 'image' && args[1] === 'inspect') {
      const ref = args[args.length - 1]!;
      return ref === this.options.missingImage ? { code: 1, stdout: '', stderr: 'No such image' } : ok(`["${ref.split(':')[0]}@sha256:${'c'.repeat(64)}"]|sha256:${'d'.repeat(64)}\n`);
    }
    if (args[0] !== 'compose') return ok();
    if (args.includes('config')) {
      return ok(JSON.stringify({ services: { api: { image: 'demo-api:1' }, db: { image: 'mongo:8' }, seed: { image: 'demo-seed:1' } } }));
    }
    const runAt = args.indexOf('run');
    if (runAt >= 0 && args.includes('seed')) {
      const hashes = this.options.seedHashes ?? [HASH_A];
      return ok(`seeded\nBENCH_DATASET_SHA256=${hashes[Math.min(this.seedCall++, hashes.length - 1)]}\n`);
    }
    if (runAt >= 0 && args.includes('k6')) {
      const env = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-e').map((e) => e.split('=') as [string, string]));
      const call = this.k6Call++;
      const measureStart = this.clock.t + Number(env.BENCH_WARMUP_MS);
      this.clock.t = measureStart + Number(env.BENCH_DURATION_MS);
      const tags = `{scenario:measure,usecase:c}`;
      const summary = {
        metrics: {
          bench_measure_start_ms: { type: 'gauge', values: { value: measureStart } },
          'dropped_iterations{scenario:measure}': { type: 'counter', values: { count: this.options.dropped?.[call] ?? 0 } },
          [`http_reqs${tags}`]: { type: 'counter', values: { count: 600 } },
          [`http_req_duration${tags}`]: { type: 'trend', values: { avg: 10, med: 9, 'p(90)': 12, 'p(95)': 14, 'p(99)': this.options.p99?.[call] ?? 20, max: 40 } },
          [`bench_errors${tags}`]: { type: 'rate', values: { rate: 0 } },
        },
      };
      mkdirSync(dirname(env.BENCH_SUMMARY_PATH!), { recursive: true });
      writeFileSync(env.BENCH_SUMMARY_PATH!, JSON.stringify(summary));
      return ok();
    }
    return ok();
  }

  /** Simplified view: the docker subcommand of each compose call, plus the service for `run`. */
  composeVerbs(): string[] {
    return this.calls
      .filter((a) => a[0] === 'compose' && !a.includes('config') && a[1] !== 'version')
      .map((a) => {
        const verb = ['down', 'up', 'run'].find((v) => a.includes(v))!;
        return verb === 'run' ? `run ${a.includes('k6') ? 'k6' : 'seed'}` : verb;
      });
  }
}

function fakeFetch(clock: { t: number }): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown) => ({ status: 200, json: async () => body }) as unknown as Response;
    if (url.pathname === '/api/v1/query') {
      const jobs = ['cadvisor', 'db-exporter'];
      return json({ status: 'success', data: { result: jobs.map((job) => ({ metric: { job }, value: [clock.t / 1000, '1'] })) } });
    }
    if (url.pathname === '/api/v1/query_range') {
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const result = [{ metric: { container_label_com_docker_compose_service: 'api' }, values: [[start, '1'], [end, '3']] }];
      return json({ status: 'success', data: { resultType: 'matrix', result } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

function project(profileExtra: Record<string, unknown> = {}): { target: string; profile: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
  writeFileSync(
    join(dir, 'target.yaml'),
    stringify({
      schemaVersion: 1,
      name: 'demo',
      compose: ['compose.yaml'],
      services: [{ name: 'api', cpus: 1, memory: '256m' }],
      dependencies: [{ name: 'db', type: 'mongodb', cpus: 1, memory: '512m' }],
      seed: { service: 'seed' },
    }),
  );
  writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
  mkdirSync(join(dir, 'scenarios'));
  writeFileSync(join(dir, 'scenarios', 'c.js'), '');
  writeFileSync(
    join(dir, 'profile.yaml'),
    stringify({
      schemaVersion: 1,
      seed: 7,
      repetitions: 3,
      timings: { warmup: '5s', duration: '10s', cooldown: '1s' },
      scenarios: [{ name: 'crud', script: 'scenarios/c.js', usecases: ['c'] }],
      scales: { small: { crud: 5 } },
      ...profileExtra,
    }),
  );
  return { target: join(dir, 'target.yaml'), profile: join(dir, 'profile.yaml'), out: join(dir, 'results') };
}

function harness(options: FakeOptions = {}) {
  const clock = { t: Date.UTC(2026, 9, 8, 12, 0, 0) };
  const runner = new FakeDocker(clock, options);
  const logs: string[] = [];
  const deps: RunDeps = {
    runner,
    fetch: fakeFetch(clock),
    hostFiles: hostFiles(),
    selfContainer: 'cli',
    user: '1000:1000',
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    log: (m) => logs.push(m),
    statsSampler: () => ({ start: () => undefined, stop: async () => new Map() }),
  };
  return { runner, deps, logs };
}

const run = (paths: ReturnType<typeof project>, deps: RunDeps, mode: 'matrix' | 'capacity' = 'matrix') =>
  executeRun({ targetFile: paths.target, profileFile: paths.profile, outDir: paths.out, mode, rawSamples: false, kitVersion: 'test' }, deps);

describe('run lifecycle (fake Docker)', () => {
  it('resets, seeds, loads and collects in order for every repetition, then tears down', async () => {
    const paths = project();
    const { runner, deps } = harness();
    const { runDir, manifest } = await run(paths, deps);

    expect(runner.composeVerbs()).toEqual([
      'up', // observers
      'down', 'up', 'run seed', 'run k6',
      'down', 'up', 'run seed', 'run k6',
      'down', 'up', 'run seed', 'run k6',
      'down', 'down', // teardown: target, observers
    ]);
    const network = runner.calls.find((a) => a[0] === 'network' && a[1] === 'create')!;
    expect(network).toContain('--internal');
    expect(runner.calls.filter((a) => a[0] === 'compose' && (a.includes('up') || a.includes('run'))).every((a) => a.includes('never'))).toBe(true);
    expect(runner.calls.some((a) => a[0] === 'pull')).toBe(false);

    expect(manifest.status).toBe('complete');
    expect(manifest.valid).toBe(true);
    expect(manifest.repetitions).toHaveLength(3);
    expect(manifest.repetitions.every((r) => r.valid && r.datasetSha256 === HASH_A)).toBe(true);
    expect(manifest.host.classification).toBe('smoke-only'); // the fake host has no cpufreq
    expect(manifest.host.baseline).toBe(false);
    expect(Object.keys(manifest.images)).toEqual(expect.arrayContaining(['demo-api:1', 'mongo:8', 'demo-seed:1']));

    const rep = manifest.repetitions[0]!;
    expect(rep.window!.end - rep.window!.start).toBe(10);
    const samples = JSON.parse(readFileSync(join(runDir, rep.dir, 'samples.json'), 'utf8')) as MetricSample[];
    expect(samples.find((s) => s.metric === 'req_rate')!.value).toBe(60);
    expect(samples.find((s) => s.metric === 'cpu_cores_avg' && s.subject === 'api')!.value).toBeCloseTo(0.2, 10);
    expect(samples.some((s) => s.metric === 'cpu_seconds_per_1k_req')).toBe(true);
    expect(existsSync(join(runDir, rep.dir, 'prometheus.json.gz'))).toBe(true);

    const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')) as RunSummary;
    const latency = summary.entries.find((e) => e.metric === 'latency_p99')!;
    expect(latency.values).toEqual([20, 20, 20]);
    expect(latency.stats!.stability).toBe('stable');
  });

  it('fails before starting anything when an image is missing (BR-13)', async () => {
    const paths = project();
    const { runner, deps } = harness({ missingImage: 'mongo:8' });
    await expect(run(paths, deps)).rejects.toThrow(/bench prepare[\s\S]*- mongo:8/);
    expect(runner.calls.some((a) => a.includes('up') || (a[0] === 'network' && a[1] === 'create'))).toBe(false);
  });

  it('invalidates a repetition whose load generator dropped iterations (BR-1)', async () => {
    const paths = project();
    const { deps } = harness({ dropped: [0, 7, 0] });
    const { manifest } = await run(paths, deps);
    expect(manifest.repetitions.map((r) => r.valid)).toEqual([true, false, true]);
    expect(manifest.repetitions[1]!.invalidReasons[0]).toContain('dropped 7 iterations');
    const summary = JSON.parse(readFileSync(join(paths.out, manifest.runId, 'summary.json'), 'utf8')) as RunSummary;
    expect(summary.validRepetitions).toBe(2);
    expect(summary.entries.find((e) => e.metric === 'latency_p99')!.values).toHaveLength(2);
  });

  it('marks the run invalid when the dataset differs between repetitions (BR-3)', async () => {
    const paths = project();
    const { deps } = harness({ seedHashes: [HASH_A, HASH_B] });
    const { manifest } = await run(paths, deps);
    expect(manifest.valid).toBe(false);
    expect(manifest.invalidReasons[0]).toContain('dataset fingerprints differ');
  });

  it('tears everything down and records the failure when a step fails (BR-12)', async () => {
    const paths = project();
    const { runner, deps } = harness({ seedHashes: ['not-a-hash'] });
    await expect(run(paths, deps)).rejects.toThrow('BENCH_DATASET_SHA256');
    expect(runner.composeVerbs().slice(-2)).toEqual(['down', 'down']);
    expect(runner.calls.some((a) => a[0] === 'network' && a[1] === 'rm')).toBe(true);
    const runId = readdirSync(paths.out)[0]!;
    const manifest = readManifest(join(paths.out, runId), { allowIncomplete: true });
    expect(manifest.status).toBe('failed');
    expect(() => readManifest(join(paths.out, runId))).toThrow(/failed.*BR-12/);
  });

  it('writes a manifest with every reproducibility field (BR-12)', async () => {
    const paths = project();
    const { deps } = harness();
    const { runDir } = await run(paths, deps);
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Manifest;
    for (const field of ['runId', 'kitVersion', 'target', 'host', 'cpuPlan', 'collector', 'images', 'seed', 'config', 'repetitions', 'startedAt', 'finishedAt']) {
      expect(manifest).toHaveProperty(field);
    }
    expect(manifest.host.hostClass.id).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.seed).toBe(7);
  });

  it('finds the knee at the last step meeting the SLOs (BR-17)', async () => {
    const paths = project({ slo: { latency_p99_ms: 100 }, capacity: { scenario: 'crud', start: 10, factor: 2, max: 200, warmup: '2s', stepDuration: '5s' } });
    const { deps } = harness({ p99: [20, 40, 80, 150, 300] });
    const { runDir, manifest } = await run(paths, deps, 'capacity');
    const capacity = JSON.parse(readFileSync(join(runDir, 'capacity.json'), 'utf8')) as { knee: number; lowerBound: boolean; steps: { rate: number }[] }[];
    expect(capacity[0]!.steps.map((s) => s.rate)).toEqual([10, 20, 40, 80]);
    expect(capacity[0]!.knee).toBe(40);
    expect(capacity[0]!.lowerBound).toBe(false);
    expect(manifest.mode).toBe('capacity');
  });

  it('stops the capacity search with a lower bound when the load generator saturates (BR-17, BR-1)', async () => {
    const paths = project({ slo: { latency_p99_ms: 100 }, capacity: { scenario: 'crud', start: 10, factor: 2, max: 200, warmup: '2s', stepDuration: '5s' } });
    const { deps } = harness({ dropped: [0, 0, 5] });
    const { runDir } = await run(paths, deps, 'capacity');
    const capacity = JSON.parse(readFileSync(join(runDir, 'capacity.json'), 'utf8')) as { knee: number; lowerBound: boolean }[];
    expect(capacity[0]).toMatchObject({ knee: 20, lowerBound: true });
  });
});
