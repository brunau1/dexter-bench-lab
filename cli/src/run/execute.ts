import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { kitPath, loadCatalog, loadProfile, loadTarget, loadVersions, type LoadedProfile, type LoadedTarget } from '../config/load.js';
import type { MetricDef, Versions } from '../config/schema.js';
import { docker, type DockerRunner } from '../docker/runner.js';
import { evaluateHost, type DoctorReport } from '../host/classify.js';
import { benchServices, type BenchService } from '../host/demand.js';
import { probeHost, type HostFiles } from '../host/probe.js';
import { k6Env } from '../k6/env.js';
import { sinkSamples, type SinkStats } from '../k6/sink.js';
import { droppedIterations, k6Samples, type K6Summary } from '../k6/summary.js';
import { aggregate } from '../metrics/aggregate.js';
import { planQueries, PROJECT_LABEL } from '../metrics/catalog.js';
import { aggregateStats, DockerStatsSampler, FALLBACK_METRICS } from '../metrics/docker-stats.js';
import { exportersFor, prometheusConfig } from '../metrics/observers.js';
import { collectPrometheus, PrometheusClient, type RawSeries } from '../metrics/prometheus.js';
import type { MetricSample } from '../metrics/sample.js';
import { observerOverride, SINK_PORT, sutOverride, validateTargetCompose } from './compose.js';
import { derivedSamples, sutMemoryQuery } from './derived.js';
import { checkDatasetFingerprints, writeManifest, type Manifest, type RepetitionRecord } from './manifest.js';
import { buildPlan, capacityRates, measurementWindow, stepDir, type Step, type Window } from './plan.js';
import { sinkImageTag } from './images.js';
import { renderReport } from '../report/render.js';
import { writeSummary } from './summary.js';

export const REPORT_FILE = 'report.md';

export const CATALOG_FILE = 'catalog.json';
export const RESERVED_SERVICES = ['k6', 'sink', 'prometheus', 'cadvisor'];
const PROMETHEUS_URL = 'http://prometheus:9090';
const SINK_URL = `http://sink:${SINK_PORT}`;
/** Margin after the window so the slowest scrape (MongoDB, 2 s) has covered it. */
const SCRAPE_LAG_MS = 3_000;
const EXPORTERS_READY_TIMEOUT_MS = 90_000;
const CADVISOR_DISCOVERY_TIMEOUT_MS = 20_000;

export interface RunOptions {
  targetFile: string;
  profileFile: string;
  /** Directory that receives results/<run-id>. */
  outDir: string;
  mode: 'matrix' | 'capacity';
  rawSamples: boolean;
  kitVersion: string;
  /** Replaces the profile's variants (used by calibrate for an A/A run). */
  variants?: { name: string; env: Record<string, string> }[];
}

export interface RunDeps {
  runner: DockerRunner;
  fetch: typeof fetch;
  hostFiles: HostFiles;
  /** Name of the CLI's own container, to attach it to the run network; null outside a container. */
  selfContainer: string | null;
  /** uid:gid that files written by k6 must belong to. */
  user: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
  statsSampler(): Pick<DockerStatsSampler, 'start' | 'stop'>;
}

interface RunContext {
  target: LoadedTarget;
  profile: LoadedProfile;
  catalog: MetricDef[];
  versions: Versions;
  services: BenchService[];
  report: DoctorReport;
  runId: string;
  runDir: string;
  network: string;
  sutProject: string;
  obsProject: string;
  sutFiles: string[];
  obsFiles: string[];
  sinkImage: string | null;
  manifest: Manifest;
  prometheus: PrometheusClient;
  collector: 'cadvisor' | 'docker-stats';
}

