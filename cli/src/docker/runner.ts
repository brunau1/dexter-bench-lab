import { spawn } from 'node:child_process';
import { InterruptedError } from '../signals.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the kit does to Docker goes through this interface, so it can be faked in tests. */
export interface RunOptions {
  input?: string;
  env?: Record<string, string>;
  inheritOutput?: boolean;
  /** Kills the docker process when aborted (run interruption). */
  signal?: AbortSignal;
}

export interface DockerRunner {
  run(args: string[], options?: RunOptions): Promise<CommandResult>;
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
  run(args: string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        env: { ...process.env, ...options.env },
        ...(options.signal ? { signal: options.signal, killSignal: 'SIGTERM' as const } : {}),
        stdio: [options.input === undefined ? 'ignore' : 'pipe', options.inheritOutput ? 'inherit' : 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (options.inheritOutput) process.stderr.write(chunk);
      });
      child.on('error', (error) => reject(error.name === 'AbortError' ? new InterruptedError() : error));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

/** A runner that stops every command when the signal aborts, and refuses to start new ones. */
export function interruptible(runner: DockerRunner, signal: AbortSignal | undefined): DockerRunner {
  if (!signal) return runner;
  return {
    run: async (args, options) => {
      if (signal.aborted) throw new InterruptedError();
      const result = await runner.run(args, { ...options, signal });
      if (signal.aborted) throw new InterruptedError();
      return result;
    },
  };
}

/** Runs a docker command and throws a DockerCommandError when it fails. */
export async function docker(runner: DockerRunner, args: string[], options?: Parameters<DockerRunner['run']>[1]): Promise<string> {
  const result = await runner.run(args, options);
  if (result.code !== 0) throw new DockerCommandError(args, result);
  return result.stdout;
}
