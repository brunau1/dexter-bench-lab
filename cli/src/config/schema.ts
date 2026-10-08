import { z } from 'zod';
import { parseDurationMs, parseMemoryBytes } from './units.js';

/** Validates with a unit parser and converts, so errors point at the offending field. */
function parsed<T>(parse: (value: string) => T) {
  return z.string().transform((value, ctx): T => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });
}

const duration = parsed(parseDurationMs);
const memory = parsed(parseMemoryBytes);
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, "-" or "_"');
const cpus = z.number().positive().max(256);

/** Resource limits of one container; they drive the capacity plan (BR-9). */
const limits = { cpus, memory };

export const DEPENDENCY_TYPES = ['mongodb', 'redis', 'custom'] as const;
export const CPU_UNITS = ['logical', 'physical'] as const;

const exporterSpec = z.object({
  image: z.string().min(1),
  port: z.number().int().positive(),
  metricsPath: z.string().default('/metrics'),
  command: z.array(z.string()).default([]),
});

const dependency = z
  .object({
    name,
    type: z.enum(DEPENDENCY_TYPES),
    ...limits,
    /** Connection the built-in exporter uses; defaults to the dependency's standard port. */
    exporterTarget: z.string().optional(),
    /** Exporter of a `custom` dependency. */
    exporter: exporterSpec.optional(),
  })
  .refine((dep) => dep.type !== 'custom' || dep.exporter !== undefined, {
    message: 'a custom dependency must declare its exporter (image, port)',
    path: ['exporter'],
  });

export const targetSchema = z.object({
  schemaVersion: z.literal(1),
  name,
  compose: z.array(z.string().min(1)).min(1),
  services: z.array(z.object({ name, ...limits })).min(1),
  dependencies: z.array(dependency).default([]),
  simulators: z.array(z.object({ name, ...limits })).default([]),
  seed: z.object({
    /** Compose service run once per repetition with BENCH_SEED set; prints BENCH_DATASET_SHA256=<hex> (BR-3). */
    service: name,
  }),
  callbacks: z
    .object({
      /** Dotted path to the correlation id inside a callback body, e.g. `data.id` (BR-19). */
      idPath: z.string().regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/),
    })
    .optional(),
});

const scenario = z.object({
  name,
  script: z.string().min(1),
  /** Use-case tags the script emits; each gets its own metrics. */
  usecases: z.array(name).min(1),
  callbacks: z.boolean().default(false),
});

const variant = z.object({
  name,
  /** Environment for the target's compose files (e.g. an image tag). */
  env: z.record(z.string(), z.string()).default({}),
});

export const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    seed: z.number().int().nonnegative(),
    repetitions: z.number().int().min(3, 'at least 3 repetitions are needed to estimate spread (BR-4)').default(5),
    /**
     * Unit of the CPU limits when planning isolation (BR-9): `logical` counts hyper-threads, like cloud
     * vCPUs; `physical` counts whole cores. Groups always receive whole physical cores either way.
     */
    cpuUnit: z.enum(CPU_UNITS).default('logical'),
    timings: z.object({ warmup: duration, duration, cooldown: duration }),
    stability: z
      .object({ stable: z.number().positive().max(1), acceptable: z.number().positive().max(1) })
      .refine((s) => s.stable < s.acceptable, { message: 'stable must be below acceptable' })
      .default({ stable: 0.05, acceptable: 0.1 }),
    loadGenerator: z
      .object({
        ...limits,
        preAllocatedVUs: z.number().int().positive().default(50),
        maxVUs: z.number().int().positive().default(500),
      })
      .default({ cpus: 2, memory: 1024 ** 3, preAllocatedVUs: 50, maxVUs: 500 }),
    variants: z.array(variant).min(1).default([{ name: 'base', env: {} }]),
    scenarios: z.array(scenario).min(1),
    /** Arrival rate (iterations/s) of every scenario at each scale (§3.1). */
    scales: z.record(name, z.record(name, z.number().positive())),
    slo: z
      .object({
        latency_p99_ms: z.number().positive().optional(),
        error_rate: z.number().min(0).max(1).optional(),
        e2e_p99_ms: z.number().positive().optional(),
      })
      .default({}),
    capacity: z
      .object({
        scenario: name,
        start: z.number().positive(),
        factor: z.number().gt(1),
        max: z.number().positive(),
        warmup: duration,
        stepDuration: duration,
      })
      .optional(),
  })
  .superRefine((profile, ctx) => {
    const scenarioNames = new Set(profile.scenarios.map((s) => s.name));
    const variantNames = profile.variants.map((v) => v.name);
    if (new Set(variantNames).size !== variantNames.length) {
      ctx.addIssue({ code: 'custom', message: 'variant names must be unique', path: ['variants'] });
    }
    if (Object.keys(profile.scales).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'define at least one scale', path: ['scales'] });
    }
    for (const [scale, rates] of Object.entries(profile.scales)) {
      for (const scenario of scenarioNames) {
        if (!(scenario in rates)) {
          ctx.addIssue({ code: 'custom', message: `missing rate for scenario "${scenario}"`, path: ['scales', scale] });
        }
      }
      for (const key of Object.keys(rates)) {
        if (!scenarioNames.has(key)) {
          ctx.addIssue({ code: 'custom', message: `unknown scenario "${key}"`, path: ['scales', scale, key] });
        }
      }
    }
    if (profile.capacity && !scenarioNames.has(profile.capacity.scenario)) {
      ctx.addIssue({ code: 'custom', message: `unknown scenario "${profile.capacity.scenario}"`, path: ['capacity', 'scenario'] });
    }
    if (profile.capacity && profile.capacity.max < profile.capacity.start) {
      ctx.addIssue({ code: 'custom', message: 'max must be ≥ start', path: ['capacity', 'max'] });
    }
  });

