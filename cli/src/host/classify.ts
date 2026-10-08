import { createHash } from 'node:crypto';
import type { BenchService, Group } from './demand.js';
import type { HostFacts } from './probe.js';

const GROUPS: Group[] = ['sut', 'external', 'observers'];

export const MIN_DOCKER = '24.0.0';
export const MIN_COMPOSE = '2.24.0';
export const RAM_HEADROOM = 1.2;
export const MAX_SWAP_USED_BYTES = 64 * 1024 ** 2;
export const MAX_LOAD_PER_CPU = 0.5;

export interface HostClass {
  id: string;
  label: string;
}

/** BR-11: hardware and kernel identity that decides which runs are comparable. */
export function hostClass(facts: HostFacts): HostClass {
  const ramGiB = Math.round(facts.memTotalBytes / 1024 ** 3);
  const kernelMinor = /^(\d+\.\d+)/.exec(facts.kernel)?.[1] ?? facts.kernel;
  const parts = [facts.cpuModel, `${facts.physicalCores.length}c`, `${facts.onlineCpus.length}t`, `${ramGiB}GiB`, `kernel ${kernelMinor}`, `cgroup v${facts.cgroupVersion}`];
  const id = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
  return { id, label: parts.join(', ') };
}

export interface CpuPlan {
  reserved: number[];
  groups: Record<Group, number[]>;
}

export interface CapacityPlan {
  /** Logical CPUs each group needs: ceil(Σ CPU limits). */
  needs: Record<Group, number>;
  memoryNeededBytes: number;
  /** Whole-physical-core allocation, or null when the host is too small to isolate the groups. */
  cpus: CpuPlan | null;
}

/** BR-9: allocates whole physical cores per group, keeping the first core for the OS and the CLI. */
export function capacityPlan(facts: HostFacts, services: BenchService[]): CapacityPlan {
  const needs = Object.fromEntries(
    GROUPS.map((g) => [g, Math.ceil(services.filter((s) => s.group === g).reduce((sum, s) => sum + s.cpus, 0) - 1e-9)]),
  ) as Record<Group, number>;
  const memoryNeededBytes = Math.ceil(services.reduce((sum, s) => sum + s.memory, 0) * RAM_HEADROOM);

  const [reservedCore, ...cores] = facts.physicalCores;
  if (!reservedCore) return { needs, memoryNeededBytes, cpus: null };
  const groups = { sut: [], external: [], observers: [] } as Record<Group, number[]>;
  let next = 0;
  for (const group of GROUPS) {
    while (groups[group].length < needs[group]) {
      const core = cores[next++];
      if (!core) return { needs, memoryNeededBytes, cpus: null };
      groups[group].push(...core.cpus);
    }
  }
  return { needs, memoryNeededBytes, cpus: { reserved: reservedCore.cpus, groups } };
}

export interface Check {
  id: string;
  ok: boolean;
  /** Required checks decide the classification; informational ones are only reported. */
  required: boolean;
  detail: string;
}

export type Classification = 'benchmark-grade' | 'smoke-only';

