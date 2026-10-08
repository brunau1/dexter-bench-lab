import { loadProfile, loadTarget } from '../config/load.js';
import { DockerCli, type DockerRunner } from '../docker/runner.js';
import { evaluateHost, formatDoctorReport, type DoctorReport } from '../host/classify.js';
import { benchServices } from '../host/demand.js';
import { probeHost, realHostFiles, type HostFiles } from '../host/probe.js';

export interface DoctorOptions {
  target?: string;
  profile?: string;
}

export async function runDoctor(options: DoctorOptions, runner: DockerRunner = new DockerCli(), files: HostFiles = realHostFiles): Promise<DoctorReport> {
  if ((options.target === undefined) !== (options.profile === undefined)) {
    throw new Error('pass both --target and --profile to plan capacity, or neither');
  }
  const profile = options.profile ? loadProfile(options.profile) : undefined;
  const services = options.target && profile ? benchServices(loadTarget(options.target), profile) : undefined;
  return evaluateHost(await probeHost(runner, files), services, profile?.cpuUnit);
}

export async function doctorCommand(options: DoctorOptions & { json?: boolean }): Promise<number> {
  const report = await runDoctor(options);
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`);
  return 0;
}
