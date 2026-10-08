import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapacityResult } from '../run/execute.js';
import type { Manifest } from '../run/manifest.js';
import type { RunSummary, SummaryEntry } from '../run/summary.js';
import { formatPercent, formatValue, HEADLINE_CAVEAT, table } from './format.js';

const STABILITY_MARK = { stable: 'stable', acceptable: 'acceptable', unstable: '**unstable**' } as const;

const RESOURCE_COLUMNS: [string, string][] = [
  ['cpu_cores_avg', 'CPU avg'],
  ['cpu_cores_p95', 'CPU p95'],
  ['cpu_throttled_ratio', 'Throttled'],
  ['mem_working_set_max', 'Mem max'],
  ['mem_limit_ratio_max', 'Mem / limit'],
  ['oom_events', 'OOM'],
  ['net_rx_bps', 'Net rx'],
  ['net_tx_bps', 'Net tx'],
  ['blkio_read_bps', 'Disk read'],
  ['blkio_write_bps', 'Disk write'],
];
const RESOURCE_IDS = new Set(RESOURCE_COLUMNS.map(([id]) => id));
const SCENARIO_IDS = ['req_rate', 'error_rate', 'latency_p50', 'latency_p90', 'latency_p95', 'latency_p99', 'latency_max', 'dropped_iterations'];
const ASYNC_IDS = ['e2e_p50', 'e2e_p95', 'e2e_p99', 'callback_timeouts', 'callback_unmatched'];
const EFFICIENCY_IDS = ['cpu_seconds_per_1k_req', 'sut_memory_peak', 'req_per_core', 'inflight_littles_law'];

function median(entry: SummaryEntry | undefined): string {
  return entry?.stats ? formatValue(entry.stats.median, entry.unit) : '–';
}

function spread(entry: SummaryEntry): string {
  return entry.stats ? `${formatPercent(entry.stats.cv)} ${STABILITY_MARK[entry.stats.stability]}` : '–';
}

function statRows(entries: SummaryEntry[], ids: string[]): string[][] {
  return ids.flatMap((id) =>
    entries
      .filter((e) => e.metric === id)
      .map((e) => [id, e.subject + (e.key ? ` / ${e.key}` : ''), median(e), spread(e), `n=${e.values.length}`]),
  );
}

function resourceTable(entries: SummaryEntry[], subjects: string[]): string {
  const rows = subjects.map((subject) => [
    subject,
    ...RESOURCE_COLUMNS.map(([id]) => median(entries.find((e) => e.metric === id && e.subject === subject))),
  ]);
  return table(['Container', ...RESOURCE_COLUMNS.map(([, label]) => label)], rows);
}

function section(title: string, body: string | null): string[] {
  return body ? [`#### ${title}`, '', body, ''] : [];
}

function groupBody(entries: SummaryEntry[]): string[] {
  const out: string[] = [];
  const scenarioRows = statRows(entries, SCENARIO_IDS);
  out.push(...section('Service level (RED)', scenarioRows.length ? table(['Metric', 'Use case', 'Median', 'CV', 'Valid reps'], scenarioRows) : null));
  const asyncRows = statRows(entries, ASYNC_IDS);
  out.push(...section('Asynchronous end-to-end', asyncRows.length ? table(['Metric', 'Scenario', 'Median', 'CV', 'Valid reps'], asyncRows) : null));

  const resources = entries.filter((e) => RESOURCE_IDS.has(e.metric));
  const target = [...new Set(resources.filter((e) => !e.overhead).map((e) => e.subject))].sort();
  const overhead = [...new Set(resources.filter((e) => e.overhead).map((e) => e.subject))].sort();
  out.push(...section('Resources of the system under test (USE, medians)', target.length ? resourceTable(resources, target) : null));

  const dependencyRows = entries
    .filter((e) => !SCENARIO_IDS.includes(e.metric) && !ASYNC_IDS.includes(e.metric) && !EFFICIENCY_IDS.includes(e.metric) && !RESOURCE_IDS.has(e.metric))
    .map((e) => [e.metric, e.subject + (e.key ? ` / ${e.key}` : ''), median(e), spread(e)]);
  out.push(...section('Dependency internals and domain metrics', dependencyRows.length ? table(['Metric', 'Dependency', 'Median', 'CV'], dependencyRows) : null));

  const efficiencyRows = statRows(entries, EFFICIENCY_IDS).map(([id, , m, cv, n]) => [id!, m!, cv!, n!]);
  out.push(...section('Efficiency and cost proxies', efficiencyRows.length ? table(['Metric', 'Median', 'CV', 'Valid reps'], efficiencyRows) : null));
  out.push(...section('Kit overhead (load generator, sink, observers)', overhead.length ? resourceTable(resources, overhead) : null));
  return out;
}

