import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError, kitPath, loadCatalog, loadProfile, loadTarget, loadVersions } from '../src/config/load.js';
import { parseDurationMs, parseMemoryBytes } from '../src/config/units.js';

function workdir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-config-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : stringify(content));
  }
  return dir;
}

const validProfile = {
  schemaVersion: 1,
  seed: 7,
  timings: { warmup: '10s', duration: '1m', cooldown: '5s' },
  scenarios: [{ name: 'crud', script: 'crud.js', usecases: ['create'] }],
  scales: { small: { crud: 5 } },
};

const validTarget = {
  schemaVersion: 1,
  name: 'demo',
  compose: ['compose.yaml'],
  services: [{ name: 'api', cpus: 1, memory: '512m' }],
  dependencies: [{ name: 'db', type: 'mongodb', cpus: 1, memory: '1g' }],
  seed: { service: 'seed' },
};

const metric = (overrides: Record<string, unknown> = {}) => ({
  id: 'cpu_x',
  source: 'prometheus',
  query: 'up',
  unit: 'cores',
  aggregation: 'avg',
  direction: 'lower',
  scope: 'container',
  rationale: 'Explains why this metric matters.',
  ref: '#metrics-container',
  ...overrides,
});

function expectConfigError(fn: () => unknown, ...fragments: string[]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    for (const fragment of fragments) expect((error as Error).message).toContain(fragment);
    return;
  }
  throw new Error('expected a ConfigError');
}

describe('units', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['1.5m', 90_000],
    ['1h', 3_600_000],
  ])('parses duration %s', (input, ms) => expect(parseDurationMs(input)).toBe(ms));

  it.each([
    ['256m', 256 * 1024 ** 2],
    ['1g', 1024 ** 3],
    ['1.5GiB', 1.5 * 1024 ** 3],
    ['2048', 2048],
  ])('parses memory %s', (input, bytes) => expect(parseMemoryBytes(input)).toBe(bytes));

  it.each(['10', '1d', 'fast'])('rejects duration %s', (input) => expect(() => parseDurationMs(input)).toThrow());
});

describe('profile validation', () => {
  it('converts timings and applies the statistical defaults', () => {
    const dir = workdir({ 'profile.yaml': validProfile, 'crud.js': '' });
    const profile = loadProfile(join(dir, 'profile.yaml'));
    expect(profile.timings).toEqual({ warmup: 10_000, duration: 60_000, cooldown: 5_000 });
    expect(profile.repetitions).toBe(5);
    expect(profile.stability).toEqual({ stable: 0.05, acceptable: 0.1 });
    expect(profile.variants).toEqual([{ name: 'base', env: {} }]);
    expect(profile.scripts.crud).toBe(join(dir, 'crud.js'));
  });

  it('rejects fewer than 3 repetitions (BR-4)', () => {
    const dir = workdir({ 'profile.yaml': { ...validProfile, repetitions: 2 }, 'crud.js': '' });
    expectConfigError(() => loadProfile(join(dir, 'profile.yaml')), 'repetitions', 'at least 3');
  });

  it('rejects a scale that misses a scenario rate', () => {
    const profile = { ...validProfile, scenarios: [...validProfile.scenarios, { name: 'list', script: 'crud.js', usecases: ['list'] }] };
    const dir = workdir({ 'profile.yaml': profile, 'crud.js': '' });
    expectConfigError(() => loadProfile(join(dir, 'profile.yaml')), 'scales.small', 'missing rate for scenario "list"');
  });

  it('rejects a missing scenario script', () => {
    const dir = workdir({ 'profile.yaml': validProfile });
    expectConfigError(() => loadProfile(join(dir, 'profile.yaml')), 'script of scenario "crud" not found');
  });

  it('rejects stability thresholds in the wrong order', () => {
    const dir = workdir({ 'profile.yaml': { ...validProfile, stability: { stable: 0.2, acceptable: 0.1 } }, 'crud.js': '' });
    expectConfigError(() => loadProfile(join(dir, 'profile.yaml')), 'stable must be below acceptable');
  });
});

