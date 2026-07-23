/**
 * Token estimation for planning.
 *
 * This is a heuristic, not a tokenizer. It exists so the plan panel can show
 * "this subtask costs roughly N tokens" before anything runs. Every number in
 * the savings report comes from provider-reported usage instead — estimates
 * never feed the accounting, only the forecast.
 *
 * Code tokenizes denser than prose because identifiers, punctuation and
 * indentation fragment more, so the two are estimated separately.
 */

const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 3.2;

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'c', 'h',
  'cc', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm', 'scala',
  'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'toml', 'xml', 'gradle',
  'dts', 'dtsi', 'S', 'asm', 'mk', 'cmake',
]);

export function isCodePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? CODE_EXTENSIONS.has(ext) : false;
}

export function estimateTokens(text: string, kind: 'code' | 'prose' = 'prose'): number {
  if (!text) {
    return 0;
  }
  const divisor = kind === 'code' ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / divisor);
}

export function estimateFileTokens(path: string, text: string): number {
  return estimateTokens(text, isCodePath(path) ? 'code' : 'prose');
}

/** Rough JSON-schema overhead, which is charged on every request that sends one. */
export function estimateSchemaTokens(schema: object): number {
  return estimateTokens(JSON.stringify(schema), 'code');
}

export function formatTokens(count: number): string {
  if (count < 1_000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) {
    return '$0.00';
  }
  if (Math.abs(usd) < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}
