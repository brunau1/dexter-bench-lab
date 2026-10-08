import type { K6Summary } from '../k6/summary.js';
import type { MetricSample } from '../metrics/sample.js';

/**
 * §4.5 efficiency metrics of one repetition, from its other samples:
 * SUT CPU (cores, averaged over the window), SUT memory peak (one Prometheus query), and the k6 summary.
 */
export function derivedSamples(input: {
  samples: MetricSample[];
  sutServices: string[];
  sutMemoryPeak: number | null;
  summary: K6Summary;
  usecases: string[];
  measureSeconds: number;
}): MetricSample[] {
  const { samples, sutServices, summary, usecases, measureSeconds } = input;
  const out: MetricSample[] = [];
  const sutCores = samples.filter((s) => s.metric === 'cpu_cores_avg' && sutServices.includes(s.subject)).reduce((sum, s) => sum + s.value, 0);
  let requests = 0;
  let inflight = 0;
  for (const usecase of usecases) {
    const tags = `{scenario:measure,usecase:${usecase}}`;
    const count = summary.metrics[`http_reqs${tags}`]?.values.count ?? 0;
    const meanMs = summary.metrics[`http_req_duration${tags}`]?.values.avg ?? 0;
    requests += count;
    inflight += (count / measureSeconds) * (meanMs / 1000); // Little's Law: L = λ · W
  }
  const sample = (metric: string, value: number) => out.push({ metric, subject: 'sut', key: '', value });
  if (requests > 0 && sutCores > 0) {
    sample('cpu_seconds_per_1k_req', ((sutCores * measureSeconds) / requests) * 1000);
    sample('req_per_core', requests / measureSeconds / sutCores);
  }
  if (input.sutMemoryPeak !== null) sample('sut_memory_peak', input.sutMemoryPeak);
  if (requests > 0) sample('inflight_littles_law', inflight);
  return out;
}

/** PromQL for the SUT group's summed working set; aggregated with `max` over the window. */
export function sutMemoryQuery(projects: string[], sutServices: string[]): string {
  const re = (values: string[]) => values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return `sum(container_memory_working_set_bytes{container_label_com_docker_compose_project=~"${re(projects)}", container_label_com_docker_compose_service=~"${re(sutServices)}"})`;
}