export interface DoctorReport {
  facts: HostFacts;
  hostClass: HostClass;
  plan: CapacityPlan | null;
  checks: Check[];
  /** null when no target was given, so capacity could not be evaluated. */
  classification: Classification | null;
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

function describePlan(plan: CapacityPlan, facts: HostFacts): string {
  const threads = Math.max(1, ...facts.physicalCores.map((c) => c.cpus.length));
  const needed = GROUPS.reduce((sum, g) => sum + Math.ceil(plan.needs[g] / threads), 1);
  const wanted = GROUPS.map((g) => `${g} ${plan.needs[g]}`).join(', ');
  if (plan.cpus) {
    const got = GROUPS.map((g) => `${g} [${plan.cpus!.groups[g].join(',')}]`).join(', ');
    return `${got}; reserved [${plan.cpus.reserved.join(',')}]`;
  }
  return `needs ~${needed} physical cores (logical CPUs: ${wanted}, +1 reserved core), host has ${facts.physicalCores.length}`;
}

/** BR-9: runs every check; the host is benchmark-grade only when all required checks pass. */
export function evaluateHost(facts: HostFacts, services?: BenchService[]): DoctorReport {
  const checks: Check[] = [];
  const plan = services ? capacityPlan(facts, services) : null;
  if (plan) {
    checks.push({ id: 'isolation', ok: plan.cpus !== null, required: true, detail: describePlan(plan, facts) });
    checks.push({
      id: 'memory',
      ok: facts.memTotalBytes >= plan.memoryNeededBytes,
      required: true,
      detail: `needs ${gib(plan.memoryNeededBytes)} (${RAM_HEADROOM}× limits), host has ${gib(facts.memTotalBytes)}`,
    });
  }
  const governors = Object.values(facts.governors);
  const notPerformance = Object.entries(facts.governors).filter(([, g]) => g !== 'performance');
  checks.push({
    id: 'governor',
    ok: notPerformance.length === 0,
    required: true,
    detail:
      notPerformance.length === 0
        ? 'performance on every CPU'
        : governors.every((g) => g === null)
          ? 'cpufreq not exposed: frequency scaling cannot be verified'
          : `not "performance": ${[...new Set(notPerformance.map(([, g]) => g))].join(', ')} (set with: cpupower frequency-set -g performance)`,
  });
  checks.push({
    id: 'swap',
    ok: facts.swapUsedBytes < MAX_SWAP_USED_BYTES,
    required: true,
    detail: `${(facts.swapUsedBytes / 1024 ** 2).toFixed(0)} MiB of swap in use (limit 64 MiB)`,
  });
  const maxLoad = MAX_LOAD_PER_CPU * facts.onlineCpus.length;
  checks.push({
    id: 'load',
    ok: facts.loadAvg1 < maxLoad,
    required: true,
    detail: `1-minute load ${facts.loadAvg1.toFixed(2)} (limit ${maxLoad.toFixed(2)})`,
  });
  checks.push({
    id: 'docker',
    ok: versionAtLeast(facts.dockerVersion, MIN_DOCKER),
    required: true,
    detail: `Docker ${facts.dockerVersion} (minimum ${MIN_DOCKER})`,
  });
  checks.push({
    id: 'compose',
    ok: versionAtLeast(facts.composeVersion, MIN_COMPOSE),
    required: true,
    detail: `Compose ${facts.composeVersion} (minimum ${MIN_COMPOSE})`,
  });
  checks.push({
    id: 'turbo',
    ok: facts.turbo !== 'on',
    required: false,
    detail: facts.turbo === 'unknown' ? 'turbo state not exposed' : `turbo ${facts.turbo}`,
  });
  const classification = plan ? (checks.every((c) => c.ok || !c.required) ? 'benchmark-grade' : 'smoke-only') : null;
  return { facts, hostClass: hostClass(facts), plan, checks, classification };
}

export function formatDoctorReport(report: DoctorReport): string {
  const { facts } = report;
  const lines = [
    `Host class   ${report.hostClass.id}  (${report.hostClass.label})`,
    `System       ${facts.os}, ${facts.arch}, kernel ${facts.kernel}, Docker ${facts.dockerVersion}, Compose ${facts.composeVersion}`,
    `CPU          ${facts.cpuModel}: ${facts.physicalCores.length} physical cores, ${facts.onlineCpus.length} logical CPUs`,
    `Memory       ${gib(facts.memTotalBytes)}`,
    '',
    'Checks',
    ...report.checks.map((c) => `  ${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.id.padEnd(10)} ${c.detail}`),
    '',
    report.classification === null
      ? 'Classification: not evaluated (pass --target and --profile to plan capacity)'
      : `Classification: ${report.classification}${report.classification === 'smoke-only' ? ' (results will be non-baseline, BR-10)' : ''}`,
  ];
  return lines.join('\n');
}
