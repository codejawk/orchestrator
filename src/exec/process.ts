import { spawn, type SpawnOptions } from 'node:child_process';

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the binary could not be spawned at all (ENOENT and friends). */
  spawnError?: string;
}

export interface CaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to stdin then closed. Claude accepts piped input up to 10MB. */
  stdin?: string;
  signal?: AbortSignal;
  /** Called with each stdout chunk, for streaming and early abort. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawns a CLI and captures its output.
 *
 * Never rejects on a non-zero exit — a failed model run is data the caller
 * needs to record and account for, not an exception to unwind through. Only
 * genuine programming errors throw.
 */
export function capture(
  bin: string,
  args: string[],
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const { cwd, env, timeoutMs, stdin, signal, onStdout, onStderr } = options;
  const started = Date.now();

  return new Promise((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Never use a shell: subtask goals are model-authored text and must not
      // reach a shell parser under any circumstances.
      shell: false,
    };

    let child;
    try {
      child = spawn(bin, args, spawnOptions);
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // SIGTERM lets Claude Code run SessionEnd hooks and exit cleanly.
          // Escalate only if it is still alive after a grace period.
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
        }, timeoutMs)
      : undefined;

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal: sig,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, sig) => finish(code, sig));

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      // Claude Code warns and continues when stdin is unreadable, but closing
      // it explicitly keeps the run from waiting on a terminal that is not there.
      child.stdin?.end();
    }
  });
}
