import type { Profile } from '../config/schema.js';

export interface Step {
  scenario: string;
  scale: string;
  /** 1-based repetition number. */
  rep: number;
  variant: string;
  /** Arrival rate in iterations per second. */
  rate: number;
}

/**
 * Expands the scenario × scale × repetition × variant matrix. Within each repetition the variant
 * order alternates (AB, BA, AB, …) so linear host drift affects every variant equally (BR-16).
 */
export function buildPlan(profile: Pick<Profile, 'scenarios' | 'scales' | 'repetitions' | 'variants'>): Step[] {
  const steps: Step[] = [];
  const variants = profile.variants.map((v) => v.name);
  for (const scenario of profile.scenarios) {
    for (const [scale, rates] of Object.entries(profile.scales)) {
      for (let rep = 1; rep <= profile.repetitions; rep++) {
        const order = rep % 2 === 1 ? variants : [...variants].reverse();
        for (const variant of order) steps.push({ scenario: scenario.name, scale, rep, variant, rate: rates[scenario.name]! });
      }
    }
  }
  return steps;
}

/** BR-17: geometric capacity steps start · factorⁿ up to max (rates rounded to 0.01 it/s). */
export function capacityRates(capacity: NonNullable<Profile['capacity']>): number[] {
  const rates: number[] = [];
  for (let rate = capacity.start; rate <= capacity.max + 1e-9; rate *= capacity.factor) {
    rates.push(Math.round(rate * 100) / 100);
  }
  return rates;
}

export interface Window {
  /** Unix seconds. */
  start: number;
  end: number;
}

/** BR-2: the measurement window of a repetition, from the measure scenario's real start time. */
export function measurementWindow(measureStartMs: number, durationMs: number): Window {
  return { start: measureStartMs / 1000, end: (measureStartMs + durationMs) / 1000 };
}

/** Directory of one repetition inside the run's raw data. */
export function stepDir(step: Pick<Step, 'scenario' | 'scale' | 'variant' | 'rep'>): string {
  return `raw/${step.scenario}/${step.scale}/${step.variant}/rep-${String(step.rep).padStart(2, '0')}`;
}