function runIdFor(now: number, target: string): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${target}`.toLowerCase();
}

function composeArgs(project: string, projectDir: string, files: string[]): string[] {
  return ['compose', '-p', project, '--project-directory', projectDir, ...files.flatMap((f) => ['-f', f])];
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

const FINGERPRINT = /BENCH_DATASET_SHA256=([a-f0-9]{64})/g;

/** BR-3: the seed job must print the dataset fingerprint; the last one printed wins. */
export function parseFingerprint(stdout: string): string {
  const matches = [...stdout.matchAll(FINGERPRINT)];
  const last = matches[matches.length - 1];
  if (!last) throw new Error('seed did not print BENCH_DATASET_SHA256=<64 hex chars> (see templates/target/seed/README.md)');
  return last[1]!;
}

/** Commit of the target (BR-12); null when the target is not in a git repository. */
function gitCommit(dir: string): string | null {
  const result = spawnSync('git', ['-C', dir, 'describe', '--always', '--dirty', '--abbrev=40'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Validates the target's compose files under every variant and returns the images they use. */
async function inspectTargetCompose(deps: RunDeps, target: LoadedTarget, profile: LoadedProfile): Promise<string[]> {
  const images = new Set<string>();
  const base = composeArgs('bench-validate', target.dir, target.composeFiles);
  for (const variant of profile.variants) {
    const config = JSON.parse(await docker(deps.runner, [...base, '--profile', '*', 'config', '--format', 'json'], { env: variant.env })) as {
      services: Record<string, { image?: string; build?: unknown } & Parameters<typeof validateTargetCompose>[0]['services'][string]>;
    };
    const problems = validateTargetCompose(config);
    for (const [name, service] of Object.entries(config.services)) {
      if (RESERVED_SERVICES.includes(name)) problems.push(`${name}: this service name is reserved by the kit`);
      if (service.build !== undefined && !service.image) problems.push(`${name}: built services need an explicit image: tag so bench prepare can build it once`);
      if (service.image) images.add(service.image);
    }
    const declared = [...target.services, ...target.dependencies, ...target.simulators].map((s) => s.name);
    for (const name of [...declared, target.seed.service]) {
      if (!(name in config.services)) problems.push(`${name}: declared in target.yaml but missing from the compose files`);
    }
    if (problems.length > 0) throw new Error(`target compose files break the kit's rules (variant "${variant.name}"):\n  - ${problems.join('\n  - ')}`);
  }
  return [...images];
}

/** BR-13: a run never pulls; every image must be present locally (bench prepare). Returns ref → digest. */
async function resolveImages(deps: RunDeps, refs: string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const missing: string[] = [];
  for (const ref of refs) {
    const result = await deps.runner.run(['image', 'inspect', '--format', '{{json .RepoDigests}}|{{.Id}}', ref]);
    if (result.code !== 0) {
      missing.push(ref);
      continue;
    }
    const [repoDigests, id] = result.stdout.trim().split('|') as [string, string];
    const repo = (JSON.parse(repoDigests) as string[])[0];
    digests[ref] = repo ?? id;
  }
  if (missing.length > 0) throw new Error(`images missing locally (a run never pulls, BR-13); run "bench prepare" first:\n  - ${missing.join('\n  - ')}`);
  return digests;
}

async function waitCadvisor(ctx: RunContext, deps: RunDeps): Promise<boolean> {
  const deadline = deps.now() + CADVISOR_DISCOVERY_TIMEOUT_MS;
  const query = `count(container_cpu_usage_seconds_total{${PROJECT_LABEL}="${ctx.sutProject}"})`;
  while (deps.now() < deadline) {
    const t = deps.now() / 1000;
    const result = await ctx.prometheus.queryRange(query, { start: t - 2, end: t }).catch(() => []);
    if (result.some((series) => series.values.some(([, v]) => Number(v) > 0))) return true;
    await deps.sleep(1_000);
  }
  return false;
}

interface StepTimings {
  warmupMs: number;
  durationMs: number;
  cooldownMs: number;
}

