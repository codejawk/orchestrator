import { runClaude, runCodex } from './cli.ts';
import { clampEffort, nearestOn, findModel } from './catalog.ts';
import { parseFiles } from './artifacts.ts';
import type { Adapter, Plan, Subtask, SubtaskResult } from './types.ts';

/**
 * Runs the plan's subtasks in dependency order — independent ones in parallel —
 * each on the model the router assigned. A subtask receives the outputs of the
 * subtasks it depends on, so later work builds on earlier work.
 */

export interface RunnerContext {
  claudeBin: string;
  codexBin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  /** Stop launching new subtasks once this many total tokens are spent (0 = no cap). */
  maxTokens?: number;
  /** A structure map of the repo, given to reading subtasks so they navigate
   *  without opening every file. */
  codeMap?: string;
  onEvent?: (e: RunnerEvent) => void;
  signal?: AbortSignal;
}

export type RunnerEvent =
  | { type: 'start'; subtask: Subtask }
  | { type: 'log'; subtask: Subtask; text: string }
  | { type: 'delta'; subtask: Subtask; text: string }
  | { type: 'usage'; subtask: Subtask; inputTokens: number; outputTokens: number }
  | { type: 'done'; result: SubtaskResult };

const FILE_SYSTEM = `You are one worker in a pipeline. Produce ONLY the change(s) this subtask must deliver — no preamble, no plan, no restating the task, no explanation outside the blocks.

For a NEW file, output its full contents:
===FILE: <relative/path/with/extension>===
<the complete file contents>
===END FILE===

For a file that ALREADY EXISTS, do NOT reprint it. First READ it with your tools, then emit ONE OR MORE minimal search/replace edits — only the lines that change:
===EDIT: <relative/path>===
<<<<<<< SEARCH
<exact lines copied verbatim from the current file>
=======
<the replacement lines>
>>>>>>> REPLACE
===END EDIT===

Rules:
- Prefer EDIT for any file that exists; use FILE only for brand-new files. This saves large amounts of output.
- The SEARCH text MUST match the current file exactly (whitespace included) and be unique — read the file first, keep SEARCH small but unambiguous. Emit several EDIT blocks for several changes.
- Do NOT wrap contents in triple-backtick fences. Use real filenames/extensions.
- Stay consistent with earlier files (same names, same imports). Output nothing before the first marker or after the last.`;

const PROSE_SYSTEM = `You are one worker in a pipeline. Answer THIS subtask only, clearly and concisely, in Markdown.
- If you need to look at the code, open ONLY the files this subtask is about — do not crawl or read the whole repository (that wastes tokens). Grep for a symbol rather than reading everything.
- Reference real file and symbol names. Quote only short, relevant snippets — do not paste whole files.
- Do NOT use ===FILE:=== markers; this is an explanation/answer, not files to write. No preamble or restating the task — just the answer.`;

const READ_HINT = `\n\nThe files are in the current working directory. A CODE MAP of the repo (file → its classes/functions/signatures) is provided below — use it to understand the structure. Open the FULL text of a file ONLY when you need its implementation detail; do not read files you can already understand from the map, and never crawl the whole tree.`;

/** The code-map block appended to a reading subtask's prompt. */
function codeMapBlock(codeMap: string | undefined): string {
  return codeMap ? `\n\nCODE MAP (structure only — bodies omitted):\n${codeMap}` : '';
}

/**
 * Subtasks on the same Claude model+output share one warm session, so its ~20k
 * preamble is cache-read (~90% cheaper) after the first call and its context
 * carries forward. Codex has no such resume here, so each Codex call is its own
 * key (no pooling). Different pools run in parallel; a pool runs sequentially.
 */
function poolKey(s: Subtask): string {
  return s.adapter === 'claude' ? `claude|${s.model}|${s.output}` : `codex|${s.id}`;
}

interface RunState {
  results: Map<string, SubtaskResult>;
  /** Claude session id per pool, for --resume. */
  sessions: Map<string, string>;
  /** Which pool each finished subtask ran in (so we can skip redundant handoffs). */
  ranInPool: Map<string, string>;
}

