import { runClaude, runCodex } from './cli.ts';
import { clampEffort, nearestOn, findModel } from './catalog.ts';
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
  onEvent?: (e: RunnerEvent) => void;
  signal?: AbortSignal;
}

export type RunnerEvent =
  | { type: 'start'; subtask: Subtask }
  | { type: 'log'; subtask: Subtask; text: string }
  | { type: 'delta'; subtask: Subtask; text: string }
  | { type: 'usage'; subtask: Subtask; inputTokens: number; outputTokens: number }
  | { type: 'done'; result: SubtaskResult };

const EXEC_SYSTEM = `You are one worker in a pipeline. Produce ONLY the file(s) this subtask must deliver — no preamble, no plan, no restating the task, no explanation outside the files.

Output EVERY file wrapped EXACTLY like this, and nothing else:
===FILE: <relative/path/with/extension>===
<the complete file contents>
===END FILE===

Rules:
- Use the real intended filename and extension (e.g. rate_limiter.py, tests/test_x.py, README.md).
- Put the raw file contents between the markers. Do NOT wrap them in triple-backtick fences.
- A documentation deliverable is still a file (===FILE: README.md===).
- If you depend on earlier files, stay consistent with them (same names, same imports).
- Emit one ===FILE:...===/===END FILE=== block per file. Output nothing before the first marker or after the last.`;

export async function executePlan(plan: Plan, ctx: RunnerContext): Promise<SubtaskResult[]> {
  const results = new Map<string, SubtaskResult>();
  const waves = topoWaves(plan.subtasks);

  for (const wave of waves) {
    await Promise.all(
      wave.map(async (id) => {
        const subtask = plan.subtasks.find((s) => s.id === id)!;
        ctx.onEvent?.({ type: 'start', subtask });
        const result = await runSubtask(plan, subtask, results, ctx);
        results.set(id, result);
        ctx.onEvent?.({ type: 'done', result });
      }),
    );
  }
  // Preserve the plan's order in the returned list.
  return plan.subtasks.map((s) => results.get(s.id)!).filter(Boolean);
}

async function runSubtask(
  plan: Plan,
  subtask: Subtask,
  done: Map<string, SubtaskResult>,
  ctx: RunnerContext,
): Promise<SubtaskResult> {
  const deps = subtask.dependsOn
    .map((d) => done.get(d))
    .filter((r): r is SubtaskResult => Boolean(r && r.ok));

  const depContext =
    deps.length > 0
      ? `\n\nOUTPUT OF EARLIER SUBTASKS YOU DEPEND ON:\n\n${deps
          .map((d) => `--- ${d.id} ---\n${d.text.slice(0, 4000)}`)
          .join('\n\n')}`
      : '';

  const prompt = `OVERALL REQUEST (for context):\n${plan.prompt}\n\nYOUR SUBTASK: ${subtask.title}\n${subtask.goal}${depContext}`;

  const first = await runOn(subtask.adapter, subtask.model, subtask.effort, prompt, subtask, ctx);

  // Reactive reroute: a quota/limit failure moves the subtask to the other
  // provider once, so one exhausted account does not sink the whole plan.
  if (!first.ok && isQuotaError(first.error) && !ctx.signal?.aborted) {
    const other: Adapter = subtask.adapter === 'claude' ? 'codex' : 'claude';
    const weight = findModel(subtask.adapter, subtask.model)?.weight ?? 5;
    const target = nearestOn(other, weight);
    const effort = clampEffort(target, subtask.effort);
    ctx.onEvent?.({ type: 'log', subtask, text: `${subtask.adapter}/${subtask.model} hit its usage limit → retrying on ${target.adapter}/${target.id} (${effort})` });
    return runOn(target.adapter, target.id, effort, prompt, subtask, ctx);
  }
  return first;
}

/** Runs one subtask on a specific adapter/model/effort. */
async function runOn(
  adapter: Adapter,
  model: string,
  effort: Subtask['effort'],
  prompt: string,
  subtask: Subtask,
  ctx: RunnerContext,
): Promise<SubtaskResult> {
  const base = { id: subtask.id, adapter, model, effort, usd: 0 };
  const common = {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs: ctx.timeoutMs,
    onEvent: (event: Parameters<typeof forwardCliEvent>[0]) => forwardCliEvent(event, subtask, ctx),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  const r =
    adapter === 'codex'
      ? // Codex has no system-prompt flag, so the marker instructions ride in the prompt.
        await runCodex({ bin: ctx.codexBin, model, effort, prompt: `${EXEC_SYSTEM}\n\n${prompt}`, ...common })
      : await runClaude({ bin: ctx.claudeBin, model, effort, system: EXEC_SYSTEM, prompt, ...common });
  return { ...base, model: r.model, ok: r.ok, text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) };
}

/** Whether an error message indicates a usage/quota/rate limit. */
function isQuotaError(error?: string): boolean {
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
