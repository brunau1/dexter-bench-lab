import { stringify } from 'yaml';
import type { CpuPlan } from '../host/classify.js';
import type { BenchService } from '../host/demand.js';
import { exporterServices, type ExporterService } from '../metrics/observers.js';

export const SINK_PORT = 9000;

function resources(service: BenchService, cpus: CpuPlan | null): Record<string, unknown> {
  return {
    cpus: service.cpus,
    mem_limit: service.memory,
    // a memory limit without swap: swapping would make memory access times unpredictable (§6.2)
    memswap_limit: service.memory,
    ...(cpus ? { cpuset: cpus.groups[service.group].join(',') } : {}),
  };
}

export interface SutOverrideInput {
  services: BenchService[];
  cpus: CpuPlan | null;
  network: string;
  k6Image: string;
  sinkImage: string | null;
  sinkIdPath?: string;
  /** Host paths (same inside the CLI container). */
  kitK6Dir: string;
  scriptsDir: string;
  runDir: string;
  user: string;
}

/**
 * Override of the target project: limits and cpusets from target.yaml (BR-9), the run's internal
 * network as the only network (BR-13), plus the kit's k6 and sink services.
 */
export function sutOverride(input: SutOverrideInput): string {
  const byName = new Map(input.services.map((s) => [s.name, s]));
  const services: Record<string, unknown> = {};
  for (const service of input.services.filter((s) => !s.kit)) services[service.name] = resources(service, input.cpus);

  services.k6 = {
    image: input.k6Image,
    profiles: ['bench-k6'],
    user: input.user,
    volumes: [`${input.kitK6Dir}:/kit:ro`, `${input.scriptsDir}:/scripts:ro`, `${input.runDir}:${input.runDir}`],
    ...resources(byName.get('k6')!, input.cpus),
  };
  if (input.sinkImage) {
    services.sink = {
      image: input.sinkImage,
      environment: { SINK_ID_PATH: input.sinkIdPath ?? 'id', SINK_PORT: String(SINK_PORT) },
      ...resources(byName.get('sink')!, input.cpus),
    };
  }
  return stringify({ services, networks: { default: { name: input.network, external: true } } });
}

export interface ObserverOverrideInput {
  services: BenchService[];
  cpus: CpuPlan | null;
  exporters: ExporterService[];
}

/** Override of the observer project: exporters, plus limits and cpusets of every observer. */
export function observerOverride(input: ObserverOverrideInput): string {
  const exporters = exporterServices(input.exporters) as Record<string, Record<string, unknown>>;
  const services: Record<string, unknown> = {};
  for (const service of input.services.filter((s) => s.group === 'observers')) {
    services[service.name] = { ...(exporters[service.name] ?? {}), ...resources(service, input.cpus) };
  }
  return stringify({ services });
}

interface ComposeService {
  ports?: unknown[];
  network_mode?: string;
  networks?: Record<string, unknown> | string[];
  deploy?: { resources?: { limits?: unknown; reservations?: unknown } };
  cpus?: unknown;
  cpuset?: unknown;
  mem_limit?: unknown;
}

/**
 * Rules a target compose file must follow so the kit can guarantee isolation and no egress
 * (BR-9, BR-13): no published ports, no host networking, no own networks, no own limits.
 */
export function validateTargetCompose(config: { services: Record<string, ComposeService> }): string[] {
  const problems: string[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    if (service.ports && service.ports.length > 0) problems.push(`${name}: publishes ports (BR-13)`);
    if (service.network_mode) problems.push(`${name}: sets network_mode "${service.network_mode}" (BR-13)`);
    const networks = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});
    const foreign = networks.filter((n) => n !== 'default');
    if (foreign.length > 0) problems.push(`${name}: joins networks ${foreign.join(', ')}; use the default network only (BR-13)`);
    if (service.deploy?.resources?.limits || service.deploy?.resources?.reservations) {
      problems.push(`${name}: sets deploy.resources; limits come from target.yaml (BR-9)`);
    }
    if (service.cpus !== undefined || service.cpuset !== undefined || service.mem_limit !== undefined) {
      problems.push(`${name}: sets cpus/cpuset/mem_limit; limits come from target.yaml (BR-9)`);
    }
  }
  return problems;
}
