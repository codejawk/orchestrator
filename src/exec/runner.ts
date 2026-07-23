import type {
  AdapterId,
  CostRecord,
  ExecutionPlan,
  RunAccounting,
  Subtask,
} from '../types/ir.ts';
import { renderIR } from '../planner/compiler.ts';
import { topologicalWaves } from '../planner/decompose.ts';
import { assertRoutingSafe } from '../planner/router.ts';
import { TERSE_PREAMBLE } from '../optimize/outputPolicy.ts';
import { EgressGuard } from '../policy/egress.ts';
import type { AuditLog } from '../audit/log.ts';
import type { ModelAdapter, RunResult } from './adapters/types.ts';
import { materializeContext, type FileReader } from './context.ts';
import { RunLedger } from './ledger.ts';
import { CircuitBreaker, SpendGuard } from './breaker.ts';

/**
 * The DAG executor.
 *
 * Runs each wave of independent subtasks in parallel, then the next. Two things
 * it deliberately does not do:
 *
 * It never retries a failed subtask automatically. A subtask that failed on a
 * frontier model will usually fail again the same way, and silent retries are
 * how an orchestrator that claims to save money quietly triples the bill.
 *
 * It never continues past a failed dependency. Feeding a downstream subtask the
 * absence of its input produces confident nonsense, which is more expensive
 * than stopping.
 */

export type RunnerEvent =
  | { type: 'wave-start'; wave: number; subtaskIds: string[] }
  | { type: 'subtask-start'; subtask: Subtask }
  | { type: 'subtask-done'; subtask: Subtask; result: RunResult }
  | { type: 'subtask-skipped'; subtask: Subtask; reason: string }
  | { type: 'chunk'; subtaskId: string; text: string };

export interface RunnerOptions {
  adapters: Map<AdapterId, ModelAdapter>;
  read: FileReader;
  cwd: string;
  /** Paths that must never reach an external provider. Checked per dispatch. */
  gaussOnlyPaths: Set<string>;
  /** Environment for spawned CLIs. See `adapterEnv()` for why this exists. */
  env?: NodeJS.ProcessEnv;
  /** The last-line-of-defence scanner. One is created if not supplied. */
  egress?: EgressGuard;
  /** Tamper-evident record of what left the network. Optional but recommended. */
  audit?: AuditLog;
  /** Hard ceiling on total run spend in USD. 0 or absent means no cap. */
  maxRunUsd?: number;
  /** Cost already spent (planning), so the cap counts the whole run. */
  spentBeforeRun?: number;
  maxConcurrency?: number;
  timeoutMsPerSubtask?: number;
  onEvent?: (event: RunnerEvent) => void;
  signal?: AbortSignal;
}

