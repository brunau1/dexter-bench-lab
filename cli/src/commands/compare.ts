import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareRuns, loadCalibration, renderComparison, type Side } from '../compare/compare.js';
import { readManifest } from '../run/manifest.js';
import { SUMMARY_FILE, type RunSummary } from '../run/summary.js';
import { readRunCatalog } from './report.js';

/** `results/<run>[:variant]`; the variant may be omitted when the run has only one. */
export function loadSide(spec: string): Side {
  const separator = spec.lastIndexOf(':');
  const [path, variant] = separator > 0 && !spec.slice(separator + 1).includes('/') ? [spec.slice(0, separator), spec.slice(separator + 1)] : [spec, undefined];
  const runDir = resolve(path);
  const manifest = readManifest(runDir);
  const summary = JSON.parse(readFileSync(join(runDir, SUMMARY_FILE), 'utf8')) as RunSummary;
  const variants = [...new Set(manifest.repetitions.map((r) => r.variant))];
  const chosen = variant ?? (variants.length === 1 ? variants[0] : undefined);
  if (!chosen || !variants.includes(chosen)) {
    throw new Error(`${spec}: choose a variant with <run>:<variant>; this run has: ${variants.join(', ')}`);
  }
  return { runDir, manifest, summary, variant: chosen };
}

export interface CompareCommandOptions {
  out?: string;
  'allow-cross-host'?: boolean;
  'force-verdicts'?: boolean;
  'calibration-dir'?: string;
}

export async function compareCommand(positionals: string[], options: CompareCommandOptions): Promise<number> {
  const [, specA, specB] = positionals;
  if (!specA || !specB) throw new Error('usage: bench compare <runA>[:variant] <runB>[:variant]');
  const a = loadSide(specA);
  const b = loadSide(specB);
  const comparison = compareRuns(a, b, readRunCatalog(b.runDir), {
    allowCrossHost: options['allow-cross-host'] ?? false,
    forceVerdicts: options['force-verdicts'] ?? false,
    calibration: loadCalibration(resolve(options['calibration-dir'] ?? 'calibration'), b.manifest.host.hostClass.id),
  });
  const outDir = resolve(options.out ?? 'comparisons');
  mkdirSync(outDir, { recursive: true });
  const name = `${a.manifest.runId}-${a.variant}__${b.manifest.runId}-${b.variant}`;
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(comparison, null, 1)}\n`);
  writeFileSync(join(outDir, `${name}.md`), renderComparison(comparison));
  process.stdout.write(`${join(outDir, `${name}.md`)}\n`);
  return 0;
}