describe('target validation', () => {
  it('parses limits and resolves compose files', () => {
    const dir = workdir({ 'target.yaml': validTarget, 'compose.yaml': 'services: {}' });
    const target = loadTarget(join(dir, 'target.yaml'));
    expect(target.services[0]?.memory).toBe(512 * 1024 ** 2);
    expect(target.composeFiles).toEqual([join(dir, 'compose.yaml')]);
  });

  it('rejects an unknown dependency type', () => {
    const dir = workdir({
      'target.yaml': { ...validTarget, dependencies: [{ name: 'q', type: 'kafka', cpus: 1, memory: '1g' }] },
      'compose.yaml': '',
    });
    expectConfigError(() => loadTarget(join(dir, 'target.yaml')), 'dependencies.0.type');
  });

  it('requires an exporter for a custom dependency', () => {
    const dir = workdir({
      'target.yaml': { ...validTarget, dependencies: [{ name: 'q', type: 'custom', cpus: 1, memory: '1g' }] },
      'compose.yaml': '',
    });
    expectConfigError(() => loadTarget(join(dir, 'target.yaml')), 'dependencies.0.exporter');
  });

  it('rejects a service name declared twice across groups', () => {
    const dir = workdir({
      'target.yaml': { ...validTarget, simulators: [{ name: 'db', cpus: 0.5, memory: '128m' }] },
      'compose.yaml': '',
    });
    expectConfigError(() => loadTarget(join(dir, 'target.yaml')), 'service "db" is declared more than once');
  });
});

describe('catalogue validation (BR-14)', () => {
  it('rejects a metric without a rationale', () => {
    const dir = workdir({ 'c.yaml': { schemaVersion: 1, metrics: [metric({ rationale: '' })] } });
    expectConfigError(() => loadCatalog(join(dir, 'c.yaml')), 'metrics.0.rationale', 'rationale');
  });

  it.each([
    ['missing', 'rate(x[5s])', undefined],
    ['shorter than the selector', 'rate(x[30s])', '5s'],
    ['shorter than a subquery range', 'max_over_time(rate(x[5s])[1m:10s])', '30s'],
  ])('rejects a `range` that is %s (BR-2)', (_label, query, range) => {
    const dir = workdir({ 'c.yaml': { schemaVersion: 1, metrics: [metric({ query, ...(range ? { range } : {}) })] } });
    expectConfigError(() => loadCatalog(join(dir, 'c.yaml')), 'metrics.0.range', 'declare range');
  });

  it('rejects a derived metric the code does not implement', () => {
    const dir = workdir({ 'c.yaml': { schemaVersion: 1, metrics: [metric({ id: 'magic', source: 'derived' })] } });
    expectConfigError(() => loadCatalog(join(dir, 'c.yaml')), 'derived metrics must be one of');
  });

  it('rejects an extension that redefines a kit metric', () => {
    const dir = workdir({ 'ext.yaml': { schemaVersion: 1, metrics: [metric({ id: 'cpu_cores_avg' })] } });
    expectConfigError(
      () => loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'), join(dir, 'ext.yaml')),
      'metric "cpu_cores_avg" is defined more than once',
    );
  });
});

describe('shipped kit files', () => {
  it('kit catalogue is valid and every metric points to the methodology', () => {
    const metrics = loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'));
    expect(metrics.length).toBeGreaterThan(30);
    expect(metrics.every((m) => m.ref.startsWith('#'))).toBe(true);
  });

  it('every image is pinned by digest', () => {
    const versions = loadVersions(kitPath('core', 'versions.yaml'));
    expect(Object.values(versions.images).every((image) => image.includes('@sha256:'))).toBe(true);
  });

  it('templates validate against the schemas', () => {
    const dir = kitPath('templates', 'target');
    expect(loadTarget(join(dir, 'target.yaml')).name).toBe('my-system');
    expect(loadProfile(join(dir, 'profile.yaml')).scenarios).toHaveLength(1);
    expect(loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'), join(dir, 'catalog.ext.yaml')).length).toBeGreaterThan(30);
  });
});
