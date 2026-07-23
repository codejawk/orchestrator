import { meterGeminiJson, toCostRecord } from '../../accounting/meter.ts';
import type { PriceTable } from '../../accounting/pricing.ts';
import { extractJson } from '../../planner/gauss.ts';
import { capture } from '../process.ts';
import { failure } from './claude.ts';
import { probeCli } from './probe.ts';
import type { ModelAdapter, ProbeResult, RunRequest, RunResult } from './types.ts';

/**
 * Gemini CLI adapter.
 *
 * `--approval-mode plan` is the read-only mode, which is what keeps this call
 * non-agentic. Gemini has no schema flag, so the output contract has to go in
 * the prompt and be validated here — noticeably less reliable than Claude's
 * `--json-schema`, which is why the router prefers Claude for schema-bearing
 * subtask kinds.
 */
export class GeminiAdapter implements ModelAdapter {
  readonly id = 'gemini' as const;

  private readonly bin: string;
  private readonly prices: PriceTable;

  constructor(bin: string, prices: PriceTable) {
    this.bin = bin;
    this.prices = prices;
  }

  probe(): Promise<ProbeResult> {
    return probeCli('gemini', this.bin);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const { subtask, output } = request;
    const warnings: string[] = [];

    const args = [
      '--model',
      subtask.model,
      '--output-format',
      'json',
      // Read-only. Gemini cannot be denied tools outright, so this is the
      // tightest available equivalent.
      '--approval-mode',
      'plan',
    ];

    let prompt = request.prompt;
    if (output.schema) {
      // No native structured output: the contract goes in the prompt.
      prompt = [
        prompt,
        '',
        'Reply with a single JSON object matching this schema. No prose, no markdown fences.',
        JSON.stringify(output.schema),
      ].join('\n');
    }
    if (request.systemPrompt) {
      prompt = `${request.systemPrompt}\n\n${prompt}`;
    }

    // -p appends to stdin, so the bulk goes over stdin and -p carries only the
    // trigger. Keeps argv well clear of ARG_MAX.
    args.push('--prompt', 'Follow the instructions provided above.');

    const result = await capture(this.bin, args, {
      cwd: request.cwd,
      stdin: prompt,
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

    const meter = meterGeminiJson(result.stdout);
    warnings.push(...meter.warnings);

    const text = meter.text ?? result.stdout;
    let structured: unknown;
    if (output.schema) {
      const parsed = extractJson<unknown>(text);
      if (parsed.ok) {
        structured = parsed.value;
      } else {
        warnings.push('Requested a schema but Gemini did not return parseable JSON.');
      }
    }

    const cost = toCostRecord({
      adapter: this.id,
      requestedModel: subtask.model,
      meter,
      durationMs: result.durationMs,
      prices: this.prices,
    });

    const ok = result.code === 0 && !result.timedOut;
    return {
      ok,
      text,
      ...(structured !== undefined ? { structured } : {}),
      cost,
      warnings,
      ...(ok ? {} : {
        error: result.stderr.slice(0, 1_000) || `exited with code ${result.code}`,
        // A timeout is an availability failure and trips the breaker; a
        // non-zero exit is the model or CLI rejecting the work, which does not.
        failureKind: (result.timedOut ? 'infra' : 'model') as 'infra' | 'model',
      }),
    };
  }
}
