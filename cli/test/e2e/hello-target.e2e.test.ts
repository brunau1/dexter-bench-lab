// End-to-end validation of the kit against examples/hello-target, with real Docker.
// Runs inside the e2e image (scripts/e2e.sh) with the target directory as the working directory.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import type { Calibration, Comparison } from '../../src/compare/compare.js';
import { loadVersions, kitPath } from '../../src/config/load.js';
import type { MetricSample } from '../../src/metrics/sample.js';
import type { Manifest } from '../../src/run/manifest.js';

const OUT = resolve('results-e2e');
const CALIBRATION = join(OUT, 'calibration');
const COMPARISONS = join(OUT, 'comparisons');
const TARGET_CONTAINERS = ['api', 'worker', 'mongo', 'redis'];
const KIT_CONTAINERS = ['sink', 'k6', 'prometheus', 'cadvisor', 'mongo-exporter', 'redis-exporter'];

function docker(...args: string[]): { code: number; stdout: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout };
}

function runs(): string[] {
  return existsSync(OUT) ? readdirSync(OUT).filter((d) => existsSync(join(OUT, d, 'manifest.json'))).sort() : [];
}

/** Runs `bench run` and returns the new run directory. */
async function benchRun(profile: string): Promise<{ dir: string; manifest: Manifest; code: number }> {
  const before = new Set(runs());
  const code = await main(['run', '--target', 'target.yaml', '--profile', profile, '--out', OUT]);
  const created = runs().filter((r) => !before.has(r));
  expect(created).toHaveLength(1);
  const dir = join(OUT, created[0]!);
  return { dir, code, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest };
}

function samplesOf(dir: string, rep: Manifest['repetitions'][number]): MetricSample[] {
  return JSON.parse(readFileSync(join(dir, rep.dir, 'samples.json'), 'utf8')) as MetricSample[];
}

/** Runs `bench compare <dir>:<va> <dir>:<vb>` and reads the JSON it writes. */
async function compare(dir: string, va: string, vb: string): Promise<Comparison> {
  expect(await main(['compare', `${dir}:${va}`, `${dir}:${vb}`, '--force-verdicts', '--calibration-dir', CALIBRATION, '--out', COMPARISONS])).toBe(0);
  const runId = basename(dir);
  return JSON.parse(readFileSync(join(COMPARISONS, `${runId}-${va}__${runId}-${vb}.json`), 'utf8')) as Comparison;
}

const verdict = (c: Comparison, metric: string, subject: string) => c.entries.find((e) => e.metric === metric && e.subject === subject)?.result;

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  expect(await main(['prepare', '--target', 'target.yaml', '--profile', 'profile.yaml'])).toBe(0);
});

