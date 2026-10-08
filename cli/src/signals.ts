/** Aborted on SIGINT/SIGTERM so a run stops at the next step and still tears everything down. */
export const shutdown = new AbortController();

export class InterruptedError extends Error {
  override readonly name = 'InterruptedError';
  constructor() {
    super('interrupted');
  }
}

export function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InterruptedError();
}