export async function executePlan(plan: Plan, ctx: RunnerContext): Promise<SubtaskResult[]> {
  const st: RunState = { results: new Map(), sessions: new Map(), ranInPool: new Map() };
  const waves = topoWaves(plan.subtasks);
  let spent = 0;

  const record = (subtask: Subtask, result: SubtaskResult, key: string): void => {
    st.results.set(subtask.id, result);
    st.ranInPool.set(subtask.id, key);
    ctx.onEvent?.({ type: 'done', result });
  };
  const skip = (subtask: Subtask, error: string): void => {
    ctx.onEvent?.({ type: 'start', subtask });
    record(subtask, { id: subtask.id, ok: false, text: '', adapter: subtask.adapter, model: subtask.model, effort: subtask.effort, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0, usd: 0, error }, poolKey(subtask));
  };

  for (const wave of waves) {
    // Skip anything with a failed dependency up front, then group the rest by
    // pool so same-model subtasks share a session (run sequentially); pools
    // run in parallel.
    const groups = new Map<string, Subtask[]>();
    for (const id of wave) {
      const subtask = plan.subtasks.find((s) => s.id === id)!;
      const failedDep = subtask.dependsOn.find((d) => st.results.get(d) && !st.results.get(d)!.ok);
      if (failedDep) {
        skip(subtask, `skipped — dependency "${failedDep}" failed`);
        continue;
      }
      const key = poolKey(subtask);
      const g = groups.get(key);
      if (g) {
        g.push(subtask);
      } else {
        groups.set(key, [subtask]);
      }
    }

    await Promise.all(
      [...groups.entries()].map(async ([key, subs]) => {
        for (const subtask of subs) {
          if (ctx.maxTokens && spent >= ctx.maxTokens) {
            skip(subtask, `skipped — run token budget (${ctx.maxTokens}) reached`);
            continue;
          }
          ctx.onEvent?.({ type: 'start', subtask });
          const result = await runSubtask(plan, subtask, st, ctx, key);
          spent += result.inputTokens + result.outputTokens;
          record(subtask, result, key);
        }
      }),
    );
  }
  return plan.subtasks.map((s) => st.results.get(s.id)!).filter(Boolean);
}

async function runSubtask(
  plan: Plan,
  subtask: Subtask,
  st: RunState,
  ctx: RunnerContext,
  key: string,
): Promise<SubtaskResult> {
  // A dependency that already ran in THIS pool's session is in the model's
  // context — don't re-send its summary. Only summarise cross-session deps.
  const deps = subtask.dependsOn
    .map((d) => st.results.get(d))
    .filter((r): r is SubtaskResult => Boolean(r && r.ok && st.ranInPool.get(r.id) !== key));

  const depContext =
    deps.length > 0
      ? `\n\nWHAT EARLIER SUBTASKS PRODUCED (summaries — stay consistent with these):\n\n${deps
          .map((d) => `--- ${d.id} ---\n${handoffSummary(d)}`)
          .join('\n\n')}`
      : '';

  const overall = plan.prompt.length > 500 ? `${plan.prompt.slice(0, 500)}…` : plan.prompt;
  const readCtx = subtask.reads ? `${READ_HINT}${codeMapBlock(ctx.codeMap)}` : '';
  const prompt = `OVERALL GOAL (for orientation only): ${overall}\n\nYOUR SUBTASK: ${subtask.title}\n${subtask.goal}${readCtx}${depContext}`;

  // Resume this pool's Claude session if one exists (warm cache + context).
  const resume = subtask.adapter === 'claude' ? st.sessions.get(key) : undefined;
  const first = await runOn(subtask.adapter, subtask.model, subtask.effort, prompt, subtask, ctx, resume);
  if (first.run.adapter === 'claude' && first.sessionId) {
    st.sessions.set(key, first.sessionId);
  }

  // Reactive reroute on a quota/limit failure — runs cold on the other provider.
  if (!first.run.ok && isQuotaError(first.run.error) && !ctx.signal?.aborted) {
    const other: Adapter = subtask.adapter === 'claude' ? 'codex' : 'claude';
    const weight = findModel(subtask.adapter, subtask.model)?.weight ?? 5;
    const target = nearestOn(other, weight);
    const effort = clampEffort(target, subtask.effort);
    ctx.onEvent?.({ type: 'log', subtask, text: `${subtask.adapter}/${subtask.model} hit its usage limit → retrying on ${target.adapter}/${target.id} (${effort})` });
    const retry = await runOn(target.adapter, target.id, effort, prompt, subtask, ctx, undefined);
    return retry.run;
  }
  return first.run;
}

