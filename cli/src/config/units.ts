const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const DURATION_FACTOR_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Parses a duration such as `30s`, `2m` or `500ms` into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}" (expected e.g. 500ms, 30s, 2m, 1h)`);
  const [, amount, unit] = match as unknown as [string, string, keyof typeof DURATION_FACTOR_MS];
  return Math.round(Number(amount) * DURATION_FACTOR_MS[unit]);
}

const MEMORY = /^(\d+(?:\.\d+)?)([kmg]?)i?b?$/i;
const MEMORY_FACTOR = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;

/** Parses a Docker-style memory size such as `512m`, `1g` or `1.5GiB` into bytes. */
export function parseMemoryBytes(value: string): number {
  const match = MEMORY.exec(value.trim());
  if (!match) throw new Error(`invalid memory size "${value}" (expected e.g. 256m, 1g)`);
  const [, amount, unit] = match as unknown as [string, string, string];
  return Math.round(Number(amount) * MEMORY_FACTOR[unit.toLowerCase() as keyof typeof MEMORY_FACTOR]);
}
