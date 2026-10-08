import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the kit does to Docker goes through this interface, so it can be faked in tests. */
export interface DockerRunner {
  run(args: string[], options?: { input?: string; env?: Record<string, string>; inheritOutput?: boolean }): Promise<CommandResult>;
}

export class DockerCommandError extends Error {
  override readonly name = 'DockerCommandError';
  constructor(
    readonly args: string[],
    readonly result: CommandResult,
  ) {
    super(`docker ${args.join(' ')} exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Runs the real `docker` binary. Output is buffered unless inheritOutput streams it to the user. */
export class DockerCli implements DockerRunner {
  run(args: string[], options: { input?: string; env?: Record<string, string>; inheritOutput?: boolean } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        env: { ...process.env, ...options.env },
        stdio: [options.input === undefined ? 'ignore' : 'pipe', options.inheritOutput ? 'inherit' : 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (options.inheritOutput) process.stderr.write(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

/** Runs a docker command and throws a DockerCommandError when it fails. */
export async function docker(runner: DockerRunner, args: string[], options?: Parameters<DockerRunner['run']>[1]): Promise<string> {
  const result = await runner.run(args, options);
  if (result.code !== 0) throw new DockerCommandError(args, result);
  return result.stdout;
}