/** One repetition: fresh state, seed, load, collect (BR-2, BR-3). */
async function runRepetition(ctx: RunContext, deps: RunDeps, step: Step, timings: StepTimings, rawSamples: boolean): Promise<RepetitionRecord> {
  const { target, profile } = ctx;
  const variant = profile.variants.find((v) => v.name === step.variant)!;
  const scenario = profile.scenarios.find((s) => s.name === step.scenario)!;
  const dir = stepDir(step);
  const repDir = join(ctx.runDir, dir);
  mkdirSync(repDir, { recursive: true });
  const record: RepetitionRecord = {
    ...step,
    dir,
    startedAt: new Date(deps.now()).toISOString(),
    window: null,
    datasetSha256: null,
    valid: true,
    invalidReasons: [],
  };
  const sut = composeArgs(ctx.sutProject, target.dir, ctx.sutFiles);
  const opts = { env: variant.env };
  deps.log(`[${step.scenario}/${step.scale}/${step.variant}] rep ${step.rep}: resetting state`);

  await docker(deps.runner, [...sut, 'down', '-v', '--remove-orphans', '--timeout', '10'], opts);
  await docker(deps.runner, [...sut, 'up', '-d', '--wait', '--pull', 'never', '--no-build'], opts);
  const seedOut = await docker(deps.runner, [...sut, 'run', '--rm', '--pull', 'never', ...envFlags({ BENCH_SEED: String(profile.seed) }), target.seed.service], opts);
  record.datasetSha256 = parseFingerprint(seedOut);
  await ctx.prometheus.waitReady(['cadvisor', ...target.dependencies.map((d) => `${d.name}-exporter`)], EXPORTERS_READY_TIMEOUT_MS);
  if (ctx.manifest.repetitions.length === 0 && !(await waitCadvisor(ctx, deps))) {
    ctx.collector = 'docker-stats';
    ctx.manifest.collector = 'docker-stats';
    deps.log('cAdvisor reports no containers of this run on this host: falling back to docker stats for container metrics (§8)');
  }

  const sampler = ctx.collector === 'docker-stats' ? deps.statsSampler() : null;
  sampler?.start();
  const summaryPath = join(repDir, 'k6.json');
  const k6Container = `${ctx.sutProject}-k6-${String(step.rep)}`;
  const env = k6Env({ profile, usecases: scenario.usecases, rate: step.rate, summaryPath, warmupMs: timings.warmupMs, durationMs: timings.durationMs });
  const script = `/scripts/${relative(profile.dir, profile.scripts[scenario.name]!)}`;
  deps.log(`[${step.scenario}/${step.scale}/${step.variant}] rep ${step.rep}: load ${step.rate} it/s`);
  const k6 = await deps.runner.run(
    [
      ...sut,
      'run',
      '--name',
      k6Container,
      ...(sampler ? [] : ['--rm']),
      '--pull',
      'never',
      '--no-deps',
      ...envFlags(env),
      'k6',
      'run',
      '--quiet',
      ...(rawSamples ? ['--out', `csv=${join(repDir, 'requests.csv.gz')}`] : []),
      script,
    ],
    opts,
  );
  if (!existsSync(summaryPath)) {
    await sampler?.stop();
    throw new Error(`k6 produced no summary (exit ${k6.code}): ${k6.stderr.trim().slice(-2000)}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as K6Summary;
  const measureStart = summary.metrics.bench_measure_start_ms?.values.value;
  if (measureStart === undefined) throw new Error('k6 summary has no bench_measure_start_ms: scenarios must run their requests inside bench.usecase()');
  const window: Window = measurementWindow(measureStart, timings.durationMs);
  record.window = window;

  // Async work may still complete during the cool-down; scrapes lag up to one interval.
  const waitUntil = window.end * 1000 + Math.max(timings.cooldownMs, SCRAPE_LAG_MS);
  if (deps.now() < waitUntil) await deps.sleep(waitUntil - deps.now());

  const measureSeconds = timings.durationMs / 1000;
  const samples: MetricSample[] = k6Samples(summary, ctx.catalog, scenario.usecases, measureSeconds);
  if (scenario.callbacks) {
    const stats = (await (await deps.fetch(`${SINK_URL}/stats`)).json()) as SinkStats;
    samples.push(...sinkSamples(stats, ctx.catalog, scenario.name));
  }

  const sutServices = [...target.services, ...target.dependencies].map((s) => s.name);
  const projects = [ctx.sutProject, ctx.obsProject];
  const planned = planQueries(ctx.catalog, { projects, sutServices, dependencies: target.dependencies }).filter(
    (p) => ctx.collector === 'cadvisor' || !(p.metric.scope === 'container' || p.metric.scope === 'sut'),
  );
  const collected = await collectPrometheus(ctx.prometheus, planned, window);
  samples.push(...collected.samples);
  const raw: RawSeries[] = collected.raw;

  if (sampler) {
    const points = await sampler.stop();
    const containers = await docker(deps.runner, ['ps', '-a', '--no-trunc', '--format', '{{.ID}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project"}}']);
    const services = new Map<string, string>();
    for (const line of containers.trim().split('\n')) {
      const [id, service, project] = line.split('|');
      if (id && service && projects.includes(project ?? '')) {
        services.set(id, service);
        services.set(id.slice(0, 12), service);
      }
    }
    const fallback = aggregateStats(points, services, window).filter((s) => (FALLBACK_METRICS as readonly string[]).includes(s.metric));
    samples.push(...fallback);
    await deps.runner.run(['rm', '-f', k6Container]);
  }

  let sutMemoryPeak: number | null = null;
  if (ctx.collector === 'cadvisor') {
    const memQuery = sutMemoryQuery([ctx.sutProject], sutServices);
    const series = await ctx.prometheus.queryRange(memQuery, window);
    const values = series[0]?.values.map(([t, v]): [number, number] => [t, Number(v)]) ?? [];
    raw.push({ query: memQuery, metric: 'sut_memory_peak', labels: {}, values });
    sutMemoryPeak = aggregate(values, 'max', window);
  } else {
    sutMemoryPeak = samples.filter((s) => s.metric === 'mem_working_set_max' && sutServices.includes(s.subject)).reduce((sum, s) => sum + s.value, 0) || null;
  }
  samples.push(...derivedSamples({ samples, sutServices, sutMemoryPeak, summary, usecases: scenario.usecases, measureSeconds }));

  const dropped = droppedIterations(summary);
  if (dropped > 0) {
    record.valid = false;
    record.invalidReasons.push(`load generator dropped ${dropped} iterations: the arrival rate was not applied (BR-1)`);
  }
  if (k6.code !== 0) {
    record.valid = false;
    record.invalidReasons.push(`k6 exited with code ${k6.code}`);
  }

  samples.sort((x, y) => x.metric.localeCompare(y.metric) || x.subject.localeCompare(y.subject) || x.key.localeCompare(y.key));
  writeFileSync(join(repDir, 'samples.json'), `${JSON.stringify(samples, null, 1)}\n`);
  writeFileSync(join(repDir, 'prometheus.json.gz'), gzipSync(JSON.stringify(raw)));
  writeFileSync(join(repDir, 'meta.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** BR-17: does a capacity step meet every SLO of the profile? */
export function meetsSlo(samples: MetricSample[], slo: LoadedProfile['slo']): { ok: boolean; broken: string[] } {
  const max = (metric: string) => Math.max(-Infinity, ...samples.filter((s) => s.metric === metric).map((s) => s.value));
  const broken: string[] = [];
  if (slo.latency_p99_ms !== undefined && max('latency_p99') > slo.latency_p99_ms) broken.push(`latency p99 ${max('latency_p99').toFixed(1)} ms > ${slo.latency_p99_ms} ms`);
  if (slo.error_rate !== undefined && max('error_rate') > slo.error_rate) broken.push(`error rate ${max('error_rate')} > ${slo.error_rate}`);
  if (slo.e2e_p99_ms !== undefined && max('e2e_p99') > slo.e2e_p99_ms) broken.push(`e2e p99 ${max('e2e_p99').toFixed(1)} ms > ${slo.e2e_p99_ms} ms`);
  if (max('callback_timeouts') > 0) broken.push(`${max('callback_timeouts')} callback timeouts`);
  return { ok: broken.length === 0, broken };
}

interface CapacityStepResult {
  variant: string;
  rate: number;
  dir: string;
  meetsSlo: boolean;
  broken: string[];
  dropped: number;
}

export interface CapacityResult {
  variant: string;
  steps: CapacityStepResult[];
  /** Highest rate meeting every SLO, or null when even the first step broke one. */
  knee: number | null;
  /** True when the search stopped because the load generator saturated: the knee is a lower bound. */
  lowerBound: boolean;
}

async function runCapacity(ctx: RunContext, deps: RunDeps, rawSamples: boolean): Promise<CapacityResult[]> {
  const capacity = ctx.profile.capacity!;
  const results: CapacityResult[] = [];
  for (const variant of ctx.profile.variants) {
    const result: CapacityResult = { variant: variant.name, steps: [], knee: null, lowerBound: false };
    for (const rate of capacityRates(capacity)) {
      const step: Step = { scenario: capacity.scenario, scale: `capacity-${rate}`, rep: 1, variant: variant.name, rate };
      const record = await runRepetition(ctx, deps, step, { warmupMs: capacity.warmup, durationMs: capacity.stepDuration, cooldownMs: ctx.profile.timings.cooldown }, rawSamples);
      ctx.manifest.repetitions.push(record);
      writeManifest(ctx.runDir, ctx.manifest);
      const samples = JSON.parse(readFileSync(join(ctx.runDir, record.dir, 'samples.json'), 'utf8')) as MetricSample[];
      const dropped = samples.find((s) => s.metric === 'dropped_iterations')?.value ?? 0;
      const slo = meetsSlo(samples, ctx.profile.slo);
      result.steps.push({ variant: variant.name, rate, dir: record.dir, meetsSlo: slo.ok, broken: slo.broken, dropped });
      if (dropped > 0) {
        result.lowerBound = true;
        deps.log(`capacity: load generator saturated at ${rate} it/s; knee ≥ ${result.knee ?? 'n/a'} (BR-17)`);
        break;
      }
      if (!slo.ok) {
        deps.log(`capacity: SLO broken at ${rate} it/s (${slo.broken.join('; ')}); knee = ${result.knee ?? 'below the first step'}`);
        break;
      }
      result.knee = rate;
    }
    results.push(result);
  }
  writeFileSync(join(ctx.runDir, 'capacity.json'), `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

async function cleanup(ctx: RunContext, deps: RunDeps): Promise<void> {
  const attempt = async (args: string[]) => {
    const result = await deps.runner.run(args).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }));
    if (result.code !== 0) deps.log(`cleanup: docker ${args.slice(0, 6).join(' ')} … failed: ${result.stderr.trim()}`);
  };
  await attempt([...composeArgs(ctx.sutProject, ctx.target.dir, ctx.sutFiles), 'down', '-v', '--remove-orphans', '--timeout', '10']);
  await attempt([...composeArgs(ctx.obsProject, ctx.runDir, ctx.obsFiles), 'down', '-v', '--remove-orphans', '--timeout', '10']);
  if (deps.selfContainer) await attempt(['network', 'disconnect', '--force', ctx.network, deps.selfContainer]);
  await attempt(['network', 'rm', ctx.network]);
}

