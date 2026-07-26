/**
 * Whether `claude --bare` can be used, given the available credentials.
 *
 * Kept vscode-free so it is testable outside the extension host — the logic is
 * pure and the auth rule it encodes is easy to get subtly wrong.
 *
 * `--bare` skips OAuth and keychain reads, so it only works with an API-key-style
 * credential. A plain Claude Pro/Max subscription login is NOT one, so "auto"
 * turns bare off unless a real key/token is present — otherwise the CLI fails to
 * authenticate and it looks like a bug in this extension.
 */

export type BareMode = 'auto' | 'on' | 'off';

export function resolveBare(mode: BareMode, env: NodeJS.ProcessEnv): boolean {
  if (mode !== 'auto') {
    return mode === 'on';
  }
  return Boolean(
    env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.CLAUDE_CODE_USE_BEDROCK ||
      env.CLAUDE_CODE_USE_VERTEX ||
      env.CLAUDE_CODE_USE_FOUNDRY,
  );
}
