import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSide } from '../src/commands/compare.js';
import { rebuildReport } from '../src/commands/report.js';
import { compareRuns, CompareRefusedError, entryKey, noiseFloors, renderComparison, type Calibration } from '../src/compare/compare.js';
import { kitPath, loadCatalog } from '../src/config/load.js';
import type { Manifest, RepetitionRecord } from '../src/run/manifest.js';
import { buildSummary } from '../src/run/summary.js';

const catalog = loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'));

interface FakeRunSpec {
  runId: string;
  hostClass?: string;
  baseline?: boolean;
  valid?: boolean;
  /** variant → metric → one value per repetition (subject `api`, or `k6` for overhead). */
  variants: Record<string, Record<string, number[]>>;
}

/** Writes a complete run directory the way `bench run` does: manifest, catalogue, raw samples. */
function fakeRun(root: string, spec: FakeRunSpec): string {
  const runDir = join(root, spec.runId);
  mkdirSync(join(runDir, 'kit'), { recursive: true });
  writeFileSync(join(runDir, 'kit', 'catalog.json'), JSON.stringify(catalog));
  const repetitions: RepetitionRecord[] = [];
  for (const [variant, metrics] of Object.entries(spec.variants)) {
    const reps = Math.max(...Object.values(metrics).map((v) => v.length));
    for (let rep = 1; rep <= reps; rep++) {
      const dir = `raw/crud/small/${variant}/rep-0${rep}`;
      mkdirSync(join(runDir, dir), { recursive: true });
      const samples = Object.entries(metrics).flatMap(([metric, values]) =>
        values[rep - 1] === undefined ? [] : [{ metric, subject: metric.startsWith('cpu') ? 'api' : 'c', key: '', value: values[rep - 1]! }],
      );
      samples.push({ metric: 'cpu_cores_avg', subject: 'k6', key: '', value: 1 + rep * 0.001 });
      writeFileSync(join(runDir, dir, 'samples.json'), JSON.stringify(samples));
      repetitions.push({ scenario: 'crud', scale: 'small', variant, rep, rate: 10, dir, startedAt: '2026-10-08T00:00:00.000Z', window: { start: 0, end: 60 }, datasetSha256: 'a'.repeat(64), valid: true, invalidReasons: [] });
    }
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    runId: spec.runId,
    mode: 'matrix',
    status: 'complete',
    startedAt: '2026-10-08T00:00:00.000Z',
    finishedAt: '2026-10-08T01:00:00.000Z',
    error: null,
    kitVersion: 'test',
    target: { name: 'demo', dir: '/t', commit: 'abc' },
    host: {
      hostClass: { id: spec.hostClass ?? 'aaaaaaaaaaaa', label: 'Test CPU' },
      classification: spec.baseline === false ? 'smoke-only' : 'benchmark-grade',
      baseline: spec.baseline !== false,
      failedChecks: spec.baseline === false ? ['governor: powersave'] : [],
      facts: {} as Manifest['host']['facts'],
    },
    cpuPlan: null,
    collector: 'cadvisor',
    images: {},
    seed: 1,
    config: { target: {}, profile: { stability: { stable: 0.05, acceptable: 0.1 } } },
    repetitions,
    valid: spec.valid !== false,
    invalidReasons: spec.valid === false ? ['dataset fingerprints differ'] : [],
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest));
  rebuildReport(runDir);
  return runDir;
}

const FAST = { latency_p99: [171, 176, 168, 180, 173], cpu_cores_avg: [0.8, 0.81, 0.79, 0.8, 0.82] };
const SLOW = { latency_p99: [212, 205, 219, 208, 214], cpu_cores_avg: [0.8, 0.79, 0.81, 0.8, 0.8] };
const OPTIONS = { allowCrossHost: false, forceVerdicts: false, calibration: null };

function verdictOf(comparison: ReturnType<typeof compareRuns>, metric: string, subject = metric.startsWith('cpu') ? 'api' : 'c') {
  return comparison.entries.find((e) => e.metric === metric && e.subject === subject)!.result;
}

describe('compare (BR-6, BR-7, BR-16)', () => {
  it('compares two variants of one interleaved run', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const dir = fakeRun(root, { runId: 'r1', variants: { base: SLOW, cand: FAST } });
    const comparison = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, OPTIONS);
    expect(comparison.interleaved).toBe(true);
    expect(comparison.verdictsWithheld).toEqual([]);
    expect(verdictOf(comparison, 'latency_p99').verdict).toBe('improved');
    expect(verdictOf(comparison, 'cpu_cores_avg').verdict).toBe('no-significant-change');
    expect(verdictOf(comparison, 'latency_p99').uncalibrated).toBe(true);
    const md = renderComparison(comparison);
    expect(md).toContain('interleaved within one run');
    expect(md).toContain('uncalibrated');
    expect(md).toContain('k6 (kit)');
  });

  it('labels separate runs as not interleaved', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const a = fakeRun(root, { runId: 'r1', variants: { base: SLOW } });
    const b = fakeRun(root, { runId: 'r2', variants: { base: FAST } });
    const comparison = compareRuns(loadSide(a), loadSide(b), catalog, OPTIONS);
    expect(comparison.interleaved).toBe(false);
    expect(renderComparison(comparison)).toContain('**not interleaved**');
  });

  it('requires a variant when a run has several', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const dir = fakeRun(root, { runId: 'r1', variants: { base: SLOW, cand: FAST } });
    expect(() => loadSide(dir)).toThrow('this run has: base, cand');
  });
});

