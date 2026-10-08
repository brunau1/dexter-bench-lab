import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';
import { relative, resolve } from 'node:path';
import { DockerCli } from '../docker/runner.js';
import { realHostFiles } from '../host/probe.js';
import { DockerStatsSampler } from '../metrics/docker-stats.js';
import { executeRun } from '../run/execute.js';
import { InterruptedError, shutdown } from '../signals.js';

export interface RunCommandOptions {
  target?: string;
  profile?: string;
  out?: string;
  capacity?: boolean;
  'raw-samples'?: boolean;
}

export async function runCommandWith(options: RunCommandOptions, variants?: { name: string; env: Record<string, string> }[]) {
  if (!options.target || !options.profile) throw new Error('bench run needs --target and --profile');
  const outDir = resolve(options.out ?? 'results');
  if (existsSync('/.dockerenv') && relative(process.cwd(), outDir).startsWith('..')) {
    throw new Error(`--out ${outDir} is outside the current directory; only the current directory is mounted into the CLI container`);
  }
  const result = await executeRun(
    {
      targetFile: options.target,
      profileFile: options.profile,
      outDir,
      mode: options.capacity ? 'capacity' : 'matrix',
      rawSamples: options['raw-samples'] ?? false,
      kitVersion: process.env.BENCH_KIT_VERSION ?? 'unknown',
      ...(variants ? { variants } : {}),
    },
    {
      runner: new DockerCli(),
      fetch,
      hostFiles: realHostFiles,
      selfContainer: existsSync('/.dockerenv') ? hostname() : null,
      user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      sleep: (ms) => sleep(ms, undefined, { signal: shutdown.signal }).catch(() => {
        throw new InterruptedError();
      }),
      now: () => Date.now(),
      log: (message) => process.stderr.write(`${message}\n`),
      statsSampler: () => new DockerStatsSampler(),
      signal: shutdown.signal,
    },
  );
  const { runDir, manifest } = result;
  const invalid = manifest.repetitions.filter((r) => !r.valid).length;
  process.stdout.write(`${runDir}\n`);
  process.stderr.write(
    `run ${manifest.runId}: ${manifest.repetitions.length} repetitions (${invalid} invalid), ${manifest.host.baseline ? 'baseline' : 'non-baseline (smoke-only host)'}${manifest.valid ? '' : `, RUN INVALID: ${manifest.invalidReasons.join('; ')}`}\n`,
  );
  return result;
}

export async function runCommand(options: RunCommandOptions): Promise<number> {
  const { manifest } = await runCommandWith(options);
  return manifest.valid ? 0 : 3;
}
