import { describe, expect, it } from 'vitest';
import type { DockerRunner } from '../src/docker/runner.js';
import { capacityPlan, evaluateHost, hostClass } from '../src/host/classify.js';
import { benchServices, type BenchService } from '../src/host/demand.js';
import { parseCpuList, probeHost, readHostFiles, type HostFacts, type HostFiles } from '../src/host/probe.js';

interface MachineSpec {
  model: string;
  cores: number;
  threadsPerCore: number;
  governor: string | null;
  noTurbo?: '0' | '1';
  memKb: number;
  swapUsedKb: number;
  load: number;
}

/** Builds the /proc and /sys files a machine would expose (siblings numbered like Linux: cpu c and c + cores). */
function machine(spec: MachineSpec): HostFiles {
  const total = spec.cores * spec.threadsPerCore;
  const files: Record<string, string> = {
    '/sys/devices/system/cpu/online': `0-${total - 1}`,
    '/proc/cpuinfo': `processor\t: 0\nmodel name\t: ${spec.model}\n`,
    '/proc/meminfo': `MemTotal:       ${spec.memKb} kB\nSwapTotal:      16777212 kB\nSwapFree:       ${16777212 - spec.swapUsedKb} kB\n`,
    '/proc/loadavg': `${spec.load} 0.4 0.3 1/900 42`,
    '/proc/sys/kernel/osrelease': '6.8.0-138-generic\n',
    '/sys/fs/cgroup/cgroup.controllers': 'cpu memory io',
  };
  for (let cpu = 0; cpu < total; cpu++) {
    const core = cpu % spec.cores;
    const siblings = Array.from({ length: spec.threadsPerCore }, (_, t) => core + t * spec.cores);
    files[`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`] = siblings.join(',');
    if (spec.governor) files[`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`] = `${spec.governor}\n`;
  }
  if (spec.noTurbo) files['/sys/devices/system/cpu/intel_pstate/no_turbo'] = spec.noTurbo;
  return { read: (path) => files[path] ?? null };
}

const versions = { dockerVersion: '29.4.3', composeVersion: '5.1.3', dockerRootDir: '/var/lib/docker', os: 'Ubuntu 22.04', arch: 'x86_64' };
const facts = (spec: MachineSpec, extra: Partial<HostFacts> = {}): HostFacts => ({ ...readHostFiles(machine(spec)), ...versions, ...extra });

const LAPTOP: MachineSpec = { model: '11th Gen Intel(R) Core(TM) i7-1165G7', cores: 4, threadsPerCore: 2, governor: 'powersave', noTurbo: '0', memKb: 16_114_676, swapUsedKb: 1_300_000, load: 0.6 };
const SERVER: MachineSpec = { model: 'AMD EPYC 9354P', cores: 32, threadsPerCore: 2, governor: 'performance', noTurbo: '1', memKb: 263_000_000, swapUsedKb: 0, load: 0.2 };
const VM: MachineSpec = { model: 'Virtual CPU', cores: 6, threadsPerCore: 1, governor: null, memKb: 8_000_000, swapUsedKb: 0, load: 0.1 };

/** A demand shaped like a mid-size SUT: 4 SUT cores, 3 external, 2 observers. */
const DEMAND: BenchService[] = benchServices(
  {
    schemaVersion: 1,
    name: 'demo',
    compose: ['compose.yaml'],
    services: [{ name: 'api', cpus: 2, memory: 2 * 1024 ** 3 }],
    dependencies: [
      { name: 'db', type: 'mongodb', cpus: 1.5, memory: 4 * 1024 ** 3 },
      { name: 'cache', type: 'redis', cpus: 0.5, memory: 1024 ** 3 },
    ],
    simulators: [{ name: 'bank', cpus: 0.5, memory: 256 * 1024 ** 2 }],
    seed: { service: 'seed' },
  },
  {
    loadGenerator: { cpus: 2, memory: 1024 ** 3, preAllocatedVUs: 50, maxVUs: 500 },
    scenarios: [{ name: 'deposit', script: 'd.js', usecases: ['deposit'], callbacks: true }],
  },
);

