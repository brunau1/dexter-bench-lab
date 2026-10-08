#!/usr/bin/env node
import { main } from './cli.js';
import { shutdown } from './signals.js';

// The CLI runs as a container process: without handlers, SIGINT/SIGTERM would kill it before the
// run's teardown. The first signal aborts the run (which then cleans up); a second one exits at once.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shutdown.signal.aborted) process.exit(130);
    process.stderr.write(`\n${signal}: stopping after cleanup (send again to exit immediately)\n`);
    shutdown.abort();
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
