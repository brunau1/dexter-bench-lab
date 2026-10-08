import { readFileSync } from 'node:fs';
import { docker, type DockerRunner } from '../docker/runner.js';

/** Physical core: the logical CPUs that share its execution units (SMT siblings). */
export interface PhysicalCore {
  cpus: number[];
}

/** What the kit knows about the host (§6). On macOS/Windows these describe Docker's VM. */
export interface HostFacts {
  cpuModel: string;
  onlineCpus: number[];
  physicalCores: PhysicalCore[];
  /** Governor per logical CPU; null when cpufreq is not exposed (VMs, some cloud instances). */
  governors: Record<number, string | null>;
  turbo: 'on' | 'off' | 'unknown';
  memTotalBytes: number;
  swapUsedBytes: number;
  loadAvg1: number;
  kernel: string;
  cgroupVersion: 1 | 2;
  dockerVersion: string;
  composeVersion: string;
  /** Docker's data root, mounted into cAdvisor. */
  dockerRootDir: string;
  os: string;
  arch: string;
}

/** Read access to the host's /proc and /sys, injectable for tests. */
export interface HostFiles {
  read(path: string): string | null;
}

export const realHostFiles: HostFiles = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/** Parses a kernel CPU list such as `0-3,8,10-11`. */
export function parseCpuList(list: string): number[] {
  const cpus: number[] = [];
  for (const part of list.trim().split(',').filter(Boolean)) {
    const [start, end] = part.split('-').map(Number) as [number, number | undefined];
    for (let cpu = start; cpu <= (end ?? start); cpu++) cpus.push(cpu);
  }
  return cpus;
}

function meminfoBytes(meminfo: string, key: string): number {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(meminfo);
  return match ? Number(match[1]) * 1024 : 0;
}

function readTurbo(files: HostFiles): HostFacts['turbo'] {
  const noTurbo = files.read('/sys/devices/system/cpu/intel_pstate/no_turbo');
  if (noTurbo !== null) return noTurbo.trim() === '1' ? 'off' : 'on';
  const boost = files.read('/sys/devices/system/cpu/cpufreq/boost');
  if (boost !== null) return boost.trim() === '1' ? 'on' : 'off';
  return 'unknown';
}

export function readHostFiles(files: HostFiles): Omit<HostFacts, 'dockerVersion' | 'composeVersion' | 'dockerRootDir' | 'os' | 'arch'> {
  const onlineCpus = parseCpuList(files.read('/sys/devices/system/cpu/online') ?? '0');
  const groups = new Map<string, number[]>();
  const governors: Record<number, string | null> = {};
  for (const cpu of onlineCpus) {
    const base = `/sys/devices/system/cpu/cpu${cpu}`;
    const siblings = files.read(`${base}/topology/thread_siblings_list`)?.trim() ?? String(cpu);
    groups.set(siblings, parseCpuList(siblings).filter((c) => onlineCpus.includes(c)));
    governors[cpu] = files.read(`${base}/cpufreq/scaling_governor`)?.trim() ?? null;
  }
  const physicalCores = [...groups.values()].map((cpus) => ({ cpus })).sort((x, y) => x.cpus[0]! - y.cpus[0]!);
  const cpuinfo = files.read('/proc/cpuinfo') ?? '';
  const model = /^(?:model name|Model|Hardware)\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? 'unknown';
  const meminfo = files.read('/proc/meminfo') ?? '';
  const swapUsedBytes = meminfoBytes(meminfo, 'SwapTotal') - meminfoBytes(meminfo, 'SwapFree');
  return {
    cpuModel: model,
    onlineCpus,
    physicalCores,
    governors,
    turbo: readTurbo(files),
    memTotalBytes: meminfoBytes(meminfo, 'MemTotal'),
    swapUsedBytes,
    loadAvg1: Number((files.read('/proc/loadavg') ?? '0').split(' ')[0]),
    kernel: (files.read('/proc/sys/kernel/osrelease') ?? 'unknown').trim(),
    cgroupVersion: files.read('/sys/fs/cgroup/cgroup.controllers') !== null ? 2 : 1,
  };
}

export async function probeHost(runner: DockerRunner, files: HostFiles = realHostFiles): Promise<HostFacts> {
  const info = JSON.parse(await docker(runner, ['info', '--format', '{{json .}}'])) as {
    ServerVersion: string;
    DockerRootDir: string;
    OperatingSystem: string;
    Architecture: string;
  };
  const composeVersion = (await docker(runner, ['compose', 'version', '--short'])).trim().replace(/^v/, '');
  return {
    ...readHostFiles(files),
    dockerVersion: info.ServerVersion,
    composeVersion,
    dockerRootDir: info.DockerRootDir,
    os: info.OperatingSystem,
    arch: info.Architecture,
  };
}
