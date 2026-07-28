import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meterCodexJsonl, toCostRecord } from '../../accounting/meter.ts';
import type { PriceTable } from '../../accounting/pricing.ts';
import { extractJson } from '../../planner/gauss.ts';
import { capture } from '../process.ts';
import { failure } from './claude.ts';
import { probeCli } from './probe.ts';
import type { ModelAdapter, ProbeResult, RunRequest, RunResult } from './types.ts';

/**
 * Codex CLI adapter.
 *
 * Two known upstream problems shape this implementation:
 *
 *   - `--json` can be silently ignored when tools or MCP servers are active
 *     (openai/codex#15451), so `-o <file>` is treated as the primary way to get
 *     the answer and the JSONL stream is only used for token accounting.
 *   - `--output-schema` has been reported to apply beyond the final message
 *     (openai/codex#19816), so the payload is validated on our side rather than
 *     trusted.
 *
 * Codex also has no equivalent of `claude --bare` or `--system-prompt`, so it
 * carries its own agent preamble on every call. That makes it a worse choice
 * for cheap-tier subtasks than the router's ordering already reflects.
 */
export class CodexAdapter implements ModelAdapter {
  readonly id = 'codex' as const;

  private readonly bin: string;
  private readonly prices: PriceTable;

  constructor(bin: string, prices: PriceTable) {
    this.bin = bin;
    this.prices = prices;
  }

  probe(): Promise<ProbeResult> {
    return probeCli('codex', this.bin);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const { subtask, output } = request;
    const warnings: string[] = [];
    const workDir = await mkdtemp(join(tmpdir(), 'orchestrator-codex-'));
    const lastMessagePath = join(workDir, 'last-message.txt');

    try {
      const args = [
        'exec',
        '--json',
        // Only pass --model for a concrete model. A ChatGPT-subscription Codex
        // account rejects model names like "gpt-5" and uses its own default
        // (e.g. gpt-5.5); the sentinel "default" (or empty) means "let Codex
        // choose", which is what makes a personal account work. Enterprise
        // API-key accounts can still name a specific model.
        ...(subtask.model && subtask.model !== 'default' ? ['--model', subtask.model] : []),
        // read-only is the tightest sandbox Codex offers. Unlike Claude it
        // cannot be denied tools entirely, so it may still read files we did
        // not select — acceptable only because routing guarantees every file in
        // this workspace slice was approved for external use.
        '--sandbox',
        'read-only',
        '--cd',
        request.cwd,
        '--skip-git-repo-check',
        '--output-last-message',
        lastMessagePath,
      ];

      if (output.schema) {
        const schemaPath = join(workDir, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(output.schema), 'utf8');
        args.push('--output-schema', schemaPath);
      }

      // Prompt over stdin: `-` tells codex exec to read the instruction there.
      args.push('-');

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

      const meter = meterCodexJsonl(result.stdout);
      warnings.push(...meter.warnings);

      const text = await readLastMessage(lastMessagePath, result.stdout);
      let structured: unknown;
      if (output.schema) {
        const parsed = extractJson<unknown>(text);
        if (parsed.ok) {
          structured = parsed.value;
        } else {
          warnings.push('Requested a schema but Codex did not return parseable JSON (see openai/codex#15451).');
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
        ...(meter.sessionId ? { sessionId: meter.sessionId } : {}),
        warnings,
        ...(ok ? {} : {
          error: result.stderr.slice(0, 1_000) || `exited with code ${result.code}`,
          failureKind: (result.timedOut ? 'infra' : 'model') as 'infra' | 'model',
        }),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Prefers the `-o` file over the event stream. When `--json` is honoured the
 * two agree; when it is not, only the file has the answer.
 */
async function readLastMessage(path: string, stdout: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path, 'utf8');
    if (text.trim()) {
      return text;
    }
  } catch {
    // File absent means the run failed before producing a message.
  }

  for (const line of stdout.split('\n').reverse()) {
    const parsed = extractJson<{ type?: string; item?: { text?: string } }>(line);
    if (parsed.ok && parsed.value.item?.text) {
      return parsed.value.item.text;
    }
  }
  return stdout;
}
