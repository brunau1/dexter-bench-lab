import { kitPath, loadProfile, loadTarget, loadVersions } from '../config/load.js';
import { docker, DockerCli, type DockerRunner } from '../docker/runner.js';
import { exportersFor } from '../metrics/observers.js';
import { sinkImageTag } from '../run/images.js';

export interface PrepareOptions {
  target: string;
  profile: string;
}

/**
 * `bench prepare`: the only step that uses the network (BR-13). Pulls the kit's pinned images and
 * the target's images, builds the target's built services and the callback sink.
 */
export async function runPrepare(options: PrepareOptions, runner: DockerRunner, log: (message: string) => void): Promise<void> {
  const target = loadTarget(options.target);
  const profile = loadProfile(options.profile);
  const versions = loadVersions(kitPath('core', 'versions.yaml'));
  const kitImages = [versions.images.k6, versions.images.prometheus, versions.images.cadvisor, ...new Set(exportersFor(target, versions).map((e) => e.image))];
  for (const image of kitImages) {
    log(`pull ${image}`);
    await docker(runner, ['pull', '--quiet', image]);
  }
  const compose = ['compose', '-p', 'bench-prepare', '--project-directory', target.dir, ...target.composeFiles.flatMap((f) => ['-f', f]), '--profile', '*'];
  for (const variant of profile.variants) {
    log(`target images, variant "${variant.name}"`);
    await docker(runner, [...compose, 'pull', '--ignore-buildable', '--quiet'], { env: variant.env, inheritOutput: true });
    await docker(runner, [...compose, 'build', '--quiet'], { env: variant.env, inheritOutput: true });
  }
  if (profile.scenarios.some((s) => s.callbacks)) {
    const tag = sinkImageTag(versions);
    log(`build ${tag}`);
    await docker(runner, ['build', '--quiet', '--build-arg', `NODE_IMAGE=${versions.images.node}`, '-t', tag, kitPath('core', 'sink')]);
  }
}

export async function prepareCommand(options: Partial<PrepareOptions>): Promise<number> {
  if (!options.target || !options.profile) throw new Error('bench prepare needs --target and --profile');
  await runPrepare(options as PrepareOptions, new DockerCli(), (m) => process.stderr.write(`${m}\n`));
  process.stderr.write('prepare: done; runs will not use the network\n');
  return 0;
}
