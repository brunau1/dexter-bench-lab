import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricDef } from '../config/schema.js';
import { formatValue, HEADLINE_CAVEAT, table } from '../report/format.js';
import type { Manifest } from '../run/manifest.js';
import type { RunSummary, SummaryEntry } from '../run/summary.js';
import { compareMetric, type ComparisonResult, type Verdict } from '../stats/verdict.js';

export interface Side {
  runDir: string;
  manifest: Manifest;
  summary: RunSummary;
  variant: string;
}

export interface Calibration {
  schemaVersion: 1;
  hostClass: string;
  runId: string;
  kitVersion: string;
  /** Noise floor per entry key (BR-8). */
  floors: Record<string, number>;
}

export interface CompareOptions {
  allowCrossHost: boolean;
  /** Test-only: draw verdicts on smoke-only runs, labelled in the output. */
  forceVerdicts: boolean;
  calibration: Calibration | null;
}

export interface ComparedEntry {
  scenario: string;
  scale: string;
  metric: string;
  subject: string;
  key: string;
  unit: string;
  overhead: boolean;
  result: ComparisonResult;
}

export interface Comparison {
  schemaVersion: 1;
  a: { runId: string; variant: string };
  b: { runId: string; variant: string };
  hostClass: string;
  interleaved: boolean;
  /** Why verdicts are withheld for the whole comparison (BR-10, BR-11); empty when verdicts are drawn. */
  verdictsWithheld: string[];
  forcedVerdicts: boolean;
  calibration: string | null;
  entries: ComparedEntry[];
}

export class CompareRefusedError extends Error {
  override readonly name = 'CompareRefusedError';
}

/** Key of one comparable measurement, shared by summaries and calibrations. */
export function entryKey(e: Pick<SummaryEntry, 'scenario' | 'scale' | 'metric' | 'subject' | 'key'>): string {
  return [e.scenario, e.scale, e.metric, e.subject, e.key].join('|');
}