describe('hello-target end to end', () => {
  let smoke: { dir: string; manifest: Manifest };
  let calibrationRun: Manifest;

  it('runs the full matrix and measures every container, dependency and async flow (BR-2, BR-3, BR-12, BR-15, BR-19)', async () => {
    const result = await benchRun('profile.yaml');
    smoke = result;
    const { manifest, dir } = result;
    expect(result.code).toBe(0);
    expect(manifest.status).toBe('complete');
    expect(manifest.valid).toBe(true);
    expect(manifest.repetitions).toHaveLength(2 * 2 * 3);
    expect(manifest.repetitions.every((r) => r.valid)).toBe(true);
    expect(manifest.host.baseline).toBe(manifest.host.classification === 'benchmark-grade');

    for (const rep of manifest.repetitions) {
      const samples = samplesOf(dir, rep);
      const cpuSubjects = new Set(samples.filter((s) => s.metric === 'cpu_cores_avg').map((s) => s.subject));
      for (const container of [...TARGET_CONTAINERS, 'k6', 'prometheus', 'cadvisor', 'mongo-exporter', 'redis-exporter']) {
        expect(cpuSubjects, `${rep.dir}: ${container}`).toContain(container);
      }
      expect(samples.some((s) => s.metric === 'mongo_ops_rate')).toBe(true);
      expect(samples.some((s) => s.metric === 'redis_cmd_rate')).toBe(true);
      expect(samples.some((s) => s.metric === 'cpu_seconds_per_1k_req')).toBe(true);
      expect(cpuSubjects).not.toContain('seed');
      if (rep.scenario === 'async-jobs') {
        expect(cpuSubjects).toContain('sink');
        expect(samples.find((s) => s.metric === 'e2e_p50')?.value).toBeGreaterThan(0);
        if (rep.scale === 'tiny') expect(samples.find((s) => s.metric === 'callback_timeouts')?.value).toBe(0);
      }
    }
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('Results are relative');
    expect(report).toContain('#### Kit overhead');
    if (!manifest.host.baseline) expect(report).toContain('NON-BASELINE RUN');
    expect(KIT_CONTAINERS.every((c) => report.includes(c))).toBe(true);
    // nothing of the run is left behind
    expect(docker('ps', '-a', '--filter', `label=com.docker.compose.project=${manifest.runId}-sut`, '-q').stdout.trim()).toBe('');
    expect(docker('network', 'ls', '--filter', `name=${manifest.runId}`, '-q').stdout.trim()).toBe('');
  });

  it('regenerates an identical report from raw data (BR-18)', async () => {
    const before = readFileSync(join(smoke.dir, 'report.md'), 'utf8');
    expect(await main(['report', smoke.dir])).toBe(0);
    expect(readFileSync(join(smoke.dir, 'report.md'), 'utf8')).toBe(before);
  });

  it('calibrates the noise floor with an interleaved A/A run (BR-8, BR-16)', async () => {
    const before = new Set(runs());
    expect(await main(['calibrate', '--target', 'target.yaml', '--profile', 'profile.ab.yaml', '--out', OUT, '--calibration-dir', CALIBRATION])).toBe(0);
    const dir = join(OUT, runs().find((r) => !before.has(r))!);
    calibrationRun = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    expect(calibrationRun.repetitions.map((r) => `${r.rep}${r.variant}`).slice(0, 4)).toEqual(['1a1', '1a2', '2a2', '2a1']);
    const calibration = JSON.parse(readFileSync(join(CALIBRATION, `${calibrationRun.host.hostClass.id}.json`), 'utf8')) as Calibration;
    expect(Object.keys(calibration.floors).length).toBeGreaterThan(50);

    const aa = await compare(dir, 'a1', 'a2');
    const decided = aa.entries.filter((e) => ['improved', 'regressed', 'changed-up', 'changed-down'].includes(e.result.verdict));
    expect(decided.map((e) => `${e.metric}/${e.subject}`)).toEqual([]);
  });

  it('starts every repetition from the same dataset, across runs (BR-3)', () => {
    const fingerprints = new Set([...smoke.manifest.repetitions, ...calibrationRun.repetitions].map((r) => r.datasetSha256));
    expect(fingerprints.size).toBe(1);
  });

  it('detects an injected 20 ms delay, and the run has no route out of the host (BR-6, BR-7, BR-13)', async () => {
    // probe the run's network while the run is in progress
    const probe = (async () => {
      for (let i = 0; i < 300; i++) {
        const net = docker('network', 'ls', '--filter', 'name=hello-target-net', '--format', '{{.Name}}').stdout.trim().split('\n')[0];
        if (net) {
          const internal = docker('network', 'inspect', '-f', '{{.Internal}}', net).stdout.trim();
          const node = loadVersions(kitPath('core', 'versions.yaml')).images.node;
          const egress = docker('run', '--rm', '--network', net, '--pull', 'never', node, 'node', '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0),()=>process.exit(1))");
          return { internal, egress: egress.code };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    })();
    const { dir, manifest } = await benchRun('profile.ab.yaml');
    expect(manifest.valid).toBe(true);
    expect(await probe).toEqual({ internal: 'true', egress: 1 });

    const ab = await compare(dir, 'base', 'delayed');
    const p50 = verdict(ab, 'latency_p50', 'read-item')!;
    expect(p50.verdict).toBe('regressed');
    expect(p50.ratio).toBeGreaterThan(2);
    expect(p50.ci![0]).toBeGreaterThan(1);
    expect(verdict(ab, 'latency_p95', 'read-item')!.verdict).not.toBe('improved');
  });

  it('fails before starting anything when an image is missing (BR-13)', async () => {
    const profile = '.e2e-missing-image.profile.yaml';
    writeFileSync(profile, readFileSync('profile.ab.yaml', 'utf8').replace('env: {}', 'env: { APP_IMAGE: "hello-target-app:does-not-exist" }'));
    try {
      const networksBefore = docker('network', 'ls', '-q').stdout;
      await expect(main(['run', '--target', 'target.yaml', '--profile', profile, '--out', OUT])).rejects.toThrow(/bench prepare[\s\S]*does-not-exist/);
      expect(docker('network', 'ls', '-q').stdout).toBe(networksBefore);
    } finally {
      rmSync(profile, { force: true });
    }
  });
});
