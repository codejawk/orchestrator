import { spawn } from 'node:child_process';

/**
 * The developer's real login-shell environment.
 *
 * A VS Code window launched from the Dock/Finder inherits a minimal environment
 * — truncated PATH, no shell profile — so a spawned `claude`/`codex` cannot find
 * its binary or its stored login and reports "not logged in" even when you are.
 * We run the login shell once, capture its env between markers, and merge it in.
 */

let cached: Record<string, string> | undefined;
const MARKER = '__ORCH_ENV__';

export async function loginShellEnv(): Promise<Record<string, string>> {
  if (cached) {
    return cached;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const command = `builtin echo ${MARKER}; env; builtin echo ${MARKER}`;
  for (const args of [['-lic', command], ['-lc', command]]) {
    try {
      const out = await run(shell, args);
      const parsed = parse(out);
      if (Object.keys(parsed).length > 0) {
        cached = parsed;
        return cached;
      }
    } catch {
      // try the next form
    }
  }
  cached = {};
  return cached;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function parse(stdout: string): Record<string, string> {
  const start = stdout.indexOf(MARKER);
  const end = stdout.lastIndexOf(MARKER);
  if (start === -1 || end <= start) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of stdout.slice(start + MARKER.length, end).split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = line.slice(eq + 1);
    }
  }
  return env;
}

export async function spawnEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, ...(await loginShellEnv()) };
}
