import type { Profile } from '../config/schema.js';

export interface K6RunInput {
  profile: Pick<Profile, 'timings' | 'loadGenerator'>;
  usecases: string[];
  /** Arrival rate in iterations per second (BR-1). */
  rate: number;
  /** Path of the summary JSON inside the k6 container. */
  summaryPath: string;
  /** Warm-up override, e.g. for capacity steps (BR-17). */
  warmupMs?: number;
  durationMs?: number;
}

/** Environment the kit's k6 helper (core/k6/bench.js) reads to build the open-model scenarios. */
export function k6Env(input: K6RunInput): Record<string, string> {
  const { timings, loadGenerator } = input.profile;
  return {
    BENCH_RATE: String(input.rate),
    BENCH_USECASES: input.usecases.join(','),
    BENCH_WARMUP_MS: String(input.warmupMs ?? timings.warmup),
    BENCH_DURATION_MS: String(input.durationMs ?? timings.duration),
    BENCH_COOLDOWN_MS: String(timings.cooldown),
    BENCH_PRE_VUS: String(loadGenerator.preAllocatedVUs),
    BENCH_MAX_VUS: String(loadGenerator.maxVUs),
    BENCH_SUMMARY_PATH: input.summaryPath,
  };
}
