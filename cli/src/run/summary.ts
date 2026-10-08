import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricDef } from '../config/schema.js';
import type { MetricSample } from '../metrics/sample.js';
import { describe, stability, type Description, type Stability, type StabilityThresholds } from '../stats/describe.js';
import type { Manifest, RepetitionRecord } from './manifest.js';

/** One metric of one scenario × scale × variant, across its valid repetitions (§2.5). */
export interface SummaryEntry {
  scenario: string;
  scale: string;
  variant: string;
  metric: string;
  subject: string;
  key: string;
  unit: string;
  direction: MetricDef['direction'];
  /** Kit containers (load generator, sink, observers): reported as overhead (BR-15). */
  overhead: boolean;
  /** One value per valid repetition, in repetition order. */
  values: number[];
  stats: (Description & { stability: Stability }) | null;
}

export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  baseline: boolean;
  validRepetitions: number;
  invalidRepetitions: { dir: string; reasons: string[] }[];
  entries: SummaryEntry[];
}

export const SUMMARY_FILE = 'summary.json';
const KIT_SERVICES = new Set(['k6', 'sink', 'prometheus', 'cadvisor']);

export function isOverhead(subject: string): boolean {
  return KIT_SERVICES.has(subject) || subject.endsWith('-exporter');
}

function readSamples(runDir: string, rep: RepetitionRecord): MetricSample[] {
  const file = join(runDir, rep.dir, 'samples.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MetricSample[]) : [];
}

/** BR-18: the summary is a pure function of raw/ and the manifest. */
export function buildSummary(runDir: string, manifest: Manifest, catalog: MetricDef[]): RunSummary {
  const thresholds = (manifest.config.profile as { stability: StabilityThresholds }).stability;
  const defs = new Map(catalog.map((m) => [m.id, m]));
  const groups = new Map<string, SummaryEntry>();
  const valid = manifest.repetitions.filter((r) => r.valid);
  for (const rep of valid) {
    for (const sample of readSamples(runDir, rep)) {
      const def = defs.get(sample.metric);
      if (!def) continue;
      const id = [rep.scenario, rep.scale, rep.variant, sample.metric, sample.subject, sample.key].join('\u0000');
      let entry = groups.get(id);
      if (!entry) {
        entry = {
          scenario: rep.scenario,
          scale: rep.scale,
          variant: rep.variant,
          metric: sample.metric,
          subject: sample.subject,
          key: sample.key,
          unit: def.unit,
          direction: def.direction,
          overhead: isOverhead(sample.subject),
          values: [],
          stats: null,
        };
        groups.set(id, entry);
      }
      entry.values.push(sample.value);
    }
  }
  const entries = [...groups.values()]
    .map((entry) => {
      const d = describe(entry.values);
      return { ...entry, stats: { ...d, stability: stability(d.cv, thresholds) } };
    })
    .sort(
      (a, b) =>
        a.scenario.localeCompare(b.scenario) ||
        a.scale.localeCompare(b.scale) ||
        a.variant.localeCompare(b.variant) ||
        a.metric.localeCompare(b.metric) ||
        a.subject.localeCompare(b.subject) ||
        a.key.localeCompare(b.key),
    );
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    baseline: manifest.host.baseline,
    validRepetitions: valid.length,
    invalidRepetitions: manifest.repetitions.filter((r) => !r.valid).map((r) => ({ dir: r.dir, reasons: r.invalidReasons })),
    entries,
  };
}

export function writeSummary(runDir: string, manifest: Manifest, catalog: MetricDef[]): RunSummary {
  const summary = buildSummary(runDir, manifest, catalog);
  writeFileSync(join(runDir, SUMMARY_FILE), `${JSON.stringify(summary, null, 1)}\n`);
  return summary;
}
