import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  catalogSchema,
  profileSchema,
  targetSchema,
  versionsSchema,
  type MetricDef,
  type Profile,
  type Target,
  type Versions,
} from './schema.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function formatIssues(file: string, issues: z.core.$ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `${file} is invalid:\n${lines.join('\n')}`;
}

/** Reads a YAML file and validates it, reporting every issue with its path. */
export function loadYaml<S extends z.ZodType>(file: string, schema: S): z.output<S> {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatIssues(file, result.error.issues));
  return result.data;
}

function resolveExisting(baseDir: string, file: string, what: string): string {
  const path = isAbsolute(file) ? file : resolve(baseDir, file);
  if (!existsSync(path)) throw new ConfigError(`${what} not found: ${path}`);
  return path;
}

export interface LoadedTarget extends Target {
  /** Directory of target.yaml; compose and seed paths are relative to it. */
  dir: string;
  composeFiles: string[];
}

export function loadTarget(file: string): LoadedTarget {
  const target = loadYaml(file, targetSchema);
  const dir = dirname(resolve(file));
  const names = [...target.services, ...target.dependencies, ...target.simulators].map((s) => s.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new ConfigError(`${file}: service "${duplicate}" is declared more than once`);
  const composeFiles = target.compose.map((c) => resolveExisting(dir, c, 'compose file'));
  return { ...target, dir, composeFiles };
}

export interface LoadedProfile extends Profile {
  dir: string;
  scripts: Record<string, string>;
}

export function loadProfile(file: string): LoadedProfile {
  const profile = loadYaml(file, profileSchema);
  const dir = dirname(resolve(file));
  const scripts = Object.fromEntries(
    profile.scenarios.map((s) => [s.name, resolveExisting(dir, s.script, `script of scenario "${s.name}"`)]),
  );
  return { ...profile, dir, scripts };
}

/** Kit catalogue plus an optional domain extension; ids must stay unique (BR-14). */
export function loadCatalog(kitFile: string, extensionFile?: string): MetricDef[] {
  const metrics = loadYaml(kitFile, catalogSchema).metrics;
  if (extensionFile) metrics.push(...loadYaml(extensionFile, catalogSchema).metrics);
  const seen = new Set<string>();
  for (const metric of metrics) {
    if (seen.has(metric.id)) throw new ConfigError(`metric "${metric.id}" is defined more than once`);
    seen.add(metric.id);
  }
  return metrics;
}

export function loadVersions(file: string): Versions {
  return loadYaml(file, versionsSchema);
}

/** Root of the kit inside the CLI image (or the repo when run from source). */
export function kitDir(): string {
  return process.env.BENCH_KIT_DIR ?? resolve(import.meta.dirname, '..', '..', '..');
}

export function kitPath(...parts: string[]): string {
  return join(kitDir(), ...parts);
}
