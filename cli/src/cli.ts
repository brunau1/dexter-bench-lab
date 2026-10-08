import { parseArgs } from 'node:util';
import { doctorCommand } from './commands/doctor.js';
import { calibrateCommand } from './commands/calibrate.js';
import { compareCommand } from './commands/compare.js';
import { prepareCommand } from './commands/prepare.js';
import { reportCommand } from './commands/report.js';
import { runCommand } from './commands/run.js';
import { CompareRefusedError } from './compare/compare.js';
import { ConfigError } from './config/load.js';
import { IncompleteRunError } from './run/manifest.js';

const USAGE = `dexter-bench-lab: controlled, reproducible benchmark runs in Docker

Usage: bench <command> [options]
       bench report <results/run-id>
       bench compare <runA>[:variant] <runB>[:variant]

Commands:
  doctor      Probe the host, print its fingerprint, capacity plan and classification
  prepare     Pull and pin every image a run needs (the only step that uses the network)
  run         Run the scenario x scale x repetition matrix against a target
  report      Rebuild summary.json and report.md of a run from its raw data
  compare     Compare two runs (or two variants of one run) with confidence intervals
  calibrate   A/A run that measures the noise floor of this host class

Options:
  --target <file>   target.yaml of the system under test
  --profile <file>  profile.yaml with scenarios, scales and timings
  --out <dir>       Results directory (run; default ./results)
  --capacity        Capacity search instead of the scale matrix (run)
  --raw-samples     Keep every request of k6 as an audit artifact (run)
  --json            Machine-readable output (doctor)
  --allow-cross-host  Show numbers across host classes, without verdicts (compare)
  --force-verdicts  Draw verdicts on smoke-only runs, labelled; for testing the kit only (compare)
  --calibration-dir <dir>  Noise-floor calibrations (compare, calibrate; default ./calibration)
  -h, --help        Show this help

See docs/methodology.md for the rules every command follows.`;

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      target: { type: 'string' },
      profile: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
      capacity: { type: 'boolean' },
      'raw-samples': { type: 'boolean' },
      'allow-cross-host': { type: 'boolean' },
      'force-verdicts': { type: 'boolean' },
      'calibration-dir': { type: 'string' },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    switch (command) {
      case 'doctor':
        return await doctorCommand(values);
      case 'prepare':
        return await prepareCommand(values);
      case 'run':
        return await runCommand(values);
      case 'report':
        return await reportCommand(positionals);
      case 'compare':
        return await compareCommand(positionals, values);
      case 'calibrate':
        return await calibrateCommand(values);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CompareRefusedError || error instanceof IncompleteRunError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
