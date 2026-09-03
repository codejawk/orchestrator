import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { routeFor, type UsageHeadroom } from '../src/router.ts';
import { clampEffort, defaultRoute, nearestOn, findModel } from '../src/catalog.ts';
import { lastRateLimits } from '../src/usage.ts';
import { topoWaves, handoffSummary, isQuotaError } from '../src/runner.ts';
import type { ProviderUsage } from '../src/usage.ts';
import type { Subtask, SubtaskResult } from '../src/types.ts';

const P = (adapter: 'claude' | 'codex', headroom?: number, reached = false): ProviderUsage => ({
  adapter, known: headroom !== undefined, headroom, usedPercent: headroom !== undefined ? 100 - headroom : undefined,
  reachedLimit: reached, detail: '',
});

describe('routeFor', () => {
  test('hard work goes to a strong model', () => {
    const r = routeFor('code', 'hard', { adapter: 'claude', model: 'opus', effort: 'high', reason: '' });
    assert.equal(r.adapter, 'claude');
    assert.equal(r.model, 'opus');
  });

  test('an underpowered pick for hard work is upgraded by the guardrail', () => {
    const r = routeFor('code', 'hard', { adapter: 'claude', model: 'haiku', effort: 'low', reason: '' });
    assert.ok((findModel(r.adapter, r.model)?.weight ?? 0) >= 7);
  });

  test('low headroom reroutes to the healthier provider', () => {
    const usage: UsageHeadroom = { claude: P('claude', 5), codex: P('codex', 90), softFloor: 20 };
    const r = routeFor('code', 'standard', { adapter: 'claude', model: 'sonnet', effort: 'medium', reason: '' }, usage);
    assert.equal(r.adapter, 'codex');
    assert.match(r.note, /low on quota|out of quota/);
  });

  test('analysis is capped to a Sonnet-class model, never Opus', () => {
    // Even if the main model picks Opus for a "hard" analysis, cap it.
    const r = routeFor('analysis', 'hard', { adapter: 'claude', model: 'opus', effort: 'high', reason: '' });
    assert.ok((findModel(r.adapter, r.model)?.weight ?? 99) <= 6, `expected sonnet-class, got ${r.model}`);
    assert.match(r.note, /does not need a frontier model/);
  });

  test('healthy quota keeps the chosen provider', () => {
    const usage: UsageHeadroom = { claude: P('claude', 80), codex: P('codex', 90), softFloor: 20 };
    const r = routeFor('code', 'standard', { adapter: 'claude', model: 'sonnet', effort: 'medium', reason: '' }, usage);
    assert.equal(r.adapter, 'claude');
  });
});

describe('catalog', () => {
  test('clampEffort lowers to a supported level', () => {
    const haiku = findModel('claude', 'haiku')!;
    assert.equal(clampEffort(haiku, 'ultra'), 'medium'); // haiku supports low/medium
  });
  test('defaultRoute picks a strong model for hard', () => {
    assert.ok(defaultRoute('code', 'hard').entry.weight >= 7);
  });
  test('nearestOn finds a model on the requested adapter', () => {
    assert.equal(nearestOn('codex', 9).adapter, 'codex');
  });
});

describe('usage.lastRateLimits', () => {
  test('reads the final rate_limits snapshot', () => {
    const content = [
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 5 } } } }),
      JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 42 } } } }),
    ].join('\n');
    assert.equal(lastRateLimits(content)?.primary?.used_percent, 42);
  });
});

describe('runner helpers', () => {
  test('topoWaves orders by dependency', () => {
    const subs = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: [] },
    ] as Subtask[];
    const waves = topoWaves(subs);
    assert.deepEqual(waves[0]!.sort(), ['a', 'c']);
    assert.deepEqual(waves[1], ['b']);
  });

  test('handoffSummary gives signatures for file output', () => {
    const r = { id: 'm', ok: true, text: '===FILE: m.py===\ndef foo(x):\n    return x\nclass Bar:\n    pass\n===END FILE===' } as SubtaskResult;
    const s = handoffSummary(r);
    assert.match(s, /file m\.py/);
    assert.match(s, /def foo/);
    assert.match(s, /class Bar/);
  });

  test('handoffSummary excerpts prose', () => {
    const r = { id: 'p', ok: true, text: 'This module does X and Y.' } as SubtaskResult;
    assert.equal(handoffSummary(r), 'This module does X and Y.');
  });

  test('isQuotaError detects limit messages', () => {
    assert.ok(isQuotaError("You've hit your usage limit"));
    assert.ok(isQuotaError('not supported when using Codex with a ChatGPT account'));
    assert.ok(!isQuotaError('syntax error on line 3'));
  });
});
