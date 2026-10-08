import type { Profile, Target } from '../config/schema.js';

export type Group = 'sut' | 'external' | 'observers';

/** One container of a bench run and the group whose cores it is pinned to (§6.1). */
export interface BenchService {
  name: string;
  group: Group;
  cpus: number;
  memory: number;
  /** True for containers the kit adds (load generator, sink, observers): reported as overhead (BR-15). */
  kit: boolean;
}

const MiB = 1024 ** 2;

/** Fixed resources of the kit's own containers. */
export const KIT_LIMITS = {
  prometheus: { cpus: 0.5, memory: 512 * MiB },
  cadvisor: { cpus: 0.5, memory: 256 * MiB },
  exporter: { cpus: 0.25, memory: 128 * MiB },
  sink: { cpus: 0.5, memory: 256 * MiB },
} as const;

export function exporterName(dependency: string): string {
  return `${dependency}-exporter`;
}

/** Every container of a run with its group and limits: the input of the capacity plan and the compose override. */
export function benchServices(target: Target, profile: Pick<Profile, 'loadGenerator' | 'scenarios'>): BenchService[] {
  const services: BenchService[] = [
    ...target.services.map((s) => ({ name: s.name, group: 'sut' as const, cpus: s.cpus, memory: s.memory, kit: false })),
    ...target.dependencies.map((d) => ({ name: d.name, group: 'sut' as const, cpus: d.cpus, memory: d.memory, kit: false })),
    ...target.simulators.map((s) => ({ name: s.name, group: 'external' as const, cpus: s.cpus, memory: s.memory, kit: false })),
    { name: 'k6', group: 'external', cpus: profile.loadGenerator.cpus, memory: profile.loadGenerator.memory, kit: true },
  ];
  if (profile.scenarios.some((s) => s.callbacks)) services.push({ name: 'sink', group: 'external', ...KIT_LIMITS.sink, kit: true });
  services.push({ name: 'prometheus', group: 'observers', ...KIT_LIMITS.prometheus, kit: true });
  services.push({ name: 'cadvisor', group: 'observers', ...KIT_LIMITS.cadvisor, kit: true });
  for (const dep of target.dependencies) {
    services.push({ name: exporterName(dep.name), group: 'observers', ...KIT_LIMITS.exporter, kit: true });
  }
  return services;
}