describe('host probe', () => {
  it('parses kernel CPU lists', () => {
    expect(parseCpuList('0-3,8,10-11\n')).toEqual([0, 1, 2, 3, 8, 10, 11]);
  });

  it('groups SMT siblings into physical cores and reads host state', () => {
    const laptop = readHostFiles(machine(LAPTOP));
    expect(laptop.physicalCores).toEqual([{ cpus: [0, 4] }, { cpus: [1, 5] }, { cpus: [2, 6] }, { cpus: [3, 7] }]);
    expect(laptop.onlineCpus).toHaveLength(8);
    expect(laptop.governors[5]).toBe('powersave');
    expect(laptop.turbo).toBe('on');
    expect(laptop.swapUsedBytes).toBe(1_300_000 * 1024);
    expect(laptop.cgroupVersion).toBe(2);
  });

  it('handles a VM without cpufreq or turbo information', () => {
    const vm = readHostFiles(machine(VM));
    expect(vm.physicalCores).toHaveLength(6);
    expect(Object.values(vm.governors).every((g) => g === null)).toBe(true);
    expect(vm.turbo).toBe('unknown');
  });

  it('reads Docker and Compose versions through the runner', async () => {
    const runner: DockerRunner = {
      run: async (args) => ({
        code: 0,
        stderr: '',
        stdout: args[0] === 'info' ? JSON.stringify({ ServerVersion: '29.4.3', DockerRootDir: '/data/docker', OperatingSystem: 'Ubuntu', Architecture: 'x86_64' }) : 'v5.1.3\n',
      }),
    };
    const result = await probeHost(runner, machine(LAPTOP));
    expect(result.dockerVersion).toBe('29.4.3');
    expect(result.composeVersion).toBe('5.1.3');
    expect(result.dockerRootDir).toBe('/data/docker');
  });
});

describe('host class (BR-11)', () => {
  it('is stable for the same hardware and ignores transient state', () => {
    expect(hostClass(facts(LAPTOP)).id).toBe(hostClass(facts({ ...LAPTOP, load: 3.5, swapUsedKb: 0 })).id);
  });

  it.each([
    ['RAM size', { memKb: 32_000_000 }],
    ['CPU model', { model: 'Other CPU' }],
    ['core count', { cores: 8 }],
  ])('changes with the %s', (_label, change) => {
    expect(hostClass(facts(LAPTOP)).id).not.toBe(hostClass(facts({ ...LAPTOP, ...change })).id);
  });
});

describe('capacity plan and classification (BR-9)', () => {
  it('pins disjoint whole physical cores per group on a sized server', () => {
    const plan = capacityPlan(facts(SERVER), DEMAND);
    expect(plan.needs).toEqual({ sut: 4, external: 3, observers: 2 });
    const cpus = plan.cpus!;
    expect(cpus.reserved).toEqual([0, 32]);
    const all = [cpus.reserved, cpus.groups.sut, cpus.groups.external, cpus.groups.observers].flat();
    expect(new Set(all).size).toBe(all.length);
    expect(cpus.groups.sut.length).toBeGreaterThanOrEqual(4);
    expect(cpus.groups.external.length).toBeGreaterThanOrEqual(3);
    // siblings always travel together
    for (const group of Object.values(cpus.groups)) {
      for (const cpu of group) expect(group).toContain(cpu < 32 ? cpu + 32 : cpu - 32);
    }
  });

  it('classifies the sized server as benchmark-grade', () => {
    const report = evaluateHost(facts(SERVER), DEMAND);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.classification).toBe('benchmark-grade');
  });

  it('classifies the laptop as smoke-only and lists exactly what failed', () => {
    const report = evaluateHost(facts(LAPTOP), DEMAND);
    expect(report.classification).toBe('smoke-only');
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(['governor', 'isolation', 'swap', 'turbo']);
    expect(report.plan!.cpus).toBeNull();
  });

  it.each([
    ['memory', { memKb: 8_000_000 }, {}],
    ['load', { load: 40 }, {}],
    ['compose', {}, { composeVersion: '2.3.3' }],
    ['docker', {}, { dockerVersion: '20.10.7' }],
  ] as const)('fails the %s check alone', (id, change, extra) => {
    const report = evaluateHost(facts({ ...SERVER, ...change }, extra), DEMAND);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([id]);
    expect(report.classification).toBe('smoke-only');
  });

  it('reports turbo without failing the classification', () => {
    const report = evaluateHost(facts({ ...SERVER, noTurbo: '0' }), DEMAND);
    expect(report.checks.find((c) => c.id === 'turbo')).toMatchObject({ ok: false, required: false });
    expect(report.classification).toBe('benchmark-grade');
  });

  it('cannot verify frequency scaling on a VM, so it is smoke-only', () => {
    const report = evaluateHost(facts(VM), []);
    expect(report.checks.find((c) => c.id === 'governor')).toMatchObject({ ok: false, detail: expect.stringContaining('not exposed') });
  });

  it('leaves the classification open without a target', () => {
    expect(evaluateHost(facts(SERVER)).classification).toBeNull();
  });
});
