import { stringify } from 'yaml';
import type { Target, Versions } from '../config/schema.js';
import { exporterName } from '../host/demand.js';

/** Scrape interval of every observer target: the time resolution of resource metrics (§8). */
export const SCRAPE_INTERVAL = '1s';

export interface ExporterService {
  name: string;
  dependency: string;
  image: string;
  port: number;
  metricsPath: string;
  command: string[];
  environment: Record<string, string>;
  /** Scrape interval and timeout of this exporter's job (Prometheus requires timeout ≤ interval). */
  scrapeInterval: string;
  scrapeTimeout: string;
}

/** BR-15: one exporter per declared dependency, chosen by its type. */
export function exportersFor(target: Target, versions: Versions): ExporterService[] {
  return target.dependencies.map((dep): ExporterService => {
    const name = exporterName(dep.name);
    switch (dep.type) {
      case 'mongodb':
        return {
          name,
          dependency: dep.name,
          image: versions.images.mongodbExporter,
          port: 9216,
          metricsPath: '/metrics',
          // diagnosticdata = serverStatus, the source of every mongodb_ss_* metric of the catalogue.
          // The exporter returns no data at a 1 s scrape timeout, so its job is scraped every 2 s (§8).
          command: [
            `--mongodb.uri=${dep.exporterTarget ?? `mongodb://${dep.name}:27017`}`,
            '--mongodb.direct-connect=true',
            '--mongodb.global-conn-pool',
            '--web.timeout-offset=0',
            '--collector.diagnosticdata',
          ],
          environment: {},
          scrapeInterval: '2s',
          scrapeTimeout: '1500ms',
        };
      case 'redis':
        return {
          name,
          dependency: dep.name,
          image: versions.images.redisExporter,
          port: 9121,
          metricsPath: '/metrics',
          command: [],
          environment: { REDIS_ADDR: dep.exporterTarget ?? `redis://${dep.name}:6379` },
          scrapeInterval: SCRAPE_INTERVAL,
          scrapeTimeout: SCRAPE_INTERVAL,
        };
      case 'custom': {
        const exporter = dep.exporter!;
        return {
          name,
          dependency: dep.name,
          image: exporter.image,
          port: exporter.port,
          metricsPath: exporter.metricsPath,
          command: exporter.command,
          environment: {},
          scrapeInterval: SCRAPE_INTERVAL,
          scrapeTimeout: SCRAPE_INTERVAL,
        };
      }
    }
  });
}

/** Prometheus configuration of a run: cAdvisor plus one job per exporter, named after it. */
export function prometheusConfig(exporters: ExporterService[]): string {
  return stringify({
    global: { scrape_interval: SCRAPE_INTERVAL, scrape_timeout: SCRAPE_INTERVAL, evaluation_interval: SCRAPE_INTERVAL },
    scrape_configs: [
      { job_name: 'cadvisor', static_configs: [{ targets: ['cadvisor:8080'] }] },
      ...exporters.map((e) => ({
        job_name: e.name,
        scrape_interval: e.scrapeInterval,
        scrape_timeout: e.scrapeTimeout,
        metrics_path: e.metricsPath,
        static_configs: [{ targets: [`${e.name}:${e.port}`] }],
      })),
    ],
  });
}

/** Compose services of the exporters, added to the observer project. */
export function exporterServices(exporters: ExporterService[]): Record<string, object> {
  return Object.fromEntries(
    exporters.map((e) => [
      e.name,
      {
        image: e.image,
        ...(e.command.length > 0 ? { command: e.command } : {}),
        ...(Object.keys(e.environment).length > 0 ? { environment: e.environment } : {}),
        networks: ['bench'],
        restart: 'unless-stopped',
      },
    ]),
  );
}
