import { capture } from './process.ts';

/**
 * The developer's real login-shell environment.
 *
 * When VS Code is launched from the Dock or Finder (not from a terminal), the
 * extension host inherits a minimal environment — no `~/.zprofile`, a truncated
 * PATH, and, critically, none of the context the CLIs need to reach their stored
 * credentials. A spawned `claude` then reports "Not logged in" even though the
 * developer is logged in, and `codex`/`gemini` fail to find their binaries or
 * auth. This is the classic "works in the terminal, fails from the app" trap.
 *
 * The fix, used by many editor extensions, is to run the user's login shell
 * once, capture its environment, and merge it into what we spawn. We isolate the
 * real `env` output between markers so shell noise (banners, prompts) cannot
 * corrupt it, and we cache the result for the session.
 */

let cached: Record<string, string> | undefined;

const MARKER = '__ORCH_SHELL_ENV__';

export async function resolveShellEnv(): Promise<Record<string, string>> {
  if (cached) {
    return cached;
  }
  cached = await load();
  return cached;
}

/** Forget the cached environment, e.g. after the user changes their shell rc. */
export function clearShellEnvCache(): void {
  cached = undefined;
}

async function load(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || '/bin/zsh';

  // -lic: a login + interactive shell, so both ~/.zprofile and ~/.zshrc load —
  // credentials helpers are often set up in the interactive rc. stdin is closed
  // by capture(), so an interactive shell still exits rather than hanging.
  const command = `builtin echo ${MARKER}; env; builtin echo ${MARKER}`;

  for (const args of [['-lic', command], ['-lc', command]]) {
    try {
      const result = await capture(shell, args, { timeoutMs: 8_000 });
      const parsed = parse(result.stdout);
      if (Object.keys(parsed).length > 0) {
        return parsed;
      }
    } catch {
      // Try the next form, then give up.
    }
  }
  return {};
}

/** Extracts KEY=VALUE pairs from the marker-delimited env output. */
function parse(stdout: string): Record<string, string> {
  const start = stdout.indexOf(MARKER);
  const end = stdout.lastIndexOf(MARKER);
  if (start === -1 || end <= start) {
    return {};
  }
  const body = stdout.slice(start + MARKER.length, end);
  const env: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue; // blank line, or a continuation of a multi-line value — skip
    }
    const key = line.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = line.slice(eq + 1);
    }
  }
  return env;
}