/** Runs one subtask on a specific adapter/model/effort, optionally resuming. */
async function runOn(
  adapter: Adapter,
  model: string,
  effort: Subtask['effort'],
  prompt: string,
  subtask: Subtask,
  ctx: RunnerContext,
  resumeSessionId: string | undefined,
): Promise<{ run: SubtaskResult; sessionId?: string }> {
  const base = { id: subtask.id, adapter, model, effort, usd: 0 };
  const sys = subtask.output === 'prose' ? PROSE_SYSTEM : FILE_SYSTEM;
  const common = {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs: ctx.timeoutMs,
    onEvent: (event: Parameters<typeof forwardCliEvent>[0]) => forwardCliEvent(event, subtask, ctx),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  const r =
    adapter === 'codex'
      ? // Codex has no system-prompt flag, so the instructions ride in the prompt.
        await runCodex({ bin: ctx.codexBin, model, effort, prompt: `${sys}\n\n${prompt}`, ...common })
      : // File subtasks also get read access so they can inspect an existing
        // file and emit a diff instead of rewriting it.
        await runClaude({ bin: ctx.claudeBin, model, effort, system: sys, prompt, allowRead: subtask.reads || subtask.output === 'files', ...(resumeSessionId ? { resumeSessionId } : {}), ...common });
  const run: SubtaskResult = { ...base, model: r.model, ok: r.ok, text: r.text, inputTokens: r.inputTokens, cachedInputTokens: r.cachedInputTokens ?? 0, outputTokens: r.outputTokens, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) };
  return { run, ...(r.sessionId ? { sessionId: r.sessionId } : {}) };
}

/**
 * A compact summary of a dependency's output for the next subtask: for file
 * output, the filenames plus their declaration lines (the API a dependent needs
 * — e.g. to write tests against it); for prose, a short excerpt.
 */
export function handoffSummary(result: SubtaskResult): string {
  const files = parseFiles(result.text);
  if (files.length > 0) {
    return files
      .map((f) => {
        const sigs = f.contents
          .split('\n')
          .filter((l) => /^\s*(export |def |class |func |function |public |private |protected |interface |type \w|const \w+\s*=|async def )/.test(l))
          .map((l) => l.trim())
          .slice(0, 40);
        const body = sigs.length >= 2 ? sigs.join('\n') : f.contents.split('\n').slice(0, 15).join('\n');
        return `file ${f.path}:\n${body}`;
      })
      .join('\n\n');
  }
  // Prose: a short excerpt is enough context for a dependent.
  const text = result.text.trim();
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

/** Whether an error message indicates a usage/quota/rate limit. */
export function isQuotaError(error?: string): boolean {
  if (!error) {
    return false;
  }
  return /usage limit|quota|rate.?limit|not supported when using|too many requests|429/i.test(error);
}

function forwardCliEvent(
  event: Parameters<NonNullable<Parameters<typeof runClaude>[0]['onEvent']>>[0],
  subtask: Subtask,
  ctx: RunnerContext,
): void {
  if (event.type === 'log') {
    ctx.onEvent?.({ type: 'log', subtask, text: event.text });
  } else if (event.type === 'delta') {
    ctx.onEvent?.({ type: 'delta', subtask, text: event.text });
  } else {
    ctx.onEvent?.({ type: 'usage', subtask, inputTokens: event.inputTokens, outputTokens: event.outputTokens });
  }
}

/** Kahn-style layering: each wave is the set of tasks whose deps are all done. */
export function topoWaves(subtasks: Subtask[]): string[][] {
  const remaining = new Map(subtasks.map((s) => [s.id, new Set(s.dependsOn.filter((d) => subtasks.some((x) => x.id === d)))]));
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) {
      // Cycle or dangling dep — run the rest as one wave rather than hang.
      waves.push([...remaining.keys()]);
      break;
    }
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }
  return waves;
}
