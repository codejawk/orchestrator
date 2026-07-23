import { ZERO_USAGE, type AdapterId, type CostRecord, type Usage } from '../types/ir.ts';
import type { PriceTable } from './pricing.ts';

/**
 * Normalizes token usage out of three CLIs that each report it differently.
 *
 * Every parser here is deliberately tolerant: CLI output shapes drift between
 * versions, and a savings report that crashes is worse than one that reports a
 * gap. On unrecognized shapes we return zero usage plus a warning, and the
 * report surfaces the warning rather than silently under-counting.
 */

export interface MeterResult {
  usage: Usage;
  /** Provider-reported cost, when the CLI gives one. Claude does. */
  reportedUsd?: number;
  /** Model the provider says it actually used, which can differ from request. */
  model?: string;
  sessionId?: string;
  /** Final assistant text, where the shape carries it. */
  text?: string;
  warnings: string[];
}

function emptyResult(): MeterResult {
  return { usage: { ...ZERO_USAGE }, warnings: [] };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export function sumUsage(usages: Usage[]): Usage {
  return usages.reduce(addUsage, { ...ZERO_USAGE });
}

export function totalTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cachedInputTokens +
    usage.cacheCreationTokens
  );
}

/**
 * Reads a usage object using whichever key spelling is present. Anthropic uses
 * `cache_read_input_tokens`, Codex uses `cached_input_tokens`, and both have
 * appeared camelCased in SDK surfaces.
 */
function readUsageObject(raw: unknown): Usage {
  if (!isRecord(raw)) {
    return { ...ZERO_USAGE };
  }
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      if (key in raw) {
        return num(raw[key]);
      }
    }
    return 0;
  };
  return {
    inputTokens: pick('input_tokens', 'inputTokens', 'prompt_tokens'),
    outputTokens: pick('output_tokens', 'outputTokens', 'completion_tokens'),
    cachedInputTokens: pick(
      'cache_read_input_tokens',
      'cached_input_tokens',
      'cacheReadInputTokens',
      'cachedInputTokens',
    ),
    cacheCreationTokens: pick(
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
    ),
  };
}

/**
 * `claude -p --output-format json` emits a single result object carrying
 * `usage`, `total_cost_usd`, `session_id` and `num_turns`.
 */
export function meterClaudeJson(stdout: string): MeterResult {
  const result = emptyResult();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    result.warnings.push('claude: stdout was not valid JSON');
    return result;
  }
  if (!isRecord(parsed)) {
    result.warnings.push('claude: unexpected JSON root');
    return result;
  }

  result.usage = readUsageObject(parsed.usage);
  if (typeof parsed.total_cost_usd === 'number') {
    result.reportedUsd = parsed.total_cost_usd;
  }
  if (typeof parsed.session_id === 'string') {
    result.sessionId = parsed.session_id;
  }
  if (typeof parsed.result === 'string') {
    result.text = parsed.result;
  }

  // `modelUsage` breaks cost down per model when a run spanned several.
  // Prefer it for the model label; the top-level object does not carry one.
  if (isRecord(parsed.modelUsage)) {
    const models = Object.keys(parsed.modelUsage);
    if (models[0]) {
      result.model = models[0];
    }
  }

  if (totalTokens(result.usage) === 0 && result.reportedUsd === undefined) {
    result.warnings.push('claude: no usage or cost in result object');
  }
  return result;
}

/**
 * `codex exec --json` emits JSONL. Token usage rides on `turn.completed`.
 * A run can span several turns, so usage accumulates across all of them.
 */
export function meterCodexJsonl(stdout: string): MeterResult {
  const result = emptyResult();
  let sawTurn = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Codex interleaves progress on stderr, but a malformed stdout line is
      // still possible. Skip rather than abandon the whole stream.
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === 'turn.completed' || event.type === 'turn_completed') {
      sawTurn = true;
      result.usage = addUsage(result.usage, readUsageObject(event.usage));
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      result.sessionId = event.thread_id;
    }
  }

  if (!sawTurn) {
    // Known upstream issue: --json can be silently ignored when MCP servers or
    // tools are active (openai/codex#15451). The adapter falls back to reading
    // the -o file, but usage is genuinely unavailable in that case.
    result.warnings.push(
      'codex: no turn.completed event found; usage unavailable for this run',
    );
  }
  return result;
}

/**
 * `gemini -p -o json`. The exact envelope is not pinned in published docs the
 * way the other two are, so this walks the object looking for a usage-shaped
 * node rather than asserting a path. Revisit once the shape is confirmed
 * against the installed CLI version.
 */
export function meterGeminiJson(stdout: string): MeterResult {
  const result = emptyResult();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    result.warnings.push('gemini: stdout was not valid JSON');
    return result;
  }

  const found = findUsageNode(parsed);
  if (found) {
    result.usage = found;
  } else {
    result.warnings.push('gemini: no usage node found in JSON output');
  }

  if (isRecord(parsed) && typeof parsed.response === 'string') {
    result.text = parsed.response;
  }
  return result;
}

/** Depth-first search for the first node carrying token-count keys. */
function findUsageNode(node: unknown, depth = 0): Usage | undefined {
  if (depth > 6 || !isRecord(node)) {
    return undefined;
  }
  const keys = Object.keys(node);
  const looksLikeUsage = keys.some((k) =>
    /^(input|output|prompt|completion|cached_input|total)_?tokens$/i.test(k),
  );
  if (looksLikeUsage) {
    const usage = readUsageObject(node);
    if (totalTokens(usage) > 0) {
      return usage;
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = findUsageNode(item, depth + 1);
        if (hit) {
          return hit;
        }
      }
    } else {
      const hit = findUsageNode(value, depth + 1);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/** OpenAI-compatible `usage` block, used by the Gauss client. */
export function meterOpenAiCompatible(body: unknown): MeterResult {
  const result = emptyResult();
  if (!isRecord(body)) {
    result.warnings.push('gauss: unexpected response body');
    return result;
  }
  result.usage = readUsageObject(body.usage);
  if (typeof body.model === 'string') {
    result.model = body.model;
  }
  return result;
}

export function meterByAdapter(adapter: AdapterId, stdout: string): MeterResult {
  switch (adapter) {
    case 'claude':
      return meterClaudeJson(stdout);
    case 'codex':
      return meterCodexJsonl(stdout);
    case 'gemini':
      return meterGeminiJson(stdout);
    case 'gauss':
      try {
        return meterOpenAiCompatible(JSON.parse(stdout));
      } catch {
        const r = emptyResult();
        r.warnings.push('gauss: stdout was not valid JSON');
        return r;
      }
  }
}

/**
 * Builds the cost record for one call. Provider-reported cost always wins over
 * a price-table derivation, and the record says which one it used so a stale
 * table is visible in the report rather than quietly wrong.
 */
export function toCostRecord(args: {
  adapter: AdapterId;
  requestedModel: string;
  meter: MeterResult;
  durationMs: number;
  prices: PriceTable;
}): CostRecord {
  const { adapter, requestedModel, meter, durationMs, prices } = args;
  const model = meter.model ?? requestedModel;
  const reported = meter.reportedUsd;
  return {
    adapter,
    model,
    usage: meter.usage,
    usd: reported ?? prices.cost(model, meter.usage),
    usdReported: reported !== undefined,
    durationMs,
  };
}
