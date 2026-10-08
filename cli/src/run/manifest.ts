import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DoctorReport } from '../host/classify.js';
import type { Window } from './plan.js';

export interface RepetitionRecord {
  scenario: string;
  scale: string;
  variant: string;
  rep: number;
  rate: number;
  dir: string;
  /** Compose project of the repetition's target. */
  project?: string;
  startedAt: string;
  window: Window | null;
  datasetSha256: string | null;
  valid: boolean;
  invalidReasons: string[];
  /** Collection problems that did not invalidate the repetition, e.g. unparsable fallback samples. */
  warnings?: string[];
}

/** BR-12: everything needed to reproduce, audit and compare a run. */
export interface Manifest {
  schemaVersion: 1;
  runId: string;
  mode: 'matrix' | 'capacity';
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  kitVersion: string;
  target: { name: string; dir: string; commit: string | null };
  host: {
    hostClass: DoctorReport['hostClass'];
    classification: NonNullable<DoctorReport['classification']>;
    /** BR-10: only runs on a benchmark-grade host are baselines. */
    baseline: boolean;
    failedChecks: string[];
    facts: DoctorReport['facts'];
  };
  cpuPlan: DoctorReport['plan'];
  collector: 'cadvisor' | 'docker-stats';
  /** Image reference → content digest (repo digest when pulled, image id when built locally). */
  images: Record<string, string>;
  seed: number;
  config: { target: unknown; profile: unknown };
  repetitions: RepetitionRecord[];
  /** Run-level validity (e.g. BR-3 dataset fingerprints must match). */
  valid: boolean;
  invalidReasons: string[];
}

export const MANIFEST_FILE = 'manifest.json';

/** Writes atomically so a crash never leaves a half-written manifest. */
export function writeManifest(runDir: string, manifest: Manifest): void {
  const file = join(runDir, MANIFEST_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export class IncompleteRunError extends Error {
  override readonly name = 'IncompleteRunError';
}

/** Reads a manifest; a run that never finished can't be reported or compared (BR-12). */
export function readManifest(runDir: string, options: { allowIncomplete?: boolean } = {}): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(runDir, MANIFEST_FILE), 'utf8')) as Manifest;
  } catch (error) {
    throw new IncompleteRunError(`${runDir}: no readable manifest (${(error as Error).message})`);
  }
  if (manifest.status !== 'complete' && !options.allowIncomplete) {
    throw new IncompleteRunError(`${runDir}: run is ${manifest.status === 'running' ? 'incomplete (never finalized)' : 'failed'}; it can't be reported or compared (BR-12)`);
  }
  return manifest;
}

/** BR-3: every repetition of a run must start from the same dataset. */
export function checkDatasetFingerprints(repetitions: RepetitionRecord[]): string[] {
  const fingerprints = new Set(repetitions.map((r) => r.datasetSha256).filter((f): f is string => f !== null));
  return fingerprints.size > 1 ? [`dataset fingerprints differ between repetitions (${fingerprints.size} distinct): the data was not controlled (BR-3)`] : [];
}
