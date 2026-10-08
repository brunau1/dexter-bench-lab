import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProfile } from '../config/load.js';
import { compareRuns, noiseFloors, type Calibration } from '../compare/compare.js';
import { buildSummary } from '../run/summary.js';
import { readRunCatalog } from './report.js';
import { runCommandWith, type RunCommandOptions } from './run.js';

/**
 * `bench calibrate` (BR-8): an A/A run of the profile's first variant against itself, interleaved,
 * whose confidence intervals become the noise floor of every metric on this host class.
 */
export async function calibrateCommand(options: RunCommandOptions & { 'calibration-dir'?: string }): Promise<number> {
  if (!options.target || !options.profile) throw new Error('bench calibrate needs --target and --profile');
  const base = loadProfile(options.profile).variants[0]!;
  const { runDir, manifest } = await runCommandWith(options, [
    { name: 'a1', env: base.env },
    { name: 'a2', env: base.env },
  ]);
  const catalog = readRunCatalog(runDir);
  const summary = buildSummary(runDir, manifest, catalog);
  const side = (variant: string) => ({ runDir, manifest, summary, variant });
  const aa = compareRuns(side('a1'), side('a2'), catalog, { allowCrossHost: false, forceVerdicts: true, calibration: null });
  const calibration: Calibration = {
    schemaVersion: 1,
    hostClass: manifest.host.hostClass.id,
    runId: manifest.runId,
    kitVersion: manifest.kitVersion,
    floors: noiseFloors(aa),
  };
  const dir = resolve(options['calibration-dir'] ?? 'calibration');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${calibration.hostClass}.json`);
  writeFileSync(file, `${JSON.stringify(calibration, null, 1)}\n`);
  process.stdout.write(`${file}\n`);
  if (!manifest.host.baseline) process.stderr.write('calibration taken on a smoke-only host: valid only for testing the kit (BR-10)\n');
  return manifest.valid ? 0 : 3;
}