function capacitySection(runDir: string): string[] {
  const file = join(runDir, 'capacity.json');
  if (!existsSync(file)) return [];
  const results = JSON.parse(readFileSync(file, 'utf8')) as CapacityResult[];
  const out = ['## Capacity (BR-17)', ''];
  for (const result of results) {
    const knee = result.knee === null ? 'below the first step' : `${result.knee} it/s${result.lowerBound ? ' (lower bound: the load generator saturated first)' : ''}`;
    out.push(`**Variant ${result.variant}: knee ${knee}**`, '');
    out.push(table(['Rate (it/s)', 'Meets SLOs', 'Broken', 'Dropped'], result.steps.map((s) => [String(s.rate), s.meetsSlo ? 'yes' : 'no', s.broken.join('; ') || '–', String(s.dropped)])), '');
  }
  return out;
}

/** report.md of a run: deterministic for the same manifest and summary (BR-18). */
export function renderReport(runDir: string, manifest: Manifest, summary: RunSummary): string {
  const host = manifest.host;
  const out: string[] = [
    `# Benchmark run ${manifest.runId}`,
    '',
    HEADLINE_CAVEAT,
    '',
    host.baseline
      ? '**Baseline run** on a benchmark-grade host.'
      : '> ⚠️ **NON-BASELINE RUN.** The host is smoke-only: these numbers check that scenarios and the pipeline work. They are not a baseline, and comparisons draw no verdicts from them (BR-10).',
    '',
    '## Run',
    '',
    table(
      ['Field', 'Value'],
      [
        ['Target', `${manifest.target.name} @ ${manifest.target.commit ?? 'not in git'}`],
        ['Kit version', manifest.kitVersion],
        ['Mode', manifest.mode],
        ['Started / finished', `${manifest.startedAt} / ${manifest.finishedAt ?? '–'}`],
        ['Host class', `${host.hostClass.id} (${host.hostClass.label})`],
        ['Classification', host.classification],
        ['Container collector', manifest.collector === 'cadvisor' ? 'cAdvisor' : 'docker stats (fallback, §8)'],
        ['CPU isolation', manifest.cpuPlan?.cpus ? `whole physical cores per group; limits counted in ${manifest.cpuPlan.unit} CPUs` : 'none (host too small): groups share cores'],
        ['Seed', String(manifest.seed)],
        ['Valid repetitions', `${summary.validRepetitions} of ${manifest.repetitions.length}`],
      ],
    ),
    '',
  ];
  if (host.failedChecks.length > 0) out.push('**Failed host checks:**', '', ...host.failedChecks.map((c) => `- ${c}`), '');
  if (!manifest.valid) out.push('> ❌ **RUN INVALID:** ' + manifest.invalidReasons.join('; '), '');
  if (summary.invalidRepetitions.length > 0) {
    out.push('**Invalid repetitions (excluded from statistics):**', '', ...summary.invalidRepetitions.map((r) => `- \`${r.dir}\`: ${r.reasons.join('; ')}`), '');
  }

  out.push(...capacitySection(runDir));
  const groups = new Map<string, SummaryEntry[]>();
  for (const entry of summary.entries) {
    const key = `${entry.scenario} · ${entry.scale} · ${entry.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  if (groups.size > 0 && manifest.mode === 'matrix') {
    out.push('## Results', '', 'Medians across valid repetitions; CV = run-to-run spread (BR-5).', '');
    for (const [key, entries] of groups) out.push(`### ${key}`, '', ...groupBody(entries));
  }
  return `${out.join('\n').trimEnd()}\n`;
}