export interface ExecutionOutcome {
  accounting: RunAccounting;
  ledger: RunLedger;
  results: Map<string, RunResult>;
  skipped: { id: string; reason: string }[];
  warnings: string[];
  /** Tokens avoided by skeletonizing and compressing rather than sending files whole. */
  contextTokensSaved: number;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 300_000;

export async function executePlan(
  plan: ExecutionPlan,
  options: RunnerOptions,
): Promise<ExecutionOutcome> {
  const ledger = new RunLedger();
  const results = new Map<string, RunResult>();
  const skipped: ExecutionOutcome['skipped'] = [];
  const warnings: string[] = [];
  const execution: CostRecord[] = [];
  let contextTokensSaved = 0;

  const byId = new Map(plan.subtasks.map((subtask) => [subtask.id, subtask]));
  const waves = topologicalWaves(plan.subtasks);
  const failed = new Set<string>();

  // Guards shared across the whole run. Created here, not per subtask, because
  // the spend total and the breaker's failure counts accumulate across waves.
  const guards: Guards = {
    egress: options.egress ?? new EgressGuard(),
    breaker: new CircuitBreaker(),
    spend: new SpendGuard(options.maxRunUsd ?? 0, options.spentBeforeRun ?? 0),
    audit: options.audit,
  };

  for (const [index, wave] of waves.entries()) {
    if (options.signal?.aborted) {
      for (const id of wave) {
        skipped.push({ id, reason: 'run cancelled' });
      }
      continue;
    }

    options.onEvent?.({ type: 'wave-start', wave: index, subtaskIds: wave });

    const runnable: Subtask[] = [];
    for (const id of wave) {
      const subtask = byId.get(id);
      if (!subtask) {
        continue;
      }
      // Dependency failures are known before the wave runs. The spend and
      // breaker checks are NOT done here: independent subtasks share a wave and
      // run in parallel, so a check at wave-start would see stale state. They
      // are enforced inside runSubtask, which the worker queue serializes past
      // the concurrency limit, so cost and failures added by earlier subtasks
      // are visible to later ones.
      const blockedBy = subtask.dependsOn.filter((dep) => failed.has(dep));
      if (blockedBy.length > 0) {
        skip(subtask, `dependency ${blockedBy.join(', ')} did not complete`);
        continue;
      }
      runnable.push(subtask);
    }

    const outcomes = await mapWithConcurrency(
      runnable,
      options.maxConcurrency ?? DEFAULT_CONCURRENCY,
      (subtask) => runSubtask(subtask, plan, ledger, options, guards),
    );

    for (const outcome of outcomes) {
      const { subtask, result, saved, warning } = outcome;
      if (outcome.skippedReason) {
        skip(subtask, outcome.skippedReason);
        continue;
      }
      if (warning) {
        warnings.push(warning);
      }
      results.set(subtask.id, result);
      execution.push(result.cost);
      contextTokensSaved += saved;
      warnings.push(...result.warnings.map((w) => `${subtask.id}: ${w}`));
      if (!result.ok) {
        failed.add(subtask.id);
      }
      ledger.record(subtask, result);
      options.onEvent?.({ type: 'subtask-done', subtask, result });
    }
  }

  function skip(subtask: Subtask, reason: string): void {
    skipped.push({ id: subtask.id, reason });
    failed.add(subtask.id);
    options.onEvent?.({ type: 'subtask-skipped', subtask, reason });
  }

  return {
    accounting: {
      planId: plan.id,
      planning: [plan.planningCost],
      execution,
    },
    ledger,
    results,
    skipped,
    warnings,
    contextTokensSaved,
  };
}

interface SubtaskOutcome {
  subtask: Subtask;
  result: RunResult;
  saved: number;
  warning?: string;
  /** Set when a guard stopped this subtask before it ran. */
  skippedReason?: string;
}

interface Guards {
  egress: EgressGuard;
  breaker: CircuitBreaker;
  spend: SpendGuard;
  audit?: AuditLog;
}

async function runSubtask(
  subtask: Subtask,
  plan: ExecutionPlan,
  ledger: RunLedger,
  options: RunnerOptions,
  guards: Guards,
): Promise<SubtaskOutcome> {
  options.onEvent?.({ type: 'subtask-start', subtask });

  // The hard spend stop. Checked here, not at wave-start, so a subtask cannot
  // begin once the running total has crossed the ceiling — including cost added
  // by an earlier subtask in this same wave.
  if (guards.spend.exceeded) {
    return { subtask, result: errorResult(subtask, 'skipped'), saved: 0, skippedReason: guards.spend.reason() };
  }
  // A broken adapter takes its remaining subtasks out of rotation.
  if (subtask.adapter !== 'gauss' && guards.breaker.isTripped(subtask.adapter)) {
    return {
      subtask,
      result: errorResult(subtask, 'skipped'),
      saved: 0,
      skippedReason: guards.breaker.reason(subtask.adapter),
    };
  }

  // Last line of defence at the routing level. The router already guarantees
  // this; the check is cheap and the failure it prevents cannot be undone.
  try {
    assertRoutingSafe(subtask, options.gaussOnlyPaths);
  } catch (error) {
    return {
      subtask,
      result: errorResult(subtask, error instanceof Error ? error.message : String(error)),
      saved: 0,
      warning: `${subtask.id} was blocked by the routing check. This indicates a bug in the router.`,
    };
  }

  const adapter = options.adapters.get(subtask.adapter);
  if (!adapter) {
    return {
      subtask,
      result: errorResult(subtask, `no adapter registered for "${subtask.adapter}"`),
      saved: 0,
    };
  }

  const context = await materializeContext(subtask.context, options.read);
  const handoff = ledger.renderFor(subtask);
  const systemPrompt = systemPromptFor(subtask);

  // Ordered static-first so the provider prompt cache sees a stable prefix
  // across subtasks: the IR is identical for every subtask in a plan, while
  // context and handoff differ. Reordering silently costs cache hits.
  const prompt = [
    renderIR(plan.ir, subtask.goal),
    context.text ? `\nCONTEXT:\n${context.text}` : '',
    handoff.text ? `\n${handoff.text}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const files = subtask.context.map((ref) => ref.path);

  // THE EGRESS CHOKEPOINT.
  //
  // Every external dispatch passes through here, and here alone, with the exact
  // bytes about to be sent. It re-scans the serialized payload deterministically
  // and hard-fails on a secret or confidential-tier content — whatever routing
  // decided. Gauss is internal, so its payloads are exempt; nothing leaves the
  // network on that path.
  if (subtask.adapter !== 'gauss') {
    const verdict = guards.egress.inspect([systemPrompt, prompt]);
    if (!verdict.allowed) {
      const detail = verdict.violations.map((v) => v.detail).join('; ');
      await guards.audit?.append({
        event: 'egress-block',
        planId: plan.id,
        subtaskId: subtask.id,
        adapter: subtask.adapter,
        model: subtask.model,
        tier: verdict.tier,
        files,
        decision: `blocked: ${detail}`,
        promptHash: guards.audit.hashContent(prompt),
      });
      return {
        subtask,
        result: errorResult(subtask, `egress guard blocked this subtask: ${detail}`),
        saved: 0,
        warning:
          `${subtask.id} was stopped at the egress chokepoint (${detail}). ` +
          'Nothing was sent. This means content that should not leave the network reached the dispatch stage — a bug upstream, not here.',
      };
    }

    await guards.audit?.append({
      event: 'dispatch',
      planId: plan.id,
      subtaskId: subtask.id,
      adapter: subtask.adapter,
      model: subtask.model,
      tier: verdict.tier,
      files,
      promptHash: guards.audit.hashContent(prompt),
    });
  }

  const result = await adapter.run({
    subtask,
    prompt,
    systemPrompt,
    output: subtask.output,
    cwd: options.cwd,
    scopeDirs: [],
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: options.timeoutMsPerSubtask ?? DEFAULT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    onChunk: (text) => options.onEvent?.({ type: 'chunk', subtaskId: subtask.id, text }),
  });

  // Update the shared guards immediately, so the next subtask the worker queue
  // picks up in this wave sees the new spend total and failure counts.
  guards.spend.add(result.cost.usd);
  if (result.ok) {
    guards.breaker.recordSuccess(subtask.adapter);
  } else if (subtask.adapter !== 'gauss' && result.failureKind === 'infra') {
    guards.breaker.recordFailure(subtask.adapter);
  }

  await guards.audit?.append({
    event: 'result',
    planId: plan.id,
    subtaskId: subtask.id,
    adapter: subtask.adapter,
    model: result.cost.model,
    files,
    decision: result.ok ? 'ok' : `failed: ${result.error ?? 'unknown'}`,
    usd: result.cost.usd,
    tokens: result.cost.usage.inputTokens + result.cost.usage.outputTokens,
    responseHash: guards.audit.hashContent(result.text),
  });

  const warning =
    context.dropped.length > 0
      ? `${subtask.id}: dropped ${context.dropped.map((d) => `${d.path} (${d.reason})`).join('; ')}`
      : undefined;

  return { subtask, result, saved: context.savedVersusFull, ...(warning ? { warning } : {}) };
}

const KIND_INSTRUCTIONS: Record<Subtask['kind'], string> = {
  analyze: 'You analyse code and report findings. You do not propose edits.',
  review: 'You review code for defects, security issues and correctness. Report only real problems you can point at.',
  edit: 'You produce minimal search/replace edits. The search text must match the file exactly and appear only once.',
  refactor: 'You restructure code without changing behaviour. Produce minimal search/replace edits.',
  test: 'You write tests that would fail before the change and pass after it.',
  doc: 'You write documentation. Describe what the code does, not what you did.',
};

function systemPromptFor(subtask: Subtask): string {
  return [
    KIND_INSTRUCTIONS[subtask.kind],
    TERSE_PREAMBLE,
    'All context you need is in the message. You have no file access — do not ask for files, work with what is given.',
  ].join(' ');
}

function errorResult(subtask: Subtask, error: string): RunResult {
  return {
    ok: false,
    text: '',
    cost: {
      adapter: subtask.adapter,
      model: subtask.model,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0 },
      usd: 0,
      usdReported: false,
      durationMs: 0,
    },
    warnings: [],
    error,
  };
}

/** Bounded parallelism. Unbounded would spawn one CLI process per subtask. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item);
      }
    }
  });

  await Promise.all(workers);
  return results;
}
