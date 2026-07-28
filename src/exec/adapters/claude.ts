import { meterClaudeJson, toCostRecord } from '../../accounting/meter.ts';
import type { PriceTable } from '../../accounting/pricing.ts';
import { extractJson } from '../../planner/gauss.ts';
import { capture } from '../process.ts';
import { probeCli } from './probe.ts';
import type { ModelAdapter, ProbeResult, RunRequest, RunResult } from './types.ts';

/**
 * Claude Code adapter.
 *
 * Runs `claude -p` as a one-shot, non-agentic call. Four flags do the work:
 *
 *   --bare              skips CLAUDE.md, hooks, plugins and MCP discovery,
 *                       which is thousands of input tokens on every call
 *   --system-prompt     replaces Claude Code's agent system prompt entirely
 *   --max-turns 1       no agentic loop: one request, one answer
 *   --disallowedTools   the agent cannot read anything we did not give it
 *
 * That last one is the security control, not just an optimization. Context is
 * inlined into the prompt from files the user approved. If the CLI could read
 * the filesystem itself it could pull in a file the scan marked Gauss-only, and
 * the approval gate would be decorative. We deliberately do NOT pass --add-dir
 * for the same reason.
 */
export class ClaudeAdapter implements ModelAdapter {
  readonly id = 'claude' as const;

  private readonly bin: string;
  private readonly prices: PriceTable;
  /**
   * Whether to pass `--bare`. It saves tokens (skips CLAUDE.md/hooks/MCP) but
   * requires an API-key-style credential — a plain Pro/Max subscription login
   * cannot use it. Defaults to true; the pipeline turns it off for subscription
   * auth so a developer's own Claude account works through this tool.
   */
  private readonly useBare: boolean;

  constructor(bin: string, prices: PriceTable, useBare = true) {
    this.bin = bin;
    this.prices = prices;
    this.useBare = useBare;
  }

  probe(): Promise<ProbeResult> {
    return probeCli('claude', this.bin);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const { subtask, output } = request;
    const warnings: string[] = [];

    const args = [
      '--print',
      ...(this.useBare ? ['--bare'] : []),
      '--model',
      subtask.model,
      '--output-format',
      'json',
      // A few turns, not one. Structured output (--json-schema) is delivered via
      // an internal tool call, which needs a second turn — capping at 1 makes
      // schema requests fail with error_max_turns. All real tools are disallowed
      // below, so extra turns cannot cause agentic behaviour, only let the
      // response complete.
      '--max-turns',
      '8',
      '--permission-mode',
      'dontAsk',
      '--disallowedTools',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
    ];

    if (request.systemPrompt) {
      args.push('--system-prompt', request.systemPrompt);
    }
    if (output.schema) {
      args.push('--json-schema', JSON.stringify(output.schema));
    }
    if (request.resumeSessionId) {
      // Resuming keeps the provider prompt cache warm across sequential
      // subtasks, which is worth far more than the session itself.
      args.push('--resume', request.resumeSessionId);
    }

    // The prompt goes over stdin, not argv: context routinely exceeds ARG_MAX,
    // and Claude Code accepts piped stdin up to 10MB.
    const result = await capture(this.bin, args, {
      cwd: request.cwd,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      ...(request.env ? { env: request.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onChunk ? { onStdout: request.onChunk } : {}),
    });

    if (result.spawnError) {
      return failure(this.id, subtask.model, `could not run ${this.bin}: ${result.spawnError}`, result.durationMs, this.prices);
    }
    if (result.timedOut) {
      warnings.push(`Timed out after ${request.timeoutMs}ms.`);
    }

    const meter = meterClaudeJson(result.stdout);
    warnings.push(...meter.warnings);

    const cost = toCostRecord({
      adapter: this.id,
      requestedModel: subtask.model,
      meter,
      durationMs: result.durationMs,
      prices: this.prices,
    });

    const text = meter.text ?? result.stdout;
    let structured: unknown;
    if (output.schema) {
      // --json-schema puts the payload in `structured_output`; fall back to
      // parsing the text for CLI versions that place it elsewhere.
      const envelope = extractJson<{ structured_output?: unknown }>(result.stdout);
      if (envelope.ok && envelope.value.structured_output !== undefined) {
        structured = envelope.value.structured_output;
      } else {
        const parsed = extractJson<unknown>(text);
        if (parsed.ok) {
          structured = parsed.value;
        } else {
          warnings.push('Requested a schema but could not parse structured output.');
        }
      }
    }

    const ok = result.code === 0 && !result.timedOut;
    // On failure, surface whatever Claude actually said. The real error is often
    // in stdout (an is_error JSON with a message), not stderr — reporting only
    // "exited with code N" hides it.
    const errorDetail =
      extractClaudeError(result.stdout) ||
      result.stderr.slice(0, 1_000) ||
      result.stdout.slice(0, 1_000) ||
      `exited with code ${result.code}`;
    return {
      ok,
      text,
      ...(structured !== undefined ? { structured } : {}),
      cost,
      ...(meter.sessionId ? { sessionId: meter.sessionId } : {}),
      warnings,
      ...(ok ? {} : {
        error: errorDetail,
        // A timeout is an availability failure and trips the breaker; a
        // non-zero exit is the model or CLI rejecting the work, which does not.
        failureKind: (result.timedOut ? 'infra' : 'model') as 'infra' | 'model',
      }),
    };
  }
}

/** Pulls a human-readable error out of Claude's JSON result, when present. */
function extractClaudeError(stdout: string): string | undefined {
  const parsed = extractJson<{ is_error?: boolean; subtype?: string; result?: string; error?: string }>(stdout);
  if (parsed.ok && parsed.value.is_error) {
    return parsed.value.error || parsed.value.result || `claude error: ${parsed.value.subtype ?? 'unknown'}`;
  }
  return undefined;
}

export function failure(
  adapter: 'claude' | 'codex' | 'gemini' | 'gauss',
  model: string,
  error: string,
  durationMs: number,
  prices: PriceTable,
): RunResult {
  return {
    ok: false,
    text: '',
    cost: {
      adapter,
      model,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
      usd: prices.cost(model, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 }),
      usdReported: false,
      durationMs,
    },
    warnings: [],
    error,
    // A spawn failure is an availability problem, so it counts toward the breaker.
    failureKind: 'infra',
  };
}
