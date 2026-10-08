import type { MetricDef } from '../config/schema.js';

/** cAdvisor labels that identify a container of the run. */
export const PROJECT_LABEL = 'container_label_com_docker_compose_project';
export const SERVICE_LABEL = 'container_label_com_docker_compose_service';

export interface QueryContext {
  /** Compose projects of the run (target + observers). */
  projects: string[];
  /** Compose services of the SUT group (services + dependencies). */
  sutServices: string[];
  /** Dependencies of the target with their type. */
  dependencies: { name: string; type: string }[];
}

/** One PromQL query to run for a catalogue entry, and the subject its series belong to. */
export interface PlannedQuery {
  metric: MetricDef;
  query: string;
  /** Fixed subject (a dependency name) or undefined when the subject comes from each series' service label. */
  subject?: string;
}

function escapeRegex(values: string[]): string {
  return values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Expands the placeholders of a Prometheus catalogue entry:
 * {{containers}} all containers of the run, {{sut}} the SUT group, {{service}} the grouping labels,
 * {{job}} the scrape job of one dependency (one query per dependency of the entry's type).
 */
export function planQueries(metrics: MetricDef[], ctx: QueryContext): PlannedQuery[] {
  const containers = `${PROJECT_LABEL}=~"${escapeRegex(ctx.projects)}"`;
  const sut = `${containers}, ${SERVICE_LABEL}=~"${escapeRegex(ctx.sutServices)}"`;
  const service = `${PROJECT_LABEL}, ${SERVICE_LABEL}`;
  const fill = (query: string, job?: string) =>
    query
      .replaceAll('{{containers}}', containers)
      .replaceAll('{{sut}}', sut)
      .replaceAll('{{service}}', service)
      .replaceAll('{{job}}', job ?? '');

  const planned: PlannedQuery[] = [];
  for (const metric of metrics.filter((m) => m.source === 'prometheus')) {
    if (metric.scope.startsWith('dependency:')) {
      const type = metric.scope.slice('dependency:'.length);
      for (const dep of ctx.dependencies.filter((d) => d.type === type)) {
        planned.push({ metric, query: fill(metric.query, `job="${dep.name}-exporter"`), subject: dep.name });
      }
    } else {
      planned.push({ metric, query: fill(metric.query), ...(metric.scope === 'sut' ? { subject: 'sut' } : {}) });
    }
  }
  return planned;
}
