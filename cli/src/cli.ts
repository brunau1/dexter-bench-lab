import { parseArgs } from 'node:util';

const USAGE = `dexter-bench-lab: controlled, reproducible benchmark runs in Docker

Usage: bench <command> [options]

Commands:
  doctor      Probe the host, print its fingerprint, capacity plan and classification
  prepare     Pull and pin every image a run needs (the only step that uses the network)
  run         Run the scenario x scale x repetition matrix against a target
  report      Rebuild summary.json and report.md of a run from its raw data
  compare     Compare two runs (or two variants of one run) with confidence intervals
  calibrate   A/A run that measures the noise floor of this host class

Options:
  -h, --help  Show this help

See docs/methodology.md for the rules every command follows.`;

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: false,
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}
