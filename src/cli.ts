import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findModel } from './catalog.ts';
import type { Adapter, Effort } from './types.ts';

/**
 * Headless invocation of the Claude and Codex CLIs.
 *
 * Both authenticate themselves from the login the user already has — this
 * extension never touches API keys. The flags here are the ones validated
 * against the real binaries: one-shot, no agentic exploration, tools denied.
 */

export interface CliRun {
  ok: boolean;
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export type CliEvent =
  | { type: 'log'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
}

function capture(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    stdin?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(e), durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: String(e), durationMs: Date.now() - start });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** Pull the first JSON object/array out of a string. */
function extractJson<T>(text: string): T | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const first = trimmed.search(/[{[]/);
  if (first === -1) {
    return undefined;
  }
  for (let end = trimmed.length; end > first; end--) {
    const slice = trimmed.slice(first, end);
    if (slice.endsWith('}') || slice.endsWith(']')) {
      try {
        return JSON.parse(slice) as T;
      } catch {
        /* keep shrinking */
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export async function runClaude(args: {
  bin: string;
  model: string;
  effort?: Effort;
  system?: string;
  prompt: string;
  schema?: object;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: CliEvent) => void;
}): Promise<CliRun> {
  const stream = !args.schema;
  const cli = [
    '--print',
    '--model',
    args.model,
    '--output-format',
    stream ? 'stream-json' : 'json',
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
  if (args.effort) {
    cli.push('--effort', args.effort);
  }
  if (stream) {
    // With --print, --output-format=stream-json requires --verbose. Without it
    // Claude exits immediately with an error and the subtask returns empty.
    cli.push('--verbose', '--include-partial-messages');
  }
  if (args.system) {
    cli.push('--system-prompt', args.system);
  }
  if (args.schema) {
    cli.push('--json-schema', JSON.stringify(args.schema));
  }

  args.onEvent?.({ type: 'log', text: friendlyRun('claude', args.model, args.effort, args.prompt.length) });

  let streamState: ClaudeStreamState | undefined;
  let stderrBuffer = '';
  if (stream) {
    streamState = makeClaudeStreamState(args.onEvent);
  }

  const r = await capture(args.bin, cli, {
    cwd: args.cwd,
    stdin: args.prompt,
    env: args.env,
    timeoutMs: args.timeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(streamState ? { onStdout: (text) => streamState.accept(text) } : {}),
    onStderr: (text) => {
      stderrBuffer = flushTextLines(stderrBuffer + text, (line) => {
        if (!isNoiseLine(line)) {
          args.onEvent?.({ type: 'log', text: line });
        }
      });
    },
  });
  if (streamState) {
    streamState.flush();
  }
  flushTextLines(stderrBuffer + '\n', (line) => { if (!isNoiseLine(line)) args.onEvent?.({ type: 'log', text: line }); });

  if (r.spawnError) {
    return fail(args.model, `could not run ${args.bin}: ${r.spawnError}`);
  }

  if (stream && streamState) {
    const finalText = streamState.finalText.trim() || streamState.accumulatedText.trim() || r.stdout.trim();
    const actualModel = streamState.actualModel || args.model;
    const inputTokens = streamState.inputTokens;
    const outputTokens = streamState.outputTokens;
    if (r.timedOut) {
      return { ok: false, text: '', model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: `timed out after ${args.timeoutMs}ms` };
    }
    if (streamState.error) {
      return { ok: false, text: finalText, model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: streamState.error };
    }
    if (r.code !== 0) {
      return { ok: false, text: finalText, model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: r.stderr.slice(0, 500) || `exited with code ${r.code}` };
    }
    return { ok: true, text: finalText, model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs };
  }

  const json = extractJson<{
    is_error?: boolean;
    result?: string;
    error?: string;
    structured_output?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
    modelUsage?: Record<string, unknown>;
  }>(r.stdout);

  const text = json?.result ?? r.stdout;
  const inputTokens = json?.usage?.input_tokens ?? 0;
  const outputTokens = json?.usage?.output_tokens ?? 0;
  // Claude Code lists an internal helper model (haiku) alongside the model that
  // did the work. Report the one with the most output tokens — the real worker
  // — not simply the first key, which is usually the helper.
  const actualModel = pickWorkerModel(json?.modelUsage, args.model);

  if (r.timedOut) {
    return { ok: false, text: '', model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: `timed out after ${args.timeoutMs}ms` };
  }
  if (json?.is_error) {
    return { ok: false, text: '', model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: json.error || json.result || 'claude reported an error' };
  }
  if (r.code !== 0) {
    return { ok: false, text: '', model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs, error: r.stderr.slice(0, 500) || `exited with code ${r.code}` };
  }

  // For a schema request, prefer the structured payload rendered back to JSON text.
  const finalText = args.schema && json?.structured_output !== undefined ? JSON.stringify(json.structured_output) : text;
  return { ok: true, text: finalText, model: actualModel, inputTokens, outputTokens, durationMs: r.durationMs };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export async function runCodex(args: {
  bin: string;
  model: string;
  effort: Effort;
  prompt: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: CliEvent) => void;
}): Promise<CliRun> {
  const workDir = await mkdtemp(join(tmpdir(), 'orch-mvp-codex-'));
  const lastMsg = join(workDir, 'last.txt');
  const model = args.model;
  try {
    const cli = [
      'exec',
      '--json',
      '--model',
      model,
      '-c',
      `model_reasoning_effort=${args.effort}`,
      '--sandbox',
      'read-only',
      '--cd',
      args.cwd,
      '--skip-git-repo-check',
      '--output-last-message',
      lastMsg,
      '-',
    ];
    args.onEvent?.({ type: 'log', text: friendlyRun('codex', args.model, args.effort, args.prompt.length) });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError: string | undefined;

    const r = await capture(args.bin, cli, {
      cwd: args.cwd,
      stdin: args.prompt,
      env: args.env,
      timeoutMs: args.timeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
      onStdout: (text) => {
        stdoutBuffer = flushTextLines(stdoutBuffer + text, (line) => {
          const evt = extractJson<CodexStreamEvent>(line);
          if (!evt) {
            return;
          }
          const parsed = handleCodexEvent(evt, args.onEvent);
          if (parsed.inputTokens || parsed.outputTokens) {
            inputTokens = parsed.inputTokens;
            outputTokens = parsed.outputTokens;
          }
          if (parsed.error) {
            streamError = parsed.error;
          }
        });
      },
      onStderr: (text) => {
        stderrBuffer = flushTextLines(stderrBuffer + text, (line) => {
          if (!isNoiseLine(line)) {
            args.onEvent?.({ type: 'log', text: line });
          }
        });
      },
    });
    flushTextLines(stdoutBuffer + '\n', (line) => {
      const evt = extractJson<CodexStreamEvent>(line);
      if (!evt) {
        return;
      }
      const parsed = handleCodexEvent(evt, args.onEvent);
      if (parsed.inputTokens || parsed.outputTokens) {
        inputTokens = parsed.inputTokens;
        outputTokens = parsed.outputTokens;
      }
      if (parsed.error) {
        streamError = parsed.error;
      }
    });
    flushTextLines(stderrBuffer + '\n', (line) => { if (!isNoiseLine(line)) args.onEvent?.({ type: 'log', text: line }); });

    if (r.spawnError) {
      return fail(model, `could not run ${args.bin}: ${r.spawnError}`);
    }

    let text = '';
    try {
      text = (await readFile(lastMsg, 'utf8')).trim();
    } catch {
      /* no message file */
    }

    for (const line of r.stdout.split('\n')) {
      const evt = extractJson<{ type?: string; usage?: { input_tokens?: number; output_tokens?: number }; message?: string; error?: { message?: string } }>(line);
      if (!evt) {
        continue;
      }
      if (evt.type === 'turn.completed' && evt.usage) {
        inputTokens = evt.usage.input_tokens ?? 0;
        outputTokens = evt.usage.output_tokens ?? 0;
      }
      // Codex exits 0 even on failure; the real signal is a failure event.
      if (evt.type === 'turn.failed') {
        streamError = unwrap(evt.error?.message) ?? 'codex turn failed';
      } else if (evt.type === 'error') {
        streamError = unwrap(evt.message) ?? 'codex error';
      }
    }

    const displayModel = model === 'default' ? 'codex (account default)' : model;
    if (r.timedOut) {
      return { ok: false, text: '', model: displayModel, inputTokens, outputTokens, durationMs: r.durationMs, error: `timed out after ${args.timeoutMs}ms` };
    }
    if (streamError) {
      return { ok: false, text: '', model: displayModel, inputTokens, outputTokens, durationMs: r.durationMs, error: streamError };
    }
    if (r.code !== 0) {
      return { ok: false, text: '', model: displayModel, inputTokens, outputTokens, durationMs: r.durationMs, error: r.stderr.slice(0, 500) || `exited with code ${r.code}` };
    }
    return { ok: true, text: text || r.stdout, model: displayModel, inputTokens, outputTokens, durationMs: r.durationMs };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function unwrap(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }
  const inner = extractJson<{ error?: { message?: string }; message?: string }>(message);
  return inner?.error?.message || inner?.message || message;
}

interface ClaudeStreamState {
  accept(text: string): void;
  flush(): void;
  finalText: string;
  accumulatedText: string;
  actualModel: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  error?: string;
  is_error?: boolean;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: {
    model?: string;
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
};

type CodexStreamEvent = {
  type?: string;
  delta?: string;
  message?: string;
  text?: string;
  item?: { type?: string; text?: string } | unknown;
  error?: { message?: string } | string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function makeClaudeStreamState(onEvent?: (event: CliEvent) => void): ClaudeStreamState {
  const state: ClaudeStreamState & { buffer: string } = {
    buffer: '',
    finalText: '',
    accumulatedText: '',
    actualModel: '',
    inputTokens: 0,
    outputTokens: 0,
    accept(text: string) {
      state.buffer = flushTextLines(state.buffer + text, (line) => {
        const evt = extractJson<ClaudeStreamEvent>(line);
        if (!evt) {
          return;
        }
        handleClaudeEvent(evt, state, onEvent);
      });
    },
    flush() {
      state.buffer = flushTextLines(state.buffer + '\n', (line) => {
        const evt = extractJson<ClaudeStreamEvent>(line);
        if (evt) {
          handleClaudeEvent(evt, state, onEvent);
        }
      });
    },
  };
  return state;
}

function handleClaudeEvent(
  evt: ClaudeStreamEvent,
  state: ClaudeStreamState,
  onEvent?: (event: CliEvent) => void,
): void {
  if (evt.type === 'system') {
    // Session init/status/thinking chatter is pure noise in the live view.
    return;
  }
  if (evt.type === 'assistant') {
    const text = contentText(evt.message?.content);
    if (text) {
      const delta = text.startsWith(state.accumulatedText) ? text.slice(state.accumulatedText.length) : text;
      state.accumulatedText = text.startsWith(state.accumulatedText) ? text : state.accumulatedText + text;
      if (delta) {
        onEvent?.({ type: 'delta', text: delta });
      }
    }
    state.actualModel = evt.message?.model ?? evt.model ?? state.actualModel;
    // Track usage silently; only the final total is emitted (on 'result').
    const usage = evt.message?.usage;
    if (usage) {
      state.inputTokens = usage.input_tokens ?? state.inputTokens;
      state.outputTokens = usage.output_tokens ?? state.outputTokens;
    }
    return;
  }
  if (evt.type === 'result') {
    state.finalText = evt.result ?? state.finalText;
    state.actualModel = evt.model ?? state.actualModel;
    if (evt.usage) {
      state.inputTokens = evt.usage.input_tokens ?? state.inputTokens;
      state.outputTokens = evt.usage.output_tokens ?? state.outputTokens;
      onEvent?.({ type: 'usage', inputTokens: state.inputTokens, outputTokens: state.outputTokens });
    }
    if (evt.is_error) {
      state.error = evt.error || evt.result || 'claude reported an error';
    }
  }
}

function handleCodexEvent(
  evt: CodexStreamEvent,
  onEvent?: (event: CliEvent) => void,
): { inputTokens: number; outputTokens: number; error?: string } {
  const inputTokens = evt.usage?.input_tokens ?? 0;
  const outputTokens = evt.usage?.output_tokens ?? 0;
  if (evt.usage) {
    onEvent?.({ type: 'usage', inputTokens, outputTokens });
  }

  const delta = codexDelta(evt);
  if (delta) {
    onEvent?.({ type: 'delta', text: delta });
  } else if (evt.type && shouldLogCodexEvent(evt.type)) {
    onEvent?.({ type: 'log', text: `Codex: ${humanizeEventType(evt.type)}` });
  }

  let error: string | undefined;
  if (evt.type === 'turn.failed') {
    error = unwrap(typeof evt.error === 'string' ? evt.error : evt.error?.message) ?? 'codex turn failed';
  } else if (evt.type === 'error') {
    error = unwrap(typeof evt.error === 'string' ? evt.error : evt.error?.message ?? evt.message) ?? 'codex error';
  }
  return { inputTokens, outputTokens, ...(error ? { error } : {}) };
}

function flushTextLines(text: string, onLine: (line: string) => void): string {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      onLine(trimmed);
    }
  }
  return rest;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const raw = part as Record<string, unknown>;
      return typeof raw.text === 'string' ? raw.text : '';
    })
    .join('');
}

function codexDelta(evt: CodexStreamEvent): string {
  if (typeof evt.delta === 'string') {
    return evt.delta;
  }
  // Codex emits the finished message as item.completed { item: { text } } —
  // no token deltas — so surface that whole text as one chunk.
  if (evt.type === 'item.completed' && evt.item && typeof evt.item === 'object') {
    const item = evt.item as { type?: string; text?: string };
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return item.text;
    }
  }
  if (evt.type?.includes('message') && typeof evt.text === 'string') {
    return evt.text;
  }
  if (evt.type?.includes('message') && typeof evt.message === 'string') {
    return evt.message;
  }
  return '';
}

function shouldLogCodexEvent(type: string): boolean {
  // Only surface meaningful activity; turn.started/completed are noise.
  return type.includes('exec') || type.includes('patch') || type === 'turn.failed';
}

/** Known-noise CLI stderr lines that should not reach the live view. */
function isNoiseLine(line: string): boolean {
  return /models cache|base_instructions|codex_models_manager|^\s*$/.test(line);
}

function humanizeEventType(type: string): string {
  return type.replace(/[._-]+/g, ' ');
}

/** The model in `modelUsage` that produced the most output — the real worker. */
function pickWorkerModel(modelUsage: Record<string, unknown> | undefined, requested: string): string {
  if (!modelUsage) {
    return requested;
  }
  let best = requested;
  let bestOut = 0;
  for (const [name, usage] of Object.entries(modelUsage)) {
    const u = usage as { outputTokens?: number; output_tokens?: number } | undefined;
    const out = u?.outputTokens ?? u?.output_tokens ?? 0;
    if (out > bestOut) {
      bestOut = out;
      best = name;
    }
  }
  return best;
}

/**
 * A human-readable "what's running" line, in the spirit of the Claude/Codex
 * apps — the model, its effort, and roughly how much context it was given —
 * instead of the raw flag soup.
 */
function friendlyRun(adapter: Adapter, model: string, effort: Effort | undefined, promptChars: number): string {
  const label = findModel(adapter, model)?.label ?? `${adapter === 'claude' ? 'Claude' : 'Codex'} ${model}`;
  const eff = effort ? ` · ${effort} effort` : '';
  const kb = promptChars >= 1000 ? `${(promptChars / 1000).toFixed(1)}k` : String(promptChars);
  return `▸ ${label}${eff} · ${kb} chars context`;
}

function fail(model: string, error: string): CliRun {
  return { ok: false, text: '', model, inputTokens: 0, outputTokens: 0, durationMs: 0, error };
}
