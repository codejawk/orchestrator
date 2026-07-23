import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { executePlan } from '../src/exec/runner.ts';
import { EgressGuard } from '../src/policy/egress.ts';
import { AuditLog, newSalt, type AuditRecord } from '../src/audit/log.ts';
import type { ModelAdapter, RunRequest, RunResult } from '../src/exec/adapters/types.ts';
import type { AdapterId, ExecutionPlan, Subtask } from '../src/types/ir.ts';

/** In-memory audit log plus a helper to read back which events were recorded. */
function fakeAudit(): { log: AuditLog; events: () => string[] } {
  const records: AuditRecord[] = [];
  const log = new AuditLog(
    { load: () => records, save: async (next) => { records.length = 0; records.push(...next); } },
    newSalt(),
  );
  return { log, events: () => records.map((r) => r.event) };
}

/**
 * The DAG executor, driven by fake adapters.
 *
 * No CLI is spawned and no token is spent, so these run in milliseconds and do
 * not depend on three vendors being reachable.
 */

class FakeAdapter implements ModelAdapter {
  readonly id: AdapterId;
  readonly seen: string[] = [];
  private readonly behaviour: (request: RunRequest) => Partial<RunResult>;

  constructor(id: AdapterId, behaviour: (request: RunRequest) => Partial<RunResult> = () => ({})) {
    this.id = id;
    this.behaviour = behaviour;
  }

  async probe() {
    throw new Error('not used');
    return undefined as never;
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.seen.push(request.subtask.id);
    const overrides = this.behaviour(request);
    return {
      ok: true,
      text: `done ${request.subtask.id}`,
      cost: {
        adapter: this.id,
        model: request.subtask.model,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheCreationTokens: 0 },
        usd: 0.01,
        usdReported: true,
        durationMs: 5,
      },
      warnings: [],
      ...overrides,
    };
  }
}

function subtask(id: string, overrides: Partial<Subtask> = {}): Subtask {
  return {
    id,
    dependsOn: [],
    kind: 'analyze',
    goal: `goal ${id}`,
    context: [],
    consumes: [],
    adapter: 'claude',
    model: 'sonnet',
    output: { format: 'json', maxTokens: 500, reasoning: 'off' },
    estimate: { inTokens: 100, outTokens: 50, usd: 0.01 },
    ...overrides,
  };
}

function plan(subtasks: Subtask[]): ExecutionPlan {
  return {
    id: 'p1',
    createdAt: new Date().toISOString(),
    ir: {
      goal: 'do the work',
      constraints: [],
      acceptance: [],
      nonGoals: ['do not touch unrelated modules'],
      context: [],
      classification: { tier: 'internal', reasons: [] },
      rawPromptTokens: 100,
    },
    subtasks,
    estimate: { inTokens: 0, outTokens: 0, usd: 0 },
    planningCost: {
      adapter: 'gauss',
      model: 'gauss',
      usage: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0, cacheCreationTokens: 0 },
      usd: 0.03,
      usdReported: false,
      durationMs: 100,
    },
  };
}

const noFiles = async () => undefined;

function adapters(...list: FakeAdapter[]): Map<AdapterId, ModelAdapter> {
  return new Map(list.map((adapter) => [adapter.id, adapter]));
}