export const METRIC_SOURCES = ['prometheus', 'k6', 'sink', 'derived'] as const;
export const AGGREGATIONS = ['avg', 'max', 'p95', 'rate', 'delta', 'value'] as const;
export const DIRECTIONS = ['lower', 'higher', 'neutral'] as const;

/** Derived metrics are computed in code from other metrics (§4.5). */
export const DERIVED_METRICS = ['cpu_seconds_per_1k_req', 'sut_memory_peak', 'req_per_core', 'inflight_littles_law'] as const;

export const metricSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    source: z.enum(METRIC_SOURCES),
    query: z.string().min(1),
    unit: z.string().min(1),
    aggregation: z.enum(AGGREGATIONS),
    direction: z.enum(DIRECTIONS),
    scope: z.string().regex(/^(scenario|container|sut|dependency:[a-z0-9_-]+)$/),
    /** Label whose values split the metric into series (e.g. an operation type). */
    by: z.string().optional(),
    /** Longest range selector in the query (e.g. `5s` for `rate(x[5s])`); evaluation starts that long after the window opens (BR-2). */
    range: duration.optional(),
    rationale: z.string().trim().min(10, 'every metric needs a rationale (BR-14)'),
    ref: z.string().regex(/^#[a-z0-9-]+$/, 'methodology anchor, e.g. #metrics-container'),
  })
  .refine((m) => m.source !== 'derived' || (DERIVED_METRICS as readonly string[]).includes(m.id), {
    message: `derived metrics must be one of: ${DERIVED_METRICS.join(', ')}`,
    path: ['id'],
  })
  .superRefine((m, ctx) => {
    if (m.source !== 'prometheus') return;
    const longest = longestRangeMs(m.query);
    if (longest > 0 && (m.range ?? 0) < longest) {
      ctx.addIssue({
        code: 'custom',
        path: ['range'],
        message: `the query looks back ${longest / 1000}s; declare range ≥ ${longest / 1000}s so the look-back never reaches into the warm-up (BR-2)`,
      });
    }
  });

/** Longest range selector of a PromQL query, including subqueries (`[1m:10s]` → 1 m), in ms. */
export function longestRangeMs(query: string): number {
  let longest = 0;
  for (const match of query.matchAll(/\[(\d+(?:ms|s|m|h))(?::[^\]]*)?\]/g)) longest = Math.max(longest, parseDurationMs(match[1]!));
  return longest;
}

export const catalogSchema = z.object({ schemaVersion: z.literal(1), metrics: z.array(metricSchema) });

const pinnedImage = z.string().regex(/^[^\s@]+:[^\s@]+@sha256:[a-f0-9]{64}$/, 'image must be pinned as name:tag@sha256:<digest>');

export const versionsSchema = z.object({
  schemaVersion: z.literal(1),
  images: z.object({
    node: pinnedImage,
    k6: pinnedImage,
    prometheus: pinnedImage,
    cadvisor: pinnedImage,
    mongodbExporter: pinnedImage,
    redisExporter: pinnedImage,
  }),
});

export type Target = z.output<typeof targetSchema>;
export type Profile = z.output<typeof profileSchema>;
export type MetricDef = z.output<typeof metricSchema>;
export type Catalog = z.output<typeof catalogSchema>;
export type Versions = z.output<typeof versionsSchema>;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type CpuUnit = (typeof CPU_UNITS)[number];