/** `bench run`: the whole lifecycle of a run, always tearing everything down at the end. */
export async function executeRun(options: RunOptions, deps: RunDeps): Promise<{ runDir: string; manifest: Manifest }> {
  if (!deps.selfContainer) throw new Error('bench run must run inside the CLI container (use the ./bench wrapper) to reach the run network');
  const target = loadTarget(options.targetFile);
  const loaded = loadProfile(options.profileFile);
  const profile = options.variants ? { ...loaded, variants: options.variants } : loaded;
  for (const [name, script] of Object.entries(profile.scripts)) {
    if (relative(profile.dir, script).startsWith('..')) throw new Error(`script of scenario "${name}" must be inside the profile directory ${profile.dir}`);
  }
  if (options.mode === 'capacity' && !profile.capacity) throw new Error('capacity mode needs a `capacity` section in the profile');
  const extension = join(target.dir, 'catalog.ext.yaml');
  const catalog = loadCatalog(kitPath('core', 'metrics', 'catalog.yaml'), existsSync(extension) ? extension : undefined);
  const versions = loadVersions(kitPath('core', 'versions.yaml'));
  const services = benchServices(target, profile);
  const report = evaluateHost(await probeHost(deps.runner, deps.hostFiles), services);

  const runId = runIdFor(deps.now(), target.name);
  const runDir = resolve(options.outDir, runId);
  const network = `${runId}-net`;
  mkdirSync(join(runDir, 'kit', 'k6'), { recursive: true });

  const targetImages = await inspectTargetCompose(deps, target, profile);
  const exporters = exportersFor(target, versions);
  const sinkImage = profile.scenarios.some((s) => s.callbacks) ? sinkImageTag(versions) : null;
  const images = await resolveImages(deps, [
    ...targetImages,
    versions.images.k6,
    versions.images.prometheus,
    versions.images.cadvisor,
    ...new Set(exporters.map((e) => e.image)),
    ...(sinkImage ? [sinkImage] : []),
  ]);

  copyFileSync(kitPath('core', 'k6', 'bench.js'), join(runDir, 'kit', 'k6', 'bench.js'));
  // the merged catalogue travels with the run, so reports regenerate anywhere (BR-18)
  writeFileSync(join(runDir, 'kit', CATALOG_FILE), `${JSON.stringify(catalog, null, 1)}\n`);
  writeFileSync(join(runDir, 'kit', 'prometheus.yml'), prometheusConfig(exporters));
  const cpus = report.plan?.cpus ?? null;
  const sutOverridePath = join(runDir, 'kit', 'sut.override.yaml');
  writeFileSync(
    sutOverridePath,
    sutOverride({
      services,
      cpus,
      network,
      k6Image: versions.images.k6,
      sinkImage,
      ...(target.callbacks ? { sinkIdPath: target.callbacks.idPath } : {}),
      kitK6Dir: join(runDir, 'kit', 'k6'),
      scriptsDir: profile.dir,
      runDir,
      user: deps.user,
    }),
  );
  const obsOverridePath = join(runDir, 'kit', 'obs.override.yaml');
  writeFileSync(obsOverridePath, observerOverride({ services, cpus, exporters }));

  const failedChecks = report.checks.filter((c) => !c.ok && c.required).map((c) => `${c.id}: ${c.detail}`);
  const manifest: Manifest = {
    schemaVersion: 1,
    runId,
    mode: options.mode,
    status: 'running',
    startedAt: new Date(deps.now()).toISOString(),
    finishedAt: null,
    error: null,
    kitVersion: options.kitVersion,
    target: { name: target.name, dir: target.dir, commit: gitCommit(target.dir) },
    host: { hostClass: report.hostClass, classification: report.classification!, baseline: report.classification === 'benchmark-grade', failedChecks, facts: report.facts },
    cpuPlan: report.plan,
    collector: 'cadvisor',
    images,
    seed: profile.seed,
    config: { target, profile },
    repetitions: [],
    valid: true,
    invalidReasons: [],
  };
  writeManifest(runDir, manifest);
  if (!manifest.host.baseline) deps.log(`host is smoke-only: results will be non-baseline (BR-10)\n  - ${failedChecks.join('\n  - ')}`);

  const ctx: RunContext = {
    target,
    profile,
    catalog,
    versions,
    services,
    report,
    runId,
    runDir,
    network,
    sutProject: `${runId}-sut`,
    obsProject: `${runId}-obs`,
    sutFiles: [...target.composeFiles, sutOverridePath],
    obsFiles: [kitPath('core', 'observers', 'compose.yaml'), obsOverridePath],
    sinkImage,
    manifest,
    prometheus: new PrometheusClient(PROMETHEUS_URL, deps.fetch),
    collector: 'cadvisor',
  };

  const obsEnv = {
    BENCH_PROMETHEUS_IMAGE: versions.images.prometheus,
    BENCH_CADVISOR_IMAGE: versions.images.cadvisor,
    BENCH_RUN_DIR: runDir,
    BENCH_NETWORK: network,
    BENCH_DOCKER_ROOT: report.facts.dockerRootDir,
  };
  try {
    await docker(deps.runner, ['network', 'create', '--internal', network]);
    deps.log(`run ${runId}: starting observers`);
    await docker(deps.runner, [...composeArgs(ctx.obsProject, runDir, ctx.obsFiles), 'up', '-d', '--wait', '--pull', 'never'], { env: obsEnv });
    await docker(deps.runner, ['network', 'connect', network, deps.selfContainer]);
    await ctx.prometheus.waitReady(['cadvisor'], EXPORTERS_READY_TIMEOUT_MS);

    if (options.mode === 'capacity') {
      await runCapacity(ctx, deps, options.rawSamples);
    } else {
      const timings = { warmupMs: profile.timings.warmup, durationMs: profile.timings.duration, cooldownMs: profile.timings.cooldown };
      for (const step of buildPlan(profile)) {
        manifest.repetitions.push(await runRepetition(ctx, deps, step, timings, options.rawSamples));
        writeManifest(runDir, manifest);
      }
    }
    manifest.invalidReasons.push(...checkDatasetFingerprints(manifest.repetitions));
    manifest.valid = manifest.invalidReasons.length === 0;
    manifest.status = 'complete';
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = (error as Error).message;
    throw error;
  } finally {
    manifest.finishedAt = new Date(deps.now()).toISOString();
    writeManifest(runDir, manifest);
    deps.log(`run ${runId}: tearing down`);
    await cleanup(ctx, deps);
  }
  const summary = writeSummary(runDir, manifest, catalog);
  writeFileSync(join(runDir, REPORT_FILE), renderReport(runDir, manifest, summary));
  return { runDir, manifest };
}
