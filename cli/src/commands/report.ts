import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MetricDef } from '../config/schema.js';
import { renderReport } from '../report/render.js';
import { CATALOG_FILE, REPORT_FILE } from '../run/execute.js';
import { readManifest } from '../run/manifest.js';
import { writeSummary, type RunSummary } from '../run/summary.js';

export function readRunCatalog(runDir: string): MetricDef[] {
  return JSON.parse(readFileSync(join(runDir, 'kit', CATALOG_FILE), 'utf8')) as MetricDef[];
}

/** BR-18: rebuilds summary.json and report.md from raw/ and the manifest. */
export function rebuildReport(runDir: string): RunSummary {
  const manifest = readManifest(runDir);
  const summary = writeSummary(runDir, manifest, readRunCatalog(runDir));
  writeFileSync(join(runDir, REPORT_FILE), renderReport(runDir, manifest, summary));
  return summary;
}

export async function reportCommand(positionals: string[]): Promise<number> {
  const runDir = positionals[1];
  if (!runDir) throw new Error('usage: bench report <results/run-id>');
  rebuildReport(resolve(runDir));
  process.stdout.write(`${join(resolve(runDir), REPORT_FILE)}\n`);
  return 0;
}