describe('executePlan', () => {
  test('runs dependency waves in order and independent subtasks together', async () => {
    const claude = new FakeAdapter('claude');

    const outcome = await executePlan(
      plan([
        subtask('a'),
        subtask('b', { dependsOn: ['a'], consumes: ['a'] }),
        subtask('c', { dependsOn: ['a'], consumes: ['a'] }),
        subtask('d', { dependsOn: ['b', 'c'] }),
      ]),
      { adapters: adapters(claude), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set() },
    );

    assert.equal(outcome.results.size, 4);
    assert.equal(claude.seen[0], 'a');
    assert.equal(claude.seen[3], 'd');
    assert.deepEqual(claude.seen.slice(1, 3).sort(), ['b', 'c']);
  });

  test('dispatches each subtask to its own adapter', async () => {
    const claude = new FakeAdapter('claude');
    const gemini = new FakeAdapter('gemini');
    const gauss = new FakeAdapter('gauss');

    await executePlan(
      plan([
        subtask('a', { adapter: 'claude', model: 'opus' }),
        subtask('b', { adapter: 'gemini', model: 'gemini-2.5-flash' }),
        subtask('c', { adapter: 'gauss', model: 'gauss' }),
      ]),
      { adapters: adapters(claude, gemini, gauss), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set() },
    );

    assert.deepEqual(claude.seen, ['a']);
    assert.deepEqual(gemini.seen, ['b']);
    assert.deepEqual(gauss.seen, ['c']);
  });

  test('skips dependents of a failed subtask rather than feeding them nothing', async () => {
    const claude = new FakeAdapter('claude', (request) =>
      request.subtask.id === 'a' ? { ok: false, error: 'boom' } : {},
    );

    const outcome = await executePlan(
      plan([subtask('a'), subtask('b', { dependsOn: ['a'] }), subtask('c')]),
      { adapters: adapters(claude), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set() },
    );

    assert.equal(outcome.skipped.length, 1);
    assert.equal(outcome.skipped[0]?.id, 'b');
    assert.match(outcome.skipped[0]?.reason ?? '', /did not complete/);
    // An unrelated subtask still runs — one failure does not abandon the plan.
    assert.deepEqual(claude.seen.sort(), ['a', 'c']);
  });

  test('blocks a subtask whose context is not approved, without calling the adapter', async () => {
    const claude = new FakeAdapter('claude');

    const outcome = await executePlan(
      plan([
        subtask('leaky', {
          adapter: 'claude',
          context: [{ path: 'boot/sboot.c', mode: 'full', estTokens: 10 }],
        }),
      ]),
      {
        adapters: adapters(claude),
        read: noFiles,
        cwd: '/tmp',
        gaussOnlyPaths: new Set(['boot/sboot.c']),
      },
    );

    assert.deepEqual(claude.seen, [], 'the adapter must never have been invoked');
    assert.equal(outcome.results.get('leaky')?.ok, false);
    assert.match(outcome.results.get('leaky')?.error ?? '', /not approved for external use/);
    assert.match(outcome.warnings.join(' '), /bug in the router/);
  });

  test('accounting carries planning cost alongside execution cost', async () => {
    const claude = new FakeAdapter('claude');

    const outcome = await executePlan(plan([subtask('a'), subtask('b')]), {
      adapters: adapters(claude),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
    });

    assert.equal(outcome.accounting.planning.length, 1);
    assert.equal(outcome.accounting.planning[0]?.usd, 0.03);
    assert.equal(outcome.accounting.execution.length, 2);
  });

  test('the shared IR prefix is identical across subtasks, so the cache can hit', async () => {
    const prompts: string[] = [];
    const claude = new FakeAdapter('claude');
    claude.run = async (request) => {
      prompts.push(request.prompt);
      return {
        ok: true,
        text: 'ok',
        cost: {
          adapter: 'claude' as const,
          model: 'sonnet',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0 },
          usd: 0,
          usdReported: true,
          durationMs: 1,
        },
        warnings: [],
      };
    };

    await executePlan(plan([subtask('a'), subtask('b')]), {
      adapters: adapters(claude),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
    });

    const [first, second] = prompts;
    assert.ok(first && second);
    let shared = 0;
    while (shared < first.length && first[shared] === second[shared]) {
      shared++;
    }
    assert.ok(first.slice(0, shared).includes('DO NOT:'), 'static sections must precede the variable tail');
  });

  test('missing adapter fails that subtask instead of the whole run', async () => {
    const outcome = await executePlan(plan([subtask('a', { adapter: 'codex' })]), {
      adapters: adapters(new FakeAdapter('claude')),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
    });

    assert.match(outcome.results.get('a')?.error ?? '', /no adapter registered/);
  });

  test('a cancelled run skips everything and reports it', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await executePlan(plan([subtask('a')]), {
      adapters: adapters(new FakeAdapter('claude')),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
      signal: controller.signal,
    });

    assert.equal(outcome.skipped[0]?.reason, 'run cancelled');
  });

  test('the egress chokepoint blocks a payload the router let through', async () => {
    // The adapter would happily send, but the assembled prompt carries a
    // restricted marker. The guard must stop it before the adapter runs.
    const claude = new FakeAdapter('claude');
    const guard = new EgressGuard();

    const outcome = await executePlan(
      plan([
        subtask('leaky', {
          adapter: 'claude',
          // renderIR embeds the goal into the prompt; put the trigger there.
          goal: 'handle avb_verify_slot and rollback_index in secure boot',
        }),
      ]),
      { adapters: adapters(claude), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set(), egress: guard },
    );

    assert.deepEqual(claude.seen, [], 'the adapter must not have been called');
    assert.equal(outcome.results.get('leaky')?.ok, false);
    assert.match(outcome.results.get('leaky')?.error ?? '', /egress guard blocked/);
  });

  test('Gauss payloads are exempt from egress, since nothing leaves the network', async () => {
    const gauss = new FakeAdapter('gauss');

    const outcome = await executePlan(
      plan([subtask('x', { adapter: 'gauss', model: 'gauss', goal: 'review the secure_boot path' })]),
      { adapters: adapters(gauss), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set(), egress: new EgressGuard() },
    );

    assert.deepEqual(gauss.seen, ['x']);
    assert.equal(outcome.results.get('x')?.ok, true);
  });

  test('the spend cap stops dispatch once real cost crosses it', async () => {
    // Each fake subtask costs $0.01. A $0.01 cap: the first spends it, and the
    // guard is `>=`, so the second is stopped before it runs.
    const claude = new FakeAdapter('claude');

    const outcome = await executePlan(
      plan([subtask('a'), subtask('b'), subtask('c')]),
      {
        adapters: adapters(claude),
        read: noFiles,
        cwd: '/tmp',
        gaussOnlyPaths: new Set(),
        maxRunUsd: 0.01,
        // Serial, so the cap is exact: parallel dispatch is best-effort by nature.
        maxConcurrency: 1,
      },
    );

    assert.equal(claude.seen.length, 1, 'only the first subtask should have run');
    assert.ok(outcome.skipped.some((s) => /spend cap/i.test(s.reason)));
  });

  test('the spend cap counts planning cost that was already spent', async () => {
    const claude = new FakeAdapter('claude');
    // Planning cost in plan() is $0.03, already over a $0.02 cap.
    const outcome = await executePlan(plan([subtask('a')]), {
      adapters: adapters(claude),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
      maxRunUsd: 0.02,
      spentBeforeRun: 0.03,
    });

    assert.deepEqual(claude.seen, [], 'planning already blew the cap; nothing external runs');
  });

  test('the circuit breaker takes a repeatedly-failing adapter out of rotation', async () => {
    // Adapter spawn-fails (infra) every time. After 2 failures it is tripped and
    // the remaining subtasks are skipped rather than dispatched.
    const claude = new FakeAdapter('claude', () => ({
      ok: false,
      error: 'could not spawn',
      failureKind: 'infra' as const,
    }));

    const outcome = await executePlan(
      plan([subtask('a'), subtask('b'), subtask('c'), subtask('d')]),
      { adapters: adapters(claude), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set(), maxConcurrency: 1 },
    );

    assert.equal(claude.seen.length, 2, 'stops trying after the breaker trips');
    assert.ok(outcome.skipped.some((s) => /out of rotation/.test(s.reason)));
  });

  test('a model failure does not trip the breaker', async () => {
    // Bad answers are content failures, not availability failures. All four run.
    const claude = new FakeAdapter('claude', () => ({
      ok: false,
      error: 'model produced nonsense',
      failureKind: 'model' as const,
    }));

    const outcome = await executePlan(
      plan([subtask('a'), subtask('b'), subtask('c')]),
      { adapters: adapters(claude), read: noFiles, cwd: '/tmp', gaussOnlyPaths: new Set() },
    );

    assert.equal(claude.seen.length, 3, 'a healthy-but-wrong adapter stays in rotation');
    assert.equal(outcome.skipped.length, 0);
  });

  test('audit records a dispatch and a result for an external subtask', async () => {
    const claude = new FakeAdapter('claude');
    const audit = fakeAudit();

    await executePlan(plan([subtask('a', { adapter: 'claude' })]), {
      adapters: adapters(claude),
      read: noFiles,
      cwd: '/tmp',
      gaussOnlyPaths: new Set(),
      audit: audit.log,
    });

    const events = audit.events();
    assert.ok(events.includes('dispatch'));
    assert.ok(events.includes('result'));
  });

  test('audit records an egress-block instead of a dispatch when blocked', async () => {
    const claude = new FakeAdapter('claude');
    const audit = fakeAudit();

    await executePlan(
      plan([subtask('a', { adapter: 'claude', goal: 'patch the sboot rollback_index' })]),
      {
        adapters: adapters(claude),
        read: noFiles,
        cwd: '/tmp',
        gaussOnlyPaths: new Set(),
        egress: new EgressGuard(),
        audit: audit.log,
      },
    );

    const events = audit.events();
    assert.ok(events.includes('egress-block'));
    assert.ok(!events.includes('dispatch'), 'a blocked payload is never dispatched');
  });
});