describe('comparison guards (BR-10, BR-11)', () => {
  it('refuses runs from different host classes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const a = fakeRun(root, { runId: 'r1', hostClass: '111111111111', variants: { base: SLOW } });
    const b = fakeRun(root, { runId: 'r2', hostClass: '222222222222', variants: { base: FAST } });
    expect(() => compareRuns(loadSide(a), loadSide(b), catalog, OPTIONS)).toThrow(CompareRefusedError);
  });

  it('shows cross-host numbers without verdicts when explicitly allowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const a = fakeRun(root, { runId: 'r1', hostClass: '111111111111', variants: { base: SLOW } });
    const b = fakeRun(root, { runId: 'r2', hostClass: '222222222222', variants: { base: FAST } });
    const comparison = compareRuns(loadSide(a), loadSide(b), catalog, { ...OPTIONS, allowCrossHost: true });
    expect(comparison.verdictsWithheld[0]).toContain('BR-11');
    expect(verdictOf(comparison, 'latency_p99').verdict).toBe('no-significant-change');
    expect(verdictOf(comparison, 'latency_p99').ratio).toBeCloseTo(173 / 212, 10);
  });

  it('withholds verdicts on smoke-only runs, unless forced with a visible label', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const dir = fakeRun(root, { runId: 'r1', baseline: false, variants: { base: SLOW, cand: FAST } });
    const withheld = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, OPTIONS);
    expect(withheld.verdictsWithheld[0]).toContain('BR-10');
    expect(verdictOf(withheld, 'latency_p99').verdict).toBe('no-significant-change');

    const forced = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, { ...OPTIONS, forceVerdicts: true });
    expect(forced.forcedVerdicts).toBe(true);
    expect(verdictOf(forced, 'latency_p99').verdict).toBe('improved');
    expect(renderComparison(forced)).toContain('VERDICTS FORCED ON NON-BASELINE RUNS');
  });

  it('treats an invalid run as inconclusive', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const dir = fakeRun(root, { runId: 'r1', valid: false, variants: { base: SLOW, cand: FAST } });
    const comparison = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, OPTIONS);
    expect(verdictOf(comparison, 'latency_p99').verdict).toBe('inconclusive');
  });
});

describe('calibration (BR-8)', () => {
  it('derives noise floors from an A/A comparison and uses them for the same host class', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-cmp-'));
    const aa = fakeRun(root, { runId: 'cal', variants: { a1: SLOW, a2: { ...SLOW, latency_p99: [210, 207, 216, 211, 213] } } });
    const floors = noiseFloors(compareRuns(loadSide(`${aa}:a1`), loadSide(`${aa}:a2`), catalog, { ...OPTIONS, forceVerdicts: true }));
    const key = entryKey({ scenario: 'crud', scale: 'small', metric: 'latency_p99', subject: 'c', key: '' });
    expect(floors[key]).toBeGreaterThan(0);
    expect(floors[key]).toBeLessThan(0.05);

    const calibration: Calibration = { schemaVersion: 1, hostClass: 'aaaaaaaaaaaa', runId: 'cal', kitVersion: 'test', floors: { [key]: 0.25 } };
    const dir = fakeRun(root, { runId: 'r1', variants: { base: SLOW, cand: FAST } });
    const comparison = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, { ...OPTIONS, calibration });
    const p99 = verdictOf(comparison, 'latency_p99');
    expect(p99.uncalibrated).toBe(false);
    expect(p99.noiseFloor).toBe(0.25);
    expect(p99.verdict).toBe('no-significant-change'); // an 18% effect inside a 25% noise floor

    const otherHost = compareRuns(loadSide(`${dir}:base`), loadSide(`${dir}:cand`), catalog, { ...OPTIONS, calibration: { ...calibration, hostClass: 'bbbbbbbbbbbb' } });
    expect(verdictOf(otherHost, 'latency_p99').uncalibrated).toBe(true);
  });
});

describe('report (BR-18, BR-10, BR-15)', () => {
  it('regenerates byte-identical summary and report from raw data', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-rep-'));
    const dir = fakeRun(root, { runId: 'r1', baseline: false, variants: { base: SLOW } });
    const before = [readFileSync(join(dir, 'summary.json'), 'utf8'), readFileSync(join(dir, 'report.md'), 'utf8')];
    rebuildReport(dir);
    expect([readFileSync(join(dir, 'summary.json'), 'utf8'), readFileSync(join(dir, 'report.md'), 'utf8')]).toEqual(before);
  });

  it('labels non-baseline runs and separates kit overhead', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-rep-'));
    const dir = fakeRun(root, { runId: 'r1', baseline: false, variants: { base: SLOW } });
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('NON-BASELINE RUN');
    expect(report).toContain('Results are relative');
    expect(report).toContain('#### Kit overhead');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    const summary = buildSummary(dir, manifest, catalog);
    expect(summary.entries.find((e) => e.subject === 'k6')!.overhead).toBe(true);
    expect(summary.entries.find((e) => e.subject === 'api')!.overhead).toBe(false);
  });
});