export function loadCalibration(dir: string, hostClass: string): Calibration | null {
  const file = join(dir, `${hostClass}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Calibration) : null;
}

/** BR-6..BR-11, BR-16: compares variant `a.variant` of run A with `b.variant` of run B. */
export function compareRuns(a: Side, b: Side, catalog: MetricDef[], options: CompareOptions): Comparison {
  const sameHost = a.manifest.host.hostClass.id === b.manifest.host.hostClass.id;
  if (!sameHost && !options.allowCrossHost) {
    throw new CompareRefusedError(
      `runs come from different host classes (${a.manifest.host.hostClass.id} vs ${b.manifest.host.hostClass.id}); results are not comparable (BR-11). Use --allow-cross-host to see the numbers without verdicts.`,
    );
  }
  const withheld: string[] = [];
  if (!sameHost) withheld.push('different host classes: numbers are not comparable (BR-11)');
  const smoke = [a, b].filter((s) => !s.manifest.host.baseline).map((s) => s.manifest.runId);
  if (smoke.length > 0 && !options.forceVerdicts) withheld.push(`non-baseline run(s) on a smoke-only host: ${[...new Set(smoke)].join(', ')} (BR-10)`);

  const interleaved = a.runDir === b.runDir;
  const thresholds = (b.manifest.config.profile as { stability: { stable: number; acceptable: number } }).stability;
  const directions = new Map(catalog.map((m) => [m.id, m.direction]));
  const bEntries = new Map(b.summary.entries.filter((e) => e.variant === b.variant).map((e) => [entryKey(e), e]));
  const calibration = options.calibration && options.calibration.hostClass === b.manifest.host.hostClass.id ? options.calibration : null;

  const entries: ComparedEntry[] = [];
  for (const ea of a.summary.entries.filter((e) => e.variant === a.variant)) {
    const key = entryKey(ea);
    const eb = bEntries.get(key);
    if (!eb) continue;
    const result = compareMetric({
      a: { values: ea.values, valid: a.manifest.valid },
      b: { values: eb.values, valid: b.manifest.valid },
      direction: directions.get(ea.metric) ?? ea.direction,
      thresholds,
      ...(calibration && key in calibration.floors ? { noiseFloor: calibration.floors[key]! } : {}),
    });
    if (withheld.length > 0) {
      result.reasons = [...withheld, ...result.reasons];
      if (result.verdict !== 'inconclusive') result.verdict = 'no-significant-change';
    }
    entries.push({ scenario: ea.scenario, scale: ea.scale, metric: ea.metric, subject: ea.subject, key: ea.key, unit: ea.unit, overhead: ea.overhead, result });
  }
  return {
    schemaVersion: 1,
    a: { runId: a.manifest.runId, variant: a.variant },
    b: { runId: b.manifest.runId, variant: b.variant },
    hostClass: b.manifest.host.hostClass.id,
    interleaved,
    verdictsWithheld: withheld,
    forcedVerdicts: options.forceVerdicts && smoke.length > 0,
    calibration: calibration?.runId ?? null,
    entries,
  };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  improved: '✅ improved',
  regressed: '❌ regressed',
  'changed-up': '↑ changed',
  'changed-down': '↓ changed',
  'no-significant-change': 'no significant change',
  inconclusive: '❔ inconclusive',
};

function ratioText(result: ComparisonResult): string {
  if (result.ratio === null || result.ci === null) return '–';
  const pct = (r: number) => `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}%`;
  return `${pct(result.ratio)} [${pct(result.ci[0])}, ${pct(result.ci[1])}]`;
}

export function renderComparison(c: Comparison): string {
  const out = [
    `# Comparison: ${c.a.runId}:${c.a.variant} → ${c.b.runId}:${c.b.variant}`,
    '',
    HEADLINE_CAVEAT,
    '',
    `- Host class: ${c.hostClass}`,
    `- Order: ${c.interleaved ? 'interleaved within one run (BR-16)' : '**not interleaved** (separate runs): host drift between runs is not cancelled (BR-16)'}`,
    `- Noise floor: ${c.calibration ? `calibration ${c.calibration}` : '**uncalibrated** (run `bench calibrate` on this host class, BR-8)'}`,
    '',
  ];
  if (c.verdictsWithheld.length > 0) out.push(`> ⚠️ **No verdicts:** ${c.verdictsWithheld.join('; ')}.`, '');
  if (c.forcedVerdicts) out.push('> 🟥 **VERDICTS FORCED ON NON-BASELINE RUNS (--force-verdicts).** For testing the kit only; never a basis for decisions.', '');

  const counts = new Map<Verdict, number>();
  for (const e of c.entries.filter((x) => !x.overhead)) counts.set(e.result.verdict, (counts.get(e.result.verdict) ?? 0) + 1);
  out.push('**Summary (system under test):** ' + [...counts.entries()].map(([v, n]) => `${VERDICT_LABEL[v]}: ${n}`).join(' · '), '');

  const groups = new Map<string, ComparedEntry[]>();
  for (const e of c.entries) groups.set(`${e.scenario} · ${e.scale}`, [...(groups.get(`${e.scenario} · ${e.scale}`) ?? []), e]);
  for (const [group, entries] of groups) {
    out.push(`## ${group}`, '');
    const rows = entries.map((e) => [
      e.metric,
      `${e.subject}${e.key ? ` / ${e.key}` : ''}${e.overhead ? ' (kit)' : ''}`,
      formatValue(e.result.a?.median, e.unit),
      formatValue(e.result.b?.median, e.unit),
      ratioText(e.result),
      e.result.p === null ? '–' : e.result.p.toPrecision(2),
      `${VERDICT_LABEL[e.result.verdict]}${e.result.uncalibrated && e.result.verdict !== 'inconclusive' ? ' (uncalibrated)' : ''}`,
    ]);
    out.push(table(['Metric', 'Subject', 'A median', 'B median', 'B vs A [95% CI]', 'p', 'Verdict'], rows), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** BR-8: noise floor of each entry from an A/A comparison: the larger distance of the CI bounds from 1. */
export function noiseFloors(aa: Comparison): Record<string, number> {
  const floors: Record<string, number> = {};
  for (const e of aa.entries) {
    if (!e.result.ci) continue;
    floors[entryKey(e)] = Math.max(Math.abs(e.result.ci[0] - 1), Math.abs(e.result.ci[1] - 1));
  }
  return floors;
}
